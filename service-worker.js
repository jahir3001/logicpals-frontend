// LogicPals PWA Service Worker (Smart Version)

// 1. VERSION CONTROL: Change this string every time you update your code!
const CACHE_NAME = 'logicpals-v6'; 

const urlsToCache = [
  '/',
  '/index.html',
  '/login.html',
  '/signup.html',
  '/dashboard.html',
  '/learn.html',
  '/manifest.json'
];

// 2. INSTALL: Cache files and force the new worker to take over
self.addEventListener('install', event => {
  self.skipWaiting(); // <--- THIS FORCES THE UPDATE IMMEDIATELY
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

// 3. ACTIVATE: Delete old caches (The Cleanup Crew)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            console.log('Deleting old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    })
  );
});

// 4. FETCH: Use Cache, but fall back to Network
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});