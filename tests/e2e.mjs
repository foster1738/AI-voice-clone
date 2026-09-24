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
const server = spawn(process.execPath, [fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url))], {
  env: { ...process.env, PORT: String(port) },
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
