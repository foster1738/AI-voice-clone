// End-to-end smoke test in real Chromium with a fake microphone.
//   node tests/e2e.mjs [--shots dir]
// Starts the dev server, feeds a synthetic voice into the mic, and drives the
// app: live mode, presets, recording, export, and AI conversion (stub models).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { encodeWav, decodeWavPcm, detectPitchTrack } from '../app/js/dsp.js';
import { loadPlaywright } from '../scripts/playwright.mjs';

function medianOf(track) {
  const v = Array.from(track).filter((f) => f > 0).sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : 0;
}

const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

const tmp = mkdtempSync(join(tmpdir(), 'voxmorph-'));
const sr = 48000;
const voice = new Float32Array(sr * 6);
let ph = 0;
for (let i = 0; i < voice.length; i++) {
  const f0 = 140 + 8 * Math.sin((2 * Math.PI * i) / sr);
  ph += f0 / sr;
  const syl = 0.5 + 0.5 * Math.sin((2 * Math.PI * 2 * i) / sr);
  voice[i] = syl * 0.25 * (Math.sin(2 * Math.PI * ph) + 0.5 * Math.sin(4 * Math.PI * ph) + 0.3 * Math.sin(6 * Math.PI * ph) + 0.2 * Math.sin(10 * Math.PI * ph));
}
const micWav = join(tmp, 'mic.wav');
writeFileSync(micWav, Buffer.from(encodeWav([voice], sr)));

