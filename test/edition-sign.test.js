const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadEdition } = require("../lib/edition");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-sign-"));
const keys = crypto.generateKeyPairSync("ed25519");
const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = keys.publicKey.export({ type: "spki", format: "pem" });
const DAY = 86400000;

test("the signing script issues, converts, extends and withdraws one licence", () => {
  const { execFileSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(scratch, "sign-"));
  const keyFile = path.join(dir, "key.pem");
  const pubFile = path.join(dir, "pub.pem");
  fs.writeFileSync(keyFile, privatePem);
  fs.writeFileSync(pubFile, publicPem);
  const script = path.join(__dirname, "..", "scripts", "edition-sign.js");
  const out = path.join(dir, "licence.json");
  const run = (...args) => execFileSync(process.execPath, [script, "--key", keyFile, "--public-key", pubFile, "--out", out, ...args], { encoding: "utf8" });
  const read = () => JSON.parse(fs.readFileSync(out, "utf8"));

  run("--licensee", "Value Optical Ltd", "--edition", "value-optical", "--modules", "rx-capture,vault", "--trial-days", "30", "--renew-url", "https://licences.example.com/vo.json");
  const trial = read().payload;
  assert.equal(trial.trial, true);
  assert.match(trial.licenceId, /^value-optical-[0-9a-f]{12}$/);
  assert.ok(Date.parse(trial.expiresAt) > Date.now() + 29 * DAY);
  assert.equal(verifies(read()), true);

  run("--from", out, "--paid", "--expires", "2027-10-15");
  const paid = read().payload;
  assert.equal(paid.trial, false);
  assert.equal(paid.licenceId, trial.licenceId);
  assert.equal(paid.renewUrl, trial.renewUrl);
  assert.ok(Date.parse(paid.issuedAt) > Date.parse(trial.issuedAt), "each issue is later than the last");
  assert.equal(paid.expiresAt, "2027-10-15T00:00:00.000Z");

  run("--from", out, "--revoke");
  assert.equal(read().payload.revoked, true);
  assert.equal(read().payload.licenceId, trial.licenceId);

  assert.throws(() => run("--licensee", "X", "--edition", "e", "--modules", "rx-capture", "--trial-days", "30", "--expires", "2027-01-01"), /not both/);
  assert.throws(() => run("--licensee", "X", "--edition", "e", "--modules", "rx-capture", "--trial-days", "30", "--renew-url", "http://insecure.example.com/x"), /https/);
  assert.throws(() => run("--licensee", "X", "--edition", "e", "--modules", "rx-capture", "--paid", "--trial-days", "5"), /contradict/);

  function verifies(manifest) {
    return loadEdition({ manifest, publicKey: publicPem, build: null, now: () => new Date(Date.now()) }).reason === null;
  }
});
