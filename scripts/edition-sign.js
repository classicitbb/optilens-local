// Issues or checks a site's edition manifest (data/edition.json).
//
//   node scripts/edition-sign.js --licensee "Value Optical Ltd" --edition value-optical \
//        --modules rx-capture,vault [--expires 2027-10-15] [--out data/edition.json]
//   node scripts/edition-sign.js --verify data/edition.json
//
// The private signing key stays with the vendor, never in the repository. It is
// read from --key, then OPTILENS_EDITION_SIGNING_KEY, then
// ~/.optilens/edition-signing-ed25519.pem.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ALL_MODULE_IDS, expandModules, loadEdition, signPayload } = require("../lib/edition");

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
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

const licensee = option("licensee");
const editionName = option("edition");
const modules = String(option("modules") || "").split(",").map((item) => item.trim()).filter(Boolean);
if (!licensee || !editionName || !modules.length) fail("Usage: --licensee <name> --edition <name> --modules <id,id> [--expires YYYY-MM-DD] [--out file]");
const unknown = modules.filter((id) => !ALL_MODULE_IDS.includes(id));
if (unknown.length) fail(`Unknown module(s): ${unknown.join(", ")}. Known: ${ALL_MODULE_IDS.join(", ")}`);
const expires = option("expires");
if (expires && Number.isNaN(Date.parse(expires))) fail("--expires must be a date such as 2027-10-15.");

const keyFile = option("key") || process.env.OPTILENS_EDITION_SIGNING_KEY || path.join(os.homedir(), ".optilens", "edition-signing-ed25519.pem");
if (!fs.existsSync(keyFile)) fail(`Signing key not found at ${keyFile}.`);

const payload = {
  edition: editionName,
  licensee,
  // Store what was sold plus what it needs, so the file shows the real set.
  modules: [...expandModules(modules)].sort(),
  issuedAt: new Date().toISOString(),
  expiresAt: expires ? new Date(expires).toISOString() : null
};
const manifest = { payload, signature: signPayload(payload, fs.readFileSync(keyFile, "utf8")) };
const check = loadEdition({ manifest, build: null });
if (check.reason) fail(`The new manifest does not verify against lib/edition-public-key.pem: ${check.reason}`);

const out = option("out") || path.join(__dirname, "..", "data", "edition.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${out}`);
console.log(JSON.stringify(check.describe()));
