// AI voice conversion (RVC architecture) running fully on-device with
// ONNX Runtime (WebGPU when available, WebAssembly otherwise).
//
// Pipeline, per chunk of audio:
//   16 kHz audio --ContentVec/HuBERT--> speech content features (50 fps, x2 -> 100 fps)
//   16 kHz audio --YIN--> f0 track (100 fps), shifted by the chosen key
//   (features, f0, speaker id, noise) --RVC synthesizer--> audio in the target voice
//
// Models are ordinary RVC exports ("Export Onnx" in RVC WebUI) plus a
// ContentVec encoder ONNX. The `ort` module is injected so the same code runs
// in the browser (onnxruntime-web) and in tests (onnxruntime-node).

import { detectPitchTrack, resample, peakNormalize } from './dsp.js';

const ORT_VERSION = '1.30.0';
const F0_MIN = 50;
const F0_MAX = 1100;
const MEL_MIN = 1127 * Math.log(1 + F0_MIN / 700);
const MEL_MAX = 1127 * Math.log(1 + F0_MAX / 700);

let ortPromise = null;

/** Load onnxruntime-web: bundled copy first (offline / desktop), then CDN. */
export function loadOrt() {
  if (!ortPromise) {
    ortPromise = (async () => {
      const local = new URL('../vendor/ort/', import.meta.url);
      const cdn = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
      let ort;
      let base;
      try {
        ort = await import(new URL('ort.all.min.mjs', local).href);
        base = local.href;
      } catch {
        ort = await import(`${cdn}ort.all.min.mjs`);
        base = cdn;
      }
      ort.env.wasm.wasmPaths = base;
      ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      return ort;
    })();
    ortPromise.catch(() => {
      ortPromise = null;
    });
  }
  return ortPromise;
}

export function coarsePitch(f0) {
  if (f0 <= 0) return 1;
  let mel = 1127 * Math.log(1 + f0 / 700);
  mel = ((mel - MEL_MIN) * 254) / (MEL_MAX - MEL_MIN) + 1;
  return Math.max(1, Math.min(255, Math.round(mel)));
}

