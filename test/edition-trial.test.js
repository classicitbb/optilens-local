const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-trial-"));
process.env.OPTILENS_EDITION_CLOCK_FILE = path.join(scratch, "clock.json");
const { loadEdition, signPayload } = require("../lib/edition");
const { inactivePageHtml, refreshManifest, renewalStatus } = require("../lib/edition-renewal");

const keys = crypto.generateKeyPairSync("ed25519");
const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = keys.publicKey.export({ type: "spki", format: "pem" });
const DAY = 86400000;
const NOW = Date.parse("2026-10-16T12:00:00Z");

function sign(overrides = {}) {
  const payload = {
    edition: "value-optical",
    licensee: "Value Optical Ltd",
    licenceId: "value-optical-abc123",
    modules: ["rx-capture", "vault"],
    issuedAt: "2026-10-16T00:00:00.000Z",
    expiresAt: new Date(NOW + 30 * DAY).toISOString(),
    trial: true,
    renewUrl: "https://licences.example.com/value-optical.json",
    ...overrides
  };
  for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
  return { payload, signature: signPayload(payload, privatePem) };
}

function load(manifest, at = NOW) {
  return loadEdition({ manifest, publicKey: publicPem, build: null, now: () => new Date(at) });
}

test("a trial serves its modules and counts the days left", () => {
  const edition = load(sign());
  assert.equal(edition.reason, null);
  assert.equal(edition.isModuleEnabled("rx-capture"), true);
  const described = edition.describe(NOW);
  assert.equal(described.trial, true);
  assert.equal(described.daysLeft, 30);
  assert.equal(described.remoteRenewal, true);
  assert.equal(edition.describe(NOW + 29.5 * DAY).daysLeft, 1);
});

test("when the trial ends the modules stop and the reason says so", () => {
  const manifest = sign();
  const edition = load(manifest, NOW + 31 * DAY);
  assert.equal(edition.reason, "The trial period has ended.");
  assert.equal(edition.isModuleEnabled("rx-capture"), false);
  assert.equal(edition.decide("/api/auth/me").allowed, true, "sign-in and the dashboard still work");
  assert.equal(edition.decide("/api/rx-capture/orders").allowed, false);
  assert.equal(edition.decide("/api/rx-capture/orders").module, "rx-capture");
  assert.equal(edition.describe(NOW + 31 * DAY).daysLeft, null);
  assert.equal(load(manifest, Date.parse(manifest.payload.expiresAt)).reason, "The trial period has ended.", "ends at the stated instant");
});

test("a paid licence is not a trial, and a withdrawn one serves only the core", () => {
  const paid = load(sign({ trial: false, expiresAt: new Date(NOW + 365 * DAY).toISOString() }));
  assert.equal(paid.describe(NOW).trial, false);
  assert.equal(paid.isModuleEnabled("rx-capture"), true);
  const revoked = load(sign({ revoked: true }));
  assert.equal(revoked.reason, "This licence has been withdrawn.");
  assert.equal(revoked.isModuleEnabled("rx-capture"), false);
});

test("a clock set back below the latest time this site has seen does not extend a trial", () => {
  const manifest = sign({ expiresAt: new Date(Date.now() + 5 * DAY).toISOString() });
  fs.writeFileSync(process.env.OPTILENS_EDITION_CLOCK_FILE, JSON.stringify({ highWater: Date.now() + 10 * DAY }));
  const edition = loadEdition({ manifest, publicKey: publicPem, build: null });
  assert.equal(edition.reason, "The trial period has ended.");
  fs.rmSync(process.env.OPTILENS_EDITION_CLOCK_FILE, { force: true });
  assert.equal(loadEdition({ manifest, publicKey: publicPem, build: null }).reason, null, "without a record the real clock decides");
});

function site(manifest) {
  const dir = fs.mkdtempSync(path.join(scratch, "site-"));
  const file = path.join(dir, "edition.json");
  fs.writeFileSync(file, JSON.stringify(manifest));
  return file;
}

function server(body, init = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (init.throws) throw new Error(init.throws);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ok: init.status ? init.status < 400 : true, status: init.status || 200, headers: new Map(), text: async () => text };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

async function renew(file, fetchImpl) {
  let changed = 0;
  const result = await refreshManifest({ manifestFile: file, fetchImpl, publicKey: publicPem, onChange: () => { changed += 1; } });
  return { ...result, changed };
}

