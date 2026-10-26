// Editions decide which modules a site runs.
//
// The internal full edition (no manifest) enables everything, so nothing changes
// for Classic Visions. A licensed site carries data/edition.json, signed with
// the vendor's private key and verified here with the public key shipped in
// lib/edition-public-key.pem. In any edition other than "full" the server is
// default-deny: a page or API route that does not belong to the core or to an
// enabled module answers 404, and the module's migrations, workers and
// dashboard cards are skipped.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
// OPTILENS_EDITION_FILE points a process at another manifest (for trials and tests).
const MANIFEST_FILE = process.env.OPTILENS_EDITION_FILE || path.join(ROOT, "data", "edition.json");
const PUBLIC_KEY_FILE = path.join(__dirname, "edition-public-key.pem");
const BUILD_FILE = path.join(__dirname, "edition-build.json");
// The latest time this site has seen. A clock set back below it does not stretch a trial.
const CLOCK_FILE = process.env.OPTILENS_EDITION_CLOCK_FILE || path.join(ROOT, "data", "edition-clock.json");

// Always available in every edition: sign-in, users, health, the host monitor and
// updater, the dashboard shell, and the site's own settings.
const CORE = {
  pages: ["/", "/index.html", "/login", "/login.html", "/release-notes", "/release-notes.html", "/settings", "/settings.html", "/admin/users", "/admin-users.html"],
  api: ["/api/auth", "/api/health", "/api/system", "/api/monitor", "/api/dashboard", "/api/modules", "/api/admin/users", "/api/admin/roles", "/api/admin/migrate"]
};

// `requires` lists modules whose tables this one builds on. Enabling a module
// enables what it requires. Found by migrating each module on top of a fresh
// core + RX Capture database: delivery-export and beswift only migrate together,
// and email builds on the supplier-mail tables of automation.
const MODULES = {
  "rx-capture": {
    name: "RX Capture",
    pages: ["/rx-capture", "/rx-capture.html"],
    api: ["/api/rx-capture"],
    requires: []
  },
  vault: {
    name: "Credentials Vault",
    pages: ["/credentials", "/credentials.html"],
    api: ["/api/vault"],
    requires: []
  },
  "delivery-export": {
    name: "Delivery and Export",
    pages: ["/modules/delivery-export", "/delivery-export.html"],
    api: ["/api/delivery", "/api/source"],
    requires: ["beswift"]
  },
  "pricing-automation": {
    name: "Pricing Automation",
    pages: ["/modules/pricing-automation", "/pricing-automation.html", "/tools/pricing-automation", "/modules/cost-check", "/cost-check.html"],
    api: ["/api/pricing", "/api/pricelists", "/api/pl", "/api/costing", "/api/standards-catalog", "/api/v2"],
    requires: []
  },
  integrations: {
    name: "Integrations",
    pages: ["/modules/integrations", "/integrations.html"],
    api: ["/api/integrations", "/api/connectors"],
    requires: []
  },
  automation: {
    name: "Automation",
    pages: ["/modules/automation", "/automation.html", "/modules/os-lab-status", "/supplier-email.html", "/modules/job-floor", "/job-floor.html"],
    api: ["/api/rx", "/api/assistant", "/api/ai", "/api/operations", "/api/job-floor"],
    requires: []
  },
  email: {
    name: "Email",
    pages: [],
    api: ["/api/email"],
    requires: ["automation"]
  },
  "business-metrics": {
    name: "Business Metrics",
    pages: ["/modules/business-metrics", "/business-metrics.html", "/modules/production-status", "/production-status.html"],
    api: ["/api/business-metrics", "/api/production-status"],
    requires: []
  },
  "inventory-intelligence": {
    name: "Inventory Intelligence",
    pages: ["/modules/inventory-intelligence", "/inventory-intelligence.html", "/modules/inventory-clearance", "/clearance-catalogue.html"],
    api: ["/api/inventory"],
    requires: []
  },
  qbo: {
    name: "QuickBooks Online",
    pages: [],
    api: ["/api/qbo"],
    requires: []
  },
  beswift: {
    name: "BeSWIFT",
    pages: [],
    api: ["/api/beswift-extension"],
    requires: ["delivery-export"]
  },
  chemistry: {
    name: "Chemistry Clips",
    pages: ["/modules/chemistry-clips", "/chemistry-clips.html"],
    api: ["/api/chemistry"],
    requires: []
  },
  "privileged-data-access": {
    name: "Privileged Data Access",
    pages: [],
    api: ["/api/admin/data-access"],
    requires: []
  }
};

