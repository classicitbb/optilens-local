// Site bridge — runs ONLY on the OptiLens app origins (never on BeSwift).
//
// A web page cannot enumerate installed extensions, so the app has no way to
// know whether this extension is present or current. This script closes that
// gap: it announces the extension's identity/version to the page, and answers
// pings from the Delivery & Export tab row's plugin checker.
//
// It also asks the browser for an immediate update check on every page load,
// which is what makes "keeps it up to date each time the site is loaded" true
// for a policy-installed build: Edge otherwise only polls the update manifest
// on its own multi-hour schedule.
//
// Deliberately minimal surface: it exposes a version string and nothing else,
// and only ever responds to pings — the page cannot make it act on BeSwift.
(() => {
  const manifest = chrome.runtime.getManifest();
  const INFO = {
    id: chrome.runtime.id,
    version: manifest.version,
    name: manifest.name,
    channel: "beta"
  };

  // Synchronous marker, set at document_start so the page can read it even
  // before its own scripts run.
  const announce = () => {
    const root = document.documentElement;
    if (!root) return;
    root.dataset.optilensBeswiftExt = INFO.version;
    root.dataset.optilensBeswiftExtId = INFO.id;
  };
  announce();
  document.addEventListener("DOMContentLoaded", announce, { once: true });

  // Ping/pong for the checker. Same-window messages only, and we ignore
  // anything that isn't our own request type.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== "optilens-beswift-ext-ping") return;
    window.postMessage({ type: "optilens-beswift-ext-pong", info: INFO }, window.location.origin);
  });

  // Nudge Edge to pull the self-hosted update manifest now rather than on its
  // own schedule. Only meaningful for a packed/policy-installed build; on an
  // unpacked dev load this throws, which is fine and ignored.
  try {
    chrome.runtime.requestUpdateCheck?.(() => void chrome.runtime.lastError);
  } catch {
    /* unpacked load — updates come from the file-fingerprint self-reload instead */
  }

  window.postMessage({ type: "optilens-beswift-ext-pong", info: INFO }, window.location.origin);
})();