test("paying converts the trial: a newer signed manifest replaces the file", async () => {
  const file = site(sign());
  const paid = sign({ trial: false, issuedAt: "2026-10-20T00:00:00.000Z", expiresAt: new Date(NOW + 365 * DAY).toISOString() });
  const fetchImpl = server(paid);
  const result = await renew(file, fetchImpl);
  assert.equal(result.status, "updated");
  assert.equal(result.changed, 1);
  assert.equal(fetchImpl.calls[0], "https://licences.example.com/value-optical.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), paid);
  assert.equal(renewalStatus().status, "updated");
  assert.equal(load(JSON.parse(fs.readFileSync(file, "utf8")), NOW + 60 * DAY).reason, null, "still licensed after the old trial date");
});

test("an ended trial can still be revived by payment", async () => {
  const file = site(sign({ expiresAt: new Date(NOW - DAY).toISOString() }));
  const paid = sign({ trial: false, issuedAt: "2026-10-20T00:00:00.000Z", expiresAt: new Date(NOW + 365 * DAY).toISOString() });
  assert.equal((await renew(file, server(paid))).status, "updated");
});

test("the vendor can withdraw a licence the same way", async () => {
  const file = site(sign());
  const result = await renew(file, server(sign({ revoked: true, issuedAt: "2026-10-18T00:00:00.000Z" })));
  assert.equal(result.status, "updated");
  assert.equal(result.message, "The licence was withdrawn.");
  assert.equal(load(JSON.parse(fs.readFileSync(file, "utf8"))).reason, "This licence has been withdrawn.");
});

test("a renewal is refused when it is unsigned, forged, for another licence or older", async () => {
  const original = sign();
  const file = site(original);
  const next = { issuedAt: "2026-10-20T00:00:00.000Z" };

  const other = crypto.generateKeyPairSync("ed25519");
  const forgedPayload = { ...sign(next).payload, trial: false };
  const forged = { payload: forgedPayload, signature: signPayload(forgedPayload, other.privateKey.export({ type: "pkcs8", format: "pem" })) };
  assert.equal((await renew(file, server(forged))).status, "rejected");

  const tampered = sign(next);
  tampered.payload.trial = false;
  assert.equal((await renew(file, server(tampered))).status, "rejected");

  assert.equal((await renew(file, server(sign({ ...next, licenceId: "someone-else" })))).status, "rejected");
  assert.equal((await renew(file, server(sign({ ...next, edition: "other-edition" })))).status, "rejected");
  assert.equal((await renew(file, server(sign({ issuedAt: "2026-10-01T00:00:00.000Z", trial: false })))).status, "rejected", "an old manifest cannot roll the licence back");
  assert.equal((await renew(file, server("not json"))).status, "unreachable");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), original, "the file never changed");
});

test("an unchanged licence and an unreachable server leave the file alone", async () => {
  const original = sign();
  const file = site(original);
  assert.equal((await renew(file, server(original))).status, "unchanged");
  assert.equal((await renew(file, server({}, { status: 503 }))).status, "unreachable");
  assert.equal((await renew(file, server("", { throws: "getaddrinfo ENOTFOUND" }))).status, "unreachable");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), original);
});

test("renewal needs a valid manifest with a licence id and an https address", async () => {
  const none = await renew(path.join(scratch, "missing.json"), server({}));
  assert.equal(none.status, "skipped");
  const noUrl = await renew(site(sign({ renewUrl: undefined })), server({}));
  assert.equal(noUrl.status, "skipped");
  const noId = await renew(site(sign({ licenceId: undefined })), server({}));
  assert.equal(noId.status, "skipped");
  const plain = await renew(site(sign({ renewUrl: "http://licences.example.com/x.json" })), server({}));
  assert.equal(plain.status, "skipped");
  const local = server(sign());
  assert.equal((await renew(site(sign({ renewUrl: "http://localhost:9000/x.json" })), local)).status, "unchanged");
  const tamperedOnDisk = sign();
  tamperedOnDisk.payload.expiresAt = "2099-01-01T00:00:00.000Z";
  assert.equal((await renew(site(tamperedOnDisk), server({}))).status, "skipped", "an edited manifest on disk is not trusted to name the server");
});

test("the page for an ended licence escapes what it prints", () => {
  const html = inactivePageHtml({ reason: "The trial period has ended.", licensee: "<b>Bad</b> & Co" });
  assert.match(html, /The trial period has ended\./);
  assert.match(html, /&lt;b&gt;Bad&lt;\/b&gt; &amp; Co/);
  assert.doesNotMatch(html, /<b>Bad/);
});

test("the server answers an ended licence with 402 and checks for renewals only when restricted", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /requestEdition\.reason && editionDecision\.module[\s\S]{0,300}licence_inactive[\s\S]{0,200}inactivePageHtml/);
  assert.match(server, /if \(edition\.restricted\) \{\s*startEditionRenewal\(/);
  assert.match(server, /"\/api\/system\/edition\/refresh" && req\.method === "POST"[\s\S]{0,200}requirePermission\(req, "platform\.admin"\)/);
});
