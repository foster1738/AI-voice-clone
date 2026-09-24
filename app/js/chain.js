// The effect chain. Built identically on a live AudioContext and on an
// OfflineAudioContext, so what you hear live is exactly what gets exported.
//
// input -> [AI denoise] -> highpass -> voice worklet -> EQ -> character filter
//   -> drive -> ring mod -> chorus -> echo -> reverb -> limiter -> output

import { DEFAULTS, paramsToWorklet } from './presets.js';

const WORKLETS = ['voice-processor.js', 'denoise-processor.js', 'recorder-processor.js'];

export async function loadWorklets(ctx) {
  const base = new URL('./worklets/', import.meta.url);
  for (const file of WORKLETS) {
    // Denoise needs 48 kHz; a failure there must not break the app.
    try {
      await ctx.audioWorklet.addModule(new URL(file, base));
    } catch (err) {
      if (file !== 'denoise-processor.js') throw err;
      console.warn('AI denoise unavailable', err);
    }
  }
}

const FILTERS = {
  none: { hp: 20, lp: 20000, q: 0.7 },
  telephone: { hp: 350, lp: 3400, q: 1.1 },
  radio: { hp: 450, lp: 4200, q: 1.4 },
  megaphone: { hp: 700, lp: 3300, q: 2.2 },
  underwater: { hp: 60, lp: 520, q: 2 },
  mask: { hp: 90, lp: 2600, q: 3 },
};

function driveCurve(amount) {
  const n = 2048;
  const curve = new Float32Array(n);
  const k = amount * 60;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = k > 0 ? ((1 + k) * x) / (1 + k * Math.abs(x)) : x;
  }
  return curve;
}

function impulse(ctx, seconds) {
  const len = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  let seed = 1;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x40000000 - 1;
  };
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = rnd() * Math.pow(1 - i / len, 3.5);
  }
  return buf;
}

export class VoiceChain {
  constructor(ctx, { denoise = true, params = {} } = {}) {
    this.ctx = ctx;
    this.params = { ...DEFAULTS, ...params };
    const g = (v = 1) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };

    this.input = g();
    try {
      // Initial settings go in processorOptions: port messages are delivered
      // asynchronously and would arrive after an offline render has started.
      this.denoise = new AudioWorkletNode(ctx, 'denoise-processor', {
        outputChannelCount: [1],
        processorOptions: { enabled: denoise },
      });
      this.denoiseOn = denoise;
    } catch {
      this.denoise = null;
    }
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 70;
    this.voice = new AudioWorkletNode(ctx, 'voice-processor', {
      outputChannelCount: [1],
      processorOptions: { params: paramsToWorklet(this.params) },
    });

    this.bass = ctx.createBiquadFilter();
    this.bass.type = 'lowshelf';
    this.bass.frequency.value = 180;
    this.mid = ctx.createBiquadFilter();
    this.mid.type = 'peaking';
    this.mid.Q.value = 0.9;
    this.treble = ctx.createBiquadFilter();
    this.treble.type = 'highshelf';
    this.treble.frequency.value = 4500;
    this.fHp = ctx.createBiquadFilter();
    this.fHp.type = 'highpass';
    this.fLp = ctx.createBiquadFilter();
    this.fLp.type = 'lowpass';

    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '2x';
    this.driveGain = g();

    // Ring modulator: y = x * ((1 - mix) + mix * sin(wt))
    this.ring = g();
    this.ringOsc = ctx.createOscillator();
    this.ringDepth = g(0);
    this.ringOsc.connect(this.ringDepth).connect(this.ring.gain);

    // Chorus / flanger
    this.chorusIn = g();
    this.chorusDry = g();
    this.chorusWet = g(0);
    this.chorusDelay = ctx.createDelay(0.1);
    this.chorusFb = g(0);
    this.chorusLfo = ctx.createOscillator();
    this.chorusLfoGain = g(0);
    this.chorusLfo.connect(this.chorusLfoGain).connect(this.chorusDelay.delayTime);
    this.chorusOut = g();
    this.chorusIn.connect(this.chorusDry).connect(this.chorusOut);
    this.chorusIn.connect(this.chorusDelay);
    this.chorusDelay.connect(this.chorusWet).connect(this.chorusOut);
    this.chorusDelay.connect(this.chorusFb).connect(this.chorusDelay);

