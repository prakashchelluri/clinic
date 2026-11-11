// The app shell for a reload with no internet: always the network first, the last copy only when the network fails.
// Patient data (/api) is never cached here; the app keeps its own last-loaded copy (web/src/offline.ts).
// ponytail: one cache that only grows with old hashed assets; prune by age if it ever matters.
const CACHE = 'cubott-shell';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const r = e.request; const u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(r).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r.mode === 'navigate' ? '/' : r, copy)); }
    return res;
  }).catch(() => caches.match(r.mode === 'navigate' ? '/' : r).then((hit) => hit ?? Response.error())));
});
