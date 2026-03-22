const CACHE_NAME = 'fund-helper-v8';
const BASE = self.registration.scope;
const ASSETS = [
  './',
  './index.html',
  './db.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
const CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'
];

// Install: cache core assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(ASSETS).catch(() => {
        // If running from file://, addAll may fail - that's OK
        return cache.addAll(ASSETS.filter(u => u !== './'));
      })
    ).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for API calls, cache-first for assets
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API calls (fund NAV & detail data) - network only, don't cache
  if(url.hostname.includes('fundgz.1234567.com.cn') || url.hostname.includes('fund.eastmoney.com') || url.hostname.includes('fundf10.eastmoney.com')){
    return; // let browser handle normally
  }

  // CDN resources - cache first, then network
  if(CDN_URLS.some(cdn => e.request.url.startsWith(cdn))){
    e.respondWith(
      caches.match(e.request).then(cached => {
        if(cached) return cached;
        return fetch(e.request).then(resp => {
          if(resp.ok){
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          }
          return resp;
        });
      })
    );
    return;
  }

  // App assets - network first, fallback to cache
  e.respondWith(
    fetch(e.request).then(resp => {
      if(resp.ok){
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
      }
      return resp;
    }).catch(() => caches.match(e.request))
  );
});
