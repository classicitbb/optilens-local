"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const preview = require("../lib/dev-preview");

test("dev preview mode forces every production-touching switch off and moves to its own port", () => {
  const env = {
    OPTILENS_DEV_PREVIEW: "1",
    OPTILENS_WRITEBACK_ENABLED: "true",
    OPTILENS_PRIVILEGED_DATA_ACCESS_ENABLED: "true",
    OPTILENS_AUTO_APPLY_UPDATES: "true",
    OPTILENS_SYNC_WORKER: "on",
    OPTILENS_QBO_WORKER: "on",
    OPTILENS_PORT: "8080",
    OPTILENS_HOST: "0.0.0.0",
    PORT: "9999"
  };
  assert.equal(preview.applyDevPreviewEnv(env), true);
  assert.equal(env.OPTILENS_WRITEBACK_ENABLED, "false");
  assert.equal(env.OPTILENS_PRIVILEGED_DATA_ACCESS_ENABLED, "false");
  assert.equal(env.OPTILENS_AUTO_APPLY_UPDATES, "false");
  assert.equal(env.OPTILENS_SYNC_WORKER, "off");
  assert.equal(env.OPTILENS_QBO_WORKER, "off");
  assert.equal(env.OPTILENS_HOST, "127.0.0.1");
  assert.equal(env.OPTILENS_PORT, String(preview.DEFAULT_DEV_PORT));
  assert.equal(env.PORT, undefined);
});

test("a normal start is left exactly as configured", () => {
  const env = { OPTILENS_WRITEBACK_ENABLED: "true", OPTILENS_PORT: "8080" };
  assert.equal(preview.applyDevPreviewEnv(env), false);
  assert.deepEqual(env, { OPTILENS_WRITEBACK_ENABLED: "true", OPTILENS_PORT: "8080" });
});

test("dev preview honours an explicit port, host and scratch database", () => {
  const env = { OPTILENS_DEV_PREVIEW: "true", OPTILENS_DEV_PORT: "8123", OPTILENS_DEV_HOST: "0.0.0.0", OPTILENS_DEV_DB_NAME: "optilens_scratch", OPTILENS_DB_NAME: "optilens_local" };
  preview.applyDevPreviewEnv(env);
  assert.equal(env.OPTILENS_PORT, "8123");
  assert.equal(env.OPTILENS_HOST, "0.0.0.0");
  assert.equal(env.OPTILENS_DB_NAME, "optilens_scratch");
});

test("looksLikeLiveHost trusts a fresh watchdog log, ignores a stale or missing one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-live-"));
  assert.equal(preview.looksLikeLiveHost(root, { env: {} }), false);
  fs.mkdirSync(path.join(root, "data"));
  const log = path.join(root, "data", "watchdog.log");
  fs.writeFileSync(log, "tick");
  assert.equal(preview.looksLikeLiveHost(root, { env: {} }), true);
  assert.equal(preview.looksLikeLiveHost(root, { env: {}, now: Date.now() + 60 * 60 * 1000 }), false);
  assert.equal(preview.looksLikeLiveHost(root, { env: { OPTILENS_LIVE_CHECKOUT: root }, now: Date.now() + 60 * 60 * 1000 }), true);
});

test("classifyChange swaps styles, reloads for pages, and ignores noise", () => {
  assert.equal(preview.classifyChange("public/styles/pages/automation.css"), "css");
  assert.equal(preview.classifyChange("public\\automation.html"), "reload");
  assert.equal(preview.classifyChange("public/app.js"), "reload");
  assert.equal(preview.classifyChange("public/.automation.html.swp"), null);
  assert.equal(preview.classifyChange("public/app.js~"), null);
  assert.equal(preview.classifyChange("public/extensions/beswift-co-beta.crx"), null);
  assert.equal(preview.classifyChange("public/assets/ui/app.js.map"), null);
  assert.equal(preview.classifyChange("node_modules/x/index.js"), null);
});

test("a burst of changes becomes one browser action; any non-css change forces a reload", () => {
  assert.deepEqual(preview.summarizeChanges(new Map([["a.css", "css"], ["b.css", "css"]])), { type: "css", files: ["a.css", "b.css"] });
  assert.equal(preview.summarizeChanges(new Map([["a.css", "css"], ["b.html", "reload"]])).type, "reload");
  assert.equal(preview.summarizeChanges(new Map()), null);
});

test("injectClient adds the live reload script once, before </body>", () => {
  const html = "<html><body><h1>Hi</h1></body></html>";
  const once = preview.injectClient(html);
  assert.match(once, /<script src="\/__dev\/client\.js"><\/script><\/body>/);
  assert.equal(preview.injectClient(once), once);
  assert.match(preview.injectClient("<p>fragment</p>"), /<\/script>$/);
  assert.match(preview.injectClient(Buffer.from(html)), /__dev\/client\.js/);
});

test("the live reload feed streams a css event for a stylesheet save and a reload event for a page save", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-reload-"));
  fs.mkdirSync(path.join(root, "public"));
  const callbacks = [];
  const liveReload = preview.createLiveReload({
    root,
    watchDirs: ["public"],
    debounceMs: 5,
    watch: (_dir, _options, callback) => {
      callbacks.push(callback);
      return { close() {}, on() {} };
    }
  });
  const server = http.createServer((req, res) => liveReload.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { liveReload.close(); server.close(); });

  const received = [];
  const req = http.get({ host: "127.0.0.1", port: server.address().port, path: preview.EVENTS_PATH });
  const response = await new Promise((resolve) => req.on("response", resolve));
  assert.match(response.headers["content-type"], /text\/event-stream/);
  response.setEncoding("utf8");
  response.on("data", (chunk) => received.push(chunk));
  t.after(() => req.destroy());

  const waitFor = async (pattern) => {
    for (let i = 0; i < 100; i++) {
      if (pattern.test(received.join(""))) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`never received ${pattern}; got ${JSON.stringify(received.join(""))}`);
  };

  await waitFor(/: connected/);
  callbacks[0]("change", "styles/pages/automation.css");
  await waitFor(/event: css\ndata: \{"files":\["public\/styles\/pages\/automation\.css"\]\}/);
  callbacks[0]("change", "automation.html");
  await waitFor(/event: reload/);
});
