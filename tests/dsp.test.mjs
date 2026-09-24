import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCore } from '../app/js/worklets/voice-processor.js';
import { detectPitchTrack, encodeWav, decodeWavPcm } from '../app/js/dsp.js';

const SR = 48000;

// Glottal-ish pulse train with two formant-like resonances: a crude vowel.
function vowel(f0, seconds, sr = SR) {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  let phase = 0;
  const res = [
    [700, 0.995],
    [1200, 0.993],
  ].map(([f, r]) => ({ c: 2 * r * Math.cos((2 * Math.PI * f) / sr), r2: r * r, y1: 0, y2: 0 }));
  for (let i = 0; i < n; i++) {
    phase += f0 / sr;
    let x = 0;
    if (phase >= 1) {
      phase -= 1;
      x = 1;
    }
    let y = 0;
    for (const f of res) {
      const v = x + f.c * f.y1 - f.r2 * f.y2;
      f.y2 = f.y1;
      f.y1 = v;
      y += v;
    }
    out[i] = y;
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * 0.5;
  return out;
}

function run(core, signal) {
  const out = new Float32Array(signal.length);
  const block = new Float32Array(128);
  for (let i = 0; i + 128 <= signal.length; i += 128) {
    core.process(signal.subarray(i, i + 128), block);
    out.set(block, i);
  }
  return out;
}

function medianPitch(sig, sr = SR) {
  const track = detectPitchTrack(sig, sr, 100).filter((f) => f > 0);
  track.sort((a, b) => a - b);
  return track[Math.floor(track.length / 2)];
}

test('pitch tracker finds the fundamental', () => {
  const f = medianPitch(vowel(140, 1));
  assert.ok(Math.abs(f - 140) < 3, `got ${f}`);
});

test('shifts pitch up an octave', () => {
  const core = new VoiceCore(SR);
  core.setParams({ pitch: 12 });
  const out = run(core, vowel(120, 1.5)).subarray(SR * 0.3);
  const f = medianPitch(out);
  assert.ok(Math.abs(f - 240) < 8, `got ${f}`);
});

test('shifts pitch down five semitones', () => {
  const core = new VoiceCore(SR);
  core.setParams({ pitch: -5 });
  const out = run(core, vowel(220, 1.5)).subarray(SR * 0.3);
  const f = medianPitch(out);
  const want = 220 * Math.pow(2, -5 / 12);
  assert.ok(Math.abs(f - want) < 6, `got ${f} want ${want}`);
});

test('formant shift keeps pitch', () => {
  const core = new VoiceCore(SR);
  core.setParams({ formant: 1.3 });
  const out = run(core, vowel(150, 1.5)).subarray(SR * 0.3);
  const f = medianPitch(out);
  assert.ok(Math.abs(f - 150) < 5, `got ${f}`);
});

test('robot mode flattens to a fixed pitch', () => {
  const core = new VoiceCore(SR);
  core.setParams({ mode: 'robot', robotHz: 100 });
  const out = run(core, vowel(180, 1.5)).subarray(SR * 0.3);
  const f = medianPitch(out);
  assert.ok(Math.abs(f - 100) < 4, `got ${f}`);
});

test('tune mode snaps to the nearest semitone', () => {
  const core = new VoiceCore(SR);
  core.setParams({ mode: 'tune', tuneScale: 'chromatic' });
  const out = run(core, vowel(452, 1.5)).subarray(SR * 0.3); // between A4 and A#4, closer to A4
  const f = medianPitch(out);
  assert.ok(Math.abs(f - 440) < 6, `got ${f}`);
});

test('output stays bounded and finite', () => {
  const core = new VoiceCore(SR);
  core.setParams({ pitch: 7, formant: 1.4, whisper: 0.3, crushBits: 6, crushDown: 3 });
  const noise = new Float32Array(SR).map(() => Math.random() - 0.5);
  const out = run(core, noise);
  for (const v of out) assert.ok(Number.isFinite(v) && Math.abs(v) < 4);
});

test('bypass is a pure delay', () => {
  const core = new VoiceCore(SR);
  core.setParams({ pitch: 0, formant: 1 });
  const sig = vowel(200, 0.5);
  const out = run(core, sig);
  const L = core.latency;
  for (let i = L; i < 10000; i++) assert.equal(out[i], sig[i - L]);
});

test('wav round trip', () => {
  const sig = vowel(200, 0.2);
  const wav = encodeWav([sig, sig], SR);
  const { channels, sampleRate } = decodeWavPcm(wav);
  assert.equal(sampleRate, SR);
  assert.equal(channels.length, 2);
  assert.ok(Math.abs(channels[0][500] - sig[500]) < 1e-3);
});

test('formant shift raises the spectral centroid', () => {
  const centroid = (x) => {
    // crude: zero-crossing rate is proportional to the dominant resonance
    let z = 0;
    for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) z++;
    return z / x.length;
  };
  const src = vowel(130, 1.5);
  const up = new VoiceCore(SR);
  up.setParams({ formant: Math.pow(2, 5 / 12) });
  const down = new VoiceCore(SR);
  down.setParams({ formant: Math.pow(2, -5 / 12) });
  const a = centroid(run(up, src).subarray(SR * 0.3));
  const b = centroid(run(down, src).subarray(SR * 0.3));
  const c = centroid(src.subarray(SR * 0.3));
  assert.ok(a > c * 1.15 && b < c * 0.9, `up ${a} base ${c} down ${b}`);
});

test('octave down keeps a clean fundamental', () => {
  const core = new VoiceCore(SR);
  core.setParams({ pitch: -12 });
  const out = run(core, vowel(240, 1.5)).subarray(SR * 0.3);
  const f = medianPitch(out);
  assert.ok(Math.abs(f - 120) < 5, `got ${f}`);
});
