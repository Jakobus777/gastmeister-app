const CACHE_NAME = 'gastmeister-v12';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './github-sync.js',
  './styles.css',
  './lucide.min.js',
  './dexie.min.js',
  './jspdf.min.js',
  './tuerschild_template.js',
  './kelch_serviette.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Install: Cache alle statischen Assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: Alte Caches löschen
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: Cache-first, dann Netzwerk
self.addEventListener('fetch', event => {
  // Backup-Server und GitHub API nicht cachen
  if (event.request.url.includes(':9847')) return;
  if (event.request.url.includes('api.github.com')) return;
  if (event.request.url.includes('raw.githubusercontent.com')) return;
  if (event.request.url.includes('gastmeister_data.json')) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Nur eigene Assets cachen, keine externen
        if (response.ok && event.request.url.startsWith(self.location.origin)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => {
      // Offline-Fallback: index.html für Navigation
      if (event.request.mode === 'navigate') {
        return caches.match('./index.html');
      }
    })
  );
});
