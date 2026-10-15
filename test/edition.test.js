const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { ALL_MODULE_IDS, MODULES, canonicalPayload, expandModules, loadEdition, signPayload, verifyManifest } = require("../lib/edition");
const { migrationFiles, migrationPlan } = require("../lib/migrations");

const ROOT = path.join(__dirname, "..");
const keys = crypto.generateKeyPairSync("ed25519");
const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = keys.publicKey.export({ type: "spki", format: "pem" });

function licensed(modules, extra = {}, options = {}) {
  const payload = { edition: "value-optical", licensee: "Value Optical Ltd", modules, issuedAt: "2026-10-15T00:00:00.000Z", expiresAt: null, ...extra };
  return loadEdition({ manifest: { payload, signature: signPayload(payload, privatePem) }, publicKey: publicPem, build: null, ...options });
}

test("the internal full edition enables everything and blocks nothing", () => {
  const edition = loadEdition({ manifest: null, build: null });
  assert.equal(edition.name, "full");
  assert.equal(edition.restricted, false);
  for (const id of ALL_MODULE_IDS) assert.equal(edition.isModuleEnabled(id), true);
  for (const route of ["/api/qbo/anything", "/modules/business-metrics", "/api/unknown/thing", "/not-a-page"]) {
    assert.equal(edition.decide(route).allowed, true, route);
  }
});

test("a signed Value Optical edition serves the core, the vault and RX Capture only", () => {
  const edition = licensed(["rx-capture", "vault"]);
  assert.equal(edition.restricted, true);
  assert.deepEqual(edition.modules.sort(), ["rx-capture", "vault"]);
  const allowed = [
    "/", "/index.html", "/login", "/release-notes", "/settings", "/admin/users",
    "/api/auth/login", "/api/auth/me", "/api/health/live", "/api/monitor/updates", "/api/system/updates", "/api/system/edition",
    "/api/dashboard", "/api/modules", "/api/admin/users", "/api/admin/roles", "/api/admin/migrate",
    "/rx-capture", "/rx-capture.html", "/api/rx-capture/orders", "/api/rx-capture/batches/abc", "/credentials", "/api/vault/state",
    "/rx-capture.js", "/styles/pages/rx-capture.css", "/icons/optilens.svg", "/rx-capture.webmanifest"
  ];
  for (const route of allowed) assert.equal(edition.decide(route).allowed, true, `${route} should be served`);
  const blocked = [
    "/modules/delivery-export", "/delivery-export.html", "/modules/pricing-automation", "/tools/pricing-automation/index.html",
    "/modules/integrations", "/modules/automation", "/modules/business-metrics", "/modules/inventory-intelligence", "/modules/chemistry-clips",
    "/api/delivery/sessions", "/api/pricing/calc", "/api/connectors/live-gateway", "/api/integrations/file-drop-destinations",
    "/api/rx/catalog", "/api/qbo/status", "/api/business-metrics/overview", "/api/inventory/scan", "/api/email/messages",
    "/api/admin/data-access/query", "/api/beswift-extension/status", "/api/v2/price",
    "/modules/anything-else", "/some-new-page", "/api/never-heard-of-it"
  ];
  for (const route of blocked) assert.equal(edition.decide(route).allowed, false, `${route} should answer 404`);
});

test("the longest matching rule wins, so a module cannot be reached through a core prefix", () => {
  const edition = licensed(["rx-capture"]);
  assert.equal(edition.decide("/api/admin/users").allowed, true);
  assert.equal(edition.decide("/api/admin/data-access").allowed, false);
  assert.equal(edition.decide("/api/rx-capture/x").allowed, true);
  assert.equal(edition.decide("/api/rx/x").allowed, false);
  assert.equal(edition.decide("/credentials").allowed, false, "the vault is a module and was not licensed here");
  assert.equal(edition.decide("/API/QBO/status").allowed, false);
  assert.equal(edition.decide("//api//qbo//status").allowed, false);
  assert.equal(edition.decide("/rx-capture/").allowed, true);
});

test("a tampered, unsigned, expired or missing manifest leaves only the core", () => {
  const good = licensed(["rx-capture"]);
  assert.equal(good.isModuleEnabled("rx-capture"), true);

  const payload = { edition: "value-optical", licensee: "Value Optical Ltd", modules: ["rx-capture"], issuedAt: "2026-10-15T00:00:00.000Z", expiresAt: null };
  const signature = signPayload(payload, privatePem);

  const tampered = loadEdition({ manifest: { payload: { ...payload, modules: ["rx-capture", "qbo"] }, signature }, publicKey: publicPem, build: null });
  assert.equal(tampered.name, "unlicensed");
  assert.match(tampered.reason, /signature/);
  assert.equal(tampered.isModuleEnabled("qbo"), false);
  assert.equal(tampered.isModuleEnabled("rx-capture"), false);
  assert.equal(tampered.decide("/api/auth/me").allowed, true);

  const otherKey = crypto.generateKeyPairSync("ed25519");
  const forged = loadEdition({ manifest: { payload, signature: signPayload(payload, otherKey.privateKey.export({ type: "pkcs8", format: "pem" })) }, publicKey: publicPem, build: null });
  assert.match(forged.reason, /signature/);

  const noKey = loadEdition({ manifest: { payload, signature }, publicKey: null, build: null });
  assert.match(noKey.reason, /signature/);

  const expired = licensed(["rx-capture"], { expiresAt: "2026-10-01T00:00:00.000Z" }, { now: () => new Date("2026-10-15T00:00:00Z") });
  assert.match(expired.reason, /expired/);
  assert.equal(expired.isModuleEnabled("rx-capture"), false);
  const notYet = licensed(["rx-capture"], { expiresAt: "2027-10-01T00:00:00.000Z" }, { now: () => new Date("2026-10-15T00:00:00Z") });
  assert.equal(notYet.reason, null);

  // A licensed build must carry a manifest; deleting it must not unlock everything.
  const stripped = loadEdition({ manifest: null, build: { requireManifest: true } });
  assert.equal(stripped.restricted, true);
  assert.match(stripped.reason, /No edition manifest/);
});

