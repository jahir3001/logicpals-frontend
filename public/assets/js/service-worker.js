// LogicPals PWA Service Worker (Full Offline Support)

// 1. VERSION CONTROL: Increment this (v8, v9...) whenever you update code!
const CACHE_NAME = 'logicpals-v10'; 

// 2. FILES TO CACHE: The browser will save these for offline use
const urlsToCache = [
  '/',
  '/index.html',
  '/login.html',
  '/signup.html',
  '/dashboard.html',
  '/learn.html',
  '/pricing.html',
  '/manifest.json'
];

// 3. INSTALL EVENT: Cache files & force update
self.addEventListener('install', event => {
  // skipWaiting() forces the new Service Worker to become active immediately
  self.skipWaiting(); 
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});

// 4. ACTIVATE EVENT: Cleanup old versions (Garbage Collection)
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

// 5. FETCH EVENT: Serve from Cache first, then Network (Offline Strategy)
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Cache hit - return response
        if (response) {
          return response;
        }
        // Not in cache - fetch from internet
        return fetch(event.request);
      })
  );
});