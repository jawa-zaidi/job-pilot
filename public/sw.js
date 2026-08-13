// JobPilot service worker — app shell only.
//
// The one rule that matters here: JobPilot's data is live and user-specific, so
// NOTHING under /api/* is ever read from or written to the cache. A stale job
// board, a stale application status or a stale settings response would look like
// a data-loss bug, not a caching win. Those requests are left completely
// untouched (we never call respondWith), so they always go to the network.
//
// Only the static shell — html, css, js, icons, manifest — is cached, under a
// versioned cache name.
//
// ---------------------------------------------------------------------------
// SHIPPING AN UPDATE: bump CACHE_VERSION below. That creates a brand-new cache,
// and activate() deletes every older jobpilot-shell-* cache, so users pick up
// the new index.html / app.js / styles.css on their next load. Nothing else to
// do — there are no hashed filenames to update.
// ---------------------------------------------------------------------------
const CACHE_VERSION = 'v5';
const CACHE_NAME = `jobpilot-shell-${CACHE_VERSION}`;

// Everything needed to paint the app shell with the network unplugged. The
// typefaces are in here because they are bundled, not fetched from a CDN — the
// app has to look right offline, and nothing should leave this machine.
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/offline.html',
  '/manifest.webmanifest',
  '/fonts/instrument-sans-latin.woff2',
  '/fonts/instrument-sans-latin-ext.woff2',
  '/fonts/instrument-serif-latin.woff2',
  '/fonts/instrument-serif-latin-ext.woff2',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-192-maskable.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/icons/favicon-16.png'
];

// Paths whose responses must never touch the cache.
function isLiveData(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Individually, so one missing file can't fail the whole install.
    await Promise.all(SHELL.map(url =>
      cache.add(new Request(url, { cache: 'reload' }))
        .catch(err => console.warn('[sw] could not precache', url, err))
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => n.startsWith('jobpilot-shell-') && n !== CACHE_NAME)
        .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;

  // Anything that isn't a plain GET (POST /api/run, uploads, ...) → untouched.
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // Other origins (job boards, avatars, ...) → untouched.
  if (url.origin !== self.location.origin) return;

  // Live, user-specific data → untouched. No respondWith, no cache, ever.
  if (isLiveData(url.pathname)) return;

  // Navigations: network first so a running server always wins, with the cached
  // shell (then the offline page) as the fallback when the network is gone.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstPage(req));
    return;
  }

  // Static shell assets: serve instantly from cache, refresh in the background.
  event.respondWith(staleWhileRevalidate(req));
});

// Only complete, same-origin, non-redirected 200s go in. Refusing redirects
// matters twice over: a redirect could land somewhere we never meant to store,
// and a cached redirected response can't be replayed to satisfy a navigation.
function cacheable(res) {
  return !!res && res.ok && res.type === 'basic' && !res.redirected;
}

async function networkFirstPage(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(req);
    if (cacheable(fresh)) cache.put(req, fresh.clone());
    return fresh;
  } catch {
    return (await cache.match(req)) ||
           (await cache.match('/index.html')) ||
           (await cache.match('/offline.html')) ||
           Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then(res => {
      if (cacheable(res)) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}
