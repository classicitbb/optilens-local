"use strict";

// Dev preview support: a safe, hot-reloading way to run the app while editing it.
//
// A dev preview is a second instance of the real server. It must never behave like the
// production service: no background workers, no source write-back, no self-update, no
// host stop/restart. This module owns that rule (applyDevPreviewEnv) and the browser
// live reload (SSE feed + a tiny client script injected into served HTML).

const fs = require("node:fs");
const path = require("node:path");

const EVENTS_PATH = "/__dev/events";
const CLIENT_PATH = "/__dev/client.js";
const DEFAULT_DEV_PORT = 8090;
const HEARTBEAT_MS = 25000;
const LIVE_HOST_FRESH_MS = 15 * 60 * 1000;

function isDevPreview(env = process.env) {
  return ["1", "true", "on", "yes"].includes(String(env.OPTILENS_DEV_PREVIEW || "").toLowerCase());
}

// Called first thing in server.js, before lib/config reads the environment. Values set here
// win over .env because the .env loader only fills variables that are still undefined.
function applyDevPreviewEnv(env = process.env) {
  if (!isDevPreview(env)) return false;
  Object.assign(env, {
    OPTILENS_WRITEBACK_ENABLED: "false",
    OPTILENS_SUPPLIER_STATUS_AUTO_APPLY: "false",
    OPTILENS_SUPPLIER_EXCEPTION_DIGEST_ENABLED: "false",
    OPTILENS_PRIVILEGED_DATA_ACCESS_ENABLED: "false",
    OPTILENS_AUTO_APPLY_UPDATES: "false",
    OPTILENS_SYNC_WORKER: "off",
    OPTILENS_QBO_WORKER: "off"
  });
  env.OPTILENS_HOST = env.OPTILENS_DEV_HOST || "127.0.0.1";
  env.OPTILENS_PORT = env.OPTILENS_DEV_PORT || String(DEFAULT_DEV_PORT);
  delete env.PORT;
  // Optional: point the preview at a scratch app database instead of the production one.
  if (env.OPTILENS_DEV_DB_NAME) env.OPTILENS_DB_NAME = env.OPTILENS_DEV_DB_NAME;
  return true;
}

// True when this checkout is the one the production service runs from. The host watchdog
// writes data/watchdog.log every minute, so a fresh log is a reliable tell without any
// host-specific configuration.
function looksLikeLiveHost(root, { now = Date.now(), env = process.env } = {}) {
  if (env.OPTILENS_LIVE_CHECKOUT && path.resolve(env.OPTILENS_LIVE_CHECKOUT) === path.resolve(root)) return true;
  try {
    return now - fs.statSync(path.join(root, "data", "watchdog.log")).mtimeMs < LIVE_HOST_FRESH_MS;
  } catch {
    return false;
  }
}

