// Офлайн-кэш приложения. __BUILD__ подменяется при деплое на хэш коммита,
// так что каждая выкладка получает свой кэш. Стратегия: отдать из кэша
// сразу, а в фоне скачать свежую версию — она откроется при следующем запуске.

const CACHE = 'metermate-__BUILD__';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/store.js', 'js/dom.js', 'js/camera.js', 'js/cropper.js',
  'js/recognizer.js', 'js/stats.js', 'js/xlsx.js', 'js/export.js',
  'js/ledger.js', 'js/sheets.js', 'js/legacy.js', 'js/google.js',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request)
      .then((res) => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      })
      .catch(() => cached);
    if (cached) {
      e.waitUntil(fresh);
      return cached;
    }
    return fresh;
  }));
});
