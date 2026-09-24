import { Engine } from './engine.js';
import { PRESETS, DEFAULTS, resolveParams } from './presets.js';
import { store, requestPersistence } from './storage.js';
import { encodeWav, toMono, detectPitchTrack } from './dsp.js';
import { Calls, randomId } from './calls.js';

const VERSION = '1.0.0';
const $ = (s) => document.querySelector(s);
const engine = new Engine();

// ---------- persisted state ----------
const ls = {
  get(k, d) {
    try {
      const v = localStorage.getItem('vm.' + k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('vm.' + k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};

const state = {
  presetId: ls.get('preset', 'natural'),
  overrides: {},
  custom: ls.get('custom', []),
  profile: ls.get('profile', null),
  category: 'All',
  settings: ls.get('settings', { input: '', output: '', aiDenoise: true, browserNs: false, echo: false }),
  ai: ls.get('ai', { pitch: 0, speaker: 0, voice: null }),
};

function allPresets() {
  return [...state.custom.map((c) => ({ ...c, cat: 'Mine' })), ...PRESETS];
}

function currentPreset() {
  return allPresets().find((p) => p.id === state.presetId) || PRESETS[0];
}

function currentParams() {
  return resolveParams(currentPreset(), state.overrides, state.profile);
}

// ---------- toast ----------
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- tabs ----------
document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.dataset.tab !== b.dataset.go));
    if (b.dataset.go === 'settings') refreshDevices();
    if (b.dataset.go === 'ai') probeAI();
    if (b.dataset.go === 'calls') refreshVirtualMic();
  }),
);

// ---------- presets ----------
function renderCats() {
  const cats = ['All', ...new Set(allPresets().map((p) => p.cat))];
  $('#cats').innerHTML = '';
  for (const c of cats) {
    const b = document.createElement('button');
    b.className = 'chip' + (c === state.category ? ' active' : '');
    b.textContent = c;
    b.onclick = () => {
      state.category = c;
      renderCats();
      renderPresets();
    };
    $('#cats').append(b);
  }
}

function renderPresets() {
  const box = $('#presets');
  box.innerHTML = '';
  for (const p of allPresets()) {
    if (state.category !== 'All' && p.cat !== state.category) continue;
    const b = document.createElement('button');
    b.className = 'preset' + (p.id === state.presetId ? ' active' : '');
    b.dataset.id = p.id;
    b.innerHTML = `<span class="emoji">${p.icon}</span><span></span>${p.targetF0 ? '<span class="tag" title="Adapts to your voice">AI</span>' : ''}`;
    b.children[1].textContent = p.name;
    b.onclick = () => selectPreset(p.id);
    box.append(b);
  }
}

function selectPreset(id) {
  state.presetId = id;
  state.overrides = {};
  ls.set('preset', id);
  applyParams();
  renderPresets();
  renderSliders();
  renderCallVoices();
}

function applyParams() {
  engine.setParams(currentParams());
  $('#voiceName').textContent = currentPreset().name;
}

// ---------- customize sliders ----------
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SLIDERS = [
  ['pitch', 'Pitch', -12, 12, 0.5, (v) => `${v > 0 ? '+' : ''}${v} st`],
  ['formant', 'Formant (voice size)', -8, 8, 0.5, (v) => `${v > 0 ? '+' : ''}${v}`],
  ['mode', 'Pitch mode', ['normal', 'robot', 'tune']],
  ['robotHz', 'Robot pitch', 50, 400, 1, (v) => `${v} Hz`],
  ['tuneScale', 'Tune scale', ['chromatic', 'major', 'minor', 'pentatonic']],
  ['tuneKey', 'Tune key', NOTE.map((n, i) => [i, n])],
  ['whisper', 'Whisper', 0, 1, 0.05, pct],
  ['drive', 'Distortion', 0, 1, 0.05, pct],
  ['crushBits', 'Bit crush (bits, 0=off)', 0, 16, 1, (v) => (v ? `${v} bit` : 'off')],
  ['crushDown', 'Sample crush', 1, 16, 1, (v) => `÷${v}`],
  ['ringMix', 'Ring modulator', 0, 1, 0.05, pct],
  ['ringHz', 'Ring frequency', 5, 500, 1, (v) => `${v} Hz`],
  ['chorusMix', 'Chorus', 0, 1, 0.05, pct],
  ['chorusRate', 'Chorus rate', 0.1, 8, 0.1, (v) => `${v} Hz`],
  ['echoMix', 'Echo', 0, 1, 0.05, pct],
  ['echoTime', 'Echo time', 0.05, 1, 0.01, (v) => `${Math.round(v * 1000)} ms`],
  ['echoFeedback', 'Echo repeats', 0, 0.85, 0.05, pct],
  ['reverbMix', 'Reverb', 0, 1, 0.05, pct],
  ['reverbDecay', 'Room size', 0.3, 8, 0.1, (v) => `${v} s`],
  ['bass', 'Bass', -12, 12, 1, db],
  ['mid', 'Mid', -12, 12, 1, db],
  ['treble', 'Treble', -12, 12, 1, db],
  ['filter', 'Character', ['none', 'telephone', 'radio', 'megaphone', 'underwater', 'mask']],
  ['volume', 'Volume', 0, 2, 0.05, pct],
];

