# Real-time calls with your changed voice

VoxMorph changes your voice **live during calls** in three ways:

| Where | How | Works on |
|---|---|---|
| **Phone calls to any number** | Placed from the **Calls** tab through Twilio. The other person can be on any normal phone or landline and hears your changed voice. They can also call your Twilio number and it rings in the app. | iPhone, Android, Windows, Mac |
| **Free app-to-app calls** | Peer-to-peer WebRTC call between two VoxMorph users. You share a link or a code. | iPhone, Android, Windows, Mac |
| **Every calling app on a computer** | VoxMorph feeds a virtual microphone that other apps use: Zoom, Teams, Discord, Meet, Skype, WhatsApp or Telegram desktop, OBS, games. **Normal cellular calls** also work when your phone's calls run through the computer (Windows **Phone Link**, or **iPhone calls on Mac**). | Windows, Mac, Linux |

### Why not inside the phone's own dialer, WhatsApp, etc.?
iOS and Android don't give any app access to the audio of the built-in phone app or of other apps' microphones. This is a security guarantee of the operating system, and no app store app can get around it. Voice-changer calling apps use the same approach as VoxMorph: the call is placed from inside the app.

---

## 1. Deploy the VoxMorph server
The server serves the app and powers both kinds of calls. It's a single Node file with no dependencies.

- **Render (easiest):** go to *New → Blueprint*, pick this repo, and it uses `render.yaml`.
- **Any Docker host** (Fly.io, Railway, a VPS): `docker build -t voxmorph . && docker run -p 8080:8080 --env-file .env voxmorph`.
- **Plain Node:** `npm ci && npm run vendor && npm start`.

It must be reachable over **HTTPS**, because phones only allow the microphone on secure pages. Open the server URL on each device and install the app from there (*Add to Home Screen* or *Install app*). If you use the app from another place, such as GitHub Pages or the desktop app, enter the server URL under **Calls → ⚙️ Call server**.

App-to-app calls work as soon as the server runs. For users on strict mobile networks, set the Twilio variables below (VoxMorph then uses Twilio's TURN relays automatically), or set `TURN_URLS`, `TURN_USERNAME` and `TURN_CREDENTIAL`.

## 2. Enable phone calls (Twilio)
1. Create a Twilio account and **buy a phone number** with voice capability. This becomes your caller ID.
2. **Console → Account → API keys:** create a *Standard* API key. Note the SID (`SK…`) and the secret.
3. **Console → Voice → TwiML Apps:** create an app and set **Voice Request URL** to
   `https://YOUR-SERVER/twilio/voice` (HTTP POST). Note its SID (`AP…`).
4. To receive calls in the app, open your **phone number's** settings and set *A call comes in* to the same URL.
5. Set these environment variables on the server:

| Variable | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | `AC…` from the console dashboard |
| `TWILIO_AUTH_TOKEN` | Auth token. Used to verify webhooks and fetch TURN relays. |
| `TWILIO_API_KEY` / `TWILIO_API_SECRET` | The API key from step 2 |
| `TWILIO_TWIML_APP_SID` | `AP…` from step 3 |
| `TWILIO_CALLER_ID` | Your Twilio number, for example `+14155550123` |
| `APP_PASSWORD` | **Required.** Only people with this password can place calls on your account. |
| `PUBLIC_URL` | `https://YOUR-SERVER`, the public URL Twilio calls (used for signature checks behind proxies) |
| `ALLOWED_PREFIXES` | Optional. Allowed destinations, for example `+1,+44`. This protects your bill. |
| `CLIENT_IDENTITY` | Optional, default `voxmorph`. The server is meant for one person: incoming calls ring on whichever device last turned on *Receive calls*. Run one server per person if you want to share. |
| `ALLOWED_ORIGINS` | Optional CORS allow-list if the app is hosted elsewhere, default `*` |

In the app, open **Calls → ⚙️ Call server**, enter the password and tap *Connect*. Type a number in international format and tap **Call**. Turn on *Receive calls to my number in this app* to answer incoming calls with your changed voice while VoxMorph is open.

Twilio charges per minute plus a monthly number fee (see twilio.com/voice/pricing). Twilio only lets you use caller IDs you own or have verified, so spoofing other people's numbers isn't possible.

## 3. Every app on your computer (virtual microphone)
1. Install a virtual audio cable once: **VB-Audio Cable** (Windows) or **BlackHole 2ch** (Mac). On Linux, the VoxMorph desktop app creates **VoxMorph Microphone** for you (PulseAudio or PipeWire).
2. In **Calls → Every app on this computer**, tap **Send my voice to the virtual microphone**.
3. In the other app, choose **CABLE Output** / **BlackHole 2ch** / **VoxMorph Microphone** as the microphone.
   - *Phone Link (Windows):* pair your phone, then in Phone Link go to Settings → Calls and pick the cable as the microphone. Your regular cellular calls now use the changed voice.
   - *iPhone calls on Mac:* allow calls on other devices on the iPhone, then choose BlackHole in FaceTime → Settings → Microphone (or System Settings → Sound → Input).

This needs Chrome, Edge or the desktop app, because Safari and Firefox can't choose an output device.

## Tips
- Wear headphones on computers so the other person's voice doesn't loop back into your mic. On phones, echo cancellation is turned on automatically during calls.
- You can switch voices mid-call from the voice strip on the call screen.
- Latency is about 60–80 ms end to end on top of the normal call delay.
- Be responsible: don't use a changed voice to deceive, harass or defraud anyone. Recording or altering calls may be regulated where you live.
