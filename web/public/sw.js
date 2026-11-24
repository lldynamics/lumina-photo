const CACHE_NAME = 'lumina-shell-v3';
const MAX_ASSET_CACHE_ENTRIES = 80;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function pruneAssetCache(cache) {
  try {
    const keys = await cache.keys();
    const assetKeys = keys.filter((req) => new URL(req.url).pathname.startsWith('/assets/'));
    if (assetKeys.length <= MAX_ASSET_CACHE_ENTRIES) return;
    const toDelete = assetKeys.slice(0, assetKeys.length - MAX_ASSET_CACHE_ENTRIES);
    await Promise.all(toDelete.map((req) => cache.delete(req)));
  } catch {
    // ignore cache pruning errors
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Network-first for HTML navigation; only cache healthy 2xx responses and always return a Response
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(async () => {
          const cached = (await caches.match(req)) || (await caches.match('/'));
          if (cached) return cached;
          return new Response('当前处于离线状态，无法连接到「自己用的一个相册」服务端。', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }),
    );
    return;
  }

  // Fingerprinted Vite build assets are immutable -> cache-first with bounded cache size
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(async (cached) => {
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) {
          const clone = res.clone();
          caches
            .open(CACHE_NAME)
            .then(async (c) => {
              await c.put(req, clone);
              await pruneAssetCache(c);
            })
            .catch(() => {});
        }
        return res;
      }),
    );
    return;
  }

  if (url.pathname === '/icon.svg') {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetched = fetch(req)
          .then((res) => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
            }
            return res;
          })
          .catch(() => cached || new Response('', { status: 404 }));
        return cached || fetched;
      }),
    );
  }
});
