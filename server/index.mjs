// VoxMorph server: serves the app and powers real-time calls. No dependencies.
//
//   Phone calls  - issues Twilio Voice access tokens and answers Twilio's
//                  webhook with TwiML, so the app can call any phone number
//                  (and receive calls) with the changed voice.
//   App-to-app   - WebRTC signaling over Server-Sent Events + POST, so two
//                  VoxMorph users can talk for free, peer to peer.
//
// Configuration (environment variables) is documented in docs/CALLS.md.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const APP_ROOT = fileURLToPath(new URL('../app/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
};
const E164 = /^\+[1-9]\d{6,14}$/;
const ROOM = /^[a-zA-Z0-9-]{4,40}$/;
const PEER = /^[a-zA-Z0-9-]{4,40}$/;

// ---------- helpers ----------
const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function twilioAccessToken({ accountSid, apiKey, apiSecret, appSid, identity, ttl = 3600, now = Math.floor(Date.now() / 1000) }) {
  const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti: `${apiKey}-${now}`,
    grants: { identity, voice: { incoming: { allow: true }, outgoing: { application_sid: appSid } } },
    iat: now,
    exp: now + ttl,
    iss: apiKey,
    sub: accountSid,
  };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac('sha256', apiSecret).update(body).digest();
  return `${body}.${b64url(sig)}`;
}

