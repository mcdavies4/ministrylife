// Ministry Life service worker: lets the game load and play offline after the first visit.
// Pages always try the network first, so a new deploy shows up on the next online visit.
const VERSION = 'ml-v1';
const CORE = ['/', '/site.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(CORE.map(u => c.add(new Request(u, { mode: u.startsWith('http') ? 'cors' : 'same-origin' })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.hostname.endsWith('workers.dev')) return;            // live votes and stats: never cached
  if (url.pathname.endsWith('.mp3') || req.headers.has('range')) return;   // audio streams straight from the network
  const sameOrigin = url.origin === self.location.origin;
  const cdn = /cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.hostname);
  if (!sameOrigin && !cdn) return;

  const admin = url.pathname.startsWith('/admin');
  if (admin) return;                                            // the dashboard is always live
  if (req.mode === 'navigate' || (sameOrigin && (url.pathname === '/' || url.pathname.endsWith('.html')))) {
    // network first, fall back to the cached game
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put('/index.html', copy)); }
      return res;
    }).catch(() => caches.match('/index.html').then(r => r || caches.match('/'))));
    return;
  }
  // everything else: cache first, refresh in the background
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(res => { if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return res; }).catch(() => hit);
    return hit || net;
  }));
});
