/*
 * Service worker for the Arnis web app.
 *
 * 1. Cross-origin isolation. The engine is multithreaded and needs
 *    SharedArrayBuffer, which browsers only enable for pages sent with
 *    Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers.
 *    GitHub Pages cannot set headers, so this worker adds them to every
 *    same-origin response.
 *
 *    Chromium and Firefox get `COEP: credentialless`, under which map tiles
 *    and other cross-origin images keep loading untouched. Safari only knows
 *    `require-corp`, which blocks cross-origin images that lack a
 *    Cross-Origin-Resource-Policy header, so for Safari this worker re-fetches
 *    such images with CORS (every map tile server Arnis uses allows it) and
 *    marks them as shareable.
 *
 * 2. Offline start. The app shell is cached when the worker installs and
 *    everything else same-origin (including the large engine) as it is first
 *    used. Each deployment gets a fresh cache, named after the build.
 */
'use strict';

// Replaced by web/assemble.mjs at build time.
const VERSION = '__ARNIS_VERSION__';
const PRECACHE = self.__ARNIS_PRECACHE || [];

const CACHE = `arnis-${VERSION}`;

const ua = (self.navigator && self.navigator.userAgent) || '';
// Safari (desktop and every iOS browser) has no `credentialless`.
const credentialless = /Chrome|Chromium|Firefox|CriOS|FxiOS|Edg\//.test(ua) && !/iPhone|iPad|iPod/.test(ua);
const COEP = credentialless ? 'credentialless' : 'require-corp';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // A failed shell file should not stop the worker from installing: the
      // isolation headers matter more than offline start.
      await Promise.all(
        PRECACHE.map((path) => cache.add(new Request(path, { cache: 'reload' })).catch(() => {})),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('arnis-') && key !== CACHE) {
          await caches.delete(key);
        }
      }
      await self.clients.claim();
    })(),
  );
});

function isolate(response) {
  if (!response || response.status === 0 || response.type === 'opaqueredirect') {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', COEP);
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function sameOrigin(request) {
  const cache = await caches.open(CACHE);
  const isPage = request.mode === 'navigate' || request.destination === 'document';

  if (isPage) {
    // Pages: network first, so a new deployment shows up on the next load.
    try {
      const fresh = await fetch(request);
      if (fresh.ok) {
        cache.put(request, fresh.clone()).catch(() => {});
      }
      return isolate(fresh);
    } catch (e) {
      const cached = await cache.match(request, { ignoreSearch: true });
      return isolate(cached || Response.error());
    }
  }

  // Everything else: cache first, filled on first use.
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) {
    return isolate(cached);
  }
  const fresh = await fetch(request);
  if (fresh.ok && request.method === 'GET') {
    cache.put(request, fresh.clone()).catch(() => {});
  }
  return isolate(fresh);
}

// Safari under require-corp: make a cross-origin image usable by fetching it
// with CORS and declaring it shareable.
async function corsImage(request) {
  try {
    const response = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (e) {
    return fetch(request);
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') {
    return;
  }
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(sameOrigin(request));
    return;
  }
  if (!credentialless && request.mode === 'no-cors' && ['image', 'style', 'font'].includes(request.destination)) {
    event.respondWith(corsImage(request));
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') {
    self.skipWaiting();
  }
});