function pct(v) {
  return `${Math.round(v * 100)}%`;
}

function db(v) {
  return `${v > 0 ? '+' : ''}${v} dB`;
}

function renderSliders() {
  const p = currentParams();
  const box = $('#sliders');
  box.innerHTML = '';
  for (const [key, label, a, b, step, fmt] of SLIDERS) {
    const wrap = document.createElement('label');
    wrap.className = 'slider';
    const head = document.createElement('span');
    head.className = 'lbl';
    head.textContent = label;
    const out = document.createElement('output');
    head.append(out);
    wrap.append(head);
    let input;
    if (Array.isArray(a)) {
      input = document.createElement('select');
      for (const opt of a) {
        const [val, text] = Array.isArray(opt) ? opt : [opt, opt[0].toUpperCase() + opt.slice(1)];
        const o = document.createElement('option');
        o.value = val;
        o.textContent = text;
        input.append(o);
      }
      input.value = p[key];
      input.onchange = () => {
        const v = typeof DEFAULTS[key] === 'number' ? Number(input.value) : input.value;
        state.overrides[key] = v;
        applyParams();
      };
    } else {
      input = document.createElement('input');
      input.type = 'range';
      input.min = a;
      input.max = b;
      input.step = step;
      input.value = p[key];
      out.textContent = fmt(Number(p[key]));
      input.oninput = () => {
        const v = Number(input.value);
        out.textContent = fmt(v);
        state.overrides[key] = v;
        applyParams();
      };
    }
    input.dataset.key = key;
    wrap.append(input);
    box.append(wrap);
  }
}

$('#resetBtn').onclick = () => {
  state.overrides = {};
  applyParams();
  renderSliders();
};

$('#saveBtn').onclick = () => {
  const name = prompt('Name your voice', 'My voice');
  if (!name) return;
  const params = { ...currentParams() };
  const preset = { id: 'custom-' + Date.now(), name, icon: '⭐', params };
  state.custom.unshift(preset);
  ls.set('custom', state.custom);
  renderCats();
  selectPreset(preset.id);
  toast(`Saved “${name}”`);
};

// ---------- live ----------
function micOptions() {
  return {
    deviceId: state.settings.input || undefined,
    noiseSuppression: state.settings.browserNs,
    echoCancellation: state.settings.echo,
    autoGainControl: false,
  };
}

async function startLive() {
  try {
    await engine.startMic(micOptions());
    applyParams();
    return true;
  } catch (err) {
    console.error(err);
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    toast(denied ? 'Microphone permission denied. Allow it in your browser settings.' : `Mic error: ${err.message || err}`, 5000);
    return false;
  }
}

function updateStatus() {
  const s = $('#status');
  const rec = Boolean(engine.recording) || recording;
  s.textContent = rec ? 'Recording' : engine.micOn ? 'Live' : 'Mic off';
  s.className = 'status' + (rec ? ' rec' : engine.micOn ? ' live' : '');
  $('#liveBtn').setAttribute('aria-pressed', String(engine.micOn));
  $('#liveBtn .label').textContent = engine.micOn ? 'Stop live' : 'Start live';
  $('#monitorBtn').setAttribute('aria-pressed', String(engine.monitor));
}

engine.addEventListener('mic', updateStatus);

$('#liveBtn').onclick = async () => {
  if (engine.inCall) return toast('You are in a call. Hang up on the Calls tab first.');
  if (engine.micOn) {
    if (recording) await stopRec();
    engine.stopMic();
  } else if (await startLive()) {
    if (!ls.get('monitorAsked', false)) {
      ls.set('monitorAsked', true);
      toast('Tip: turn on 🎧 Monitor with headphones to hear your new voice.', 4000);
    }
  }
  updateStatus();
};

$('#monitorBtn').onclick = async () => {
  await engine.resume();
  engine.setMonitor(!engine.monitor);
  if (engine.monitor && !engine.micOn) await startLive();
  updateStatus();
};

let recording = false;
let recStart = 0;
let recTimer = null;

