// Issues or checks a site's edition manifest (data/edition.json).
//
//   Sell:     node scripts/edition-sign.js --licensee "Value Optical Ltd" --edition value-optical \
//                  --modules rx-capture,vault --expires 2027-10-15 [--out data/edition.json]
//   Trial:    node scripts/edition-sign.js --licensee "Value Optical Ltd" --edition value-optical \
//                  --modules rx-capture,vault --trial-days 30 --renew-url https://example.com/licences/value-optical.json
//   Convert:  node scripts/edition-sign.js --from licences/value-optical.json --paid --expires 2027-10-15 --out licences/value-optical.json
//   Extend:   node scripts/edition-sign.js --from licences/value-optical.json --trial-days 14 --out licences/value-optical.json
//   Withdraw: node scripts/edition-sign.js --from licences/value-optical.json --revoke --out licences/value-optical.json
//   Check:    node scripts/edition-sign.js --verify data/edition.json
//
// --from reads an earlier manifest and keeps its licence id, licensee, edition,
// modules and renew address, so the new file is accepted as the next version of
// the same licence. Each issue is stamped later than the one before it.
// The private signing key stays with the vendor, never in the repository. It is
// read from --key, then OPTILENS_EDITION_SIGNING_KEY, then
// ~/.optilens/edition-signing-ed25519.pem.
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ALL_MODULE_IDS, expandModules, loadEdition, signPayload } = require("../lib/edition");

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const verifyFile = option("verify");
if (verifyFile) {
  const manifest = JSON.parse(fs.readFileSync(verifyFile, "utf8"));
  const edition = loadEdition({ manifest, build: null });
  console.log(JSON.stringify(edition.describe(), null, 2));
  process.exit(edition.reason ? 1 : 0);
}

const fromFile = option("from");
const earlier = fromFile ? JSON.parse(fs.readFileSync(fromFile, "utf8")).payload : null;
if (fromFile && !earlier) fail(`${fromFile} has no payload.`);

const licensee = option("licensee") || earlier?.licensee;
const editionName = option("edition") || earlier?.edition;
const modules = option("modules") ? String(option("modules")).split(",").map((item) => item.trim()).filter(Boolean) : (earlier?.modules || []);
if (!licensee || !editionName || !modules.length) {
  fail("Usage: --licensee <name> --edition <name> --modules <id,id> [--expires YYYY-MM-DD | --trial-days N] [--renew-url https://...] [--out file]\n   or: --from <manifest> [--paid | --trial-days N | --expires YYYY-MM-DD | --revoke] [--out file]");
}
const unknown = modules.filter((id) => !ALL_MODULE_IDS.includes(id));
if (unknown.length) fail(`Unknown module(s): ${unknown.join(", ")}. Known: ${ALL_MODULE_IDS.join(", ")}`);

const trialDays = option("trial-days");
const expires = option("expires");
if (trialDays && (!/^\d+$/.test(trialDays) || Number(trialDays) < 1 || Number(trialDays) > 366)) fail("--trial-days must be a whole number from 1 to 366.");
if (trialDays && expires) fail("Pass --trial-days or --expires, not both.");
if (expires && Number.isNaN(Date.parse(expires))) fail("--expires must be a date such as 2027-10-15.");
if (flag("paid") && trialDays) fail("--paid and --trial-days contradict each other.");

const renewUrl = option("renew-url") || earlier?.renewUrl || null;
if (renewUrl && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(renewUrl)) fail("--renew-url must be an https:// address.");
const revoke = flag("revoke");
const trial = revoke ? Boolean(earlier?.trial) : flag("paid") ? false : trialDays ? true : (expires ? false : Boolean(earlier?.trial));
if (trial && !renewUrl && !flag("no-renew")) {
  console.warn("Warning: a trial with no --renew-url cannot be extended or converted remotely; it can only end. Pass --no-renew to silence this.");
}

const keyFile = option("key") || process.env.OPTILENS_EDITION_SIGNING_KEY || path.join(os.homedir(), ".optilens", "edition-signing-ed25519.pem");
if (!fs.existsSync(keyFile)) fail(`Signing key not found at ${keyFile}.`);

// The next version of a licence is always stamped later than the last.
const now = Date.now();
const previousIssued = earlier?.issuedAt ? Date.parse(earlier.issuedAt) : 0;
const issuedAt = new Date(Math.max(now, previousIssued + 1000)).toISOString();

let expiresAt = earlier?.expiresAt || null;
if (trialDays) expiresAt = new Date(now + Number(trialDays) * 86400000).toISOString();
else if (expires) expiresAt = new Date(expires).toISOString();
if (revoke && !expiresAt) expiresAt = null;
if (trial && !expiresAt) fail("A trial needs an end: pass --trial-days.");

const payload = {
  edition: editionName,
  licensee,
  licenceId: option("licence-id") || earlier?.licenceId || `${editionName}-${crypto.randomBytes(6).toString("hex")}`,
  // Store what was sold plus what it needs, so the file shows the real set.
  modules: [...expandModules(modules)].sort(),
  issuedAt,
  expiresAt,
  trial
};
if (renewUrl) payload.renewUrl = renewUrl;
if (revoke) payload.revoked = true;

const manifest = { payload, signature: signPayload(payload, fs.readFileSync(keyFile, "utf8")) };
// --public-key checks against another key pair, for rehearsals that must not use the vendor key.
const publicKeyFile = option("public-key");
const check = loadEdition({ manifest, build: null, now: () => new Date(0), ...(publicKeyFile ? { publicKey: fs.readFileSync(publicKeyFile, "utf8") } : {}) });
if (!revoke && check.reason) fail(`The new manifest does not verify against lib/edition-public-key.pem: ${check.reason}`);

const out = option("out") || path.join(__dirname, "..", "data", "edition.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${out}`);
console.log(JSON.stringify(check.describe()));
if (trial) console.log(`Trial ends ${payload.expiresAt}.`);
if (payload.renewUrl) console.log(`Publish this file at ${payload.renewUrl} to reach sites that already have the licence.`);
