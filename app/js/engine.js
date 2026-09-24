// Owns the live AudioContext: microphone, monitoring, recording, previews
// and offline rendering through the same VoiceChain.

import { VoiceChain, loadWorklets } from './chain.js';

export class Engine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.chain = null;
    this.stream = null;
    this.micSource = null;
    this.preview = null;
    this.monitor = false;
    this.recording = null;
    this.params = null;
    this.denoise = true;
    this.ownsStream = false;
    this.inCall = false;
    this.callDest = null;
  }

  async init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    try {
      this.ctx = new Ctx({ sampleRate: 48000, latencyHint: 'interactive' });
    } catch {
      this.ctx = new Ctx({ latencyHint: 'interactive' });
    }
    await loadWorklets(this.ctx);
    this.chain = new VoiceChain(this.ctx, { denoise: this.denoise, params: this.params || {} });

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;
    this.monitorGain = this.ctx.createGain();
    this.monitorGain.gain.value = 0;
    this.chain.output.connect(this.analyser);
    this.chain.output.connect(this.monitorGain).connect(this.ctx.destination);

    this.recorder = new AudioWorkletNode(this.ctx, 'recorder-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.chain.dryTap.connect(this.recorder);
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.recorder.connect(sink).connect(this.ctx.destination);
    this.recorder.port.onmessage = (e) => this._onRecorder(e.data);

    this.chain.voice.port.onmessage = (e) => {
      if (e.data.type === 'meter') this.dispatchEvent(new CustomEvent('meter', { detail: e.data }));
    };
    if (this.chain.denoise) {
      this.chain.denoise.port.onmessage = (e) => {
        if (e.data.type === 'ready') this.dispatchEvent(new CustomEvent('denoise', { detail: e.data }));
      };
    }
  }

  async resume() {
    await this.init();
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 48000;
  }

  setParams(params) {
    this.params = params;
    if (this.chain) this.chain.set(params);
  }

  setDenoise(on) {
    this.denoise = on;
    if (this.chain) this.chain.setDenoise(on);
  }

  setMonitor(on) {
    this.monitor = on;
    this._applyMonitor();
  }

  _applyMonitor() {
    if (!this.monitorGain) return;
    const on = this.monitor || Boolean(this.preview);
    this.monitorGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.015);
  }

  async startMic({ deviceId, noiseSuppression = true, echoCancellation = false, autoGainControl = false } = {}) {
    await this.resume();
    this.stopMic();
    this.stopPreview();
    // iOS 17+: keep playback on the loudspeaker while the mic is open.
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'play-and-record';
    } catch {
      /* not supported */
    }
    const audio = {
      echoCancellation,
      noiseSuppression,
      autoGainControl,
      channelCount: 1,
      latency: 0,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    this._attach(stream, true);
  }

  /** Use a microphone stream opened by someone else (e.g. the phone-call SDK). */
  async attachStream(stream) {
    await this.resume();
    this.stopMic();
    this.stopPreview();
    this._attach(stream, false);
  }

  _attach(stream, owned) {
    this.stream = stream;
    this.ownsStream = owned;
    this.micSource = this.ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.chain.input);
    this.dispatchEvent(new Event('mic'));
  }

  stopMic() {
    if (this.micSource) this.micSource.disconnect();
    if (this.stream && this.ownsStream) this.stream.getTracks().forEach((t) => t.stop());
    this.micSource = null;
    this.stream = null;
    try {
      if (navigator.audioSession && !this.inCall) navigator.audioSession.type = 'playback';
    } catch {
      /* not supported */
    }
    this.dispatchEvent(new Event('mic'));
  }

  /** The changed voice as a MediaStream, ready to send into a call. */
  async callStream() {
    await this.init();
    if (!this.callDest) {
      this.callDest = this.ctx.createMediaStreamDestination();
      this.callDest.channelCount = 1;
      this.chain.output.connect(this.callDest);
    }
    return this.callDest.stream;
  }

  get micOn() {
    return Boolean(this.stream);
  }

  startRecording() {
    this.recording = { chunks: [], resolve: null };
    this.recorder.port.postMessage('start');
  }

  stopRecording() {
    return new Promise((resolve) => {
      if (!this.recording) return resolve(null);
      this.recording.resolve = resolve;
      this.recorder.port.postMessage('stop');
    });
  }

  _onRecorder(msg) {
    if (!this.recording) return;
    if (msg.type === 'chunk') this.recording.chunks.push(msg.data);
    if (msg.type === 'stopped') {
      const { chunks, resolve } = this.recording;
      this.recording = null;
      const n = chunks.reduce((a, c) => a + c.length, 0);
      const data = new Float32Array(n);
      let o = 0;
      for (const c of chunks) {
        data.set(c, o);
        o += c.length;
      }
      resolve({ data, sampleRate: this.ctx.sampleRate });
    }
  }

  /** Play mono audio. `withVoice` routes it through the effect chain. */
  async play(data, sampleRate, { withVoice = true, onEnded } = {}) {
    if (this.inCall) throw new Error('Playback is paused during a call.');
    await this.resume();
    this.stopPreview();
    if (this.micOn) this.stopMic();
    const buf = this.ctx.createBuffer(1, data.length, sampleRate);
    buf.copyToChannel(data, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    if (withVoice) {
      src.connect(this.chain.input);
    } else {
      this._rawGain = this.ctx.createGain();
      src.connect(this._rawGain).connect(this.ctx.destination);
      src.connect(this.analyser);
    }
    this.preview = { src, withVoice };
    this._applyMonitor();
    src.onended = () => {
      if (this.preview && this.preview.src === src) {
        this.preview = null;
        this._applyMonitor();
      }
      src.disconnect();
      if (onEnded) onEnded();
    };
    src.start();
  }

  stopPreview() {
    if (this.preview) {
      const { src } = this.preview;
      this.preview = null;
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      this._applyMonitor();
    }
  }

  async setOutputDevice(id) {
    await this.init();
    if (typeof this.ctx.setSinkId === 'function') await this.ctx.setSinkId(id || '');
  }

  /** Render mono audio through the chain offline. Returns stereo channels. */
  async render(data, sampleRate, params, { denoise = this.denoise } = {}) {
    const tail = 2.5;
    const sr = sampleRate;
    const length = data.length + Math.round(tail * sr);
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new Offline(2, length, sr);
    await loadWorklets(off);
    const chain = new VoiceChain(off, { denoise: denoise && sr === 48000, params });
    const buf = off.createBuffer(1, data.length, sr);
    buf.copyToChannel(data, 0);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(chain.input);
    chain.output.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    const skip = Math.round(chain.latency * sr);
    const chans = [rendered.getChannelData(0), rendered.getChannelData(1)];
    // Trim latency and trailing silence.
    let end = length;
    const floor = 1e-4;
    while (end > skip + data.length && Math.abs(chans[0][end - 1]) < floor && Math.abs(chans[1][end - 1]) < floor) end--;
    return { channels: chans.map((c) => c.slice(skip, end)), sampleRate: sr };
  }
}
