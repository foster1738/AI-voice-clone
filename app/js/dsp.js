// Offline DSP helpers shared by the UI, the AI pipeline and the tests.

/**
 * YIN pitch track. Returns one f0 (Hz, 0 = unvoiced) per hop, with
 * `fps` frames per second, frame i centred at i * sr / fps.
 */
export function detectPitchTrack(signal, sr, fps = 100, { fmin = 50, fmax = 1100, threshold = 0.15 } = {}) {
  const hop = sr / fps;
  const frames = Math.floor(signal.length / hop) + 1;
  const tauMin = Math.max(2, Math.floor(sr / fmax));
  const tauMax = Math.ceil(sr / fmin);
  const W = Math.round(Math.max(0.025 * sr, tauMax));
  const d = new Float32Array(tauMax + 2);
  const out = new Float32Array(frames);
  for (let fr = 0; fr < frames; fr++) {
    const start = Math.round(fr * hop) - ((W + tauMax) >> 1);
    const at = (i) => {
      const j = start + i;
      return j >= 0 && j < signal.length ? signal[j] : 0;
    };
    let e = 0;
    for (let i = 0; i < W + tauMax; i++) e += at(i) * at(i);
    if (Math.sqrt(e / (W + tauMax)) < 0.004) continue;
    let running = 0;
    d[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let i = 0; i < W; i++) {
        const x = at(i) - at(i + tau);
        s += x * x;
      }
      running += s;
      d[tau] = running > 0 ? (s * tau) / running : 1;
    }
    let found = -1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (d[tau] < threshold) {
        while (tau + 1 < tauMax && d[tau + 1] < d[tau]) tau++;
        found = tau;
        break;
      }
    }
    if (found < 0) continue;
    let t = found;
    const a = d[found - 1];
    const b = d[found];
    const c = d[found + 1];
    const den = a + c - 2 * b;
    if (Math.abs(den) > 1e-9) t = found + (0.5 * (a - c)) / den;
    out[fr] = sr / t;
  }
  return medianSmooth(out, 3);
}

function medianSmooth(track, radius) {
  const out = new Float32Array(track.length);
  const win = [];
  for (let i = 0; i < track.length; i++) {
    if (track[i] === 0) continue;
    win.length = 0;
    for (let j = i - radius; j <= i + radius; j++) if (j >= 0 && j < track.length && track[j] > 0) win.push(track[j]);
    win.sort((a, b) => a - b);
    out[i] = win[win.length >> 1];
  }
  return out;
}

/** Band-limited resampling (windowed sinc). */
export function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return Float32Array.from(input);
  const ratio = toRate / fromRate;
  const outLen = Math.round(input.length * ratio);
  const out = new Float32Array(outLen);
  const cutoff = Math.min(1, ratio);
  const taps = 16;
  const half = Math.ceil(taps / cutoff);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const c = Math.floor(pos);
    let acc = 0;
    let norm = 0;
    for (let k = c - half + 1; k <= c + half; k++) {
      const x = (pos - k) * cutoff;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * (pos - k)) / (half + 1));
      const g = sinc * w;
      norm += g;
      if (k >= 0 && k < input.length) acc += input[k] * g;
    }
    out[i] = norm > 0 ? acc / norm : 0;
  }
  return out;
}

/** Mix any number of channels down to mono. */
export function toMono(channels) {
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
  return out;
}

export function peakNormalize(x, peak = 0.95) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (m < 1e-6) return x;
  const g = peak / m;
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

/** Encode float channels as a 16-bit PCM WAV ArrayBuffer. */
export function encodeWav(channels, sampleRate) {
  const nch = channels.length;
  const n = channels[0].length;
  const buf = new ArrayBuffer(44 + n * nch * 2);
  const v = new DataView(buf);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * nch * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nch * 2, true);
  v.setUint16(32, nch * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * nch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return buf;
}

/** Minimal 16-bit PCM WAV decoder (used where decodeAudioData is unavailable). */
export function decodeWavPcm(buf) {
  const v = new DataView(buf);
  let o = 12;
  let fmt = null;
  while (o + 8 <= v.byteLength) {
    const id = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { nch: v.getUint16(o + 10, true), sampleRate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    if (id === 'data' && fmt) {
      if (fmt.bits !== 16) throw new Error('Only 16-bit PCM WAV is supported');
      const n = size / 2 / fmt.nch;
      const channels = Array.from({ length: fmt.nch }, () => new Float32Array(n));
      for (let i = 0; i < n; i++) for (let c = 0; c < fmt.nch; c++) channels[c][i] = v.getInt16(o + 8 + (i * fmt.nch + c) * 2, true) / 32768;
      return { channels, sampleRate: fmt.sampleRate };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('Invalid WAV file');
}
