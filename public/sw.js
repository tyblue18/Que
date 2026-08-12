/**
 * Que — Service Worker Bouncer
 *
 * Strategy:
 *  - Install:  pre-cache the app shell (logo, manifest, offline page)
 *  - Activate: purge stale caches
 *  - Fetch:
 *      /api/*          → network-only   (auth cookies must not be cached)
 *      /auth/*         → network-only   (sign-in page always fresh)
 *      navigation      → network-first, fall back to cached shell
 *      static assets   → cache-first, revalidate in background
 */

// Bump this whenever you ship a change to sw.js itself (cache strategy,
// route handling). The activate handler purges every cache whose name
// doesn't match, so a deploy with a fresh version guarantees no stale
// entries linger. JS/CSS hashes already invalidate via network-first below.
const CACHE = 'que-v15';

// Only list assets that definitely exist. NOTE: '/index.html' was removed —
// it existed under the old static export (output:'export') but 404s on the
// App Router, which made cache.addAll() reject and the SW fail to install,
// leaving a previous SW stuck serving a stale build.
const PRECACHE = [
  '/',
  '/Que_logo.png',
  '/badge.png',
  '/notification-icon.png',
  '/manifest.json',
];

/* ── Install: cache app shell ──────────────────────────────────────────
 * NOTE: we do NOT call skipWaiting() unconditionally any more. The new SW
 * stays in "waiting" until the client explicitly asks it to take over via
 * the SKIP_WAITING message (see message listener below). This is what lets
 * the in-app "New version ready — Update" prompt control the timing of the
 * controllerchange + reload — without it, a long-running tab would silently
 * swap workers and could produce a mid-session JS/CSS mismatch.            */
self.addEventListener('install', event => {
  event.waitUntil(
    // Resilient precache: a single missing asset must NEVER abort the install.
    // A failed install leaves the previous SW in control serving stale content
    // (exactly the trap the old static-export '/index.html' caused). allSettled
    // lets every reachable asset cache while ignoring any that 404.
    caches.open(CACHE).then(cache => Promise.allSettled(PRECACHE.map(u => cache.add(u))))
  );
});

/* ── Allow the client to promote the waiting worker on demand ─────────── */
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ── Activate: evict old caches ────────────────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── Push notifications ────────────────────────────────────────────── */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { /* malformed payload */ }
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'Que', {
      body:    data.body ?? '',
      // Large icon (right side): branded dark tile with the Q (looks clean on
      // the dark notification shade, unlike the plain white logo square).
      icon:    data.icon ?? '/notification-icon.png',
      // Small status-bar icon (left): MUST be a monochrome transparent PNG —
      // Android masks it to its alpha. Using the full-color logo here rendered
      // as a blank square; badge.png is a white Q silhouette on transparent.
      badge:   '/badge.png',
      // Same tag → a new reminder of the same kind replaces the old one instead
      // of stacking. Distinct kinds (weigh-in / food / battle) pass their own.
      tag:     data.tag ?? 'que',
      renotify: true,
      vibrate: [60, 40, 60],
      timestamp: Date.now(),
      data:    { url: data.url ?? '/app' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return clients.openWindow(event.notification.data.url);
    })
  );
});

/* ── Fetch: route-based bouncer ────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // API + auth routes — NEVER cache, always hit network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    event.respondWith(fetch(request));
    return;
  }

  // Navigation requests — network-first, fall back to cached root
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        })
        // Offline fallback: the cached page if we have it, else the landing shell.
        .catch(() => caches.match(request).then(r => r || caches.match('/')))
    );
    return;
  }

  // JS / CSS — always network-first so logic updates reach users immediately.
  // Fall back to cache only when offline.
  if (request.method === 'GET' && (
    url.pathname.endsWith('.js') || url.pathname.endsWith('.css')
  )) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // All other static assets (images, fonts, manifest) — cache-first
  if (request.method === 'GET') {
    event.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(request).then(cached => {
          const networkFetch = fetch(request).then(response => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          });
          return cached || networkFetch;
        })
      )
    );
  }
});