$('#recBtn').onclick = async () => {
  if (recording) return stopRec();
  if (!engine.micOn && !(await startLive())) return;
  engine.startRecording();
  recording = true;
  recStart = performance.now();
  $('#recBtn').setAttribute('aria-pressed', 'true');
  recTimer = setInterval(() => {
    const s = Math.floor((performance.now() - recStart) / 1000);
    $('#recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
  updateStatus();
};

async function stopRec() {
  recording = false;
  clearInterval(recTimer);
  $('#recBtn').setAttribute('aria-pressed', 'false');
  $('#recTime').textContent = 'Record';
  const res = await engine.stopRecording();
  updateStatus();
  if (!res || res.data.length < res.sampleRate * 0.3) return toast('Recording too short');
  const take = {
    id: 'take-' + Date.now(),
    name: `Recording ${new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`,
    created: Date.now(),
    sampleRate: res.sampleRate,
    data: res.data,
    kind: 'mic',
  };
  await store.put('takes', take);
  await renderTakes();
  toast('Saved to Studio');
}

// ---------- visualizer ----------
const scope = $('#scope');
const g2 = scope.getContext('2d');
let meter = { f0: 0, level: 0 };
engine.addEventListener('meter', (e) => {
  meter = e.detail;
  if (matchCollect && meter.f0 > 0) matchCollect.push(meter.f0);
  $('#pitchOut').textContent = meter.f0 > 0 ? `${Math.round(meter.f0)} Hz · ${noteName(meter.f0)}` : '–';
});
engine.addEventListener('denoise', (e) => {
  denoiseOk = e.detail.ok;
  showDenoise();
});
let denoiseOk = true;

function showDenoise() {
  $('#denoiseOut').textContent = !denoiseOk ? 'Unavailable' : state.settings.aiDenoise ? 'On' : 'Off';
}

function noteName(f) {
  const m = Math.round(69 + 12 * Math.log2(f / 440));
  return NOTE[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

let timeData = null;
function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = scope.clientWidth * dpr;
  const h = scope.clientHeight * dpr;
  if (scope.width !== w || scope.height !== h) {
    scope.width = w;
    scope.height = h;
  }
  g2.clearRect(0, 0, w, h);
  const grad = g2.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#8b5cf6');
  grad.addColorStop(1, '#22d3ee');
  if (engine.analyser) {
    if (!timeData) timeData = new Float32Array(engine.analyser.fftSize);
    engine.analyser.getFloatTimeDomainData(timeData);
    g2.lineWidth = 2 * dpr;
    g2.strokeStyle = grad;
    g2.beginPath();
    const n = timeData.length;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h / 2 - timeData[i] * h * 0.9;
      if (i) g2.lineTo(x, y);
      else g2.moveTo(x, y);
    }
    g2.stroke();
  } else {
    g2.fillStyle = '#9a9ab5';
    g2.font = `${13 * dpr}px system-ui`;
    g2.textAlign = 'center';
    g2.fillText('Tap “Start live” to begin', w / 2, h / 2);
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// ---------- studio ----------
function fmtDur(s) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

async function renderTakes() {
  let takes = [];
  try {
    takes = await store.all('takes');
  } catch (err) {
    console.warn(err);
  }
  takes.sort((a, b) => b.created - a.created);
  const box = $('#takes');
  box.innerHTML = '';
  $('#noTakes').hidden = takes.length > 0;
  for (const t of takes) {
    const el = document.createElement('div');
    el.className = 'take';
    el.innerHTML = `
      <input class="name" aria-label="Name" />
      <div class="meta"><span class="kind"></span> · ${fmtDur(t.data.length / t.sampleRate)} · ${new Date(t.created).toLocaleDateString()}</div>
      <div class="row">
        <button class="chip primary" data-a="voice">▶ With voice</button>
        <button class="chip" data-a="orig">▶ Original</button>
        <button class="chip" data-a="export">⬇ Export</button>
        <button class="chip" data-a="ai">🧠 AI convert</button>
        <button class="chip" data-a="del" aria-label="Delete">🗑</button>
      </div>`;
    el.querySelector('.kind').textContent = t.kind === 'ai' ? `AI · ${t.voiceName || ''}` : t.kind === 'import' ? 'Imported' : 'Mic';
    const name = el.querySelector('.name');
    name.value = t.name;
    name.onchange = async () => {
      t.name = name.value || t.name;
      await store.put('takes', t);
    };
    el.querySelector('.row').onclick = (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a) takeAction(a, t, e.target.closest('button'));
    };
    box.append(el);
  }
}

let playingBtn = null;
async function takeAction(action, take, btn) {
  if (action === 'voice' || action === 'orig') {
    if (playingBtn === btn) {
      engine.stopPreview();
      return;
    }
    const reset = () => {
      if (playingBtn) playingBtn.textContent = playingBtn.dataset.a === 'voice' ? '▶ With voice' : '▶ Original';
      playingBtn = null;
    };
    reset();
    if (recording) await stopRec();
    playingBtn = btn;
    btn.textContent = '⏹ Stop';
    applyParams();
    try {
      await engine.play(take.data, take.sampleRate, { withVoice: action === 'voice', onEnded: reset });
    } catch (err) {
      reset();
      return toast(err.message);
    }
    updateStatus();
  } else if (action === 'export') {
    btn.disabled = true;
    btn.textContent = 'Rendering…';
    try {
      await engine.init();
      const out = await engine.render(take.data, take.sampleRate, currentParams(), { denoise: state.settings.aiDenoise && take.kind !== 'ai' });
      const wav = encodeWav(out.channels, out.sampleRate);
      await shareOrDownload(wav, `${slug(take.name)}-${slug(currentPreset().name)}.wav`);
    } catch (err) {
      console.error(err);
      toast(`Export failed: ${err.message || err}`, 5000);
    } finally {
      btn.disabled = false;
      btn.textContent = '⬇ Export';
    }
  } else if (action === 'ai') {
    await convertWithAI(take);
  } else if (action === 'del') {
    if (!confirm(`Delete “${take.name}”?`)) return;
    engine.stopPreview();
    await store.delete('takes', take.id);
    renderTakes();
  }
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'voice';
}

async function shareOrDownload(buffer, filename) {
  const file = new File([buffer], filename, { type: 'audio/wav' });
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(`Saved ${filename}`);
}

$('#importInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    await engine.init();
    const buf = await engine.ctx.decodeAudioData(await file.arrayBuffer());
    const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
    const take = {
      id: 'take-' + Date.now(),
      name: file.name.replace(/\.[^.]+$/, ''),
      created: Date.now(),
      sampleRate: buf.sampleRate,
      data: toMono(chans),
      kind: 'import',
    };
    await store.put('takes', take);
    renderTakes();
    toast('Imported');
  } catch (err) {
    console.error(err);
    toast('Could not read that file. Try WAV, MP3, M4A or OGG.', 4500);
  }
};

// ---------- AI voices ----------
let worker = null;
let workerLoaded = { encoder: null, voice: null };
let workerJob = null;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress' && workerJob?.onProgress) workerJob.onProgress(m.value);
      else if (workerJob) {
        const job = workerJob;
        workerJob = null;
        if (m.type === 'error') job.reject(new Error(m.message));
        else job.resolve(m);
      }
    };
    worker.onerror = (e) => {
      if (workerJob) workerJob.reject(new Error(e.message || 'AI worker failed'));
      workerJob = null;
      worker = null;
      workerLoaded = { encoder: null, voice: null };
    };
  }
  return worker;
}

