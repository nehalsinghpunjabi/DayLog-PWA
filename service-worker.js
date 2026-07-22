/* DayLog 2.0 — service worker.
 * App-shell cache-first for local assets; network-first for Supabase API so
 * data stays fresh (Supabase remains the source of truth). ESM CDN modules are
 * cached at runtime so the app boots offline after the first successful load.
 */

const VERSION = "daylog-v2.0.0";
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.json",
  "./js/app.js",
  "./js/supabase.js",
  "./js/auth.js",
  "./js/exporters.js",
  "./js/meetings.js",
  "./js/api/cache.js",
  "./js/api/db.js",
  "./js/api/storage.js",
  "./js/ocr/provider.js",
  "./js/ocr/parse-card.js",
  "./icons/icon.svg",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) =>
      // Add individually so one missing optional asset can't fail the install.
      Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url))),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

function isSupabaseApi(url) {
  return url.hostname.endsWith(".supabase.co") &&
    (url.pathname.startsWith("/auth/") ||
     url.pathname.startsWith("/rest/") ||
     url.pathname.startsWith("/storage/") ||
     url.pathname.startsWith("/functions/"));
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never cache Supabase API/auth/storage — always go to network; fall back to
  // an error so the app can render its offline/cached data from IndexedDB.
  if (isSupabaseApi(url)) {
    event.respondWith(fetch(request).catch(() => Response.error()));
    return;
  }

  // Same-origin app shell: cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) =>
        cached || fetch(request).then((resp) => {
          const copy = resp.clone();
          caches.open(SHELL).then((c) => c.put(request, copy)).catch(() => {});
          return resp;
        }).catch(() => caches.match("./index.html")),
      ),
    );
    return;
  }

  // Cross-origin (ESM CDN, Tesseract): stale-while-revalidate.
  event.respondWith(
    caches.open(RUNTIME).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request).then((resp) => {
        if (resp.ok) cache.put(request, resp.clone());
        return resp;
      }).catch(() => cached);
      return cached || network;
    }),
  );
});
