const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { applySiteSettings, createSiteSettingsStore, missingForRelease, normaliseSiteSettings, siteSettings } = require("../lib/site-settings");
const { createRxCaptureService } = require("../lib/rx-capture/service");

const ROOT = path.join(__dirname, "..");
const restricted = { restricted: true };
const full = { restricted: false };

function memoryStore(initial = {}, edition = full) {
  const map = new Map(Object.entries(initial));
  const store = createSiteSettingsStore({
    getSetting: async (key) => map.get(key) ?? null,
    setSetting: async (key, value) => { map.set(key, value); },
    getEdition: () => edition
  });
  return { map, store };
}

test("saved values are cleaned, blanks are dropped, and bad values are refused with a reason", () => {
  assert.deepEqual(
    normaliseSiteSettings({ labNum: " 1234 ", custSeqNum: "1", remoteOperator: "VO-001", agentName: "", incomingFolder: "D:\\Innovations\\Incoming" }),
    { labNum: "1234", custSeqNum: "1", remoteOperator: "VO-001", incomingFolder: "D:\\Innovations\\Incoming" }
  );
  assert.deepEqual(normaliseSiteSettings(null), {});
  assert.equal(normaliseSiteSettings({ incomingFolder: "\\\\vo-server\\Innovations\\Incoming" }).incomingFolder, "\\\\vo-server\\Innovations\\Incoming");
  assert.equal(normaliseSiteSettings({ stagingFolder: "./output/rx/staging" }).stagingFolder, "./output/rx/staging");
  const refused = [
    [{ labNum: "12 34" }, /Lab number/],
    [{ custSeqNum: "one" }, /number/],
    [{ incomingFolder: "Incoming" }, /full path/],
    [{ archiveFolder: "C:\\a<b" }, /cannot have/],
    [{ remoteOperator: "Zoë" }, /plain letters/],
    [{ labNum: "1".repeat(31) }, /30 characters/]
  ];
  for (const [input, message] of refused) assert.throws(() => normaliseSiteSettings(input), (error) => error.statusCode === 400 && message.test(error.message), JSON.stringify(input));
});

test("saved settings sit over the checked-in defaults and leave untouched fields alone", () => {
  const base = { defaults: { labNum: "1177", custSeqNum: "1", remoteOperator: "1177-004", agentName: "LL", shipName: "Enhance Vision Optical" }, folders: { staging: "./output/rx/staging", archive: "./output/rx/archive", incoming: "\\\\classic\\Incoming" }, output: { extension: ".rx" } };
  assert.equal(applySiteSettings(base, null), base);
  assert.equal(applySiteSettings(base, {}), base);
  const merged = applySiteSettings(base, { labNum: "4321", remoteOperator: "VO-7", incomingFolder: "D:\\Innovations\\Incoming" });
  assert.equal(merged.defaults.labNum, "4321");
  assert.equal(merged.defaults.remoteOperator, "VO-7");
  assert.equal(merged.defaults.agentName, "LL");
  assert.equal(merged.defaults.shipName, "Enhance Vision Optical");
  assert.equal(merged.folders.incoming, "D:\\Innovations\\Incoming");
  assert.equal(merged.folders.staging, "./output/rx/staging");
  assert.deepEqual(merged.output, base.output);
  assert.equal(base.defaults.labNum, "1177", "the checked-in defaults are never changed");
});

test("saving persists the cleaned settings and a restart reads them back", async () => {
  const { map, store } = memoryStore();
  assert.equal(await store.refresh(), null);
  const saved = await store.save({ labNum: "4321", remoteOperator: " VO-7 ", agentName: "" }, { username: "admin" });
  assert.deepEqual(saved, { labNum: "4321", remoteOperator: "VO-7" });
  assert.deepEqual(store.current(), saved);
  assert.deepEqual(JSON.parse(map.get("rx.site-settings")), saved);

  const restarted = createSiteSettingsStore({ getSetting: async (key) => map.get(key) ?? null, setSetting: async () => {}, getEdition: () => full });
  assert.deepEqual(await restarted.refresh(), saved);

  const corrupted = memoryStore({ "rx.site-settings": "{not json" });
  assert.equal(await corrupted.store.refresh(), null);
  await assert.rejects(store.save({ labNum: "bad value" }, { username: "admin" }), { statusCode: 400 });
  assert.deepEqual(store.current(), saved, "a refused save changes nothing");
});