function workerCall(msg, onProgress) {
  return new Promise((resolve, reject) => {
    if (workerJob) return reject(new Error('The AI is busy. Try again in a moment.'));
    workerJob = { resolve, reject, onProgress };
    getWorker().postMessage(msg);
  });
}

let probed = false;
async function probeAI() {
  renderModels();
  if (probed) return;
  probed = true;
  try {
    const r = await workerCall({ type: 'probe' });
    const gpu = r.providers.includes('webgpu');
    $('#aiBackend').textContent = gpu ? 'WebGPU ⚡' : 'CPU (WebAssembly)';
    $('#aiBackend').className = 'pill ok';
  } catch (err) {
    probed = false;
    $('#aiBackend').textContent = 'AI runtime offline';
    console.warn(err);
  }
}

function fmtSize(b) {
  return b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`;
}

async function renderModels() {
  let models = [];
  try {
    models = await store.all('models');
  } catch {
    /* storage unavailable */
  }
  const enc = models.find((m) => m.kind === 'encoder');
  $('#encoderInfo').textContent = enc ? `${enc.name} · ${fmtSize(enc.size)}` : 'None. Required for all AI voices.';
  const voices = models.filter((m) => m.kind === 'voice').sort((a, b) => a.added - b.added);
  if (!state.ai.voice && voices[0]) setAI({ voice: voices[0].id });
  $('#noVoices').hidden = voices.length > 0;
  const box = $('#voices');
  box.innerHTML = '';
  for (const v of voices) {
    const el = document.createElement('div');
    el.className = 'voice' + (v.id === state.ai.voice ? ' active' : '');
    el.innerHTML = `<input class="name" aria-label="Voice name" /><div class="meta">${fmtSize(v.size)}</div>
      <div class="row"><button class="chip" data-a="use"></button><button class="chip" data-a="del">🗑</button></div>`;
    el.querySelector('[data-a=use]').textContent = v.id === state.ai.voice ? '✓ Active' : 'Use this voice';
    const name = el.querySelector('.name');
    name.value = v.name;
    name.onchange = async () => {
      v.name = name.value || v.name;
      await store.put('models', v);
    };
    el.querySelector('[data-a=use]').onclick = () => {
      setAI({ voice: v.id });
      renderModels();
    };
    el.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm(`Remove AI voice “${v.name}”?`)) return;
      await store.delete('models', v.id);
      if (state.ai.voice === v.id) setAI({ voice: null });
      renderModels();
    };
    box.append(el);
  }
}

function setAI(patch) {
  Object.assign(state.ai, patch);
  ls.set('ai', state.ai);
}

async function addModel(kind, name, bytes) {
  const head = new Uint8Array(bytes.slice(0, 4));
  if (bytes.byteLength < 64 || head[0] !== 0x08) {
    toast('That does not look like an ONNX model (.onnx). RVC .pth files must be exported to ONNX first.', 6000);
    return;
  }
  await requestPersistence();
  if (kind === 'encoder') {
    for (const m of await store.all('models')) if (m.kind === 'encoder') await store.delete('models', m.id);
  }
  const rec = { id: `${kind}-${Date.now()}`, kind, name: name.replace(/\.onnx$/i, ''), size: bytes.byteLength, bytes, added: Date.now() };
  await store.put('models', rec);
  if (kind === 'voice') setAI({ voice: rec.id });
  renderModels();
  toast(kind === 'encoder' ? 'Content encoder installed' : `AI voice “${rec.name}” added`);
}

$('#encoderFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) await addModel('encoder', f.name, await f.arrayBuffer());
};
$('#voiceFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) await addModel('voice', f.name, await f.arrayBuffer());
};

document.querySelectorAll('[data-url-for]').forEach((b) => {
  b.onclick = async () => {
    const kind = b.dataset.urlFor;
    const url = prompt(kind === 'encoder' ? 'URL of the ContentVec .onnx file' : 'URL of the RVC voice .onnx file');
    if (!url) return;
    const bar = $('#aiProgress');
    bar.hidden = false;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        bar.firstElementChild.style.width = total ? `${(got / total) * 100}%` : '50%';
        bar.lastElementChild.textContent = `Downloading… ${fmtSize(got)}${total ? ' / ' + fmtSize(total) : ''}`;
      }
      const bytes = new Uint8Array(got);
      let o = 0;
      for (const p of parts) {
        bytes.set(p, o);
        o += p.length;
      }
      const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'model.onnx');
      await addModel(kind, name, bytes.buffer);
    } catch (err) {
      toast(`Download failed: ${err.message}`, 5000);
    } finally {
      bar.hidden = true;
    }
  };
});

function renderAISliders() {
  const box = $('#aiSliders');
  box.innerHTML = '';
  const defs = [
    ['pitch', 'AI key shift', -24, 24, 1, (v) => `${v > 0 ? '+' : ''}${v} st`, 'Male→female voice: about +12. Female→male: about -12.'],
    ['speaker', 'Speaker ID', 0, 20, 1, (v) => String(v), 'Only for multi-speaker models.'],
  ];
  for (const [key, label, a, b, step, fmt, hint] of defs) {
    const wrap = document.createElement('label');
    wrap.className = 'slider';
    wrap.innerHTML = `<span class="lbl"><span></span><output></output></span><input type="range" min="${a}" max="${b}" step="${step}" /><small class="muted"></small>`;
    wrap.querySelector('.lbl span').textContent = label;
    wrap.querySelector('small').textContent = hint;
    const input = wrap.querySelector('input');
    const out = wrap.querySelector('output');
    input.value = state.ai[key];
    out.textContent = fmt(state.ai[key]);
    input.oninput = () => {
      out.textContent = fmt(Number(input.value));
      setAI({ [key]: Number(input.value) });
    };
    box.append(wrap);
  }
  const row = document.createElement('div');
  row.className = 'row';
  for (const [label, target] of [
    ['🧠 Auto key → higher voice', 220],
    ['🧠 Auto key → lower voice', 110],
  ]) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = label;
    b.onclick = () => {
      const f0 = state.profile?.f0;
      if (!f0) return toast('Run Voice Match in Settings first (or record a take).');
      setAI({ pitch: Math.max(-24, Math.min(24, Math.round(12 * Math.log2(target / f0)))) });
      renderAISliders();
    };
    row.append(b);
  }
  box.append(row);
}

async function convertWithAI(take) {
  const models = await store.all('models');
  const enc = models.find((m) => m.kind === 'encoder');
  const voice = models.find((m) => m.id === state.ai.voice) || models.find((m) => m.kind === 'voice');
  if (!enc || !voice) {
    document.querySelector('[data-go=ai]').click();
    toast(!enc ? 'Install a content encoder first.' : 'Add an AI voice model first.', 4000);
    return;
  }
  const bar = $('#aiProgress');
  bar.hidden = false;
  bar.firstElementChild.style.width = '0%';
  bar.lastElementChild.textContent = `Loading AI voice “${voice.name}”…`;
  const t0 = performance.now();
  try {
    const msg = {
      type: 'convert',
      encoder: { id: enc.id, bytes: workerLoaded.encoder === enc.id ? null : enc.bytes },
      voice: { id: voice.id, bytes: workerLoaded.voice === voice.id ? null : voice.bytes },
      data: take.data,
      sampleRate: take.sampleRate,
      options: { pitchShift: state.ai.pitch, speakerId: state.ai.speaker },
    };
    const res = await workerCall(msg, (p) => {
      bar.firstElementChild.style.width = `${p * 100}%`;
      bar.lastElementChild.textContent = `Converting with AI… ${Math.round(p * 100)}%`;
    });
    workerLoaded = { encoder: enc.id, voice: voice.id };
    const out = {
      id: 'take-' + Date.now(),
      name: `${take.name} → ${voice.name}`,
      created: Date.now(),
      sampleRate: res.sampleRate,
      data: res.audio,
      kind: 'ai',
      voiceName: voice.name,
    };
    await store.put('takes', out);
    await renderTakes();
    toast(`AI conversion done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  } catch (err) {
    console.error(err);
    workerLoaded = { encoder: null, voice: null };
    toast(`AI conversion failed: ${err.message}`, 6000);
  } finally {
    bar.hidden = true;
  }
}

