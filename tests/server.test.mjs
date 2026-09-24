import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createApp, twilioAccessToken, twilioSignature } from '../server/index.mjs';

const require = createRequire(import.meta.url);
const twilio = require('twilio');

const ENV = {
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_API_KEY: 'SK00000000000000000000000000000000',
  TWILIO_API_SECRET: 'apisecret',
  TWILIO_TWIML_APP_SID: 'AP00000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'authtoken',
  TWILIO_CALLER_ID: '+15550001111',
  APP_PASSWORD: 'hunter2',
  ALLOWED_PREFIXES: '+1,+44',
};

let server;
let base;
before(async () => {
  server = createServer(createApp(ENV, { fetchImpl: null }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('access token matches the official Twilio library', () => {
  const now = 1790000000;
  const ours = twilioAccessToken({
    accountSid: ENV.TWILIO_ACCOUNT_SID,
    apiKey: ENV.TWILIO_API_KEY,
    apiSecret: ENV.TWILIO_API_SECRET,
    appSid: ENV.TWILIO_TWIML_APP_SID,
    identity: 'voxmorph',
    now,
  });
  const jwt = require('jsonwebtoken');
  const payload = jwt.verify(ours, ENV.TWILIO_API_SECRET, { algorithms: ['HS256'], clockTimestamp: now });
  const AT = twilio.jwt.AccessToken;
  const ref = new AT(ENV.TWILIO_ACCOUNT_SID, ENV.TWILIO_API_KEY, ENV.TWILIO_API_SECRET, { identity: 'voxmorph', ttl: 3600 });
  ref.addGrant(new AT.VoiceGrant({ outgoingApplicationSid: ENV.TWILIO_TWIML_APP_SID, incomingAllow: true }));
  const refPayload = jwt.decode(ref.toJwt());
  const strip = ({ jti, iat, exp, ...rest }) => rest;
  assert.deepEqual(strip(payload), strip(refPayload));
  assert.equal(payload.exp - payload.iat, 3600);
  assert.deepEqual(jwt.decode(ours, { complete: true }).header, jwt.decode(ref.toJwt(), { complete: true }).header);
});

test('webhook signature matches the official Twilio library', () => {
  const params = { From: 'client:voxmorph', To: '+15551234567', CallSid: 'CA1' };
  const url = 'https://example.com/twilio/voice';
  const sig = twilioSignature(ENV.TWILIO_AUTH_TOKEN, url, params);
  assert.ok(twilio.validateRequest(ENV.TWILIO_AUTH_TOKEN, sig, url, params));
});

test('config reports features', async () => {
  const j = await (await fetch(`${base}/api/config`)).json();
  assert.equal(j.phone, true);
  assert.equal(j.p2p, true);
  assert.equal(j.passwordRequired, true);
  assert.ok(j.iceServers.length >= 1);
});

test('token requires the app password', async () => {
  const bad = await fetch(`${base}/api/token`, { method: 'POST', body: JSON.stringify({ password: 'nope' }) });
  assert.equal(bad.status, 401);
  const good = await fetch(`${base}/api/token`, { method: 'POST', body: JSON.stringify({ password: 'hunter2' }) });
  assert.equal(good.status, 200);
  const j = await good.json();
  assert.equal(j.identity, 'voxmorph');
  assert.equal(j.token.split('.').length, 3);
});

async function webhook(params, { sign = true } = {}) {
  const url = `${base}/twilio/voice`;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (sign) headers['X-Twilio-Signature'] = twilioSignature(ENV.TWILIO_AUTH_TOKEN, url, params);
  const res = await fetch(url, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
  return { status: res.status, text: await res.text() };
}

test('outgoing call dials the number with the configured caller id', async () => {
  const r = await webhook({ From: 'client:voxmorph', To: '+1 (555) 123-4567' });
  assert.equal(r.status, 200);
  assert.match(r.text, /<Dial callerId="\+15550001111" answerOnBridge="true"><Number>\+15551234567<\/Number><\/Dial>/);
});

test('outgoing call rejects bad and disallowed numbers', async () => {
  assert.match((await webhook({ From: 'client:voxmorph', To: '5551234' })).text, /<Say>/);
  assert.match((await webhook({ From: 'client:voxmorph', To: '+491701234567' })).text, /not allowed/);
  assert.doesNotMatch((await webhook({ From: 'client:voxmorph', To: '+15551234567"><Hangup/>' })).text, /<Hangup/);
});

test('incoming phone call rings the app', async () => {
  const r = await webhook({ From: '+15559998888', To: ENV.TWILIO_CALLER_ID });
  assert.match(r.text, /<Client>voxmorph<\/Client>/);
});

test('unsigned webhooks are rejected', async () => {
  const r = await webhook({ From: 'client:voxmorph', To: '+15551234567' }, { sign: false });
  assert.equal(r.status, 403);
});

test('signaling relays messages between two peers only', async () => {
  const room = 'test-room-1';
  const open = (peer) => {
    const ctrl = new AbortController();
    const events = [];
    const ready = fetch(`${base}/api/rooms/${room}/events?peer=${peer}`, { signal: ctrl.signal }).then(async (res) => {
      if (res.status !== 200) return res.status;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value);
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const ev = block.match(/^event: (.*)$/m);
              const data = block.match(/^data: (.*)$/m);
              if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) });
            }
          }
        } catch {
          /* aborted */
        }
      })();
      return 200;
    });
    return { ctrl, events, ready };
  };
  const a = open('peer-aaaa');
  assert.equal(await a.ready, 200);
  const b = open('peer-bbbb');
  assert.equal(await b.ready, 200);
  const c = open('peer-cccc');
  assert.equal(await c.ready, 409);
  const post = await fetch(`${base}/api/rooms/${room}`, {
    method: 'POST',
    body: JSON.stringify({ from: 'peer-aaaa', data: { sdp: 'hello' } }),
  });
  assert.equal(post.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(
    b.events.filter((e) => e.event === 'signal').map((e) => e.data),
    [{ from: 'peer-aaaa', data: { sdp: 'hello' } }],
  );
  assert.equal(a.events.filter((e) => e.event === 'signal').length, 0);
  assert.deepEqual(a.events.filter((e) => e.event === 'peers').pop().data.peers.sort(), ['peer-aaaa', 'peer-bbbb']);
  const stranger = await fetch(`${base}/api/rooms/${room}`, { method: 'POST', body: JSON.stringify({ from: 'peer-zzzz', data: 1 }) });
  assert.equal(stranger.status, 404);
  a.ctrl.abort();
  b.ctrl.abort();
});

