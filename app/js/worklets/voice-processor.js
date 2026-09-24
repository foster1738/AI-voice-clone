// Real-time voice transformation core (runs on the audio thread).
//
// Pitch-synchronous overlap-add (TD-PSOLA) with independent formant control:
//   * YIN pitch tracking decides voiced/unvoiced and the pitch period P.
//   * Grains of ~2 periods are taken from the input at pitch-synchronous
//     analysis marks and re-spaced at the target period, which changes pitch
//     without changing timing.
//   * Each grain is resampled by the formant factor, which moves the vocal
//     tract resonances independently of pitch (the thing that makes a
//     male<->female change sound like a person instead of a chipmunk).
//   * Output pitch can follow the input (ratio), be fixed (robot) or be
//     snapped to a musical scale (hard tune).
// Post stages: whisper (noise excitation) and bit crusher.

const RING = 1 << 15;
const MASK = RING - 1;

const SCALES = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
};

export class VoiceCore {
  constructor(sr) {
    this.sr = sr;
    this.inBuf = new Float32Array(RING);
    this.outBuf = new Float32Array(RING);
    this.wBuf = new Float32Array(RING);
    this.inPos = 0;
    this.outPos = 0;

    this.hMax = Math.round(0.02 * sr);
    this.srcMax = Math.round(0.02 * sr);
    this.latency = Math.round(0.05 * sr);
    this.nextMark = this.hMax;
    this.unvoicedP = Math.round(0.005 * sr);

    // Pitch tracker (YIN on a decimated signal).
    this.dec = sr >= 64000 ? 4 : sr >= 32000 ? 2 : 1;
    const dsr = sr / this.dec;
    this.yW = Math.round(0.016 * dsr);
    this.tauMin = Math.max(2, Math.floor(dsr / 1000));
    this.tauMax = Math.ceil(dsr / 65);
    this.yBuf = new Float32Array(this.yW + this.tauMax + 2);
    this.yDiff = new Float32Array(this.tauMax + 2);
    this.detectHop = Math.round(0.005 * sr);
    this.lastDetect = -Infinity;
    this.voiced = false;
    this.period = sr / 150;
    this.f0 = 0;
    this.level = 0;
    this.lastA = 0;
    this.lastVoiced = false;

    // Parameters
    this.pitchRatio = 1;
    this.formant = 1;
    this.mode = 'normal'; // normal | robot | tune
    this.robotHz = 110;
    this.tuneKey = 0;
    this.tuneScale = SCALES.chromatic;
    this.whisper = 0;
    this.crushBits = 0;
    this.crushDown = 1;
    this.crushHold = 0;
    this.crushCount = 0;
    this.gain = 1;
    this.bypass = false;
    this.rng = 0x12345678;
  }

  setParams(p) {
    if (p.pitch !== undefined) this.pitchRatio = Math.pow(2, p.pitch / 12);
    if (p.formant !== undefined) this.formant = Math.min(2, Math.max(0.5, p.formant));
    if (p.mode !== undefined) this.mode = p.mode;
    if (p.robotHz !== undefined) this.robotHz = Math.max(40, Math.min(800, p.robotHz));
    if (p.tuneKey !== undefined) this.tuneKey = ((p.tuneKey % 12) + 12) % 12;
    if (p.tuneScale !== undefined) this.tuneScale = SCALES[p.tuneScale] || SCALES.chromatic;
    if (p.whisper !== undefined) this.whisper = Math.min(1, Math.max(0, p.whisper));
    if (p.crushBits !== undefined) this.crushBits = p.crushBits;
    if (p.crushDown !== undefined) this.crushDown = Math.max(1, Math.round(p.crushDown));
    if (p.gain !== undefined) this.gain = p.gain;
    const passthrough =
      this.mode === 'normal' &&
      Math.abs(this.pitchRatio - 1) < 1e-4 &&
      Math.abs(this.formant - 1) < 1e-4;
    if (passthrough !== this.bypass) {
      this.bypass = passthrough;
      this.outBuf.fill(0);
      this.wBuf.fill(0);
      this.nextMark = this.outPos + this.hMax;
    }
  }

  _noise() {
    // xorshift32 -> [-1, 1)
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng / 2147483648 - 1;
  }

