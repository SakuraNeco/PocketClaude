// Bump to invalidate the cached shell after an asset changes.
const CACHE = 'pocketclaude-v5';
const SHELL = [
  '/', '/index.html', '/viewer.html', '/app.webmanifest', '/icon.svg',
  '/assets/marked.min.js', '/assets/highlight.min.js', '/assets/purify.min.js',
  '/assets/github-dark.min.css', '/assets/tabler-icons.min.css',
  '/assets/fonts/tabler-icons.woff2',
];
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
});
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('push', (e) => {
  let data = { title: 'PocketClaude', body: '通知' };
  try { data = { ...data, ...(e.data?.json() || {}) }; } catch {}
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: data.tag || 'pocketclaude',
    renotify: true,
    vibrate: [200, 100, 200],
    data,
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const sid = e.notification.data?.sessionId || '';
  const url = sid ? '/?session=' + encodeURIComponent(sid) : '/';
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { try { c.postMessage({ type: 'open-session', sessionId: sid }); } catch {} return c.focus(); }
    }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});

// HTML → network-first (updates apply on the FIRST reload; cache only as the
// offline fallback). Static libs/fonts → cache-first with background refresh.
// Everything dynamic (API, /media, /files, /proxy, auth, WS) is untouched.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const isHtml = ['/', '/index.html', '/viewer.html'].includes(url.pathname);
  const isStatic = url.pathname.startsWith('/assets/') || ['/app.webmanifest', '/icon.svg'].includes(url.pathname);
  if (!isHtml && !isStatic) return;   // dynamic → straight to the network

  if (isHtml) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh.ok) (await caches.open(CACHE)).put(req, fresh.clone());
        return fresh;
      } catch {
        return (await caches.match(req)) || caches.match('/index.html');
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) {
      e.waitUntil((async () => {
        try { const fresh = await fetch(req); if (fresh.ok) (await caches.open(CACHE)).put(req, fresh.clone()); } catch {}
      })());
      return cached;
    }
    try {
      const fresh = await fetch(req);
      if (fresh.ok) (await caches.open(CACHE)).put(req, fresh.clone());
      return fresh;
    } catch {
      return caches.match(req);
    }
  })());
});