test("manifests sign a canonical form so key order and spacing do not matter", () => {
  assert.equal(canonicalPayload({ b: [2, 1], a: { d: null, c: "x" } }), '{"a":{"c":"x","d":null},"b":[2,1]}');
  const payload = { edition: "e", modules: ["rx-capture"] };
  const signature = signPayload(payload, privatePem);
  assert.equal(verifyManifest({ payload: { modules: ["rx-capture"], edition: "e" }, signature }, publicPem), true);
  assert.equal(verifyManifest({ payload, signature: "AAAA" }, publicPem), false);
  assert.equal(verifyManifest({ payload }, publicPem), false);
});

test("enabling a module enables the modules it builds on", () => {
  assert.deepEqual([...expandModules(["email"])].sort(), ["automation", "email"]);
  assert.deepEqual([...expandModules(["delivery-export"])].sort(), ["beswift", "delivery-export"]);
  assert.deepEqual([...expandModules(["rx-capture", "nonsense"])], ["rx-capture"]);
  const edition = licensed(["email"]);
  assert.equal(edition.isModuleEnabled("automation"), true);
});

test("every module names only real modules and owns distinct routes", () => {
  const seen = new Map();
  for (const [id, module] of Object.entries(MODULES)) {
    for (const required of module.requires) assert.ok(MODULES[required], `${id} requires unknown ${required}`);
    for (const prefix of [...module.pages, ...module.api]) {
      assert.ok(prefix.startsWith("/"), `${id}: ${prefix}`);
      assert.equal(seen.has(prefix), false, `${prefix} is claimed by ${seen.get(prefix)} and ${id}`);
      seen.set(prefix, id);
    }
  }
});

test("the full edition runs every migration and Value Optical runs only the core, RX Capture and file-drop files", () => {
  const full = migrationPlan(loadEdition({ manifest: null, build: null }));
  assert.equal(full.length, migrationFiles.length);
  assert.deepEqual(full, migrationFiles.map((entry) => entry.file), "the order is the registry order");

  const vo = migrationPlan(licensed(["rx-capture", "vault"]));
  assert.deepEqual(vo, [
    "002-core-schema.sql", "004-seed-platform.sql", "007-auth-hardening.sql", "009-user-module-access.sql", "010-role-module-access.sql",
    "021-app-settings.sql", "038-retire-legacy-data-sources.sql",
    "043-rx-capture.sql", "044-rx-capture-milestone-2.sql", "045-rx-capture-review-workflow.sql", "046-rx-capture-milestone-4-release.sql",
    "047-file-drop-destinations.sql", "048-rx-capture-innovations-account-mappings.sql", "049-rx-capture-voice-input.sql", "054-rx-capture-bulk-upload.sql"
  ]);
  assert.ok(vo.indexOf("002-core-schema.sql") < vo.indexOf("043-rx-capture.sql"));

  const unlicensed = migrationPlan(loadEdition({ manifest: null, build: { requireManifest: true } }));
  assert.ok(unlicensed.every((file) => migrationFiles.find((entry) => entry.file === file).module === "core"));
});

test("every migration is tagged with the core or a known module", () => {
  const known = new Set(["core", "doc-studio", ...ALL_MODULE_IDS]);
  for (const entry of migrationFiles) assert.ok(known.has(entry.module), `${entry.file} has unknown module ${entry.module}`);
});

test("the committed public key is a usable Ed25519 key and no private key is in the repository", () => {
  const publicKey = fs.readFileSync(path.join(ROOT, "lib", "edition-public-key.pem"), "utf8");
  assert.equal(crypto.createPublicKey(publicKey).asymmetricKeyType, "ed25519");
  const tracked = fs.readdirSync(path.join(ROOT, "lib")).filter((name) => name.endsWith(".pem"));
  for (const name of tracked) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "lib", name), "utf8"), /PRIVATE KEY/);
});

test("the server applies the edition before any route and starts only licensed workers", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const gate = server.indexOf("getEdition().decide(url.pathname)");
  assert.ok(gate > 0, "the gate exists");
  assert.ok(gate < server.indexOf("handleRxCaptureRoute({ req, res, url"), "the gate runs before module routes");
  assert.ok(gate < server.indexOf('url.pathname === "/api/auth/bootstrap-state"'), "the gate runs before auth routes");
  assert.match(server, /edition\.isModuleEnabled\("automation"\)[\s\S]{0,80}startSupplierMailboxPoller/);
  assert.match(server, /edition\.isModuleEnabled\("email"\)\) startEmailSync\(\)/);
  assert.match(server, /edition\.isModuleEnabled\("integrations"\)\) startLiveGatewayOnBoot\(\)/);
  const dashboard = fs.readFileSync(path.join(ROOT, "lib", "dashboard.js"), "utf8");
  assert.match(dashboard, /getEdition\(\)\.isModuleEnabled\(module\.id\)/);
  const auth = fs.readFileSync(path.join(ROOT, "lib", "auth.js"), "utf8");
  assert.match(auth, /getEdition\(\)\.isModuleEnabled\(module\.code\)/);
});