function gaussian() {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

function dimsOf(meta) {
  return meta && Array.isArray(meta.shape) ? meta.shape : null;
}

export class AIConverter {
  constructor(ort, { providers } = {}) {
    this.ort = ort;
    this.providers = providers || ['wasm'];
    this.encoder = null;
    this.voice = null;
  }

  async _session(bytes) {
    const opts = { executionProviders: this.providers, graphOptimizationLevel: 'all' };
    try {
      return await this.ort.InferenceSession.create(bytes, opts);
    } catch (err) {
      if (!this.providers.includes('webgpu')) throw err;
      // WebGPU can reject some graphs; retry on the CPU backend.
      console.warn('WebGPU failed, using WebAssembly', err);
      return this.ort.InferenceSession.create(bytes, { ...opts, executionProviders: ['wasm'] });
    }
  }

  async loadEncoder(bytes) {
    const session = await this._session(bytes);
    this.encoder = { session, input: session.inputNames[0], output: session.outputNames[0] };
    return this.encoder;
  }

  async loadVoice(bytes) {
    const session = await this._session(bytes);
    const names = session.inputNames;
    const find = (...cands) => names.find((n) => cands.includes(n));
    const phone = find('phone', 'feats', 'hubert') || names[0];
    const v = {
      session,
      names: {
        phone,
        lengths: find('phone_lengths', 'p_len', 'lengths'),
        pitch: find('pitch'),
        pitchf: find('pitchf', 'nsff0'),
        sid: find('ds', 'sid'),
        rnd: find('rnd'),
      },
      output: session.outputNames[0],
      dim: null,
      sampleRate: null,
    };
    v.usesF0 = Boolean(v.names.pitch && v.names.pitchf);
    const meta = session.inputMetadata;
    if (meta) {
      const entry = Array.isArray(meta) ? meta.find((m) => m.name === phone) : meta[phone];
      const shape = dimsOf(entry);
      if (shape && typeof shape[2] === 'number') v.dim = shape[2];
    }
    this.voice = v;
    return v;
  }

  async _encode(x16) {
    const { Tensor } = this.ort;
    const { session, input, output } = this.encoder;
    let res;
    try {
      res = await session.run({ [input]: new Tensor('float32', x16, [1, 1, x16.length]) });
    } catch {
      res = await session.run({ [input]: new Tensor('float32', x16, [1, x16.length]) });
    }
    const t = res[output];
    const [, a, b] = t.dims;
    const approxFrames = x16.length / 320;
    const dim = this.voice.dim || (Math.abs(a - approxFrames) < Math.abs(b - approxFrames) ? b : a);
    // Normalise to frames x dim.
    let frames;
    let data;
    if (b === dim) {
      frames = a;
      data = t.data;
    } else {
      frames = b;
      data = new Float32Array(frames * dim);
      for (let d = 0; d < dim; d++) for (let f = 0; f < frames; f++) data[f * dim + d] = t.data[d * frames + f];
    }
    return { frames, dim, data };
  }

  async _synth(feat, f0, speakerId) {
    const { Tensor } = this.ort;
    const v = this.voice;
    const T = Math.min(feat.frames * 2, f0.length);
    const phone = new Float32Array(T * feat.dim);
    for (let t = 0; t < T; t++) {
      const src = Math.min(feat.frames - 1, t >> 1) * feat.dim;
      phone.set(feat.data.subarray(src, src + feat.dim), t * feat.dim);
    }
    const feeds = { [v.names.phone]: new Tensor('float32', phone, [1, T, feat.dim]) };
    if (v.names.lengths) feeds[v.names.lengths] = new Tensor('int64', BigInt64Array.from([BigInt(T)]), [1]);
    if (v.usesF0) {
      const coarse = new BigInt64Array(T);
      const fine = new Float32Array(T);
      for (let t = 0; t < T; t++) {
        fine[t] = f0[t];
        coarse[t] = BigInt(coarsePitch(f0[t]));
      }
      feeds[v.names.pitch] = new Tensor('int64', coarse, [1, T]);
      feeds[v.names.pitchf] = new Tensor('float32', fine, [1, T]);
    }
    if (v.names.sid) feeds[v.names.sid] = new Tensor('int64', BigInt64Array.from([BigInt(speakerId)]), [1]);
    if (v.names.rnd) {
      const rnd = new Float32Array(192 * T);
      for (let i = 0; i < rnd.length; i++) rnd[i] = gaussian();
      feeds[v.names.rnd] = new Tensor('float32', rnd, [1, 192, T]);
    }
    const out = (await v.session.run(feeds))[v.output];
    const audio = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data);
    if (!v.sampleRate) v.sampleRate = Math.round((audio.length / T) * 100);
    return audio;
  }

  /**
   * Convert mono audio into the loaded voice.
   * @returns {{audio: Float32Array, sampleRate: number}}
   */
  async convert(mono, sampleRate, { pitchShift = 0, speakerId = 0, chunkSeconds = 8, onProgress } = {}) {
    if (!this.encoder) throw new Error('Load a content encoder (ContentVec) first');
    if (!this.voice) throw new Error('Load an AI voice model first');
    const x16 = resample(mono, sampleRate, 16000);
    const ratio = Math.pow(2, pitchShift / 12);
    const f0All = detectPitchTrack(x16, 16000, 100).map((f) => (f > 0 ? Math.min(F0_MAX, f * ratio) : 0));

    // Chunks with context padding on both sides; results are cropped and
    // cross-faded so chunk borders are inaudible.
    const hop = 160;
    const chunk = Math.round((chunkSeconds * 16000) / hop) * hop;
    const pad = 0.4 * 16000;
    const xfFrames = 4; // 40 ms
    const pieces = [];
    let outRate = 0;
    for (let start = 0; start < x16.length; start += chunk) {
      const s0 = Math.max(0, start - pad);
      const e0 = Math.min(x16.length, start + chunk + pad + xfFrames * hop);
      const seg = x16.subarray(s0, e0);
      const frameOffset = s0 / hop;
      const f0 = f0All.subarray(frameOffset, frameOffset + Math.ceil(seg.length / hop));
      const feat = await this._encode(seg);
      const audio = await this._synth(feat, f0, speakerId);
      outRate = this.voice.sampleRate;
      const perFrame = outRate / 100;
      const keepFrom = Math.round(((start - s0) / hop) * perFrame);
      const keepLen = Math.round((Math.min(chunk + xfFrames * hop, x16.length - start) / hop) * perFrame);
      pieces.push(audio.subarray(keepFrom, Math.min(audio.length, keepFrom + keepLen)));
      if (onProgress) onProgress(Math.min(1, (start + chunk) / x16.length));
    }

    const xf = Math.round((xfFrames * hop * outRate) / 16000);
    const total = Math.round((x16.length / 16000) * outRate);
    const out = new Float32Array(total);
    const step = Math.round((chunk / 16000) * outRate);
    pieces.forEach((p, i) => {
      const at = i * step;
      for (let j = 0; j < p.length && at + j < total; j++) {
        let w = 1;
        if (i > 0 && j < xf) w = j / xf;
        if (i < pieces.length - 1 && j >= step) w = 1 - (j - step) / xf;
        out[at + j] += p[j] * Math.max(0, w);
      }
    });
    return { audio: peakNormalize(out, 0.9), sampleRate: outRate };
  }
}

export async function createBrowserConverter() {
  const ort = await loadOrt();
  const providers = [];
  if (navigator.gpu) {
    try {
      if (await navigator.gpu.requestAdapter()) providers.push('webgpu');
    } catch {
      /* no WebGPU */
    }
  }
  providers.push('wasm');
  return new AIConverter(ort, { providers });
}
