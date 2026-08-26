// ============================================================================
// SERVICE WORKER — caches the app shell so Dashboard and recent reads stay
// viewable offline (spec §14). Data (Supabase calls) is never cached here —
// only the static shell. Bump CACHE_NAME on every deploy to invalidate.
// ============================================================================

<<<<<<< HEAD
const CACHE_NAME = "tasty-vadapav-shell-v17";
=======
const CACHE_NAME = "tasty-vadapav-shell-v16";
>>>>>>> b115528b31c9b2e922ab9f661f430157364e890e
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
  "./js/daily-operations.js",
  "./js/procurement-inventory.js",
  "./js/documents.js",
  "./js/reporting.js",
  "./js/automation.js",
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

  // App shell: network-first so a Cloudflare deployment is visible on the
  // next online launch; the cache remains the offline fallback. Cache-first
  // would otherwise keep an older app.js (and its older navigation/routes)
  // alive after a successful deployment.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && event.request.method === "GET") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});
