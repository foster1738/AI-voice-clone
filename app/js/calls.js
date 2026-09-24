// Real-time calls with the changed voice.
//
//  * Phone calls (any number, incoming and outgoing) through Twilio Voice.
//    The SDK's AudioProcessor hook hands us its microphone stream; we run it
//    through the voice chain and give back the transformed stream, so the
//    person on the other end hears the new voice live.
//  * Free app-to-app calls over WebRTC, signaled by the VoxMorph server.

const TWILIO_SDK = ['../vendor/twilio/twilio.min.js', 'https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2.18.5/dist/twilio.min.js'];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(s);
  });
}

async function loadTwilio() {
  if (window.Twilio && window.Twilio.Device) return window.Twilio;
  let lastErr;
  for (const src of TWILIO_SDK) {
    try {
      await loadScript(new URL(src, import.meta.url).href);
      if (window.Twilio && window.Twilio.Device) return window.Twilio;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Phone SDK unavailable');
}

export function randomId(len = 8) {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

export class Calls extends EventTarget {
  constructor(engine, { micOptions = () => ({}) } = {}) {
    super();
    this.engine = engine;
    this.micOptions = micOptions;
    this.server = '';
    this.password = '';
    this.config = null;
    this.device = null;
    this.call = null; // active Twilio call
    this.incoming = null;
    this.p2p = null;
    this.status = { kind: null, state: 'idle', remote: '', since: 0, muted: false };
    this.remoteAudio = new Audio();
    this.remoteAudio.autoplay = true;
    this.remoteAudio.setAttribute('playsinline', '');
  }

  _set(patch) {
    Object.assign(this.status, patch);
    this.dispatchEvent(new CustomEvent('state', { detail: { ...this.status } }));
  }

  _error(err) {
    this.dispatchEvent(new CustomEvent('error', { detail: err && err.message ? err.message : String(err) }));
  }

  api(path) {
    return (this.server || '').replace(/\/$/, '') + path;
  }

  /** Connect to a VoxMorph server ('' = the server this page came from). */
  async connect(server, password) {
    this.server = server || '';
    this.password = password || '';
    const res = await fetch(this.api('/api/config'), { cache: 'no-store' });
    if (!res.ok) throw new Error(`Call server not found (${res.status})`);
    const cfg = await res.json();
    if (typeof cfg.p2p !== 'boolean') throw new Error('That URL is not a VoxMorph server');
    this.config = cfg;
    this.dispatchEvent(new CustomEvent('config', { detail: cfg }));
    return cfg;
  }

  get busy() {
    return this.status.state !== 'idle';
  }

  _beginCall() {
    this.engine.inCall = true;
    // iOS only lets media play after a tap: start the remote audio element
    // now, while we are still inside the user's tap, with a silent stream.
    try {
      if (!this.remoteAudio.srcObject) {
        this.remoteAudio.srcObject = this.engine.ctx.createMediaStreamDestination().stream;
        this.remoteAudio.play().catch(() => {});
      }
    } catch {
      /* not needed on this platform */
    }
    // Never play our own voice back during a call: it would echo to the caller.
    this._monitorBefore = this.engine.monitor;
    this.engine.setMonitor(false);
  }

  _endCall() {
    this.engine.inCall = false;
    if (this._monitorBefore) this.engine.setMonitor(true);
    this._monitorBefore = false;
    this.remoteAudio.srcObject = null;
    this._set({ kind: null, state: 'idle', remote: '', since: 0, muted: false });
  }

  // ---------------- phone (Twilio) ----------------

  async _token() {
    const res = await fetch(this.api('/api/token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: this.password }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `Token request failed (${res.status})`);
    return j.token;
  }

  async enablePhone() {
    if (this.device) return this.device;
    if (!this.config || !this.config.phone) throw new Error('Phone calling is not set up on the call server.');
    const Twilio = await loadTwilio();
    const token = await this._token();
    const device = new Twilio.Device(token, {
      codecPreferences: ['opus', 'pcmu'],
      closeProtection: 'A call is in progress. Leave anyway?',
      enableImprovedSignalingErrorPrecision: true,
      logLevel: 'warn',
    });
    const engine = this.engine;
    // Every call's microphone goes through the voice changer.
    this.processor = {
      async createProcessedStream(stream) {
        await engine.attachStream(stream);
        return engine.callStream();
      },
      async destroyProcessedStream() {
        engine.stopMic();
      },
    };
    await device.audio.addProcessor(this.processor, false);
    device.on('error', (err) => this._error(err));
    device.on('tokenWillExpire', async () => {
      try {
        device.updateToken(await this._token());
      } catch (err) {
        this._error(err);
      }
    });
    device.on('incoming', (call) => this._onIncoming(call));
    device.on('registered', () => this.dispatchEvent(new Event('registered')));
    this.device = device;
    try {
      await device.register();
    } catch (err) {
      this._error(err);
    }
    return device;
  }

  _wire(call, remote) {
    this.call = call;
    call.on('accept', () => this._set({ state: 'in-call', since: Date.now() }));
    call.on('ringing', () => this._set({ state: 'ringing' }));
    const end = () => {
      if (this.call === call) {
        this.call = null;
        this._endCall();
      }
    };
    call.on('disconnect', end);
    call.on('cancel', end);
    call.on('reject', end);
    call.on('error', (err) => {
      this._error(err);
      end();
    });
    this._set({ kind: 'phone', state: 'connecting', remote });
  }

  async dial(number) {
    if (this.busy) throw new Error('Already in a call');
    const to = String(number).replace(/[\s()-]/g, '');
    if (!/^\+[1-9]\d{6,14}$/.test(to)) throw new Error('Enter the number in international format, e.g. +14155550123');
    await this.engine.resume();
    await this.engine.callStream();
    const device = await this.enablePhone();
    this._beginCall();
    try {
      const call = await device.connect({ params: { To: to } });
      this._wire(call, to);
    } catch (err) {
      this._endCall();
      throw err;
    }
  }

  _onIncoming(call) {
    if (this.busy) {
      call.reject();
      return;
    }
    this.incoming = call;
    const from = (call.parameters && call.parameters.From) || 'Unknown';
    const clear = () => {
      if (this.incoming === call) {
        this.incoming = null;
        if (this.status.state === 'incoming') this._endCall();
      }
    };
    call.on('cancel', clear);
    call.on('disconnect', clear);
    this._set({ kind: 'phone', state: 'incoming', remote: from });
  }

  async answer() {
    const call = this.incoming;
    if (!call) return;
    this.incoming = null;
    await this.engine.resume();
    await this.engine.callStream();
    this._beginCall();
    this._wire(call, (call.parameters && call.parameters.From) || 'Unknown');
    call.accept();
  }

  decline() {
    if (this.incoming) this.incoming.reject();
    this.incoming = null;
    this._endCall();
  }

  // ---------------- app-to-app (WebRTC) ----------------

  roomLink(room) {
    const url = new URL(location.href);
    url.hash = '';
    url.search = '';
    const params = new URLSearchParams({ call: room });
    if (this.server) params.set('server', this.server);
    return `${url.href}#${params}`;
  }

  async joinRoom(room) {
    if (this.busy) throw new Error('Already in a call');
    if (!this.config) await this.connect(this.server, this.password);
    room = String(room).trim().toLowerCase();
    if (!/^[a-z0-9-]{4,40}$/.test(room)) throw new Error('Invalid call code');
    const id = randomId(10);
    // Echo cancellation on: the other person's voice comes out of our speaker.
    await this.engine.startMic({ ...this.micOptions(), echoCancellation: true });
    const outStream = await this.engine.callStream();
    this._beginCall();
    const p2p = { room, id, pc: null, es: null, other: null, pending: [], closed: false };
    this.p2p = p2p;
    this._set({ kind: 'p2p', state: 'waiting', remote: room });

    const send = (data) =>
      fetch(this.api(`/api/rooms/${room}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: id, data }),
      }).catch(() => {});

    const newPc = () => {
      if (p2p.pc) p2p.pc.close();
      const pc = new RTCPeerConnection({ iceServers: this.config.iceServers });
      p2p.pc = pc;
      p2p.pending = [];
      for (const track of outStream.getAudioTracks()) pc.addTrack(track, outStream);
      pc.onicecandidate = (e) => {
        if (e.candidate) send({ candidate: e.candidate.toJSON() });
      };
      pc.ontrack = (e) => {
        this.remoteAudio.srcObject = e.streams[0] || new MediaStream([e.track]);
        this.remoteAudio.play().catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        if (pc !== p2p.pc) return;
        if (pc.connectionState === 'connected') this._set({ state: 'in-call', since: this.status.since || Date.now() });
        if (pc.connectionState === 'failed') this._error(new Error('Could not connect. A TURN relay may be needed on this network.'));
      };
      return pc;
    };

    const es = new EventSource(this.api(`/api/rooms/${room}/events?peer=${id}`));
    p2p.es = es;
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED && !p2p.closed) {
        this._error(new Error('This call already has two people, or the server is unreachable.'));
        this.hangup();
      }
    };
    es.addEventListener('peers', async (e) => {
      const { peers } = JSON.parse(e.data);
      const other = peers.find((p) => p !== id) || null;
      if (other && other !== p2p.other) {
        p2p.other = other;
        const pc = newPc();
        // The peer with the smaller id makes the offer.
        if (id < other) {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          send({ sdp: pc.localDescription.toJSON() });
        }
        this._set({ state: 'connecting' });
      } else if (!other && p2p.other) {
        p2p.other = null;
        if (p2p.pc) p2p.pc.close();
        p2p.pc = null;
        this.remoteAudio.srcObject = null;
        this._set({ state: 'waiting', since: 0 });
      }
    });
    es.addEventListener('signal', async (e) => {
      const { data } = JSON.parse(e.data);
      const pc = p2p.pc || newPc();
      try {
        if (data.sdp) {
          await pc.setRemoteDescription(data.sdp);
          for (const c of p2p.pending.splice(0)) await pc.addIceCandidate(c);
          if (data.sdp.type === 'offer') {
            await pc.setLocalDescription(await pc.createAnswer());
            send({ sdp: pc.localDescription.toJSON() });
          }
        } else if (data.candidate) {
          if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
          else p2p.pending.push(data.candidate);
        }
      } catch (err) {
        console.warn('signal', err);
      }
    });
  }

  // ---------------- shared controls ----------------

  mute(on) {
    if (this.call) this.call.mute(on);
    if (this.engine.stream) this.engine.stream.getAudioTracks().forEach((t) => (t.enabled = !on));
    this._set({ muted: on });
  }

  sendDigits(d) {
    if (this.call) this.call.sendDigits(d);
  }

  hangup() {
    if (this.incoming) return this.decline();
    if (this.call) {
      this.call.disconnect();
      return;
    }
    if (this.p2p) {
      const p = this.p2p;
      this.p2p = null;
      p.closed = true;
      if (p.es) p.es.close();
      if (p.pc) p.pc.close();
      this.engine.stopMic();
      this._endCall();
    }
  }

  setSpeaker(deviceId) {
    if (typeof this.remoteAudio.setSinkId === 'function') return this.remoteAudio.setSinkId(deviceId || '');
    if (this.device && this.device.audio && this.device.audio.speakerDevices) return this.device.audio.speakerDevices.set(deviceId || 'default');
    return Promise.resolve();
  }
}