// ---------- settings ----------
function saveSettings() {
  ls.set('settings', state.settings);
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, value) => {
    sel.innerHTML = '<option value="">Default</option>';
    devs
      .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default')
      .forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `${kind === 'audioinput' ? 'Microphone' : 'Output'} ${i + 1}`;
        sel.append(o);
      });
    sel.value = value || '';
  };
  fill($('#inputSel'), 'audioinput', state.settings.input);
  fill($('#outputSel'), 'audiooutput', state.settings.output);
  const canSink = typeof (window.AudioContext && AudioContext.prototype.setSinkId) === 'function';
  $('#outputSel').disabled = !canSink;
  $('#outputHint').textContent = canSink
    ? 'Tip: pick a virtual cable here to use your AI voice in other apps.'
    : 'This browser always plays through the system output. Use Chrome/Edge or the desktop app to choose an output.';
  if (!devs.some((d) => d.label)) $('#outputHint').textContent += ' Start the mic once to see device names.';
}

$('#inputSel').onchange = async (e) => {
  state.settings.input = e.target.value;
  saveSettings();
  if (engine.micOn) await startLive();
};
$('#outputSel').onchange = async (e) => {
  state.settings.output = e.target.value;
  saveSettings();
  try {
    await engine.setOutputDevice(e.target.value);
  } catch (err) {
    toast(`Could not switch output: ${err.message}`);
  }
};
$('#aiDenoise').onchange = (e) => {
  state.settings.aiDenoise = e.target.checked;
  engine.setDenoise(e.target.checked);
  saveSettings();
  showDenoise();
};
$('#browserNs').onchange = async (e) => {
  state.settings.browserNs = e.target.checked;
  saveSettings();
  if (engine.micOn) await startLive();
};
$('#echoCancel').onchange = async (e) => {
  state.settings.echo = e.target.checked;
  saveSettings();
  if (engine.micOn) await startLive();
};

