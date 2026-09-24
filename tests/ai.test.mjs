import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import { AIConverter, coarsePitch } from '../app/js/ai.js';
import { detectPitchTrack } from '../app/js/dsp.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

function hum(f0, seconds, sr) {
  const x = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    x[i] = 0.3 * Math.sin(2 * Math.PI * f0 * t) + 0.15 * Math.sin(4 * Math.PI * f0 * t) + 0.08 * Math.sin(6 * Math.PI * f0 * t);
  }
  return x;
}

test('coarse pitch matches the RVC mel quantisation', () => {
  assert.equal(coarsePitch(0), 1);
  assert.equal(coarsePitch(50), 1);
  assert.equal(coarsePitch(1100), 255);
  const mid = coarsePitch(220);
  assert.ok(mid > 50 && mid < 150);
});

test('RVC pipeline: chunking, key shift and output rate', async () => {
  const conv = new AIConverter(ort, { providers: ['cpu'] });
  await conv.loadEncoder(new Uint8Array(fixture('encoder_stub.onnx')));
  const v = await conv.loadVoice(new Uint8Array(fixture('voice_stub.onnx')));
  assert.equal(v.usesF0, true);

  const sr = 44100;
  const input = hum(150, 7.3, sr); // longer than one chunk, odd length
  let progress = 0;
  const { audio, sampleRate } = await conv.convert(input, sr, {
    pitchShift: 12,
    chunkSeconds: 2,
    onProgress: (p) => (progress = p),
  });
  assert.equal(sampleRate, 40000);
  assert.equal(progress, 1);
  assert.ok(Math.abs(audio.length / sampleRate - 7.3) < 0.02, `duration ${audio.length / sampleRate}`);
  const track = Array.from(detectPitchTrack(audio, sampleRate, 50)).filter((f) => f > 0);
  track.sort((a, b) => a - b);
  const med = track[track.length >> 1];
  assert.ok(Math.abs(med - 300) < 6, `median ${med}`);
  // Chunk borders must not produce clicks.
  let maxJump = 0;
  for (let i = 1; i < audio.length; i++) maxJump = Math.max(maxJump, Math.abs(audio[i] - audio[i - 1]));
  assert.ok(maxJump < 0.2, `jump ${maxJump}`);
});
