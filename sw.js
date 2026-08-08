// ============================================================================
// SERVICE WORKER — caches the app shell so Dashboard and recent reads stay
// viewable offline (spec §14). Data (Supabase calls) is never cached here —
// only the static shell. Bump CACHE_NAME on every deploy to invalidate.
// ============================================================================

const CACHE_NAME = "tasty-vadapav-shell-v2";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/styles.css",
  "./js/app.js",
  "./js/auth.js",
  "./js/config.js",
  "./js/supabase-client.js",
  "./js/offline-queue.js",
  "./js/backup.js",
  "./js/financial-engine.js",
  "./icons/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never intercept Supabase API calls — those need real network semantics
  // (auth headers, live errors) so the app's own offline-queue logic can react.
  if (url.hostname.endsWith("supabase.co") || url.hostname.endsWith("esm.sh")) {
    return;
  }

  // App shell: cache-first, falling back to network, so the last-deployed
  // shell always loads even with no connection.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => caches.match("./index.html"));
    })
  );
});
