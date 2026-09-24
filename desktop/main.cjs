// Desktop app (Windows / macOS / Linux) — wraps the web app in Electron.
// Serves app/ from a privileged app:// origin so AudioWorklets, WebAssembly,
// threads (cross-origin isolation) and WebGPU all work offline.
const { app, BrowserWindow, protocol, net, session, shell, systemPreferences, ipcMain } = require('electron');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', 'app');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#0b0b14',
    title: 'VoxMorph',
    icon: path.join(ROOT, 'icons', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
      backgroundThrottling: false, // keep the voice running while minimised
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL('app://voxmorph/index.html');
}

app.whenReady().then(async () => {
  protocol.handle('app', async (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
    if (!file.startsWith(ROOT)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    if (file.endsWith('.js') || file.endsWith('.mjs')) headers.set('Content-Type', 'text/javascript');
    if (file.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
    return new Response(res.body, { status: res.status, headers });
  });

  const allowed = new Set(['media', 'speaker-selection', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  if (process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('microphone');
    } catch {
      /* the page will surface the error */
    }
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Linux: create a system-wide "VoxMorph Microphone" (PulseAudio / PipeWire).
// VoxMorph plays the changed voice into "VoxMorph Output"; every app can then
// pick "VoxMorph Microphone" as its mic. Windows/macOS use VB-Cable/BlackHole.
function pactl(args) {
  return new Promise((resolve, reject) => {
    execFile('pactl', args, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

ipcMain.handle('virtual-mic:create', async () => {
  if (process.platform !== 'linux') throw new Error('Install VB-Audio Cable (Windows) or BlackHole (Mac).');
  let sinks = '';
  try {
    sinks = await pactl(['list', 'short', 'sinks']);
  } catch {
    throw new Error('pactl not found. Install pulseaudio-utils (works with PipeWire too).');
  }
  if (!sinks.includes('voxmorph_out')) {
    await pactl(['load-module', 'module-null-sink', 'sink_name=voxmorph_out', 'sink_properties=device.description=VoxMorph_Output']);
  }
  const sources = await pactl(['list', 'short', 'sources']);
  if (!sources.includes('voxmorph_mic')) {
    await pactl([
      'load-module',
      'module-remap-source',
      'master=voxmorph_out.monitor',
      'source_name=voxmorph_mic',
      'source_properties=device.description=VoxMorph_Microphone',
    ]);
  }
  return true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
