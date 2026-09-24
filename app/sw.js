// Offline support: cache the app shell; AI runtime files are cached on first use.
const CACHE = 'voxmorph-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'js/main.js',
  'js/engine.js',
  'js/chain.js',
  'js/presets.js',
  'js/storage.js',
  'js/dsp.js',
  'js/ai.js',
  'js/ai-worker.js',
  'js/worklets/voice-processor.js',
  'js/worklets/denoise-processor.js',
  'js/worklets/recorder-processor.js',
  'vendor/rnnoise/rnnoise-sync.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const ortCdn = url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('onnxruntime-web');
  if (!sameOrigin && !ortCdn) return;
  // Network first for our own files (so updates land), cache fallback offline.
  // Cache first for the versioned AI runtime on the CDN.
  if (ortCdn) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
            return res;
          }),
      ),
    );
    return;
  }
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })),
  );
});
