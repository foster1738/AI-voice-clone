// Runs AI voice conversion off the main thread so the UI stays responsive.
import { createBrowserConverter } from './ai.js';

let conv = null;
let loaded = { encoder: null, voice: null };

async function ensure(msg) {
  if (!conv) conv = await createBrowserConverter();
  if (msg.encoder && loaded.encoder !== msg.encoder.id) {
    await conv.loadEncoder(new Uint8Array(msg.encoder.bytes));
    loaded.encoder = msg.encoder.id;
  }
  if (msg.voice && loaded.voice !== msg.voice.id) {
    await conv.loadVoice(new Uint8Array(msg.voice.bytes));
    loaded.voice = msg.voice.id;
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'probe') {
      if (!conv) conv = await createBrowserConverter();
      self.postMessage({ type: 'probe', providers: conv.providers });
    } else if (msg.type === 'inspect') {
      await ensure({ voice: msg.voice });
      const v = conv.voice;
      self.postMessage({ type: 'inspect', id: msg.voice.id, usesF0: v.usesF0, dim: v.dim, inputs: v.session.inputNames });
    } else if (msg.type === 'convert') {
      await ensure(msg);
      const res = await conv.convert(msg.data, msg.sampleRate, {
        ...msg.options,
        onProgress: (p) => self.postMessage({ type: 'progress', value: p }),
      });
      self.postMessage({ type: 'done', audio: res.audio, sampleRate: res.sampleRate }, [res.audio.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