test('phone endpoints are off without credentials', async () => {
  const s = createServer(createApp({}, { fetchImpl: null }));
  await new Promise((r) => s.listen(0, r));
  const u = `http://127.0.0.1:${s.address().port}`;
  const cfg = await (await fetch(`${u}/api/config`)).json();
  assert.equal(cfg.phone, false);
  assert.equal((await fetch(`${u}/api/token`, { method: 'POST', body: '{}' })).status, 501);
  s.close();
});

test('static files cannot escape the app folder', async () => {
  const r = await fetch(`${base}/..%2fpackage.json`);
  assert.notEqual(r.status, 200);
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test('phone tokens are refused when no password is configured', async () => {
  const { APP_PASSWORD, ...noPass } = ENV;
  const s = createServer(createApp(noPass, { fetchImpl: null }));
  await new Promise((r) => s.listen(0, r));
  const u = `http://127.0.0.1:${s.address().port}`;
  const r = await fetch(`${u}/api/token`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 503);
  s.close();
});

test('password guessing is throttled', async () => {
  const s = createServer(createApp(ENV, { fetchImpl: null }));
  await new Promise((r) => s.listen(0, r));
  const u = `http://127.0.0.1:${s.address().port}`;
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await fetch(`${u}/api/token`, { method: 'POST', body: JSON.stringify({ password: 'x' + i }) })).status);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
  assert.equal(codes[10], 429);
  s.close();
});
