// AI noise suppression: RNNoise (a recurrent neural network trained on speech
// and noise) compiled to WebAssembly. Operates on 10 ms frames at 48 kHz.
import createRNNWasmModuleSync from '../../vendor/rnnoise/rnnoise-sync.js';

const FRAME = 480;

class DenoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.enabled = opts.enabled !== undefined ? opts.enabled : true;
    this.mix = 1;
    this.ok = sampleRate === 48000;
    if (this.ok) {
      try {
        this.wasm = createRNNWasmModuleSync();
        this.ptr = this.wasm._malloc(FRAME * 4);
        this.state = this.wasm._rnnoise_create();
      } catch (err) {
        this.ok = false;
        this.port.postMessage({ type: 'error', message: String(err) });
      }
    }
    // FIFO in / FIFO out with one frame of latency.
    this.inFifo = new Float32Array(FRAME);
    this.dryFifo = new Float32Array(FRAME);
    this.outFifo = new Float32Array(FRAME);
    this.fill = 0;
    this.vad = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === 'params') {
        if (e.data.enabled !== undefined) this.enabled = e.data.enabled;
        if (e.data.mix !== undefined) this.mix = e.data.mix;
      }
    };
    this.port.postMessage({ type: 'ready', ok: this.ok });
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0].length ? inputs[0][0] : null;
    const out = outputs[0][0];
    if (!this.ok || !this.enabled) {
      if (input) out.set(input);
      for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
      return true;
    }
    for (let i = 0; i < out.length; i++) {
      const x = input ? input[i] : 0;
      this.inFifo[this.fill] = x;
      out[i] = this.outFifo[this.fill];
      this.fill++;
      if (this.fill === FRAME) {
        const heap = this.wasm.HEAPF32;
        const base = this.ptr >> 2;
        for (let j = 0; j < FRAME; j++) heap[base + j] = this.inFifo[j] * 32768;
        this.vad = this.wasm._rnnoise_process_frame(this.state, this.ptr, this.ptr);
        const h = this.wasm.HEAPF32;
        const m = this.mix;
        for (let j = 0; j < FRAME; j++) this.outFifo[j] = (h[base + j] / 32768) * m + this.inFifo[j] * (1 - m);
        this.fill = 0;
      }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}

registerProcessor('denoise-processor', DenoiseProcessor);
