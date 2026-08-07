const CACHE_NAME = "optilens-local-v10";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/styles/tokens.css",
  "/styles/base.css",
  "/styles/components.css",
  "/styles/shell.css",
  "/styles/pages/business-metrics.css",
  "/styles/pages/inventory.css",
  "/styles/pages/credentials.css",
  "/styles/pages/integrations.css",
  "/styles/pages/login.css",
  "/styles/pages/release-notes.css",
  "/tools/pricing-automation/pricing.css",
  "/styles/pages/statement-template.css",
  "/app.js",
  "/business-metrics.html",
  "/business-metrics-shared.js",
  "/business-metrics-overview.js",
  "/business-metrics-tabs.js",
  "/business-metrics-inventory.js",
  "/delivery-export.html",
  "/delivery-export.js",
  "/beswift-extension-check.js",
  "/modules/pricing-automation",
  "/pricing-automation.html",
  "/tools/pricing-automation/index.html",
  "/tools/pricing-automation/main.js",
  "/tools/pricing-automation/modules/api.js",
  "/tools/pricing-automation/modules/audit-view.js",
  "/tools/pricing-automation/modules/boot.js",
  "/tools/pricing-automation/modules/builder-view.js",
  "/tools/pricing-automation/modules/classification-view.js",
  "/tools/pricing-automation/modules/connectors-view.js",
  "/tools/pricing-automation/modules/pricing-engine-client.js",
  "/tools/pricing-automation/modules/saved-lists.js",
  "/tools/pricing-automation/modules/sourcing-view.js",
  "/tools/pricing-automation/modules/sources-view.js",
  "/tools/pricing-automation/modules/state.js",
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
