const CACHE_NAME = "optilens-local-v2";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/styles/tokens.css",
  "/styles/base.css",
  "/styles/components.css",
  "/styles/shell.css",
  "/styles/pages/business-metrics.css",
  "/styles/pages/credentials.css",
  "/styles/pages/doc-studio.css",
  "/styles/pages/integrations.css",
  "/styles/pages/login.css",
  "/styles/pages/pricing-automation.css",
  "/styles/pages/release-notes.css",
  "/styles/pages/statement-template.css",
  "/app.js",
  "/delivery-export.html",
  "/delivery-export.js",
  "/pricing-automation.html",
  "/pricing-automation.js",
  "/pwa.js",
  "/manifest.webmanifest",
  "/icons/optilens.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== "GET" || url.pathname.startsWith("/api/")) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/")))
  );
});
