const CACHE='pdh-v77';
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/','/offline.html']))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(resp => {
        if (resp.ok) caches.open(CACHE).then(c=>c.put(e.request, resp.clone()));
        return resp;
      }).catch(()=> cached || caches.match('/offline.html'));
      return cached || fetchPromise;
    }).catch(()=> caches.match('/offline.html'))
  );
});