// Decides how the browser reacts to a changed file: swap stylesheets in place, reload the
// page, or ignore it (editor scratch files, dependencies, packed artifacts).
function classifyChange(relativePath) {
  const rel = String(relativePath || "").replaceAll("\\", "/").replace(/^\.?\//, "");
  if (!rel) return null;
  if (/(^|\/)(node_modules|\.git)(\/|$)/.test(rel)) return null;
  const base = rel.split("/").pop();
  if (/(~|\.swp|\.swx|\.tmp|\.bak-.*)$/.test(base) || base.startsWith(".#") || /^\d+$/.test(base)) return null;
  if (/\.(crx|pem|map|log)$/.test(base)) return null;
  return base.endsWith(".css") ? "css" : "reload";
}

// Merges a burst of changes (a save usually fires several events) into one browser action.
function summarizeChanges(changes) {
  const files = [...changes.keys()];
  if (!files.length) return null;
  const type = [...changes.values()].every((kind) => kind === "css") ? "css" : "reload";
  return { type, files };
}

function createLiveReload({ root, watchDirs = ["public", "templates"], debounceMs = 80, watch = fs.watch } = {}) {
  const clients = new Set();
  const watchers = [];
  const pending = new Map();
  let timer = null;

  function broadcast(change) {
    const frame = `event: ${change.type}\ndata: ${JSON.stringify({ files: change.files })}\n\n`;
    for (const res of clients) res.write(frame);
  }

  function flush() {
    timer = null;
    const change = summarizeChanges(pending);
    pending.clear();
    if (change) broadcast(change);
  }

  function onFileEvent(dir, name) {
    if (!name) return;
    const rel = `${dir}/${String(name).replaceAll("\\", "/")}`;
    const kind = classifyChange(rel);
    if (!kind) return;
    pending.set(rel, kind);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    timer.unref?.();
  }

  for (const dir of watchDirs) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    try {
      const watcher = watch(full, { recursive: true }, (_event, name) => onFileEvent(dir, name));
      watcher.on?.("error", () => {});
      watchers.push(watcher);
    } catch (error) {
      console.error(`Live reload could not watch ${dir}: ${error.message}`);
    }
  }

  function handle(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("retry: 400\n: connected\n\n");
    clients.add(res);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    heartbeat.unref?.();
    req.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  }

  function close() {
    if (timer) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    for (const res of clients) res.end();
    clients.clear();
  }

  return { handle, close, broadcast, clientCount: () => clients.size };
}

// Same-origin script (the CSP allows 'self'). It swaps stylesheets on CSS saves, reloads on
// anything else, and reloads once when the feed reconnects after a server restart.
const CLIENT_SOURCE = `(() => {
  const pill = document.createElement("div");
  Object.assign(pill.style, {
    position: "fixed", left: "10px", bottom: "10px", zIndex: "2147483647", pointerEvents: "none",
    padding: "3px 9px", borderRadius: "999px", font: "600 11px/1.4 system-ui, sans-serif",
    letterSpacing: ".04em", color: "#fff", background: "#b45309", opacity: ".92"
  });
  const setPill = (text, color) => { pill.textContent = text; if (color) pill.style.background = color; };
  setPill("DEV PREVIEW \\u00b7 live reload");
  document.addEventListener("DOMContentLoaded", () => document.body.appendChild(pill));

  const swapStyles = () => {
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      let url;
      try { url = new URL(link.href); } catch { continue; }
      if (url.origin !== location.origin) continue;
      url.searchParams.set("_dev", Date.now());
      const next = link.cloneNode();
      next.href = url.toString();
      next.onload = () => link.remove();
      link.after(next);
    }
  };

  let hadError = false;
  const source = new EventSource(${JSON.stringify(EVENTS_PATH)});
  source.addEventListener("css", () => { setPill("DEV PREVIEW \\u00b7 styles updated", "#15803d"); swapStyles(); });
  source.addEventListener("reload", () => { setPill("DEV PREVIEW \\u00b7 reloading\\u2026", "#15803d"); location.reload(); });
  source.onerror = () => { hadError = true; setPill("DEV PREVIEW \\u00b7 server restarting\\u2026", "#b91c1c"); };
  source.onopen = () => { if (hadError) location.reload(); };
})();
`;

function sendClient(res) {
  res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
  res.end(CLIENT_SOURCE);
}

function injectClient(html) {
  const tag = `<script src="${CLIENT_PATH}"></script>`;
  const text = Buffer.isBuffer(html) ? html.toString("utf8") : String(html);
  if (text.includes(CLIENT_PATH)) return text;
  const closing = text.search(/<\/body\s*>/i);
  return closing === -1 ? text + tag : text.slice(0, closing) + tag + text.slice(closing);
}

module.exports = {
  EVENTS_PATH,
  CLIENT_PATH,
  DEFAULT_DEV_PORT,
  isDevPreview,
  applyDevPreviewEnv,
  looksLikeLiveHost,
  classifyChange,
  summarizeChanges,
  createLiveReload,
  sendClient,
  injectClient
};