const ALL_MODULE_IDS = Object.keys(MODULES);

function matchesPrefix(pathname, prefix) {
  if (prefix === "/") return pathname === "/";
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function longestMatch(pathname, entries) {
  let best = null;
  for (const [id, prefixes] of entries) {
    for (const prefix of prefixes) {
      if (matchesPrefix(pathname, prefix) && (!best || prefix.length > best.prefix.length)) best = { id, prefix };
    }
  }
  return best;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// The payload is signed exactly as this canonical text: keys sorted, no spaces.
function canonicalPayload(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalPayload).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalPayload(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function signPayload(payload, privateKeyPem) {
  return crypto.sign(null, Buffer.from(canonicalPayload(payload)), privateKeyPem).toString("base64");
}

function verifyManifest(manifest, publicKeyPem) {
  if (!manifest || typeof manifest !== "object" || !manifest.payload || typeof manifest.signature !== "string") return false;
  if (!publicKeyPem) return false;
  try {
    return crypto.verify(null, Buffer.from(canonicalPayload(manifest.payload)), publicKeyPem, Buffer.from(manifest.signature, "base64"));
  } catch {
    return false;
  }
}

// Modules to enable once a manifest's list is expanded with what they require.
function expandModules(requested) {
  const enabled = new Set();
  const add = (id) => {
    if (!MODULES[id] || enabled.has(id)) return;
    enabled.add(id);
    for (const required of MODULES[id].requires) add(required);
  };
  for (const id of requested) add(id);
  return enabled;
}

// Wall-clock time, never earlier than the latest time recorded on this site.
// Only used when a manifest has an expiry, so a full edition never touches the file.
function trustedNow() {
  const real = Date.now();
  let seen = 0;
  try { seen = Number(JSON.parse(fs.readFileSync(CLOCK_FILE, "utf8")).highWater) || 0; } catch { /* first run */ }
  if (real > seen + 60 * 1000) {
    try {
      fs.mkdirSync(path.dirname(CLOCK_FILE), { recursive: true });
      fs.writeFileSync(CLOCK_FILE, JSON.stringify({ highWater: real }));
    } catch { /* read-only data folder: fall back to the wall clock */ }
  }
  return new Date(Math.max(real, seen));
}

// Reads the site's edition. Options exist so tests can supply files and keys.
function loadEdition(options = {}) {
  const now = options.now || trustedNow;
  const manifest = "manifest" in options ? options.manifest : readJson(MANIFEST_FILE);
  const publicKey = "publicKey" in options ? options.publicKey : (fs.existsSync(PUBLIC_KEY_FILE) ? fs.readFileSync(PUBLIC_KEY_FILE, "utf8") : null);
  const build = "build" in options ? options.build : readJson(BUILD_FILE);
  const requireManifest = Boolean(build?.requireManifest);

  if (!manifest) {
    if (!requireManifest) return fullEdition();
    return restrictedEdition({ name: "unlicensed", licensee: null, modules: [], reason: "No edition manifest was found for this licensed build." });
  }
  if (!verifyManifest(manifest, publicKey)) {
    return restrictedEdition({ name: "unlicensed", licensee: null, modules: [], reason: "The edition manifest signature is not valid." });
  }
  const payload = manifest.payload;
  const licence = {
    trial: Boolean(payload.trial),
    licenceId: payload.licenceId || null,
    issuedAt: payload.issuedAt || null,
    expiresAt: payload.expiresAt || null,
    renewable: Boolean(payload.renewUrl)
  };
  // A vendor can withdraw a licence by publishing a newer manifest marked revoked.
  if (payload.revoked) {
    return restrictedEdition({ name: payload.edition || "revoked", licensee: payload.licensee || null, modules: [], reason: "This licence has been withdrawn.", ...licence });
  }
  if (payload.expiresAt && Date.parse(payload.expiresAt) <= now().getTime()) {
    const reason = payload.trial ? "The trial period has ended." : "The edition licence has expired.";
    return restrictedEdition({ name: payload.edition || "expired", licensee: payload.licensee || null, modules: [], reason, ...licence });
  }
  const modules = expandModules(Array.isArray(payload.modules) ? payload.modules : []);
  return restrictedEdition({ name: String(payload.edition || "custom"), licensee: payload.licensee || null, modules: [...modules], reason: null, ...licence });
}

function fullEdition() {
  return buildEdition({ name: "full", licensee: null, modules: ALL_MODULE_IDS, restricted: false, reason: null });
}

function restrictedEdition({ name, licensee, modules, reason, ...licence }) {
  return buildEdition({ name, licensee, modules, restricted: true, reason, licence });
}

function buildEdition({ name, licensee, modules, restricted, reason, licence = {} }) {
  const enabled = new Set(modules);
  const pageEntries = Object.entries(MODULES).map(([id, module]) => [id, module.pages]);
  const apiEntries = Object.entries(MODULES).map(([id, module]) => [id, module.api]);

  // Decides one request path. Only a restricted edition ever blocks anything.
  function decide(rawPath) {
    if (!restricted) return { allowed: true, module: null };
    const pathname = String(rawPath || "/").split("?")[0].replace(/\/{2,}/g, "/");
    const lower = pathname.length > 1 ? pathname.replace(/\/$/, "").toLowerCase() : pathname;
    const isApi = lower.startsWith("/api/") || lower === "/api";
    const owner = longestMatch(lower, isApi ? apiEntries : pageEntries) || longestMatch(lower, apiEntries) || longestMatch(lower, pageEntries);
    const core = longestMatch(lower, [["core", isApi ? CORE.api : CORE.pages]]);
    // The most specific rule wins: /api/admin/users is core even though a module
    // may own a sibling such as /api/admin/data-access.
    if (owner && (!core || owner.prefix.length >= core.prefix.length)) {
      return { allowed: enabled.has(owner.id), module: owner.id };
    }
    if (core) return { allowed: true, module: null };
    if (isApi) return { allowed: false, module: null };
    // Anything that looks like a page (no file extension, or .html) must be
    // listed; scripts, styles, images and fonts are not pages.
    if (lower === "/" || path.extname(lower) === "" || path.extname(lower) === ".html") return { allowed: false, module: null };
    return { allowed: true, module: null };
  }

  return {
    name,
    licensee,
    restricted,
    reason,
    modules: [...enabled],
    licence,
    // When the running process must read the manifest again.
    expiresAtMs: licence.expiresAt && !reason ? Date.parse(licence.expiresAt) : null,
    isModuleEnabled: (id) => !restricted || enabled.has(id),
    decide,
    describe: (at = Date.now()) => {
      const expiresMs = licence.expiresAt ? Date.parse(licence.expiresAt) : null;
      return {
        name, licensee, restricted, reason, modules: [...enabled],
        trial: Boolean(licence.trial),
        expiresAt: licence.expiresAt || null,
        daysLeft: expiresMs && !reason ? Math.max(0, Math.ceil((expiresMs - at) / 86400000)) : null,
        remoteRenewal: Boolean(licence.renewable)
      };
    }
  };
}

let current = null;
// The site's edition, read once. Tests call resetEdition to read it again.
function getEdition() {
  // A licence that runs out while the service is up stops at its expiry time.
  if (current && current.expiresAtMs && trustedNow().getTime() >= current.expiresAtMs) current = null;
  if (!current) current = loadEdition();
  return current;
}

function resetEdition() {
  current = null;
}

module.exports = { ALL_MODULE_IDS, getEdition, resetEdition, MANIFEST_FILE, CORE, MODULES, canonicalPayload, expandModules, loadEdition, signPayload, verifyManifest };