// Voice Match: learn the speaker's median pitch.
let matchCollect = null;
$('#matchBtn').onclick = async () => {
  const btn = $('#matchBtn');
  if (matchCollect) return;
  const wasOn = engine.micOn;
  if (!wasOn && !(await startLive())) return;
  matchCollect = [];
  btn.disabled = true;
  const t0 = performance.now();
  const tick = setInterval(() => {
    const left = Math.max(0, 8 - (performance.now() - t0) / 1000);
    btn.textContent = `Keep reading… ${Math.ceil(left)}s`;
  }, 200);
  await new Promise((r) => setTimeout(r, 8000));
  clearInterval(tick);
  const vals = matchCollect.slice().sort((a, b) => a - b);
  matchCollect = null;
  btn.disabled = false;
  btn.textContent = 'Start Voice Match';
  if (!wasOn) engine.stopMic();
  updateStatus();
  if (vals.length < 20) return toast('Not enough speech detected. Try again a bit louder.');
  // Trim outliers, take the median.
  const core = vals.slice(Math.floor(vals.length * 0.1), Math.ceil(vals.length * 0.9));
  const f0 = core[core.length >> 1];
  setProfile(f0);
};

function setProfile(f0) {
  state.profile = { f0: Math.round(f0), at: Date.now() };
  ls.set('profile', state.profile);
  showProfile();
  applyParams();
  renderSliders();
  toast(`Voice Match: your natural pitch is ${state.profile.f0} Hz`);
}

function showProfile() {
  const p = state.profile;
  $('#matchOut').textContent = p ? `Your pitch: ${p.f0} Hz (${noteName(p.f0)}). Smart voices are tuned to you.` : 'Not calibrated yet.';
}

// Learn from recordings too: the first take calibrates automatically.
async function autoProfileFromTakes() {
  if (state.profile) return;
  const takes = await store.all('takes').catch(() => []);
  const mic = takes.find((t) => t.kind === 'mic');
  if (!mic) return;
  const f = Array.from(detectPitchTrack(mic.data.subarray(0, mic.sampleRate * 10), mic.sampleRate, 50)).filter((x) => x > 0);
  if (f.length < 20) return;
  f.sort((a, b) => a - b);
  setProfile(f[f.length >> 1]);
}


// ---------- calls ----------
const calls = new Calls(engine, { micOptions });
const callPrefs = ls.get('calls', { server: '', password: '', receive: false });

