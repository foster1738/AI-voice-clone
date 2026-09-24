# VoxMorph: AI Voice Changer

VoxMorph is a voice changer for **iPhone, Android, Windows and macOS**, built from a single codebase. All audio stays on your device. Nothing is uploaded.

| | |
|---|---|
| 🧠 **AI voice conversion** | Neural voice conversion (RVC). Load any RVC voice model and turn a recording into that voice. Runs on-device with ONNX Runtime, using WebGPU when available and WebAssembly otherwise. |
| 🔇 **AI noise suppression** | RNNoise, a recurrent neural network, cleans up the mic in real time before the effects run. |
| 🎯 **Voice Match** | Learns your natural pitch. Smart voices (Feminine, Masculine, Deep, Child, Giant) then aim at a target pitch for *your* voice instead of applying a fixed shift. |
| 🎙️ **Real-time voice changer** | Pitch-synchronous engine (TD-PSOLA) with independent **pitch** and **formant** control, so a gender change sounds like a person, not a chipmunk. Also includes robot mode, hard-tune (pitch snap to a scale), whisper and bit-crush. |
| 🎛️ **29 voices + full editor** | Everyday, Fun, Sci-Fi, Horror, Music and Places. There are 24 controls: EQ, distortion, ring mod, chorus, echo, reverb and filters. You can save your own voices. |
| 🎚️ **Studio** | Record once and try every voice on it. Import audio files, export WAV, or share straight to other apps from your phone. |
| 📞 **Live voice changing on calls** | **Call any phone number** (and receive calls) from the app, with the other person hearing your changed voice in real time. There are also **free app-to-app calls**. On computers, a **virtual microphone** works in Zoom, Teams, Discord, Meet, WhatsApp desktop and games, and in normal cellular calls through Phone Link or iPhone-on-Mac. See [docs/CALLS.md](docs/CALLS.md). |

## Install

### iPhone / iPad
1. Open the app URL in **Safari** (see *Publish the web app* below).
2. Tap **Share → Add to Home Screen**. VoxMorph then opens full screen like a native app and works offline.

### Android
1. Open the app URL in **Chrome**, then tap **Install app** (or ⋮ → *Install app*).
2. If you prefer a real APK, run the **Build apps** workflow. It produces `VoxMorph-android` (a debug APK).

### Windows and macOS
- **Easiest:** open the URL in Chrome or Edge and click the install icon in the address bar.
- **Native desktop app:** run the **Build apps** workflow (Actions tab → *Build apps* → *Run workflow*, or push a tag such as `v1.0.0`). It produces a Windows installer and a portable `.exe`, a macOS `.dmg`, and a Linux AppImage.
  - The builds are unsigned. On Windows, click *More info → Run anyway*. On macOS, right-click the app and choose *Open* the first time.

### Publish the web app
Go to **Settings → Pages** and set *Source* to **GitHub Actions**. Then push to `main`. The **Deploy web app** workflow publishes the app at `https://<you>.github.io/<repo>/`. The microphone needs HTTPS, which GitHub Pages provides.

## AI voices (RVC)

AI conversion needs two ONNX files. You add them in the **AI Voices** tab, either as a file import or from a URL. They're stored on the device.

1. **Content encoder:** a ContentVec (HuBERT) ONNX file, such as `vec-768-layer-12.onnx` for RVC v2 models or `vec-256-layer-9.onnx` for v1. You install it once.
2. **Voice models:** any RVC model exported to ONNX. In the RVC WebUI, open the **ckpt processing → Export Onnx** tab and export your `.pth` voice. You can add as many voices as you like and switch between them.

Then go to **Studio**, find a recording and tap **🧠 AI convert**. Settings:
- **AI key shift:** about +12 for a male voice to a female model, about -12 the other way. The **Auto key** buttons work this out from Voice Match.
- **Speaker ID:** only for multi-speaker models.

Only use voice models you have the right to use, and don't impersonate real people without their consent.

## Real-time calls
The full setup guide is in **[docs/CALLS.md](docs/CALLS.md)**.

- **Phone calls (all devices):** deploy the included server (`render.yaml` or the `Dockerfile`) and add a Twilio number. Then dial any number from **Calls**, or answer incoming calls, with your changed voice live.
- **App-to-app (all devices, free):** tap *Start a call & share link* and send the link.
- **Every app on a computer:** install VB-Audio Cable (Windows) or BlackHole (Mac); the Linux desktop app creates its own mic. Tap *Send my voice to the virtual microphone*, then pick that microphone in Zoom, Teams, Discord, WhatsApp desktop, Phone Link, FaceTime and so on.
- **Phone's built-in dialer and WhatsApp on iOS/Android:** not possible for any app. The OS blocks access to their audio, which is why VoxMorph places the call itself.

## Development

```bash
npm install          # set ELECTRON_SKIP_BINARY_DOWNLOAD=1 if you only need the web app
npm start            # app + call server at http://localhost:8080
npm test             # DSP, AI pipeline and call-server tests
npm run vendor       # bundle ONNX Runtime for offline/desktop use
npm run test:e2e     # drives the app in Chromium with a fake mic, including a live call between two windows
npm run desktop      # run the Electron desktop app
```

Native mobile builds use Capacitor:
```bash
npx cap add ios        # or: npx cap add android
npm run mobile:sync    # copies the web app and adds microphone permissions
npx cap open ios       # build and run from Xcode (or Android Studio)
```

### How it works
```
mic ─► RNNoise (AI denoise) ─► voice engine (YIN pitch tracking + PSOLA
       pitch/formant/robot/tune + whisper/crush) ─► EQ ─► character filter ─►
       distortion ─► ring mod ─► chorus ─► echo ─► reverb ─► limiter ─► speakers / cable / recorder

recording ─► 16 kHz ─► ContentVec features ┐
                    └─► YIN f0 (+ key shift) ┴─► RVC synthesizer ─► new voice
```

| Path | What |
|---|---|
| `app/js/worklets/voice-processor.js` | Real-time voice engine (AudioWorklet) |
| `app/js/worklets/denoise-processor.js` | RNNoise AI noise suppression (AudioWorklet + WASM) |
| `app/js/chain.js` | Effect chain, shared by live playback and offline export |
| `app/js/ai.js`, `app/js/ai-worker.js` | RVC voice conversion pipeline, run in a Web Worker |
| `app/js/presets.js` | Voices and Voice Match retargeting |
| `app/js/calls.js` | Phone calls (Twilio AudioProcessor hook) and app-to-app WebRTC calls |
| `server/index.mjs` | App server, Twilio tokens and webhook, WebRTC signaling (no dependencies) |
| `desktop/main.cjs` | Electron wrapper (Windows/macOS/Linux) |
| `tests/` | Unit tests, end-to-end test, stub ONNX models (`fixtures/make_models.py`) |

### Limits
- Live mode uses the DSP engine plus AI denoise, with about 60 ms latency. RVC conversion works on recordings, not live. Real-time RVC needs a strong GPU and more latency.
- Full-size ContentVec encoders are about 200–400 MB. They run well on desktops and recent phones, but older phones may run out of memory.

Third-party code: RNNoise WASM build from `@jitsi/rnnoise-wasm` (Apache-2.0 / BSD, `app/vendor/rnnoise/LICENSE`), Twilio Voice JS SDK (`app/vendor/twilio/LICENSE.md`) and ONNX Runtime Web (MIT).
