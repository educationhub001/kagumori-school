// Kagumori service worker: makes the site installable and keeps the app shell available.
// Network-first for assets; navigation requests always fall back to cached index.html
// so a refresh offline shows the in-app "No Network" screen instead of the browser page.
const CACHE = 'kagumori-shell-v2';
const SHELL = [
  './',
  'index.html',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // Never touch Supabase, CDNs, or any non-GET request
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Navigations (address bar, refresh, open from home screen): network-first,
  // then always fall back to the app shell so the in-app offline UI can run.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match('index.html').then(r => r || caches.match('./'))
        )
    );
    return;
  }

  // Same-origin assets: network-first, cache as fallback
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(r => r || caches.match('index.html'))
      )
  );
});
