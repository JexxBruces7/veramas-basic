// Service worker Veramas: syarat agar bisa di-install sebagai aplikasi (PWA).
// Halaman & data selalu diambil dari server lokal (network-first). Tampilan terakhir disimpan hanya
// supaya ada pesan rapi bila server sedang mati. Data /api tidak pernah disimpan.
const CACHE = 'veramas-shell-v1', SHELL = ['/', '/ind.js', '/i18n.js', '/manifest.webmanifest', '/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => { })); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return; // API: langsung ke server
  e.respondWith(fetch(e.request).then(r => { if (r.ok && SHELL.includes(u.pathname)) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); } return r; })
    .catch(() => caches.match(e.request).then(m => m || new Response('<!doctype html><meta charset="utf-8"><title>Veramas</title><body style="font-family:system-ui;background:#0a0a12;color:#d8d8e8;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>Server Veramas belum berjalan</h2><p>Jalankan <b>start.bat</b> di folder tradebot-pro, lalu muat ulang.</p></div>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))));
});