    // Echo
    this.echoOut = g();
    this.echoDelay = ctx.createDelay(2);
    this.echoFb = g(0);
    this.echoWet = g(0);
    this.chorusOut.connect(this.echoOut);
    this.chorusOut.connect(this.echoDelay);
    this.echoDelay.connect(this.echoFb).connect(this.echoDelay);
    this.echoDelay.connect(this.echoWet).connect(this.echoOut);

    // Reverb
    this.revOut = g();
    this.revDry = g();
    this.revWet = g(0);
    this.convolver = ctx.createConvolver();
    this.revDecay = -1;
    this.echoOut.connect(this.revDry).connect(this.revOut);
    this.echoOut.connect(this.convolver);
    this.convolver.connect(this.revWet).connect(this.revOut);

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.15;
    this.output = g();

    let node = this.input;
    if (this.denoise) node = node.connect(this.denoise);
    node
      .connect(this.hp)
      .connect(this.voice)
      .connect(this.bass)
      .connect(this.mid)
      .connect(this.treble)
      .connect(this.fHp)
      .connect(this.fLp)
      .connect(this.driveGain)
      .connect(this.shaper)
      .connect(this.ring)
      .connect(this.chorusIn);
    this.revOut.connect(this.limiter).connect(this.output);

    this.ringOsc.start();
    this.chorusLfo.start();
    this.set(this.params);
  }

  setDenoise(enabled) {
    if (this.denoise) this.denoise.port.postMessage({ type: 'params', enabled });
    this.denoiseOn = enabled;
  }

  /** The dry recording tap: after denoise, before the voice effects. */
  get dryTap() {
    return this.hp;
  }

  set(params) {
    const p = { ...this.params, ...params };
    this.params = p;
    const t = this.ctx.currentTime;
    const ramp = (param, v) => param.setTargetAtTime(v, t, 0.02);

    this.voice.port.postMessage({ type: 'params', params: paramsToWorklet(p) });
    ramp(this.bass.gain, p.bass);
    ramp(this.mid.gain, p.mid);
    ramp(this.mid.frequency, p.midHz);
    ramp(this.treble.gain, p.treble);
    const f = FILTERS[p.filter] || FILTERS.none;
    ramp(this.fHp.frequency, f.hp);
    ramp(this.fLp.frequency, f.lp);
    this.fHp.Q.value = f.q;
    this.fLp.Q.value = f.q;

    if (this._drive !== p.drive) {
      this._drive = p.drive;
      this.shaper.curve = p.drive > 0 ? driveCurve(p.drive) : null;
      this.driveGain.gain.value = 1;
    }
    ramp(this.ring.gain, 1 - p.ringMix);
    ramp(this.ringDepth.gain, p.ringMix);
    ramp(this.ringOsc.frequency, p.ringHz);

    ramp(this.chorusWet.gain, p.chorusMix);
    ramp(this.chorusDry.gain, 1 - p.chorusMix * 0.5);
    ramp(this.chorusDelay.delayTime, p.chorusDelay / 1000);
    ramp(this.chorusLfo.frequency, p.chorusRate);
    ramp(this.chorusLfoGain.gain, p.chorusDepth / 1000);
    ramp(this.chorusFb.gain, p.chorusFeedback);

    ramp(this.echoWet.gain, p.echoMix);
    ramp(this.echoDelay.delayTime, p.echoTime);
    ramp(this.echoFb.gain, p.echoFeedback);

    if (p.reverbMix > 0 && Math.abs(this.revDecay - p.reverbDecay) > 0.05) {
      this.revDecay = p.reverbDecay;
      this.convolver.buffer = impulse(this.ctx, p.reverbDecay);
    }
    ramp(this.revWet.gain, p.reverbMix * 0.8);
    ramp(this.revDry.gain, 1 - p.reverbMix * 0.4);
    ramp(this.output.gain, p.volume);
  }

  /** Worklet processing latency in seconds (to trim exports). */
  get latency() {
    return 0.05 + (this.denoise && this.denoiseOn && this.ctx.sampleRate === 48000 ? 480 / 48000 : 0);
  }
}