function saveCallPrefs() {
  ls.set('calls', callPrefs);
}

function renderCallVoices() {
  const box = $('#callVoices');
  if (!box) return;
  box.innerHTML = '';
  for (const p of allPresets().slice(0, 40)) {
    const b = document.createElement('button');
    b.className = 'chip' + (p.id === state.presetId ? ' active' : '');
    b.textContent = `${p.icon} ${p.name}`;
    b.onclick = () => selectPreset(p.id);
    box.append(b);
  }
}

async function connectCallServer({ quiet = false } = {}) {
  $('#serverState').textContent = 'Connecting…';
  try {
    const cfg = await calls.connect(callPrefs.server, callPrefs.password);
    $('#serverState').textContent = `Connected · phone calls ${cfg.phone ? 'on' : 'off'} · app-to-app on`;
    $('#phoneState').textContent = cfg.phone ? `Your caller ID: ${cfg.callerId}.` : 'Phone calling is not configured on the server yet.';
    $('#dialBtn').disabled = !cfg.phone;
    $('#receiveCalls').disabled = !cfg.phone;
    if (cfg.phone && callPrefs.receive) enableReceive(true);
    return cfg;
  } catch (err) {
    $('#serverState').textContent = 'Not connected';
    $('#phoneState').textContent = 'Connect a call server to make calls (⚙️ Call server below).';
    $('#dialBtn').disabled = false;
    if (!quiet) toast(err.message, 5000);
    return null;
  }
}

async function ensureServer() {
  if (calls.config) return calls.config;
  const cfg = await connectCallServer();
  if (!cfg) {
    $('#serverCard').open = true;
    throw new Error('Set up the call server first.');
  }
  return cfg;
}

async function enableReceive(on) {
  callPrefs.receive = on;
  saveCallPrefs();
  $('#receiveCalls').checked = on;
  if (!on) return;
  try {
    await calls.enablePhone();
    toast('Incoming calls will ring here while VoxMorph is open.');
  } catch (err) {
    toast(err.message, 5000);
  }
}

let callTimer = null;
calls.addEventListener('state', (e) => {
  const st = e.detail;
  $('#incomingCard').hidden = st.state !== 'incoming';
  $('#incomingFrom').textContent = st.remote;
  const active = st.state !== 'idle' && st.state !== 'incoming';
  $('#callCard').hidden = !active;
  $('#callRemote').textContent = st.kind === 'p2p' ? `Call code ${st.remote}` : st.remote;
  $('#callState').textContent =
    { connecting: 'Connecting…', ringing: 'Ringing…', 'in-call': 'On call · live voice', waiting: 'Waiting for the other person…' }[st.state] || '';
  $('#muteBtn').setAttribute('aria-pressed', String(st.muted));
  $('#keypadBtn').hidden = st.kind !== 'phone';
  clearInterval(callTimer);
  if (st.state === 'in-call') {
    const tick = () => {
      const s = Math.floor((Date.now() - st.since) / 1000);
      $('#callTimer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    callTimer = setInterval(tick, 1000);
  } else {
    $('#callTimer').textContent = '';
  }
  if (st.state === 'incoming') {
    document.querySelector('[data-go=calls]').click();
    if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
  }
  $('#status').textContent = active ? 'On call' : engine.micOn ? 'Live' : 'Mic off';
  $('#status').className = 'status' + (active ? ' live' : '');
  if (!active) updateStatus();
});
calls.addEventListener('error', (e) => toast(e.detail, 6000));

$('#dialBtn').onclick = async () => {
  try {
    await ensureServer();
    await calls.dial($('#dialInput').value);
  } catch (err) {
    toast(err.message, 5000);
  }
};
$('#dialInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#dialBtn').click();
});
$('#receiveCalls').onchange = async (e) => {
  try {
    await ensureServer();
    await enableReceive(e.target.checked);
  } catch (err) {
    e.target.checked = false;
    toast(err.message);
  }
};
$('#answerBtn').onclick = () => calls.answer().catch((err) => toast(err.message));
$('#declineBtn').onclick = () => calls.decline();
$('#hangBtn').onclick = () => calls.hangup();
$('#muteBtn').onclick = () => calls.mute(!calls.status.muted);
$('#keypadBtn').onclick = () => ($('#keypad').hidden = !$('#keypad').hidden);
for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']) {
  const b = document.createElement('button');
  b.textContent = d;
  b.onclick = () => calls.sendDigits(d);
  $('#keypad').append(b);
}

async function joinRoom(code) {
  try {
    await ensureServer();
    await calls.joinRoom(code);
    applyParams();
  } catch (err) {
    toast(err.message, 5000);
  }
}

