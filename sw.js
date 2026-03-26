// === Ghost Mesh Chat — Service Worker ===

const CACHE_NAME = 'ghost-mesh-v32';

// Файлы для кэширования (офлайн-оболочка)
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './icon.svg',
  './manifest.json'
];

// Установка — кэшируем assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
  // Активируемся сразу, не ждём закрытия старых вкладок
  self.skipWaiting();
});

// Активация — удаляем старые кэши
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Стратегия: Network First, fallback на кэш
// PeerJS и WebRTC требуют сеть, но UI грузим из кэша если офлайн
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Внешние ресурсы (Google Fonts, PeerJS CDN) — только сеть + кэш
  if (url.origin !== location.origin) {
    event.respondWith(
      fetch(event.request).then((response) => {
        // Кэшируем копию
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      }).catch(() => {
        return caches.match(event.request);
      })
    );
    return;
  }

  // Локальные файлы — network first
  event.respondWith(
    fetch(event.request).then((response) => {
      const clone = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
      return response;
    }).catch(() => {
      return caches.match(event.request);
    })
  );
});