const port = 8765;
// Fake Twilio credentials: enough for the server to hand out tokens. The
// Twilio SDK itself is replaced by a stand-in inside the page.
const server = spawn(process.execPath, [fileURLToPath(new URL('../server/index.mjs', import.meta.url))], {
  env: {
    ...process.env,
    PORT: String(port),
    TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
    TWILIO_API_KEY: 'SK00000000000000000000000000000000',
    TWILIO_API_SECRET: 'secret',
    TWILIO_TWIML_APP_SID: 'AP00000000000000000000000000000000',
    TWILIO_CALLER_ID: '+15550001111',
    APP_PASSWORD: 'e2e-pass',
  },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 600));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micWav}`, '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
await context.grantPermissions(['microphone']);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

let step = '';
const ok = (s) => console.log('  ✓', s);
try {
  step = 'load';
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('.preset');
  ok(`${await page.locator('.preset').count()} voice presets rendered`);
  if (shots) await page.screenshot({ path: join(shots, '1-home.png') });

  step = 'live';
  await page.click('#liveBtn');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Live');
  await page.waitForFunction(() => /Hz/.test(document.querySelector('#pitchOut').textContent), null, { timeout: 8000 });
  const pitchText = await page.textContent('#pitchOut');
  const hz = parseInt(pitchText, 10);
  assert.ok(hz > 120 && hz < 160, `live pitch readout ${pitchText}`);
  ok(`live mic running, pitch readout "${pitchText}"`);
  const denoise = await page.textContent('#denoiseOut');
  assert.equal(denoise, 'On', 'AI denoise loaded');
  ok('AI noise suppression (RNNoise WASM) active');

  step = 'preset';
  await page.click('.preset[data-id="robot"]');
  assert.equal(await page.textContent('#voiceName'), 'Robot');
  await page.click('#monitorBtn');
  ok('preset switch + monitor');
  if (shots) await page.screenshot({ path: join(shots, '2-live.png') });

  step = 'voice-match';
  await page.evaluate(() => window.voxmorph.setProfile(120));
  await page.click('.preset[data-id="feminine"]');
  const params = await page.evaluate(() => window.voxmorph.engine.params);
  assert.equal(params.pitch, 10, 'smart preset retargets from 120 Hz to 215 Hz');
  ok(`Voice Match retargets smart presets (pitch ${params.pitch} st, formant ${params.formant})`);

  step = 'record';
  await page.click('#recBtn');
  await page.waitForTimeout(2500);
  await page.click('#recBtn');
  await page.click('[data-go=studio]');
  await page.waitForSelector('.take');
  ok('recorded a take into Studio');

  step = 'export';
  await page.click('.preset[data-id="natural"]').catch(() => {});
  await page.evaluate(() => window.voxmorph.selectPreset('deep'));
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.take [data-a=export]')]);
  const path = await download.path();
  const { channels, sampleRate } = decodeWavPcm(readFileSync(path).buffer);
  assert.equal(channels.length, 2);
  const secs = channels[0].length / sampleRate;
  assert.ok(secs > 2 && secs < 5, `export duration ${secs}`);
  const track = Array.from(detectPitchTrack(channels[0], sampleRate, 50)).filter((f) => f > 0).sort((a, b) => a - b);
  const med = track[track.length >> 1];
  // Profile says 120 Hz and Deep targets 95 Hz -> about -4 st from the 140 Hz input = ~111 Hz.
  assert.ok(med > 95 && med < 125, `exported pitch ${med}`);
  ok(`exported ${download.suggestedFilename()} (${secs.toFixed(1)} s, pitch ${med.toFixed(0)} Hz from 140 Hz input)`);
  if (shots) await page.screenshot({ path: join(shots, '3-studio.png') });

  step = 'ai';
  await page.click('[data-go=ai]');
  await page.waitForFunction(() => /WebGPU|CPU/.test(document.querySelector('#aiBackend').textContent), null, { timeout: 30000 });
  ok(`AI runtime loaded: ${await page.textContent('#aiBackend')}`);
  const fx = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
  await page.setInputFiles('#encoderFile', fx('encoder_stub.onnx'));
  await page.waitForFunction(() => /encoder_stub/.test(document.querySelector('#encoderInfo').textContent));
  await page.setInputFiles('#voiceFile', fx('voice_stub.onnx'));
  await page.waitForSelector('.voice');
  if (shots) await page.screenshot({ path: join(shots, '4-ai.png') });
  await page.click('[data-go=studio]');
  const before = await page.locator('.take').count();
  await page.locator('.take [data-a=ai]').first().click();
  await page.waitForFunction((n) => document.querySelectorAll('.take').length > n, before, { timeout: 60000 });
  const kind = await page.locator('.take .kind').first().textContent();
  assert.match(kind, /AI/);
  ok(`AI conversion produced a new take (${kind.trim()})`);


  step = 'phone-call';
  // Stand-in for the Twilio SDK that honours the AudioProcessor contract:
  // it hands the processor a mic stream and "sends" whatever comes back.
  await page.evaluate(() => {
    class FakeCall extends EventTarget {
      constructor(params) {
        super();
        this.parameters = params;
        this.muted = false;
      }
      on(ev, fn) {
        this.addEventListener(ev, () => fn());
      }
      mute(m) {
        this.muted = m;
      }
      sendDigits(d) {
        window.__digits = (window.__digits || '') + d;
      }
      disconnect() {
        window.__processor.destroyProcessedStream(window.__sent);
        this.dispatchEvent(new Event('disconnect'));
      }
    }
    class FakeDevice {
      constructor(token) {
        window.__token = token;
        this.audio = { addProcessor: async (p) => (window.__processor = p) };
      }
      on() {}
      async register() {}
      async connect({ params }) {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        window.__sent = await window.__processor.createProcessedStream(mic);
        const call = new FakeCall(params);
        window.__call = call;
        setTimeout(() => call.dispatchEvent(new Event('accept')), 100);
        return call;
      }
    }
    window.Twilio = { Device: FakeDevice };
  });
  await page.click('[data-go=calls]');
  await page.evaluate(() => (document.querySelector('#serverCard').open = true));
  await page.fill('#serverPass', 'e2e-pass');
  await page.click('#serverBtn');
  await page.waitForFunction(() => /phone calls on/.test(document.querySelector('#serverState').textContent));
  await page.evaluate(() => {
    window.voxmorph.state.profile = null;
    window.voxmorph.selectPreset('deep');
  });
  await page.fill('#dialInput', '+1 415 555 0123');
  await page.click('#dialBtn');
  await page.waitForFunction(() => /On call/.test(document.querySelector('#callState').textContent));
  const phone = await page.evaluate(async () => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const an = ctx.createAnalyser();
    an.fftSize = 32768;
    ctx.createMediaStreamSource(window.__sent).connect(an);
    await new Promise((r) => setTimeout(r, 1500));
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    return { samples: Array.from(buf), to: window.__call.parameters.To, token: window.__token.split('.').length };
  });
  const phonePitch = medianOf(detectPitchTrack(Float32Array.from(phone.samples), 48000, 100));
  assert.equal(phone.to, '+14155550123');
  assert.equal(phone.token, 3);
  // Deep Voice without calibration is -5 st: 140 Hz -> ~105 Hz.
  assert.ok(phonePitch > 92 && phonePitch < 118, `phone call pitch ${phonePitch}`);
  ok(`phone call: caller hears the changed voice (${phonePitch.toFixed(0)} Hz from 140 Hz mic)`);
  await page.click('#keypadBtn');
  await page.click('#keypad button:nth-child(5)');
  assert.equal(await page.evaluate(() => window.__digits), '5');
  if (shots) await page.screenshot({ path: join(shots, '5-call.png') });
  await page.click('#hangBtn');
  await page.waitForFunction(() => document.querySelector('#callCard').hidden);
  ok('keypad tones + hang up');

  step = 'app-to-app-call';
  const page2 = await context.newPage();
  page2.on('pageerror', (e) => errors.push('page2: ' + e.message));
  await page2.goto(`http://localhost:${port}/`);
  await page2.waitForSelector('.preset');
  await page.evaluate(() => window.voxmorph.selectPreset('chipmunk'));
  await page.evaluate(() => navigator.clipboard.writeText = async () => {});
  await page.click('#newRoomBtn');
  await page.waitForFunction(() => window.voxmorph.calls.p2p);
  const link = await page.evaluate(() => window.voxmorph.calls.roomLink(window.voxmorph.calls.p2p.room));
  await page2.goto(link);
  await page2.waitForFunction(() => document.querySelector('#roomInput').value.length > 0);
  await page2.click('#joinBtn');
  for (const p of [page, page2]) await p.waitForFunction(() => /On call/.test(document.querySelector('#callState').textContent), null, { timeout: 20000 });
  const heard = await page2.evaluate(async () => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const an = ctx.createAnalyser();
    an.fftSize = 32768;
    ctx.createMediaStreamSource(window.voxmorph.calls.remoteAudio.srcObject).connect(an);
    await new Promise((r) => setTimeout(r, 2500));
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    return Array.from(buf);
  });
  const p2pPitch = medianOf(detectPitchTrack(Float32Array.from(heard), 48000, 100));
  // Chipmunk is +10 st: 140 Hz -> ~250 Hz.
  assert.ok(p2pPitch > 220 && p2pPitch < 280, `app-to-app pitch ${p2pPitch}`);
  ok(`app-to-app WebRTC call: other person hears ${p2pPitch.toFixed(0)} Hz (Chipmunk) from a 140 Hz mic`);
  await page.click('#hangBtn');
  await page2.waitForFunction(() => /Waiting/.test(document.querySelector('#callState').textContent), null, { timeout: 10000 });
  await page2.click('#hangBtn');
  ok('hang up on both ends');

  step = 'errors';
  const real = errors.filter((e) => !/favicon/.test(e));
  assert.deepEqual(real, [], 'no console errors');
  ok('no console errors');
  console.log('\nE2E PASSED');
} catch (err) {
  console.error(`\nE2E FAILED at step "${step}":`, err.message);
  if (errors.length) console.error('page errors:', errors);
  if (shots) await page.screenshot({ path: join(shots, 'failure.png') });
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