$('#newRoomBtn').onclick = async () => {
  const code = randomId(8);
  await joinRoom(code);
  if (calls.status.kind !== 'p2p') return;
  const link = calls.roomLink(code);
  const text = `Join my VoxMorph call: ${link} (code ${code})`;
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'VoxMorph call', text, url: link });
    else {
      await navigator.clipboard.writeText(link);
      toast(`Link copied. Call code: ${code}`, 6000);
    }
  } catch {
    toast(`Call code: ${code}`, 8000);
  }
};
$('#joinBtn').onclick = () => joinRoom($('#roomInput').value);

$('#serverUrl').value = callPrefs.server;
$('#serverPass').value = callPrefs.password;
$('#serverBtn').onclick = () => {
  callPrefs.server = $('#serverUrl').value.trim();
  callPrefs.password = $('#serverPass').value;
  saveCallPrefs();
  calls.config = null;
  connectCallServer();
};

// Virtual microphone for every app on a computer.
const CABLES = [/cable input/i, /blackhole/i, /voxmorph/i, /voicemeeter input/i, /loopback/i, /soundflower/i];

async function refreshVirtualMic() {
  const native = window.voxmorphNative;
  $('#vmicCreate').hidden = !(native && native.platform === 'linux');
  if (!navigator.mediaDevices?.enumerateDevices) return null;
  const devs = await navigator.mediaDevices.enumerateDevices();
  const outs = devs.filter((d) => d.kind === 'audiooutput');
  const cable = outs.find((d) => CABLES.some((r) => r.test(d.label)));
  const canSink = typeof (window.AudioContext && AudioContext.prototype.setSinkId) === 'function';
  let msg;
  if (!canSink) msg = 'This browser cannot choose an output. Use Chrome, Edge or the VoxMorph desktop app.';
  else if (cable) msg = `✅ Found virtual microphone: ${cable.label}`;
  else if (!outs.some((d) => d.label)) msg = 'Tap the button to detect your virtual microphone.';
  else msg = 'No virtual audio cable found yet. Install one (step 1), then restart VoxMorph.';
  $('#vmicStatus').textContent = msg;
  return canSink ? cable : null;
}

$('#vmicBtn').onclick = async () => {
  if (!engine.micOn && !(await startLive())) return;
  const cable = await refreshVirtualMic();
  if (!cable) return toast('No virtual microphone found. See step 1.', 5000);
  try {
    await engine.setOutputDevice(cable.deviceId);
    state.settings.output = cable.deviceId;
    saveSettings();
    engine.setMonitor(true);
    updateStatus();
    toast(`Your voice now goes to “${cable.label}”. Pick it as the microphone in your calling app.`, 6000);
  } catch (err) {
    toast(`Could not use the virtual microphone: ${err.message}`, 5000);
  }
};

$('#vmicCreate').onclick = async () => {
  try {
    await window.voxmorphNative.createVirtualMic();
    toast('Created “VoxMorph Microphone”.');
    await refreshVirtualMic();
  } catch (err) {
    toast(err.message, 5000);
  }
};

function openCallLink() {
  const h = new URLSearchParams(location.hash.slice(1));
  const code = h.get('call');
  if (!code) return;
  if (h.get('server') !== null) {
    callPrefs.server = h.get('server');
    saveCallPrefs();
    $('#serverUrl').value = callPrefs.server;
  }
  history.replaceState(null, '', location.pathname + location.search);
  document.querySelector('[data-go=calls]').click();
  $('#roomInput').value = code;
  toast('Tap Join to enter the call.', 6000);
}
window.addEventListener('hashchange', openCallLink);

// ---------- install / PWA ----------
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  $('#installBtn').hidden = false;
});
$('#installBtn').onclick = async () => {
  if (deferredInstall) {
    deferredInstall.prompt();
    deferredInstall = null;
    $('#installBtn').hidden = true;
  } else {
    toast('On iPhone/iPad: tap Share, then “Add to Home Screen”.', 5000);
  }
};
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone) $('#installBtn').hidden = false;

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.VOXMORPH_NATIVE) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW', err));
}

// ---------- boot ----------
function boot() {
  $('#aiDenoise').checked = state.settings.aiDenoise;
  $('#browserNs').checked = state.settings.browserNs;
  $('#echoCancel').checked = state.settings.echo;
  $('#version').textContent = `VoxMorph ${VERSION}`;
  engine.setDenoise(state.settings.aiDenoise);
  if (!allPresets().some((p) => p.id === state.presetId)) state.presetId = 'natural';
  renderCats();
  renderPresets();
  renderSliders();
  renderAISliders();
  applyParams();
  showProfile();
  showDenoise();
  updateStatus();
  renderTakes().then(autoProfileFromTakes);
  if (state.settings.output) engine.setOutputDevice(state.settings.output).catch(() => {});
  if (!window.isSecureContext) toast('The microphone needs HTTPS (or localhost).', 6000);
  renderCallVoices();
  connectCallServer({ quiet: true });
  openCallLink();
}

boot();

// Expose for automated tests / debugging.
window.voxmorph = { engine, state, selectPreset, setProfile, calls };
