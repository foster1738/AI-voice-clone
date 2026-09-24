// Captures whatever is connected to it and ships chunks to the main thread.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.chunk = new Float32Array(4096);
    this.fill = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') {
        this.recording = true;
        this.fill = 0;
      } else if (e.data === 'stop') {
        this.recording = false;
        this.port.postMessage({ type: 'chunk', data: this.chunk.slice(0, this.fill) });
        this.fill = 0;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0] && inputs[0].length ? inputs[0][0] : null;
    const n = 128;
    for (let i = 0; i < n; i++) {
      this.chunk[this.fill++] = input ? input[i] : 0;
      if (this.fill === this.chunk.length) {
        this.port.postMessage({ type: 'chunk', data: this.chunk });
        this.chunk = new Float32Array(4096);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