/** Twilio webhook signature: base64(HMAC-SHA1(authToken, url + sorted(key+value))). */
export function twilioSignature(authToken, url, params) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', authToken).update(data).digest('base64');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------- app ----------
export function createApp(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const cfg = {
    accountSid: env.TWILIO_ACCOUNT_SID,
    apiKey: env.TWILIO_API_KEY,
    apiSecret: env.TWILIO_API_SECRET,
    appSid: env.TWILIO_TWIML_APP_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    callerId: env.TWILIO_CALLER_ID,
    identity: env.CLIENT_IDENTITY || 'voxmorph',
    password: env.APP_PASSWORD || '',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
    prefixes: (env.ALLOWED_PREFIXES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    origins: (env.ALLOWED_ORIGINS || '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    turn: env.TURN_URLS
      ? { urls: env.TURN_URLS.split(',').map((s) => s.trim()), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }
      : null,
  };
  const phoneEnabled = Boolean(cfg.accountSid && cfg.apiKey && cfg.apiSecret && cfg.appSid && cfg.callerId);
  const rooms = new Map(); // room -> Map(peerId -> res)
  const failures = new Map(); // ip -> { count, until }
  let iceCache = null;

  async function iceServers() {
    const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    if (cfg.turn) list.push(cfg.turn);
    // Twilio's TURN relays make app-to-app calls work on strict mobile networks.
    if (cfg.accountSid && cfg.authToken && fetchImpl) {
      if (!iceCache || iceCache.expires < Date.now()) {
        try {
          const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Tokens.json`, {
            method: 'POST',
            headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64') },
          });
          if (res.ok) {
            const j = await res.json();
            iceCache = { servers: j.ice_servers || [], expires: Date.now() + (Number(j.ttl) || 86400) * 500 };
          }
        } catch {
          /* STUN only */
        }
      }
      if (iceCache) list.push(...iceCache.servers);
    }
    return list;
  }

  function cors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return;
    if (cfg.origins.includes('*') || cfg.origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', cfg.origins.includes('*') ? '*' : origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Vary', 'Origin');
    }
  }

  function json(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  function twiml(res, inner) {
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`);
  }

  function send(peerRes, event, data) {
    peerRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function broadcastPeers(room) {
    const peers = rooms.get(room);
    if (!peers) return;
    const ids = [...peers.keys()];
    for (const r of peers.values()) send(r, 'peers', { peers: ids });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;
    cors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (path === '/api/config' && req.method === 'GET') {
      return json(res, 200, {
        phone: phoneEnabled,
        p2p: true,
        passwordRequired: Boolean(cfg.password),
        callerId: phoneEnabled ? cfg.callerId : null,
        iceServers: await iceServers(),
      });
    }

    if (path === '/api/token' && req.method === 'POST') {
      if (!phoneEnabled) return json(res, 501, { error: 'Phone calling is not configured on this server.' });
      // Calls cost money: never hand out tokens without a password.
      if (!cfg.password) return json(res, 503, { error: 'Set APP_PASSWORD on the server to enable phone calls.' });
      const ip = req.socket.remoteAddress || '';
      const f = failures.get(ip);
      if (f && f.count >= 10 && f.until > Date.now()) return json(res, 429, { error: 'Too many wrong passwords. Try again later.' });
      let body = {};
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { error: 'Invalid JSON' });
      }
      if (!safeEqual(body.password || '', cfg.password)) {
        const next = f && f.until > Date.now() ? f.count + 1 : 1;
        failures.set(ip, { count: next, until: Date.now() + 10 * 60 * 1000 });
        return json(res, 401, { error: 'Wrong app password.' });
      }
      failures.delete(ip);
      const token = twilioAccessToken({ ...cfg, identity: cfg.identity });
      return json(res, 200, { token, identity: cfg.identity, ttl: 3600 });
    }

    if (path === '/twilio/voice' && req.method === 'POST') {
      const raw = await readBody(req);
      const params = Object.fromEntries(new URLSearchParams(raw));
      if (cfg.authToken) {
        const proto = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const full = (cfg.publicUrl || `${proto}://${host}`) + req.url;
        const expected = twilioSignature(cfg.authToken, full, params);
        if (!safeEqual(req.headers['x-twilio-signature'] || '', expected)) {
          res.writeHead(403);
          return res.end('Invalid signature');
        }
      }
      const from = params.From || params.Caller || '';
      if (from.startsWith('client:')) {
        // Outgoing call from the app to a phone number.
        const to = (params.To || '').replace(/[\s()-]/g, '');
        if (!E164.test(to)) return twiml(res, '<Say>Please dial the number in international format, starting with plus.</Say>');
        if (cfg.prefixes.length && !cfg.prefixes.some((p) => to.startsWith(p))) {
          return twiml(res, '<Say>Calls to this destination are not allowed.</Say>');
        }
        return twiml(res, `<Dial callerId="${xml(cfg.callerId)}" answerOnBridge="true"><Number>${xml(to)}</Number></Dial>`);
      }
      // Incoming call to the Twilio number: ring the app.
      return twiml(res, `<Dial answerOnBridge="true" timeout="30"><Client>${xml(cfg.identity)}</Client></Dial>`);
    }

    const roomMatch = path.match(/^\/api\/rooms\/([^/]+)(\/events)?$/);
    if (roomMatch) {
      const room = roomMatch[1];
      if (!ROOM.test(room)) return json(res, 400, { error: 'Bad room code' });
      if (roomMatch[2] && req.method === 'GET') {
        const peer = url.searchParams.get('peer') || '';
        if (!PEER.test(peer)) return json(res, 400, { error: 'Bad peer id' });
        let peers = rooms.get(room);
        if (!peers) rooms.set(room, (peers = new Map()));
        if (!peers.has(peer) && peers.size >= 2) return json(res, 409, { error: 'This call already has two people.' });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        peers.set(peer, res);
        broadcastPeers(room);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => {
          clearInterval(ping);
          if (peers.get(peer) === res) peers.delete(peer);
          if (peers.size === 0) rooms.delete(room);
          else broadcastPeers(room);
        });
        return;
      }
      if (!roomMatch[2] && req.method === 'POST') {
        let msg;
        try {
          msg = JSON.parse(await readBody(req));
        } catch (err) {
          return json(res, err.status || 400, { error: err.message });
        }
        const peers = rooms.get(room);
        if (!peers || !peers.has(msg.from)) return json(res, 404, { error: 'Not in this room' });
        for (const [id, r] of peers) if (id !== msg.from && (!msg.to || msg.to === id)) send(r, 'signal', { from: msg.from, data: msg.data });
        return json(res, 200, { ok: true });
      }
    }

    if (path.startsWith('/api/') || path.startsWith('/twilio/')) return json(res, 404, { error: 'Not found' });

    // Static app
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    try {
      let p = decodeURIComponent(path);
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(APP_ROOT, p));
      if (!file.startsWith(APP_ROOT)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
      const info = await stat(file);
      if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch (err) {
      res.writeHead(err.code === 'EACCES' ? 403 : 404);
      res.end('Not found');
    }
  }

  return async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
      else res.end();
      if (!err.status) console.error(err);
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const port = Number(process.env.PORT) || 8080;
  const app = createApp();
  createServer(app).listen(port, () => {
    console.log(`VoxMorph running at http://localhost:${port}`);
    const phone = process.env.TWILIO_ACCOUNT_SID ? 'enabled' : 'off (set TWILIO_* to enable)';
    console.log(`  phone calls: ${phone}; app-to-app calls: enabled`);
  });
}