test("a licensed site cannot submit until it has saved its own lab details; the full edition is unaffected", async () => {
  assert.deepEqual(missingForRelease({}), ["labNum", "remoteOperator", "incomingFolder"]);
  const classic = memoryStore({}, full);
  await classic.store.refresh();
  assert.doesNotThrow(() => classic.store.assertReady());

  const licensed = memoryStore({}, restricted);
  await licensed.store.refresh();
  assert.throws(() => licensed.store.assertReady(), (error) => error.statusCode === 409 && /lab number, remote operator, innovations incoming folder/.test(error.message));
  await licensed.store.save({ labNum: "4321", remoteOperator: "VO-7" }, { username: "admin" });
  assert.throws(() => licensed.store.assertReady(), /incoming folder/);
  await licensed.store.save({ labNum: "4321", remoteOperator: "VO-7", incomingFolder: "D:\\Innovations\\Incoming" }, { username: "admin" });
  assert.doesNotThrow(() => licensed.store.assertReady());
});

test("the RX generator reads the saved settings", async () => {
  const appSettings = require("../lib/app-settings");
  const original = { get: appSettings.getSetting, set: appSettings.setSetting };
  const map = new Map();
  appSettings.getSetting = async (key) => map.get(key) ?? null;
  appSettings.setSetting = async (key, value) => { map.set(key, value); };
  const rxGenerator = require("../lib/rx-generator");
  try {
    await siteSettings.refresh();
    const before = rxGenerator.loadConfig();
    await siteSettings.save({ labNum: "4321", custSeqNum: "2", remoteOperator: "VO-7", agentName: "VO", stagingFolder: "./output/vo/staging" }, { username: "admin" });
    const after = rxGenerator.loadConfig();
    assert.equal(after.defaults.labNum, "4321");
    assert.equal(after.defaults.custSeqNum, "2");
    assert.equal(after.defaults.remoteOperator, "VO-7");
    assert.equal(after.defaults.agentName, "VO");
    assert.equal(after.folders.staging, "./output/vo/staging");
    assert.equal(after.folders.archive, before.folders.archive);
    assert.equal(after.defaults.fileVersion, before.defaults.fileVersion);
  } finally {
    await siteSettings.save({}, { username: "test" });
    appSettings.getSetting = original.get;
    appSettings.setSetting = original.set;
  }
});

test("approval and release stop before touching the database when the site is not ready", async () => {
  const notReady = () => { throw Object.assign(new Error("An administrator must save Site settings first."), { statusCode: 409 }); };
  const service = createRxCaptureService({
    assertSiteReady: notReady,
    getAppPool: async () => { throw new Error("the database must not be reached"); }
  });
  const orderId = "e5132c2e-a170-4958-b495-94121f7f0e08";
  const actor = { userId: "11111111-1111-4111-8111-111111111111", username: "employee" };
  await assert.rejects(service.approveOrder(orderId, actor), { statusCode: 409, message: /Site settings/ });
  await assert.rejects(service.submitOrder(orderId, actor), { statusCode: 409 });
  await assert.rejects(service.releaseOrder(orderId, actor), { statusCode: 409, message: /Site settings/ });
});

test("the site settings routes are administrator-only and the screen is hidden from everyone else", () => {
  const routes = fs.readFileSync(path.join(ROOT, "lib", "rx-capture", "routes.js"), "utf8");
  for (const method of ["GET", "PUT"]) {
    const block = routes.slice(routes.indexOf(`url.pathname === "/api/rx-capture/site-settings" && req.method === "${method}"`));
    assert.match(block.slice(0, 220), /requirePermission\(req, "platform\.admin"\)/, method);
  }
  const check = routes.slice(routes.indexOf('"/api/rx-capture/site-settings/check"'));
  assert.match(check.slice(0, 220), /requirePermission\(req, "platform\.admin"\)/);

  const html = fs.readFileSync(path.join(ROOT, "public", "rx-capture.html"), "utf8");
  const client = fs.readFileSync(path.join(ROOT, "public", "rx-capture.js"), "utf8");
  assert.match(html, /id="siteSettingsButton"[^>]*hidden/);
  assert.match(html, /id="settingsScreen"/);
  assert.match(client, /state\.isAdmin = \(auth\.user\?\.permissions \|\| \[\]\)\.includes\("platform\.admin"\)/);
  assert.match(client, /\$\("#siteSettingsButton"\)\.hidden = !state\.isAdmin/);
});

test("startup loads the saved settings", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(server, /siteSettings\.refresh\(\)\.catch/);
});