  _detect(center) {
    const { dec, yW, tauMax, tauMin, yBuf, yDiff, inBuf } = this;
    const n = yW + tauMax;
    const start = Math.round(center) - ((n * dec) >> 1);
    let energy = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      const base = start + i * dec;
      for (let d = 0; d < dec; d++) s += inBuf[(base + d) & MASK];
      s /= dec;
      yBuf[i] = s;
      energy += s * s;
    }
    const rms = Math.sqrt(energy / n);
    this.level = rms;
    if (rms < 0.004) {
      this.voiced = false;
      this.f0 = 0;
      return;
    }
    // Difference function + cumulative mean normalisation.
    yDiff[0] = 1;
    let running = 0;
    let found = -1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let i = 0; i < yW; i++) {
        const dlt = yBuf[i] - yBuf[i + tau];
        sum += dlt * dlt;
      }
      running += sum;
      yDiff[tau] = running > 0 ? (sum * tau) / running : 1;
    }
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (yDiff[tau] < 0.18) {
        while (tau + 1 < tauMax && yDiff[tau + 1] < yDiff[tau]) tau++;
        found = tau;
        break;
      }
    }
    if (found < 0) {
      this.voiced = false;
      this.f0 = 0;
      return;
    }
    let t = found;
    if (found > 1 && found < tauMax) {
      const a = yDiff[found - 1];
      const b = yDiff[found];
      const c = yDiff[found + 1];
      const den = a + c - 2 * b;
      if (Math.abs(den) > 1e-9) t = found + (0.5 * (a - c)) / den;
    }
    this.period = t * dec;
    this.f0 = this.sr / this.period;
    this.voiced = true;
  }

  _quantize(freq) {
    const midi = 69 + 12 * Math.log2(freq / 440);
    const base = Math.round(midi);
    for (let off = 0; off <= 6; off++) {
      for (const cand of off === 0 ? [base] : midi >= base ? [base + off, base - off] : [base - off, base + off]) {
        const pc = (((cand - this.tuneKey) % 12) + 12) % 12;
        if (this.tuneScale.includes(pc)) return 440 * Math.pow(2, (cand - 69) / 12);
      }
    }
    return freq;
  }

  _synth() {
    const target = this.nextMark - this.latency;
    if (target - this.lastDetect >= this.detectHop) {
      this._detect(target);
      this.lastDetect = target;
    }
    const f = this.formant;
    const voiced = this.voiced;
    let P;
    let S;
    if (voiced) {
      P = this.period;
      let tf;
      if (this.mode === 'robot') tf = this.robotHz;
      else {
        tf = (this.sr / P) * this.pitchRatio;
        if (this.mode === 'tune') tf = this._quantize(tf);
      }
      S = this.sr / Math.max(40, Math.min(1500, tf));
    } else {
      P = this.unvoicedP;
      S = P;
    }

    let a = target;
    if (voiced && this.lastVoiced && Math.abs(target - this.lastA) < 4 * P) {
      a = this.lastA + Math.round((target - this.lastA) / P) * P;
    } else if (!voiced) {
      a = target + (this._noise() * P) / 4; // decorrelate noise grains
    }

    // Voiced grains span exactly two source periods (classic PSOLA: lowering
    // the pitch leaves gaps between pulses, which is what a lower voice is).
    // Noise grains must tile without gaps.
    let H = voiced ? P / f : Math.max(P / f, S);
    H = Math.min(H, this.hMax, this.srcMax / f);
    H = Math.max(8, Math.round(H));
    const srcHalf = H * f;
    while (a + srcHalf + 2 > this.inPos) a -= P;

    const center = Math.round(this.nextMark);
    const inv = Math.PI / H;
    const { inBuf, outBuf, wBuf } = this;
    for (let j = -H; j <= H; j++) {
      const w = 0.5 + 0.5 * Math.cos(j * inv);
      const s = a + j * f;
      const si = Math.floor(s);
      const fr = s - si;
      const x0 = inBuf[si & MASK];
      const x = x0 + (inBuf[(si + 1) & MASK] - x0) * fr;
      const k = (center + j) & MASK;
      outBuf[k] += x * w;
      wBuf[k] += w;
    }
    this.lastA = a;
    this.lastVoiced = voiced;
    this.nextMark += S;
  }

  /** Process one block. `input` may be null (silence). Writes into `output`. */
  process(input, output) {
    const n = output.length;
    const { inBuf } = this;
    for (let i = 0; i < n; i++) inBuf[(this.inPos + i) & MASK] = input ? input[i] : 0;
    this.inPos += n;

    if (this.bypass) {
      for (let i = 0; i < n; i++) output[i] = inBuf[(this.outPos + i - this.latency) & MASK];
      const t = this.outPos - this.latency;
      if (t - this.lastDetect >= this.detectHop * 4) {
        this._detect(t);
        this.lastDetect = t;
      }
    } else {
      if (this.nextMark < this.outPos + this.hMax) this.nextMark = this.outPos + this.hMax;
      const horizon = this.outPos + n + this.hMax;
      while (this.nextMark < horizon) this._synth();
      const { outBuf, wBuf } = this;
      for (let i = 0; i < n; i++) {
        const k = (this.outPos + i) & MASK;
        const ws = wBuf[k];
        output[i] = ws > 0 ? outBuf[k] / Math.max(ws, 1) : 0;
        outBuf[k] = 0;
        wBuf[k] = 0;
      }
    }

    const wh = this.whisper;
    const bits = this.crushBits;
    const down = this.crushDown;
    const q = bits > 0 ? Math.pow(2, bits - 1) : 0;
    for (let i = 0; i < n; i++) {
      let y = output[i];
      if (wh > 0) y = y * (1 - wh) + y * this._noise() * 1.7 * wh;
      if (down > 1) {
        if (this.crushCount++ % down === 0) this.crushHold = y;
        y = this.crushHold;
      }
      if (q > 0) y = Math.round(y * q) / q;
      output[i] = y * this.gain;
    }
    this.outPos += n;
  }
}

// Registration only happens inside an AudioWorkletGlobalScope, so the core
// can be imported and unit-tested from Node.
if (typeof registerProcessor === 'function') {
  class VoiceProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.core = new VoiceCore(sampleRate);
      const init = options && options.processorOptions && options.processorOptions.params;
      if (init) this.core.setParams(init);
      this.reportEvery = Math.round(sampleRate / 128 / 20);
      this.blocks = 0;
      this.port.onmessage = (e) => {
        if (e.data && e.data.type === 'params') this.core.setParams(e.data.params);
      };
    }

    process(inputs, outputs) {
      const input = inputs[0] && inputs[0].length ? inputs[0][0] : null;
      const out = outputs[0];
      this.core.process(input, out[0]);
      for (let c = 1; c < out.length; c++) out[c].set(out[0]);
      if (++this.blocks % this.reportEvery === 0) {
        this.port.postMessage({ type: 'meter', f0: this.core.voiced ? this.core.f0 : 0, level: this.core.level });
      }
      return true;
    }
  }
  registerProcessor('voice-processor', VoiceProcessor);
}
