/* SONIQ service worker — offline shell + runtime asset caching.
   API calls are never cached (they need live yt-dlp). */
const VERSION = 'soniq-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const OFFLINE_URL = new URL('offline.html', self.location.href).href;
const INDEX_URL = new URL('index.html', self.location.href).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll([OFFLINE_URL, INDEX_URL]).catch(() => {})
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept API or cross-origin audio/media streams.
  if (url.pathname.includes('/api/') || url.origin !== self.location.origin) return;

  // Navigations: network-first, fall back to cached app shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(INDEX_URL, copy));
          return res;
        })
        .catch(() => caches.match(INDEX_URL).then((r) => r || caches.match(OFFLINE_URL)))
    );
    return;
  }

  // Static assets (JS/CSS/fonts/images): stale-while-revalidate.
  if (/\.(js|css|woff2?|png|jpg|jpeg|svg|webp|ico)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(RUNTIME_CACHE).then((c) => c.put(request, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});
