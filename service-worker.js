/* DayLog 2.0 — service worker.
 * App-shell cache-first for local assets; network-first for navigations and for
 * the Supabase API so data/auth stay fresh (Supabase remains the source of
 * truth). ESM CDN modules are cached at runtime so the app boots offline after
 * the first successful load.
 *
 * iOS standalone-PWA safety: WebKit throws "Response served by service worker
 * has redirections" if any response passed to respondWith() has
 * response.redirected === true. Hosts like Vercel (cleanUrls) redirect
 * /index.html -> /, so a followed fetch yields a redirected response. Every
 * response this worker serves is passed through cleanResponse() to strip that
 * flag, and navigations are handled explicitly.
 */

const VERSION = "daylog-v2.0.2";
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;

// Canonical shell entry used as the offline navigation fallback.
const APP_SHELL = "./index.html";

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.json",
  "./js/config.js",
  "./js/app.js",
  "./js/supabase.js",
  "./js/auth.js",
  "./js/exporters.js",
  "./js/meetings.js",
  "./js/api/cache.js",
  "./js/api/db.js",
  "./js/api/storage.js",
  "./js/ocr/extract.js",
  "./js/ocr/provider.js",
  "./js/ocr/parse-card.js",
  "./icons/icon.svg",
  "./icons/apple-touch-icon.png",
];

// Rebuild a redirected response into an identical, non-redirected one so it is
// safe to hand to respondWith() inside an iOS standalone PWA.
async function cleanResponse(response) {
  if (!response || !response.redirected) return response;
  const body = await response.blob();
  const headers = new Headers(response.headers);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // Fetch + clean each asset individually so a redirect or one missing
      // optional asset can never poison the cache or fail the whole install.
      await Promise.allSettled(
        SHELL_ASSETS.map(async (url) => {
          try {
            const resp = await fetch(url, { cache: "reload" });
            if (resp.ok) await cache.put(url, await cleanResponse(resp));
          } catch {
            /* ignore individual asset failures */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function isSupabaseApi(url) {
  return url.hostname.endsWith(".supabase.co") &&
    (url.pathname.startsWith("/auth/") ||
     url.pathname.startsWith("/rest/") ||
     url.pathname.startsWith("/storage/") ||
     url.pathname.startsWith("/functions/"));
}

// Navigations: network-first (fresh app shell), fall back to the cached shell
// when offline. Every returned response is cleaned so a host-side redirect
// (e.g. Vercel /index.html -> /) can never surface as a redirected response.
async function handleNavigate(request) {
  try {
    const fresh = await cleanResponse(await fetch(request));
    if (fresh && fresh.ok) {
      const cache = await caches.open(SHELL);
      cache.put(APP_SHELL, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch {
    const cache = await caches.open(SHELL);
    const cached =
      (await cache.match(request, { ignoreSearch: true })) ||
      (await cache.match(APP_SHELL, { ignoreSearch: true })) ||
      (await cache.match("./", { ignoreSearch: true }));
    return (await cleanResponse(cached)) || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Navigation requests (page loads / PWA launch) — handled explicitly.
  if (request.mode === "navigate") {
    event.respondWith(handleNavigate(request));
    return;
  }

  // Never cache Supabase API/auth/storage — always go to network; fall back to
  // an error so the app can render its offline/cached data from IndexedDB.
  if (isSupabaseApi(url)) {
    event.respondWith(fetch(request).catch(() => Response.error()));
    return;
  }

  // Same-origin app shell: cache-first (cached entries are already cleaned).
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) =>
        cached || fetch(request).then(async (resp) => {
          const clean = await cleanResponse(resp);
          const copy = clean.clone();
          caches.open(SHELL).then((c) => c.put(request, copy)).catch(() => {});
          return clean;
        }).catch(() => caches.match(APP_SHELL, { ignoreSearch: true })),
      ),
    );
    return;
  }

  // Cross-origin (ESM CDN, Tesseract): stale-while-revalidate.
  event.respondWith(
    caches.open(RUNTIME).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request).then(async (resp) => {
        if (resp.ok) cache.put(request, (await cleanResponse(resp)).clone());
        return cleanResponse(resp);
      }).catch(() => cached);
      return cached || network;
    }),
  );
});
