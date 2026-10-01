const CACHE = 'agenda-v12';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'shared.js', 'config.js', 'manifest.json', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Réseau d'abord (toujours la dernière version), cache en secours hors connexion.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    // no-cache : on revalide toujours auprès du serveur (sinon le cache HTTP de GitHub Pages peut garder l'ancienne version ~10 min)
    fetch(e.request.mode === 'navigate' ? e.request : new Request(e.request, { cache: 'no-cache' }))
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// Notifications envoyées par le serveur.
self.addEventListener('push', e => {
  let d = { title: 'Agenda', body: '' };
  try { d = e.data.json(); } catch (err) { /* message vide */ }
  e.waitUntil(self.registration.showNotification(d.title || 'Agenda', {
    body: d.body || '',
    tag: d.tag || 'agenda',
    icon: 'icons/icon-192.png',
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      return clients.openWindow('./');
    })
  );
});
