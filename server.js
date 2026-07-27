const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { URL } = require("node:url");
const nodeCrypto = require("node:crypto");
const sql = require("mssql");
const { getConfig } = require("./lib/config");
const { runOdbcProbe } = require("./lib/odbc-probe");
const { normalizeVaultData } = require("./lib/credential-vault");
const credentialVault = require("./lib/credential-vault");
const { protectString, unprotectString } = require("./lib/windows-protected-store");
const { createUpdateManager } = require("./lib/update-manager");
const { createGitUpdateChecker } = require("./lib/git-update-checker");
const { powershell, runHostScript, tailTextFile } = require("./lib/host-control");

// ─── Vault — server-side crypto + file storage ────────────────────────────────
// crypto.subtle is unavailable over plain HTTP on LAN devices, so all PIN
// hashing and session management lives here in Node.

const dataDir   = path.join(__dirname, "data");
const vaultFile = path.join(dataDir, "vault.json");
const VAULT_SALT = "optilens-credentials-v1";
const applicationStartedAt = new Date().toISOString();
const updateManager = createUpdateManager(__dirname, applicationStartedAt);
const gitUpdateChecker = createGitUpdateChecker(__dirname);
const AUTO_APPLY_GIT_UPDATES = ["1", "true", "yes", "on"].includes(String(process.env.OPTILENS_AUTO_APPLY_UPDATES || "").toLowerCase());
let scheduledUpdate = null;

/** SHA-256 hash of pin+salt, returned as base64 */
function hashPin(pin) {
  return nodeCrypto.createHash("sha256").update(pin + VAULT_SALT).digest("base64");
}

/** Read vault file → { pinHash, data } */
function readVault() {
  try {
    if (!fs.existsSync(vaultFile)) return { pinHash: null, data: null };
    const vault = JSON.parse(fs.readFileSync(vaultFile, "utf8"));
    const normalized = normalizeVaultData(vault.data);
    if (normalized.changed) {
      writeVault({ ...vault, data: normalized.data });
    }
    return { ...vault, data: normalized.data };
  } catch { return { pinHash: null, data: null }; }
}

/** Persist vault object to disk */
function writeVault(obj) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const normalized = normalizeVaultData(obj?.data);
  fs.writeFileSync(vaultFile, JSON.stringify({ ...obj, data: normalized.data }, null, 2));
}

// ─── Session tokens (in-memory, cleared on server restart) ───────────────────
// 64-char hex token stored in client sessionStorage; valid for 8 hours.

const SESSION_TTL = 8 * 60 * 60 * 1000;
const vaultSessions = new Map(); // token -> expiresAt

function createSession() {
  const token = nodeCrypto.randomBytes(32).toString("hex");
  vaultSessions.set(token, Date.now() + SESSION_TTL);
  return token;
}

function validateSession(token) {
  if (!token) return false;
  const exp = vaultSessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { vaultSessions.delete(token); return false; }
  return true;
}

function destroySession(token) {
  vaultSessions.delete(token);
}

function bearerToken(req) {
  const h = req.headers["authorization"] || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}
const { checkPsqlConfig } = require("./lib/psql-odbc");
const { getIntegrationHealthSnapshot } = require("./lib/integration-health");
const {
  buildDashboard,
  createDeviceRegistration,
  defaultModules,
  saveDashboardTiles
} = require("./lib/dashboard");
const { runMigrations } = require("./lib/migrations");
const { getBusinessMetrics } = require("./lib/business-metrics");
const {
  addShipmentSessionItem,
  closeShipmentSessionsBatch,
  createShipmentSession,
  deleteTestShipmentSessions,
  getShipmentSession,
  listShipmentSessionItems,
  listShipmentEvents,
  listShipmentSessions,
  updateShipmentStatus
} = require("./lib/delivery");
const { syncShipmentSessions } = require("./lib/shipment-sync");
const {
  claimAutomationJob: claimBeSwiftAutomationJob,
  createAutomationJob: createBeSwiftAutomationJob,
  getCoForShipment,
  getCommercialInvoicePreview,
  prepareCoDraft,
  saveCommercialInvoiceLineOverrides,
  saveCoDraft,
  updateAutomationJobStatus: updateBeSwiftAutomationJobStatus,
  getAutomationJobStatus: getBeSwiftAutomationJobStatus,
  resumeAutomationJob: resumeBeSwiftAutomationJob,
  recordFillResolution: recordBeSwiftFillResolution,
  listFillResolutions: listBeSwiftFillResolutions
} = require("./lib/beswift-co");
const {
  getCustomerParameters,
  upsertCustomerParameters
} = require("./lib/customer-parameters");
const { saveCatalogEntry } = require("./lib/co-item-catalog");
const { getStandardsCatalog } = require("./lib/standards-catalog");
const rxGenerator = require("./lib/rx-generator");
const { syncRxCoatings } = require("./lib/rx-catalog-sync");
const { getSetting, setSetting } = require("./lib/app-settings");
const { normaliseOrderSettings, orderSettingsKey, parseOrderSettings } = require("./lib/rx-order-settings");
const {
  findInvoiceItem,
  getStatement,
  listCustomers,
  listDispatchers,
  listExportCustomers,
  listPricelistCustomers,
  listShipmentItems
} = require("./lib/source-innovations");
const {
  calculatePrice,
  createPricingRule,
  listPriceCalculations,
  listPricingRules
} = require("./lib/pricing");
const {
  authenticateUser,
  bootstrapAdmin,
  changePassword,
  createRole,
  createUser,
  deleteRole,
  getBootstrapState,
  getUserAccess,
  listUsers,
  MODULE_ACCESS,
  updateRole,
  updateUser
} = require("./lib/auth");
const {
  autosaveFile,
  autosaveBillingDocument,
  createFile,
  createBillingDocument,
  deleteFile,
  deleteBillingDocument,
  getFile,
  getBillingDocument,
  listAllAccessibleFiles,
  listFiles,
  listBillingDocuments,
  updateFile,
  updateBillingDocument,
  updateBillingDocumentShares,
  updateUnifiedShares
} = require("./lib/docstudio");

// ─── Pricelist Builder (folded in from pricelist-automation) ─────────────────
const PE = require("./lib/pricing-engine");
const plSecure = require("./lib/secure-config-pricelist");
const plConnector = require("./lib/optilens-connector");
const plCvConnector = require("./lib/cv-api-connector");
const innovationsSync = require("./lib/innovations-sync");
const innovationsSyncLog = require("./lib/innovations-sync-log");
const liveGatewayWorker = require("./lib/live-gateway-worker");
const liveGatewayAutostart = require("./lib/live-gateway-autostart");
const { dispatch: dispatchLiveDataRequest } = require("./lib/live-data-gateway");
const zenMirrorWorker = require("./lib/zen-mirror-worker");
const sourceBackend = require("./lib/source-backend");

const PL_DIR = path.join(__dirname, "data", "pricelist");
const PL_GEN      = path.join(PL_DIR, "lens-data.generated.json");
const PL_FALLBACK = path.join(PL_DIR, "lens-data.fallback.json");
const PL_QUOTE    = path.join(PL_DIR, "quote-only.generated.json");
const PL_SOURCES  = path.join(PL_DIR, "sources.generated.json");
const PL_OVERRIDES = path.join(PL_DIR, "catalog-overrides.json");
const PL_LISTS    = path.join(PL_DIR, "saved-pricelists.json");
const PL_CUSTOMERS = path.join(PL_DIR, "customers.json");
const PL_SOURCE_MODE = path.join(PL_DIR, "source-mode.json");
const PL_ROWS      = path.join(PL_DIR, "catalog-rows.generated.json");   // raw mapped rows (for reclassify)
const PL_CLASS_OV  = path.join(PL_DIR, "classification-overrides.json"); // user tag-pill classifications
const plClassifier = require("./lib/lens-classifier");
let rxCoatingRefreshPromise = null;

async function listRxCoatings() {
  let items = rxGenerator.getCoatings();
  if (items.length) return { items, refreshed: false };
  if (!rxCoatingRefreshPromise) {
    rxCoatingRefreshPromise = syncRxCoatings().finally(() => { rxCoatingRefreshPromise = null; });
  }
  await rxCoatingRefreshPromise;
  items = rxGenerator.getCoatings();
  if (!items.length) {
    const error = new Error("The live Coatings group returned no usable options.");
    error.statusCode = 503;
    throw error;
  }
  return { items, refreshed: true };
}

// Vocabulary for the Sourcing Review classify pills.
const PL_TIER_OPTIONS = [
  'Progressive - Best', 'Progressive - Better', 'Progressive - Good', 'Progressive - Adept',
  'Specific Use - Office', 'Specific Use - Sport', 'Anti-Fatigue',
  'Single Vision - HD', 'Single Vision - Regular', 'Specific Use - Bifocal', 'Specific Use - Adept Bifocal',
];
const PL_GROUP_OPTIONS = [
  'Clear', 'UV420', 'Photochromic - Gray', 'Photochromic - Brown',
  'Trans Gen S™', 'Trans® XtrActive® New Gen', 'Trans® XtrActive® Polarized', 'Polarized',
];

function plReadJSON(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return dflt; }
}
function plWriteJSON(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2)); }

// Source mode: "auto" (prefer live/generated, fall back to bundled),
// "live" (force generated only), or "fallback" (force bundled snapshot).
// Persisted so the choice survives restarts.
const PL_SOURCE_MODES = ["auto", "live", "fallback"];
function plSourceMode() {
  const m = plReadJSON(PL_SOURCE_MODE, null);
  return m && PL_SOURCE_MODES.includes(m.mode) ? m.mode : "auto";
}
function plSetSourceMode(mode) {
  if (!PL_SOURCE_MODES.includes(mode)) { const e = new Error("Invalid source mode."); e.statusCode = 400; throw e; }
  plWriteJSON(PL_SOURCE_MODE, { mode, updatedAt: new Date().toISOString() });
  return mode;
}

// Load combos once at startup, reload after a live pull or a mode switch.
function plWithTypeMetadata(combos) {
  if (!Array.isArray(combos) || combos.every(c => Array.isArray(c.types))) return combos;
  const rows = plReadRawRows();
  if (!Array.isArray(rows) || !rows.length) return combos;
  try {
    const rebuilt = plConnector.combosFromRows(rows, plReadOverrides()).combos;
    return rebuilt.length ? rebuilt : combos;
  } catch {
    return combos;
  }
}

function plLoadCombos() {
  const tryFile = (p) => { try { const d = JSON.parse(fs.readFileSync(p, "utf8")); return Array.isArray(d) && d.length ? d : null; } catch { return null; } };
  const mode = plSourceMode();
  const gen = plWithTypeMetadata(tryFile(PL_GEN));
  const fb = tryFile(PL_FALLBACK);
  // Forced bundled fallback.
  if (mode === "fallback") {
    if (fb) return { combos: fb, active: "fallback", mode };
    return { combos: [], active: "empty", mode };
  }
  // Forced live/generated (no silent downgrade to the snapshot).
  if (mode === "live") {
    if (gen) return { combos: gen, active: "generated", mode };
    return { combos: [], active: "empty", mode };
  }
  // Auto: prefer the live-refreshed catalog, fall back to the bundled snapshot.
  if (gen) return { combos: gen, active: "generated", mode };
  if (fb) return { combos: fb, active: "fallback", mode };
  return { combos: [], active: "empty", mode };
}
let plLoaded = plLoadCombos();
let plCombos = plLoaded.combos;
let plComboByKey = Object.fromEntries(plCombos.map(c => [c.key, c]));

function plReloadCombos() {
  plLoaded = plLoadCombos();
  plCombos = plLoaded.combos;
  plComboByKey = Object.fromEntries(plCombos.map(c => [c.key, c]));
  return plLoaded;
}

function plRefreshCombos() {
  // The builder catalog is file-backed, so refresh before serving read paths.
  return plReloadCombos();
}

function plCombosForClassOverrides(classOverrides) {
  const rows = plReadRawRows();
  if (!classOverrides || !Array.isArray(rows) || !rows.length) {
    plRefreshCombos();
    return plCombos;
  }
  return plConnector.combosFromRows(rows, plMergedClassOverrides(classOverrides)).combos;
}

// ── Classification overrides (Sourcing Review tag pills) ────────────────────
function plReadOverrides() {
  const o = plReadJSON(PL_CLASS_OV, null) || {};
  return { tierByType: o.tierByType || {}, treatmentByType: o.treatmentByType || {}, materialByType: o.materialByType || {} };
}
function plWriteOverrides(o) { plWriteJSON(PL_CLASS_OV, o); }
function plReadRawRows() { return plReadJSON(PL_ROWS, null); }
function plCatalogSourceRows(supplier) {
  const rows = plReadRawRows() || [];
  const ov = plReadOverrides();
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const wanted = String(supplier || "").trim();
  const filtered = rows
    .map((r, idx) => ({ ...r, _rowNumber: idx + 1 }))
    .filter(r => !wanted || r.supplier === wanted);
  return filtered.map(r => {
    const typeKey = `${r.mftype || ""}|${r.lenstype || ""}`;
    const tier = hasOwn(ov.tierByType, typeKey) ? ov.tierByType[typeKey] : plClassifier.TIER_MAP[typeKey] || null;
    const treatment = hasOwn(ov.treatmentByType, typeKey) ? ov.treatmentByType[typeKey] : plClassifier.normTreatment(r.name);
    const material = hasOwn(ov.materialByType, typeKey) ? ov.materialByType[typeKey] : plClassifier.normMaterial(r.name, r.material);
    const cost = Number(r.cost);
    const approved = plClassifier.APPROVED.includes(r.supplier);
    const active = r.active !== false;
    const hasCost = Number.isFinite(cost) && cost > 0;
    const included = approved && active && hasCost && !!tier && !!treatment && !!material;
    let reason = "Included in pricing";
    if (!approved) reason = "Supplier not approved";
    else if (!active) reason = "Inactive catalog row";
    else if (!hasCost) reason = "Missing or invalid cost";
    else if (!tier) reason = "Missing category";
    else if (!treatment) reason = "Missing group";
    else if (!material) reason = "Missing material";
    return {
      rowNumber: r._rowNumber,
      supplier: r.supplier || "",
      name: r.name || "",
      mftype: r.mftype || "",
      lenstype: r.lenstype || "",
      material: r.material || "",
      cost: hasCost ? Math.round(cost * 100) / 100 : null,
      active,
      included,
      reason,
      pricingKey: included ? `${treatment}||${tier}||${material}` : null,
      classification: { treatment, tier, material },
    };
  });
}
function plNormalizeClassOverrides(o) {
  return {
    tierByType: o && typeof o.tierByType === "object" ? o.tierByType : {},
    treatmentByType: o && typeof o.treatmentByType === "object" ? o.treatmentByType : {},
    materialByType: o && typeof o.materialByType === "object" ? o.materialByType : {},
  };
}
function plMergedClassOverrides(local) {
  const base = plReadOverrides();
  const scoped = plNormalizeClassOverrides(local);
  return {
    tierByType: { ...base.tierByType, ...scoped.tierByType },
    treatmentByType: { ...base.treatmentByType, ...scoped.treatmentByType },
    materialByType: { ...base.materialByType, ...scoped.materialByType },
  };
}

// Re-bucket the saved raw catalog rows with current overrides → regenerate combos.
// Works offline (no re-pull); a later live pull re-applies the same overrides.
function plReclassify() {
  const rows = plReadRawRows();
  if (!Array.isArray(rows) || !rows.length) {
    const e = new Error("No raw catalog rows saved yet — pull the catalog first."); e.statusCode = 409; throw e;
  }
  const { combos, coverage } = plConnector.combosFromRows(rows, plReadOverrides());
  plWriteJSON(PL_GEN, combos);
  plWriteJSON(path.join(PL_DIR, "supplier-coverage.generated.json"), coverage);
  if (plSourceMode() === "fallback") plSetSourceMode("auto");
  plReloadCombos();
  return combos.length;
}

// Catalog grouped by lens TYPE (MF|LensType) — drives the classify list + pills.
// Unclassified types (no tier) sort first so they're easy to find and fix.
function plCatalogTypes(classOverrides) {
  const rows = plReadRawRows() || [];
  const ov = classOverrides ? plMergedClassOverrides(classOverrides) : plReadOverrides();
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const types = {};
  for (const r of rows) {
    if (!plClassifier.APPROVED.includes(r.supplier)) continue;
    if (r.active === false) continue;
    if (!r.mftype || !r.lenstype) continue;
    const lk = `${r.mftype}|${r.lenstype}`;
    const t = types[lk] || (types[lk] = { typeKey: lk, mftype: r.mftype, lenstype: r.lenstype, rows: 0, suppliers: {}, samples: [], treatments: {} });
    t.rows++;
    t.suppliers[r.supplier] = (t.suppliers[r.supplier] || 0) + 1;
    if (t.samples.length < 4) t.samples.push(r.name);
    const trt = hasOwn(ov.treatmentByType, lk) ? ov.treatmentByType[lk] : plClassifier.normTreatment(r.name);
    if (trt) t.treatments[trt] = (t.treatments[trt] || 0) + 1;
    const mat = hasOwn(ov.materialByType, lk) ? ov.materialByType[lk] : plClassifier.normMaterial(r.name, r.material);
    if (mat) t.materials = { ...(t.materials || {}), [mat]: ((t.materials && t.materials[mat]) || 0) + 1 };
  }
  return Object.values(types).map(t => {
    const tierHasOverride = hasOwn(ov.tierByType, t.typeKey);
    const treatmentHasOverride = hasOwn(ov.treatmentByType, t.typeKey);
    const materialHasOverride = hasOwn(ov.materialByType, t.typeKey);
    const tier = tierHasOverride ? ov.tierByType[t.typeKey] : plClassifier.TIER_MAP[t.typeKey] || null;
    const treatmentOverride = treatmentHasOverride ? ov.treatmentByType[t.typeKey] : null;
    const materialOverride = materialHasOverride ? ov.materialByType[t.typeKey] : null;
    const treatmentClassified = treatmentHasOverride ? !!treatmentOverride : Object.keys(t.treatments).length > 0;
    const materialClassified = materialHasOverride ? !!materialOverride : Object.keys(t.materials || {}).length > 0;
    return {
      typeKey: t.typeKey, mftype: t.mftype, lenstype: t.lenstype, rows: t.rows,
      suppliers: Object.keys(t.suppliers), supplierCount: Object.keys(t.suppliers).length,
      samples: t.samples, tier, classified: !!tier && treatmentClassified && materialClassified,
      tierMissing: !tier, treatmentMissing: !treatmentClassified, materialMissing: !materialClassified,
      tierOverridden: tierHasOverride,
      treatmentOverridden: treatmentHasOverride,
      materialOverridden: materialHasOverride,
      treatmentOverride, materialOverride,
      groups: Object.keys(t.treatments),
      materials: Object.keys(t.materials || {}),
    };
  }).sort((a, b) => (a.classified - b.classified) || String(a.mftype || "").localeCompare(String(b.mftype || "")) || (b.rows - a.rows));
}

function plSourceStatus() {
  plRefreshCombos();
  const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const { active, mode } = plLoaded;
  return {
    active, mode, count: plCombos.length,
    generatedExists: exists(PL_GEN),
    fallbackExists: exists(PL_FALLBACK),
    label: active === "generated" ? "Generated catalog (live-refreshable)"
      : active === "fallback" ? (mode === "fallback" ? "Bundled fallback snapshot (forced)" : "Bundled fallback snapshot (generated file unavailable)")
      : "No catalog loaded",
  };
}

function plLoadOverrides() { return plReadJSON(PL_OVERRIDES, { combos: [], suppliers: {} }); }
function plSaveOverrides(data) {
  const clean = { combos: Array.isArray(data.combos) ? data.combos : [], suppliers: data.suppliers || {} };
  plWriteJSON(PL_OVERRIDES, clean); return clean;
}

const PL_MAT_ORDER = ["1.50", "1.56", "TRIVEX", "POLY", "1.60", "1.67", "1.74", "1.59", "GLASS"];
function plMatIdx(m) { const i = PL_MAT_ORDER.indexOf(m); return i < 0 ? 99 : i; }

function plApplyDisabled(combo, dis) {
  if (!dis) return combo;
  if (Array.isArray(dis.combos) && dis.combos.includes(combo.key)) return null;
  const supDis = dis.suppliers && dis.suppliers[combo.key];
  if (supDis && supDis.length) {
    const s = Object.assign({}, combo.suppliers);
    supDis.forEach(x => delete s[x]);
    return Object.assign({}, combo, { suppliers: s });
  }
  return combo;
}

function plPricedMatrix(combos, settings) {
  const s = settings || {};
  const dis = s.disabled || null;
  const priced = combos.map(c => {
    const c2 = plApplyDisabled(c, dis);
    if (c2 === null) return { key: c.key, treatment: c.treatment, tier: c.tier, material: c.material, available: false, disabled: true };
    const sp = PE.standardPrice(c2, s);
    if (!sp.available) return { key: c.key, treatment: c.treatment, tier: c.tier, material: c.material, available: false };
    return { key: c.key, treatment: c.treatment, tier: c.tier, material: c.material, ...sp, retailUSD: PE.retailFrom(sp.priceUSD, s.markup) };
  });
  if (s.smooth === false) return priced;
  const groups = {};
  for (const p of priced) {
    if (!p.available) continue;
    const g = `${p.treatment}||${p.tier}`;
    (groups[g] = groups[g] || []).push(p);
  }
  for (const g of Object.values(groups)) {
    g.sort((a, b) => plMatIdx(a.material) - plMatIdx(b.material));
    const smoothed = PE.smoothLadder(g.map(p => ({ key: p.key, priceUSD: p.priceUSD })), s);
    const byKey = Object.fromEntries(smoothed.map(r => [r.key, r.priceUSD]));
    for (const p of g) {
      if (byKey[p.key] != null && byKey[p.key] !== p.priceUSD) {
        p.priceUSD = byKey[p.key]; p.smoothed = true;
        p.floorMargin = PE.marginAt(p.priceUSD, p.anchorCost);
        p.preferredMargin = PE.marginAt(p.priceUSD, p.preferredCost);
        p.retailUSD = PE.retailFrom(p.priceUSD, s.markup);
      }
    }
  }
  return priced;
}

function plValidatePricedRowsForProfit(pricedRows, opts) {
  const rows = Array.isArray(pricedRows) ? pricedRows : [];
  const settings = opts && typeof opts === "object" ? opts : {};
  const combos = plCombosForClassOverrides(settings.classOverrides);
  const comboByKey = Object.fromEntries(combos.map(c => [c.key, c]));
  const failures = [];
  for (const row of rows) {
    if (!row || row.available === false || !(Number(row.priceUSD) > 0)) continue;
    const combo = comboByKey[row.key];
    if (!combo) {
      failures.push({ key: row.key || "", reason: "combo not found" });
      continue;
    }
    const activeCombo = plApplyDisabled(combo, settings.disabled);
    if (!activeCombo) continue;
    const ev = PE.evaluateOverride(activeCombo, Number(row.priceUSD), settings);
    if (ev.ok) continue;
    const constrained = row.constraintSupplier
      && Array.isArray(ev.acceptableSuppliers)
      && ev.acceptableSuppliers.some(s => s.supplier === row.constraintSupplier);
    if (!constrained) failures.push({ key: row.key, reason: ev.message || "below margin floor" });
  }
  if (failures.length) {
    const e = new Error(`Refusing to publish ${failures.length} price${failures.length === 1 ? "" : "s"} below the margin floor.`);
    e.statusCode = 400;
    e.details = failures.slice(0, 20);
    throw e;
  }
  return true;
}

function plLoadLists() { return plReadJSON(PL_LISTS, {}); }
function plSaveLists(data) { plWriteJSON(PL_LISTS, data); }

// Connectors helpers
const PL_CONN_API_BASE = "https://xstmeirxhfbiyayrrsob.supabase.co/functions/v1/api-v1";
const PL_PARITY = {
  supplier: ["supplier", "supplier_id", "supplier_name", "lab", "vendor"],
  identity: ["name", "product_name", "description", "lens_name"],
  cost: ["cost (base)", "cost_base", "base_cost", "cost", "base_price", "fob", "landed_cost"],
};

const config = getConfig();
const host = config.host;
const port = config.port;
const publicDir = path.join(__dirname, "public");
const AUTH_COOKIE = "optilens_session";
const AUTH_TTL = 8 * 60 * 60 * 1000;
const authSessionFile = path.join(dataDir, "auth-sessions.protected");
const legacyAuthSessionFile = path.join(dataDir, "auth-sessions.json");
let migrateLegacyAuthSessions = false;
const authSessions = loadAuthSessions(); // token -> { userId, expiresAt }
if (migrateLegacyAuthSessions && persistAuthSessions()) {
  try {
    fs.unlinkSync(legacyAuthSessionFile);
  } catch (error) {
    console.error("Could not remove legacy plaintext auth sessions:", error.message);
  }
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

const VAULT_CATEGORIES = ["SQL Server", "PSQL", "ODBC", "Access DB", "API Keys", "Web Portals", "Other"];

async function buildVaultConnectivityReport(data) {
  const categories = {};

  for (const category of VAULT_CATEGORIES) {
    const entries = Array.isArray(data?.[category]) ? data[category] : [];
    const entryReports = await Promise.all(entries.map((entry) => checkVaultEntryConnectivity(category, entry)));
    categories[category] = summarizeConnectivityCategory(category, entryReports);
  }

  return {
    checkedAt: new Date().toISOString(),
    categories
  };
}

function summarizeConnectivityCategory(category, entries) {
  if (!entries.length) {
    return {
      state: "warning",
      label: "No saved entries",
      detail: `No ${category} entries are saved in the vault.`,
      entries
    };
  }

  const hasError = entries.some((entry) => entry.state === "error");
  const allOnline = entries.every((entry) => entry.state === "online");
  const onlineCount = entries.filter((entry) => entry.state === "online").length;

  if (hasError) {
    return {
      state: "error",
      label: "Connectivity failed",
      detail: entries.find((entry) => entry.state === "error")?.detail || "One or more saved entries could not connect.",
      entries
    };
  }

  if (allOnline) {
    return {
      state: "online",
      label: "Connected",
      detail: entries.length === 1 ? entries[0].detail : `${entries.length} saved entries connected.`,
      entries
    };
  }

  return {
    state: "warning",
    label: onlineCount ? "Partially checked" : "Needs attention",
    detail: onlineCount ? `${onlineCount} of ${entries.length} saved entries connected.` : entries[0]?.detail || "Connectivity has not been confirmed.",
    entries
  };
}

async function checkVaultEntryConnectivity(category, entry) {
  try {
    if (category === "SQL Server") return checkSqlServerVaultEntry(entry);
    if (category === "PSQL") return checkPsqlVaultEntry(entry);
    if (category === "ODBC") return checkOdbcVaultEntry(entry);
    if (category === "Access DB") return checkAccessVaultEntry(entry);
    if (category === "API Keys") return checkApiKeyVaultEntry(entry);
    if (category === "Web Portals") return checkWebPortalVaultEntry(entry);
    return entryConnectivity(entry, "warning", "Saved", "No connectivity check is configured for this entry type.");
  } catch (error) {
    return entryConnectivity(entry, "error", "Check failed", error.message || "Connectivity check failed.");
  }
}

async function checkSqlServerVaultEntry(entry) {
  const fields = vaultFieldMap(entry);
  const config = {
    server: fields.server || fields.host || "",
    database: fields.database || fields.db || "",
    user: fields.username || fields.user || fields.userid || "",
    password: fields.password || fields.pwd || "",
    encrypt: parseBool(fields.encrypt, true),
    trustServerCertificate: parseBool(fields.trustcert || fields.trustservercertificate, true)
  };

  const missing = [];
  if (!config.server) missing.push("server");
  if (!config.database) missing.push("database");
  if (!config.user) missing.push("username");
  if (!config.password) missing.push("password");

  if (missing.length) {
    return entryConnectivity(entry, "warning", "Credentials incomplete", `Missing ${missing.join(", ")}.`);
  }

  const pool = new sql.ConnectionPool({
    server: config.server,
    database: config.database,
    user: config.user,
    password: config.password,
    options: {
      encrypt: config.encrypt,
      trustServerCertificate: config.trustServerCertificate
    },
    pool: {
      max: 1,
      min: 0,
      idleTimeoutMillis: 1000
    },
    connectionTimeout: 6000,
    requestTimeout: 8000
  });

  try {
    await pool.connect();
    const result = await pool.request().query("SELECT DB_NAME() AS database_name");
    const databaseName = result.recordset?.[0]?.database_name || config.database;
    return entryConnectivity(entry, "online", "Connected", `${config.server}/${databaseName} accepted the saved credentials.`);
  } catch (error) {
    return entryConnectivity(entry, "error", "Connection failed", error.message);
  } finally {
    try { await pool.close(); } catch {}
  }
}

async function checkPsqlVaultEntry(entry) {
  const fields = vaultFieldMap(entry);
  const base = getConfig().sourcePsql;
  const user = fields.username || fields.user || fields.userid || "";
  const password = fields.password || fields.pwd || "";
  const missing = [];
  if (!user) missing.push("username");
  if (!password) missing.push("password");

  if (missing.length) {
    return entryConnectivity(entry, "warning", "Credentials incomplete", `Missing ${missing.join(", ")}.`);
  }

  const config = {
    ...base,
    dsn: fields.dsn || fields.dsnname || base.dsn,
    driver: fields.driver || base.driver,
    host: fields.host || fields.server || base.host,
    port: Number(fields.port || base.port),
    database: fields.database || fields.db || base.database,
    user,
    password
  };
  const health = await checkPsqlConfig(config);
  return entryConnectivity(entry, health.state === "online" ? "online" : health.state === "error" ? "error" : "warning", health.state === "online" ? "Connected" : "Needs attention", health.detail);
}

async function checkOdbcVaultEntry(entry) {
  const fields = vaultFieldMap(entry);
  const dsn = fields.dsn || fields.dsnname || fields.name || "";
  const user = fields.username || fields.user || fields.uid || "";
  const password = fields.password || fields.pwd || "";

  if (!dsn) {
    return entryConnectivity(entry, "warning", "Credentials incomplete", "Missing ODBC DSN name.");
  }
  if (user && !password) {
    return entryConnectivity(entry, "warning", "Credentials incomplete", "Missing password.");
  }

  const connectionString = [
    ["DSN", dsn],
    user ? ["UID", user] : null,
    password ? ["PWD", password] : null
  ].filter(Boolean).map(([key, value]) => `${key}=${odbcValue(value)}`).join(";");

  try {
    await testOdbcConnection(connectionString);
    return entryConnectivity(entry, "online", "Connected", `${dsn} opened successfully through ODBC.`);
  } catch (error) {
    return entryConnectivity(entry, "error", "Connection failed", error.message);
  }
}

function checkAccessVaultEntry(entry) {
  const fields = vaultFieldMap(entry);
  const filePath = fields.filepath || fields.path || fields.file || fields.database || "";
  if (!filePath) {
    return entryConnectivity(entry, "warning", "Path missing", "Add the Access database file path to confirm availability.");
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      return entryConnectivity(entry, "online", "File found", `${filePath} is reachable from this machine.`);
    }
    return entryConnectivity(entry, "error", "Not a file", `${filePath} exists but is not a file.`);
  } catch {
    return entryConnectivity(entry, "error", "File not found", `${filePath} is not reachable from this machine.`);
  }
}

async function checkApiKeyVaultEntry(entry) {
  const fields = vaultFieldMap(entry);
  const baseUrl = fields.baseurl || fields.url || fields.endpoint || "";
  const apiKey = fields.apikey || fields.token || fields.key || "";
  if (!baseUrl || !apiKey) {
    return entryConnectivity(entry, "warning", "Credentials incomplete", "Add a base URL and API key before connectivity can be checked.");
  }

  // This used to return a flat "Saved" warning for every API key entry, which
  // meant the dot stayed amber whether the key was perfect or long revoked —
  // so it told the operator nothing, and a revoked key looked identical to a
  // working one. A scoped GET is non-destructive, so actually make the call.
  const base = String(baseUrl).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    return entryConnectivity(entry, "warning", "Base URL not testable", `'${base}' is not an http(s) URL, so the key cannot be verified.`);
  }
  try {
    const res = await fetch(`${base}/catalog?limit=1`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(8000),
    });
    // 403 means the key authenticated fine and merely lacks catalog:read — that
    // still proves the credential itself is good, which is what's being checked.
    if (res.ok || res.status === 403) {
      return entryConnectivity(entry, "online", "Key accepted", `${base} accepted this key (HTTP ${res.status}).`);
    }
    if (res.status === 401) {
      return entryConnectivity(entry, "error", "Key rejected", "The endpoint returned 401 — this key is invalid or has been revoked. Issue a new key and save it again.");
    }
    if (res.status === 404) {
      return entryConnectivity(entry, "error", "Endpoint not found", `${base}/catalog returned 404 — check the base URL.`);
    }
    return entryConnectivity(entry, "warning", `HTTP ${res.status}`, `${base} responded ${res.status}; the key could not be confirmed.`);
  } catch (error) {
    return entryConnectivity(entry, "error", "Unreachable", `Could not reach ${base}: ${error.message || error}.`);
  }
}

function checkWebPortalVaultEntry(entry) {
  const fields = vaultFieldMap(entry);
  const portalUrl = fields.url || fields.portalurl || fields.baseurl || "";
  const username = fields.username || fields.user || fields.login || "";
  const password = fields.password || fields.pwd || "";
  const missing = [];
  if (!portalUrl) missing.push("portal URL");
  if (!username) missing.push("username");
  if (!password) missing.push("password");
  if (missing.length) {
    return entryConnectivity(entry, "warning", "Credentials incomplete", `Missing ${missing.join(", ")}.`);
  }
  return entryConnectivity(entry, "warning", "Saved", "Portal credentials are saved; no login attempt is run from connectivity checks.");
}

function entryConnectivity(entry, state, label, detail) {
  return {
    name: String(entry?.name || "Untitled"),
    state,
    label,
    detail
  };
}

function vaultFieldMap(entry) {
  return (entry?.fields || []).reduce((fields, field) => {
    const key = normalizeVaultFieldName(field.label);
    if (key) fields[key] = field.val;
    return fields;
  }, {});
}

function normalizeVaultFieldName(label) {
  return String(label || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function odbcValue(value) {
  const text = String(value ?? "");
  if (!/[;{}]/.test(text)) return text;
  return `{${text.replaceAll("}", "}}")}}`;
}

function testOdbcConnection(connectionString) {
  return runOdbcProbe(connectionString, { timeoutMs: 8000 })
    .then(() => undefined);
}

function isLoopbackRequest(req) {
  const address = req.socket && req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isAllowedLocalOrigin(origin) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(parsed.hostname) || parsed.hostname.endsWith(".local");
  } catch {
    return false;
  }
}

function writeLocalDevCors(res, req) {
  const origin = req.headers.origin || "";
  if (isAllowedLocalOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "http://127.0.0.1");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function buildUpdateStatus() {
  const application = updateManager.getStatus();
  const git = gitUpdateChecker.getStatus();
  const gitChange = git.updateAvailable ? [{
    id: "git",
    label: `${git.behind} Git commit${git.behind === 1 ? "" : "s"}`,
    restartRequired: true
  }] : [];
  const changedAreas = application.changedAreas.concat(gitChange);
  const available = application.available || git.updateAvailable;

  return {
    ...application,
    available,
    changedAreas,
    git,
    plan: {
      ...application.plan,
      reloadBrowser: available,
      restartService: application.plan.restartService || git.updateAvailable,
      pullGit: git.updateAvailable
    }
  };
}

function scheduleApplicationUpdate(status) {
  scheduledUpdate = {
    requestedAt: new Date().toISOString(),
    targetRevision: status.availableRevision
  };

  const scriptPath = path.join(__dirname, "scripts", "apply-local-update.ps1");
  const args = [
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-ProjectRoot", __dirname,
    "-Port", String(port)
  ];

  if (status.plan.installDependencies || status.plan.pullGit) args.push("-InstallDependencies");
  if (status.plan.runMigrations || status.plan.pullGit) args.push("-RunMigrations");
  if (status.plan.pullGit) {
    args.push("-PullGit", "-GitRemote", status.git.remote, "-GitBranch", status.git.branch);
  }

  setTimeout(() => {
    try {
      const child = spawn(powershell, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        cwd: __dirname
      });
      child.unref();
    } catch (error) {
      scheduledUpdate = null;
      console.error("Could not start local update:", error.message);
    }
  }, 250).unref();
}

function scheduleHostStop() {
  setTimeout(() => {
    try {
      runHostScript(__dirname, "stop-app.ps1", ["-Port", String(port)]);
    } catch (error) {
      console.error("Could not stop OptiLens Local:", error.message);
    }
  }, 250).unref();
}

function scheduleHostRestart() {
  setTimeout(() => {
    try {
      runHostScript(__dirname, "restart-app.ps1", ["-ProjectRoot", __dirname, "-Port", String(port)]);
    } catch (error) {
      console.error("Could not restart OptiLens Local:", error.message);
    }
  }, 250).unref();
}

function readUpdateLogs() {
  return {
    checkedAt: new Date().toISOString(),
    logs: [
      tailTextFile(path.join(dataDir, "local-update.log")),
      tailTextFile(path.join(dataDir, "watchdog.log")),
      tailTextFile(path.join(__dirname, "server.err.log"), 32768),
    ].map((log) => ({
      ...log,
      path: path.relative(__dirname, log.path).replaceAll("\\", "/"),
    })),
  };
}

async function refreshGitUpdatesOnSchedule() {
  await gitUpdateChecker.refresh();
  const status = buildUpdateStatus();
  if (AUTO_APPLY_GIT_UPDATES && status.plan.pullGit && !status.git.localChanges && !scheduledUpdate) {
    scheduleApplicationUpdate(status);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/connectors/live-gateway/direct") {
    writeLocalDevCors(res, req);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
  }

  // ── Platform Auth API ─────────────────────────────────────────────────────

  if (url.pathname === "/api/auth/bootstrap-state" && req.method === "GET") {
    return handleApi(res, async () => getBootstrapState());
  }

  // ── RX file generation ───────────────────────────────────────────────────
  // The serializer owns all line generation and filesystem access. These
  // routes only expose approved configuration, previews, and deliveries.
  if (url.pathname === "/api/rx/order-settings" && req.method === "GET") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "automation.read");
      const settings = parseOrderSettings(await getSetting(orderSettingsKey(actor)));
      return { success: true, settings };
    });
  }

  if (url.pathname === "/api/rx/order-settings" && req.method === "POST") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "automation.manage");
      const settings = normaliseOrderSettings((await readJsonBody(req)).settings);
      await setSetting(orderSettingsKey(actor), JSON.stringify(settings), actor.username || actor.userId || "unknown");
      return { success: true, settings };
    });
  }

  if (url.pathname === "/api/rx/catalog" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "automation.read");
      const items = rxGenerator.getCatalog();
      return { success: true, count: items.length, items };
    });
  }

  if (url.pathname === "/api/rx/coatings" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "automation.read");
      const { items, refreshed } = await listRxCoatings();
      return { success: true, count: items.length, items, refreshed };
    });
  }

  if (url.pathname === "/api/rx/addons" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "automation.read");
      const items = rxGenerator.getAddons();
      return { success: true, count: items.length, items };
    });
  }

  if (url.pathname === "/api/rx/preview" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "automation.read");
      return rxGenerator.preview(await readJsonBody(req));
    });
  }

  if (url.pathname === "/api/rx/generate" && req.method === "POST") {
    try {
      const actor = await requirePermission(req, "automation.manage");
      const body = await readJsonBody(req);
      const result = rxGenerator.generate(body, actor);
      if (body.delivery === "stage") {
        return sendJson(res, {
          success: true,
          batchSize: result.batchSize,
          generated: result.generated.map(({ filename, summary }) => ({ filename, summary }))
        });
      }
      const content = result.batchSize === 1
        ? Buffer.from(result.generated[0].content, "utf8")
        : rxGenerator.zip(result.generated);
      const filename = result.batchSize === 1 ? result.generated[0].filename : `rx-batch-${Date.now()}.zip`;
      writeSecurityHeaders(res);
      res.writeHead(200, {
        "Content-Type": result.batchSize === 1 ? "text/plain; charset=utf-8" : "application/zip",
        "Content-Disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "Cache-Control": "no-store",
        "X-RX-Generated-Count": String(result.batchSize)
      });
      return res.end(content);
    } catch (error) {
      return sendJson(res, { error: error.message || "RX generation failed." }, error.statusCode || 500);
    }
  }

  if (url.pathname === "/api/rx/release" && req.method === "POST") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "automation.manage");
      return rxGenerator.release(await readJsonBody(req), actor);
    });
  }

  if (url.pathname === "/api/auth/bootstrap" && req.method === "POST") {
    return handleApi(res, async () => {
      const user = await bootstrapAdmin(await readJsonBody(req));
      setAuthCookie(res, createAuthSession(user), req);
      return { user };
    }, 201);
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    return handleApi(res, async () => {
      const body = await readJsonBody(req);
      const user = await authenticateUser(body.username, body.password);
      setAuthCookie(res, createAuthSession(user), req);
      return { user };
    });
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    destroyAuthSession(readAuthToken(req));
    clearAuthCookie(res, req);
    return sendJson(res, { ok: true });
  }

  if (url.pathname === "/api/auth/me" && req.method === "GET") {
    return handleApi(res, async () => {
      const user = await currentUser(req);
      return { user };
    });
  }

  if (url.pathname === "/api/auth/change-password" && req.method === "POST") {
    return handleApi(res, async () => {
      const user = await currentUser(req);
      if (!user) {
        const error = new Error("Unauthorized");
        error.statusCode = 401;
        throw error;
      }
      const body = await readJsonBody(req);
      await changePassword(user.userId, body.oldPassword, body.newPassword);
      return { ok: true };
    });
  }

  if (url.pathname === "/api/admin/users" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "users.manage");
      return listUsers();
    });
  }

  if (url.pathname === "/api/admin/users" && req.method === "POST") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "users.manage");
      return { user: await createUser(await readJsonBody(req), actor.userId) };
    }, 201);
  }

  if (url.pathname === "/api/admin/roles" && req.method === "POST") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "users.manage");
      return { role: await createRole(await readJsonBody(req), actor.userId) };
    }, 201);
  }

  const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUserMatch && req.method === "PATCH") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "users.manage");
      return { user: await updateUser(adminUserMatch[1], await readJsonBody(req), actor.userId) };
    });
  }

  const adminRoleMatch = url.pathname.match(/^\/api\/admin\/roles\/([^/]+)$/);
  if (adminRoleMatch && req.method === "PATCH") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "users.manage");
      return { role: await updateRole(adminRoleMatch[1], await readJsonBody(req), actor.userId) };
    });
  }

  if (adminRoleMatch && req.method === "DELETE") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "users.manage");
      return deleteRole(adminRoleMatch[1], actor.userId);
    });
  }

  // ── Vault API ──────────────────────────────────────────────────────────────

  // State — tells the client whether a PIN has been configured
  if (url.pathname === "/api/vault/state" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const v = readVault();
      return { hasPin: !!v.pinHash };
    });
  }

  // Setup — first-time: hash PIN server-side, persist data
  if (url.pathname === "/api/vault/setup" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const { pin, data } = await readJsonBody(req);
      if (!pin) throw Object.assign(new Error("pin is required"), { statusCode: 400 });
      const existing = readVault();
      if (existing.pinHash) throw Object.assign(new Error("Vault already initialised. Reset first."), { statusCode: 409 });
      writeVault({ pinHash: hashPin(pin), data: data || {} });
      return { ok: true, token: createSession() };
    }, 201);
  }

  // Unlock — verify PIN, return session token
  if (url.pathname === "/api/vault/unlock" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const { pin } = await readJsonBody(req);
      const v = readVault();
      if (!v.pinHash) throw Object.assign(new Error("Vault not initialised"), { statusCode: 404 });
      if (hashPin(pin) !== v.pinHash) throw Object.assign(new Error("Incorrect passcode"), { statusCode: 401 });
      return { ok: true, token: createSession() };
    });
  }

  // Get data — requires valid session
  if (url.pathname === "/api/vault/data" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      if (!validateSession(bearerToken(req))) throw Object.assign(new Error("Unauthorised"), { statusCode: 401 });
      return { data: readVault().data || {} };
    });
  }

  // Save data — requires valid session
  if (url.pathname === "/api/vault/data" && req.method === "PUT") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      if (!validateSession(bearerToken(req))) throw Object.assign(new Error("Unauthorised"), { statusCode: 401 });
      const { data } = await readJsonBody(req);
      const v = readVault();
      if (!v.pinHash) throw Object.assign(new Error("Vault not initialised"), { statusCode: 404 });
      writeVault({ pinHash: v.pinHash, data });
      return { ok: true };
    });
  }

  // Connectivity — summarizes saved vault entries as traffic-light states.
  if (url.pathname === "/api/vault/connectivity" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      if (!validateSession(bearerToken(req))) throw Object.assign(new Error("Unauthorised"), { statusCode: 401 });
      return buildVaultConnectivityReport(readVault().data || {});
    });
  }

  // Lock — invalidate session token
  if (url.pathname === "/api/vault/lock" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      destroySession(bearerToken(req));
      return { ok: true };
    });
  }

  // Reset — wipe vault and all sessions
  if (url.pathname === "/api/vault/reset" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      vaultSessions.clear();
      writeVault({ pinHash: null, data: null });
      return { ok: true };
    });
  }

  // ──────────────────────────────────────────────────────────────────────────

  if (url.pathname === "/api/health/live") {
    return sendJson(res, {
      ok: true,
      service: "optilens-local",
      time: new Date().toISOString(),
      application: {
        revision: updateManager.getStatus().running.revision,
        startedAt: applicationStartedAt
      }
    });
  }

  if (url.pathname === "/api/health") {
    const snapshot = await getIntegrationHealthSnapshot();
    return sendJson(res, {
      ...snapshot,
      time: new Date().toISOString(),
      application: {
        revision: updateManager.getStatus().running.revision,
        startedAt: applicationStartedAt
      },
      database: config.appDb.database,
      sourceMode: "read-only",
      writeBack: config.writeBackEnabled ? "enabled" : "disabled",
      appDatabase: snapshot.appDatabase,
      sourceDatabase: snapshot.sourceDatabase,
      psqlDatabase: snapshot.psqlDatabase
    });
  }

  if (url.pathname === "/api/system/updates" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "platform.admin");
      await gitUpdateChecker.refresh();
      return buildUpdateStatus();
    });
  }

  if (url.pathname === "/api/system/updates/apply" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "platform.admin");
      await gitUpdateChecker.refresh();
      const status = buildUpdateStatus();

      if (scheduledUpdate) {
        const error = new Error("An update is already being applied.");
        error.statusCode = 409;
        throw error;
      }
      if (!status.available) return { ...status, applying: false, message: "OptiLens Local is already up to date." };
      if (status.plan.pullGit && status.git.localChanges) {
        const error = new Error("Remote updates are available, but this checkout has local changes. Commit or stash them before applying the Git update.");
        error.statusCode = 409;
        throw error;
      }

      if (status.plan.restartService) {
        scheduleApplicationUpdate(status);
        return { ...status, applying: true, message: "Applying update. This page will reload when the service is ready." };
      }

      return { ...status, applying: false, message: "Browser files are ready. Reloading this page now." };
    });
  }

  if (url.pathname === "/api/system/updates/logs" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "platform.admin");
      return readUpdateLogs();
    });
  }

  if (url.pathname === "/api/system/host/stop" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "platform.admin");
      scheduleHostStop();
      return { ok: true, message: "Stopping OptiLens Local. The browser will show reconnecting until the app is started again." };
    });
  }

  if (url.pathname === "/api/system/host/restart" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "platform.admin");
      scheduleHostRestart();
      return { ok: true, message: "Restarting OptiLens Local. This page will reconnect when the service is healthy." };
    });
  }

  if (url.pathname === "/api/modules") {
    const user = await optionalCurrentUser(req);
    return sendJson(res, { modules: filterModulesForUser(defaultModules, user) });
  }

  if (url.pathname === "/api/dashboard" && req.method === "GET") {
    const user = await optionalCurrentUser(req);
    return sendJson(res, await buildDashboard(url.searchParams.get("deviceId"), user?.userId || null));
  }

  if (url.pathname === "/api/dashboard/tiles" && req.method === "PUT") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "dashboard.write");
      return saveDashboardTiles(await readJsonBody(req), actor.userId);
    });
  }

  if (url.pathname === "/api/dashboard/device" && req.method === "POST") {
    return sendJson(res, createDeviceRegistration((await readJsonBody(req)).deviceId), 201);
  }

  if (url.pathname === "/api/business-metrics" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "delivery.read");
      return getBusinessMetrics();
    });
  }

  if (url.pathname === "/api/access-import/status" && req.method === "GET") {
    return sendJson(res, readJsonFile(path.join(__dirname, "docs", "access-import-last-run.json"), {
      error: "Access import has not run yet."
    }));
  }

  if (url.pathname === "/api/access-import/dry-run" || url.pathname.startsWith("/api/access-import/")) {
    return sendJson(res, readJsonFile(path.join(__dirname, "docs", "access-import-dry-run.json"), {
      error: "Access import dry-run has not been generated yet."
    }));
  }

  if (url.pathname === "/api/admin/migrate" && req.method === "POST") {
    return handleApi(res, async () => {
      await requireMigrationAccess(req);
      return runMigrations();
    });
  }

  if (url.pathname === "/api/admin/cleanup-test-shipments" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "platform.admin");
      return deleteTestShipmentSessions();
    });
  }

  if (url.pathname === "/api/delivery/shipments" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "delivery.read");
      const range = {
        fromDate: url.searchParams.get("fromDate") || "",
        toDate: url.searchParams.get("toDate") || ""
      };
      // Mirror Innovations first (best-effort — a source outage should not
      // block reading whatever is already cached locally), then read back.
      let syncResult = null;
      try {
        syncResult = await syncShipmentSessions(range);
      } catch (error) {
        syncResult = { error: error.message };
      }
      const sessions = await listShipmentSessions(range);
      return { sessions: await enrichShipmentSessions(sessions), sync: syncResult };
    });
  }

  if (url.pathname === "/api/source/dispatchers" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "delivery.read");
      return { dispatchers: await listDispatchers() };
    });
  }

  if (url.pathname === "/api/source/export-customers" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "delivery.read");
      return { customers: await listExportCustomers(url.searchParams.get("q") || "") };
    });
  }

  if (url.pathname === "/api/source/customers" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "delivery.read");
      return { customers: await listCustomers(url.searchParams.get("q") || "") };
    });
  }

  if (url.pathname === "/api/source/shipment-items" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "delivery.read");
      return { items: await listShipmentItems({
        customerAccount: url.searchParams.get("customerAccount") || "",
        shipmentId: url.searchParams.get("shipmentId") || ""
      }) };
    });
  }

  if (url.pathname === "/api/delivery/shipments" && req.method === "POST") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "delivery.write");
      return { session: await createShipmentSession(await readJsonBody(req), actor.userId) };
    }, 201);
  }

  if (url.pathname === "/api/delivery/shipments/close-batch" && req.method === "POST") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "delivery.write");
      const body = await readJsonBody(req);
      const sessions = await enrichShipmentSessions(await listShipmentSessions({}));
      const byId = new Map(sessions.map((session) => [String(session.shipment_session_id), session]));
      const requested = Array.isArray(body.sessionIds) ? body.sessionIds.map((id) => String(id || "").trim()).filter(Boolean) : [];
      const blocked = requested
        .map((id) => byId.get(id))
        .filter((session) => !session || session.app_status === "closed" || session.is_export_customer || session.shipping_method_id === null);

      if (blocked.length) {
        const error = new Error("Batch close is only available for selected open domestic shipments.");
        error.statusCode = 400;
        throw error;
      }

      return { sessions: await closeShipmentSessionsBatch(requested, body.dispatcherId || "", actor.userId) };
    });
  }

  const shipmentCoMatch = url.pathname.match(/^\/api\/delivery\/shipments\/([^/]+)\/commercial-invoice\/co$/);
  if (shipmentCoMatch && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "delivery.read");
      return getCoForShipment(shipmentCoMatch[1]);
    });
  }

  if (shipmentCoMatch && req.method === "POST") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "delivery.write");
      const application = await prepareCoDraft(shipmentCoMatch[1], await readJsonBody(req), actor.userId);
      return { application };
    }, 201);
  }

  const commercialInvoicePreviewMatch = url.pathname.match(/^\/api\/delivery\/shipments\/([^/]+)\/commercial-invoice\/preview$/);
  if (commercialInvoicePreviewMatch && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "delivery.read");
      return { preview: await getCommercialInvoicePreview(commercialInvoicePreviewMatch[1]) };
    });
  }

  const commercialInvoiceLinesMatch = url.pathname.match(/^\/api\/delivery\/shipments\/([^/]+)\/commercial-invoice\/lines$/);
  if (commercialInvoiceLinesMatch && req.method === "PUT") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "delivery.write");
      const body = await readJsonBody(req);
      const result = await saveCommercialInvoiceLineOverrides(commercialInvoiceLinesMatch[1], body.lines || [], actor.userId);
      return result;
    });
  }

  const commercialInvoicePrintMatch = url.pathname.match(/^\/api\/delivery\/shipments\/([^/]+)\/commercial-invoice\.pdf$/);
  if (commercialInvoicePrintMatch && req.method === "GET") {
    return handleHtml(res, async () => {
      await requirePermission(req, "delivery.read");
      const preview = await getCommercialInvoicePreview(commercialInvoicePrintMatch[1]);
      return renderCommercialInvoiceHtml(preview);
    });
  }

  const coDraftMatch = url.pathname.match(/^\/api\/delivery\/co-applications\/([^/]+)\/draft$/);
  if (coDraftMatch && req.method === "PUT") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "delivery.write");
      const application = await saveCoDraft(coDraftMatch[1], await readJsonBody(req), actor.userId);
      return { application };
    });
  }

  const coJobCreateMatch = url.pathname.match(/^\/api\/delivery\/co-applications\/([^/]+)\/automation-jobs$/);
  if (coJobCreateMatch && req.method === "POST") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "delivery.write");
      const job = await createBeSwiftAutomationJob(coJobCreateMatch[1], actor.userId);
      return { job };
    }, 201);
  }

  const customerParamsMatch = url.pathname.match(/^\/api\/delivery\/customer-parameters\/([^/]+)$/);
  if (customerParamsMatch && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "delivery.read");
      return { parameters: await getCustomerParameters(decodeURIComponent(customerParamsMatch[1])) };
    });
  }

  if (customerParamsMatch && req.method === "PUT") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "delivery.write");
      const parameters = await upsertCustomerParameters(
        decodeURIComponent(customerParamsMatch[1]),
        await readJsonBody(req),
        actor.userId
      );
      return { parameters };
    });
  }

  const catalogEntryMatch = url.pathname.match(/^\/api\/delivery\/co-item-catalog\/(.+)$/);
  if (catalogEntryMatch && req.method === "PUT") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "delivery.write");
      const entry = await saveCatalogEntry(decodeURIComponent(catalogEntryMatch[1]), await readJsonBody(req), actor.userId);
      return { entry };
    });
  }

  const extensionClaimMatch = url.pathname.match(/^\/api\/beswift-extension\/jobs\/([^/]+)$/);
  if (extensionClaimMatch && req.method === "GET") {
    return handleApi(res, async () => claimBeSwiftAutomationJob(extensionClaimMatch[1]));
  }

  const extensionStatusMatch = url.pathname.match(/^\/api\/beswift-extension\/jobs\/([^/]+)\/status$/);
  if (extensionStatusMatch && req.method === "POST") {
    return handleApi(res, async () => {
      const job = await updateBeSwiftAutomationJobStatus(extensionStatusMatch[1], await readJsonBody(req));
      return { job };
    });
  }
  // Read-only poll used by the popup's live status panel and by anyone
  // watching a staged test run (e.g. a tab opened just to poll this URL) —
  // deliberately GET/no-auth like the claim endpoint above, same bearer-style
  // posture (automation_job_id is a GUID, not guessable).
  if (extensionStatusMatch && req.method === "GET") {
    return handleApi(res, async () => {
      const job = await getBeSwiftAutomationJobStatus(extensionStatusMatch[1]);
      return { job };
    });
  }

  // Signals a job paused via pauseForInteraction() (content.js) to continue.
  // GET, matching the claim endpoint's existing GET-mutates precedent, so a
  // plain tab navigation (no form/JS needed) can trigger it.
  const extensionResumeMatch = url.pathname.match(/^\/api\/beswift-extension\/jobs\/([^/]+)\/resume$/);
  if (extensionResumeMatch && req.method === "GET") {
    return handleApi(res, async () => {
      const job = await resumeBeSwiftAutomationJob(extensionResumeMatch[1], url.searchParams.get("message"));
      return { job };
    });
  }

  // Beta extension: capture an operator's error + resolution note for a stuck
  // field. POST, no-auth (same GUID-bearer posture as the sibling job
  // endpoints above) so content.js can relay it via the background worker.
  const extensionResolutionMatch = url.pathname.match(/^\/api\/beswift-extension\/jobs\/([^/]+)\/resolution$/);
  if (extensionResolutionMatch && req.method === "POST") {
    return handleApi(res, async () => {
      const resolution = await recordBeSwiftFillResolution(extensionResolutionMatch[1], await readJsonBody(req));
      return { resolution };
    }, 201);
  }

  // Beta extension: read-only aggregated resolutions for an AI refinement pass.
  if (url.pathname === "/api/beswift-extension/resolutions" && req.method === "GET") {
    return handleApi(res, async () => {
      const resolutions = await listBeSwiftFillResolutions({
        field: url.searchParams.get("field"),
        automationJobId: url.searchParams.get("automationJobId"),
        limit: url.searchParams.get("limit")
      });
      return { resolutions };
    });
  }

  if (url.pathname === "/api/standards-catalog" && req.method === "GET") {
    return handleApi(res, async () => {
      const field = url.searchParams.get("field");
      const catalog = await getStandardsCatalog(field || null);
      return field ? { field, options: catalog } : { catalog };
    });
  }

  if (url.pathname === "/api/pricing/rules" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      return { rules: await listPricingRules() };
    });
  }

  if (url.pathname === "/api/pricing/rules" && req.method === "POST") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "pricing.write");
      return { rule: await createPricingRule(await readJsonBody(req), actor.userId) };
    }, 201);
  }

  if (url.pathname === "/api/pricing/calculate" && req.method === "POST") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "pricing.write");
      return calculatePrice(await readJsonBody(req), actor.userId);
    }, 201);
  }

  if (url.pathname === "/api/pricing/calculations" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      return { calculations: await listPriceCalculations() };
    });
  }

  const sessionGetMatch = url.pathname.match(/^\/api\/delivery\/shipments\/([^/]+)$/);
  if (sessionGetMatch && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "delivery.read");
      const sessions = await enrichShipmentSessions([await getShipmentSession(sessionGetMatch[1])]);
      return { session: sessions[0] };
    });
  }

  const itemMatch = url.pathname.match(/^\/api\/delivery\/shipments\/([^/]+)\/items$/);
  if (itemMatch && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "delivery.read");
      return { items: await buildShipmentItems(itemMatch[1]) };
    });
  }

  if (itemMatch && req.method === "POST") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "delivery.write");
      const session = (await enrichShipmentSessions([await getShipmentSession(itemMatch[1])]))[0];
      if (!session.is_export_customer) {
        const error = new Error("Add Rows is only available for export shipments.");
        error.statusCode = 400;
        throw error;
      }
      if (session.app_status === "closed") {
        const error = new Error("Rows cannot be added to a closed shipment.");
        error.statusCode = 400;
        throw error;
      }

      const body = await readJsonBody(req);
      const invoiceNumber = String(body.invoiceNumber || "").trim();
      const sourceItem = await findInvoiceItem(invoiceNumber);
      if (!sourceItem) {
        const error = new Error(`Invoice ${invoiceNumber || "(blank)"} was not found in Innovations.`);
        error.statusCode = 404;
        throw error;
      }
      if (session.customer_account && sourceItem.customerAccount && session.customer_account !== sourceItem.customerAccount) {
        const error = new Error(`Invoice ${invoiceNumber} belongs to ${sourceItem.customerAccount}, not ${session.customer_account}.`);
        error.statusCode = 409;
        throw error;
      }

      const item = await addShipmentSessionItem(itemMatch[1], sourceItem, actor.userId);
      return { item, items: await buildShipmentItems(itemMatch[1]) };
    }, 201);
  }

  const closeMatch = url.pathname.match(/^\/api\/delivery\/shipments\/([^/]+)\/close$/);
  if (closeMatch && req.method === "POST") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "delivery.write");
      return { session: await updateShipmentStatus(closeMatch[1], "closed", actor.userId) };
    });
  }

  const reopenMatch = url.pathname.match(/^\/api\/delivery\/shipments\/([^/]+)\/reopen$/);
  if (reopenMatch && req.method === "POST") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "delivery.write");
      return { session: await updateShipmentStatus(reopenMatch[1], "prep", actor.userId) };
    });
  }

  const eventsMatch = url.pathname.match(/^\/api\/delivery\/shipments\/([^/]+)\/events$/);
  if (eventsMatch && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "delivery.read");
      return { events: await listShipmentEvents(eventsMatch[1]) };
    });
  }

  // ── Pricelist Builder API (/api/v2/* + /api/customers + /api/pricelists + /api/connectors) ──

  if (url.pathname === "/api/v2/combos" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      plRefreshCombos();
      return plCombos;
    });
  }
  if (url.pathname === "/api/v2/quote-only" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      return plReadJSON(PL_QUOTE, {});
    });
  }
  if (url.pathname === "/api/v2/sources" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      return plReadJSON(PL_SOURCES, { sources: [], live: [] });
    });
  }
  if (url.pathname === "/api/v2/catalog-source-rows" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      const rows = plCatalogSourceRows(url.searchParams.get("supplier"));
      const included = rows.filter(r => r.included).length;
      return { rows, count: rows.length, included, excluded: rows.length - included };
    });
  }
  if (url.pathname === "/api/v2/source-status" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      return plSourceStatus();
    });
  }
  if (url.pathname === "/api/v2/source-mode" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.write");
      const body = await readJsonBody(req);
      plSetSourceMode((body && body.mode) || "auto");
      plReloadCombos();
      return plSourceStatus();
    });
  }
  // All lens TYPES with their current category/group + the editable vocabulary.
  if (url.pathname === "/api/v2/catalog-types" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      plRefreshCombos();
      return { types: plCatalogTypes(), tiers: PL_TIER_OPTIONS, groups: PL_GROUP_OPTIONS, materials: PL_MAT_ORDER, overrides: plReadOverrides() };
    });
  }
  if (url.pathname === "/api/v2/classification-preview" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      const body = await readJsonBody(req);
      const classOverrides = plNormalizeClassOverrides(body && body.classOverrides);
      const combos = plCombosForClassOverrides(classOverrides);
      return { combos, types: plCatalogTypes(classOverrides), tiers: PL_TIER_OPTIONS, groups: PL_GROUP_OPTIONS, materials: PL_MAT_ORDER, overrides: classOverrides };
    });
  }
  // Tag-pill classify: set/clear a type's category (tier) and/or group (treatment), then re-bucket + re-price.
  if (url.pathname === "/api/v2/classify" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.write");
      const body = await readJsonBody(req);
      const typeKeys = Array.isArray(body && body.typeKeys)
        ? body.typeKeys.filter(Boolean)
        : [body && body.typeKey].filter(Boolean);
      if (!typeKeys.length) { const e = new Error("typeKey required."); e.statusCode = 400; throw e; }
      const ov = plReadOverrides();
      for (const typeKey of typeKeys) {
        if (body.tierAuto) delete ov.tierByType[typeKey];
        else if ('tier' in body) ov.tierByType[typeKey] = body.tier || null;
        if (body.treatmentAuto) delete ov.treatmentByType[typeKey];
        else if ('treatment' in body) ov.treatmentByType[typeKey] = body.treatment || null;
        if (body.materialAuto) delete ov.materialByType[typeKey];
        else if ('material' in body) ov.materialByType[typeKey] = body.material || null;
      }
      plWriteOverrides(ov);
      const count = plReclassify();
      return { ok: true, combos: count, types: plCatalogTypes(), overrides: ov };
    });
  }
  if (url.pathname === "/api/v2/overrides" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      return plLoadOverrides();
    });
  }
  if (url.pathname === "/api/v2/overrides" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.write");
      return plSaveOverrides(await readJsonBody(req));
    });
  }
  if (url.pathname === "/api/v2/price" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      const settings = await readJsonBody(req);
      if (!settings.disabled) settings.disabled = plLoadOverrides();
      const priceCombos = plCombosForClassOverrides(settings.classOverrides);
      return { settings, rows: plPricedMatrix(priceCombos, settings) };
    });
  }
  if (url.pathname === "/api/v2/override" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      const body = await readJsonBody(req);
      const overrideCombos = plCombosForClassOverrides(body.classOverrides);
      const combo = Object.fromEntries(overrideCombos.map(c => [c.key, c]))[body.key];
      if (!combo) { const e = new Error("combo not found"); e.statusCode = 404; throw e; }
      return PE.evaluateOverride(combo, Number(body.enteredPriceUSD), body);
    });
  }

  // Pricelist builder customers — live from SQL, enriched with priceList/balance
  // from the static JSON, with full fallback to static JSON if SQL is unavailable.
  if (url.pathname === "/api/pl/customers" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      try {
        const sqlRows = await listPricelistCustomers();
        // Build a lookup from the static file so we can enrich priceList + balance
        const staticList = plReadJSON(PL_CUSTOMERS, []);
        const staticMap = {};
        for (const c of staticList) if (c.account) staticMap[c.account] = c;
        return sqlRows.map(r => ({
          ...r,
          priceList: staticMap[r.account]?.priceList || '',
          balance:   staticMap[r.account]?.balance   || '0',
        }));
      } catch (sqlErr) {
        // SQL unavailable — serve the static snapshot
        // The _sqlError field is stripped in production but visible in devtools
        const rows = plReadJSON(PL_CUSTOMERS, []);
        rows._sqlError = sqlErr.message || String(sqlErr);
        return rows;
      }
    });
  }

  // Diagnostic: test the SQL customer query and return the raw result or error.
  // Hit GET /api/pl/customers/test in a browser to see exactly what SQL returns.
  if (url.pathname === "/api/pl/customers/test" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      try {
        const rows = await listPricelistCustomers();
        return { ok: true, source: "sql", count: rows.length, sample: rows.slice(0, 3) };
      } catch (err) {
        return { ok: false, source: "sql", error: err.message || String(err) };
      }
    });
  }

  // Saved pricelists CRUD
  if (url.pathname === "/api/pricelists" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      const pl = plLoadLists();
      return Object.entries(pl).map(([id, p]) => ({ id, name: p.name, customer: p.customer, customerName: p.customerName, updatedAt: p.updatedAt }));
    });
  }
  if (url.pathname === "/api/pricelists" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.write");
      const pl = plLoadLists();
      const id = Date.now().toString();
      pl[id] = { ...await readJsonBody(req), id, updatedAt: new Date().toISOString() };
      plSaveLists(pl);
      return { id };
    }, 201);
  }
  const plGetMatch = url.pathname.match(/^\/api\/pricelists\/([^/]+)$/);
  if (plGetMatch && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      const pl = plLoadLists();
      if (!pl[plGetMatch[1]]) {
        const error = new Error("Not found");
        error.statusCode = 404;
        throw error;
      }
      return pl[plGetMatch[1]];
    });
  }
  if (plGetMatch && req.method === "PUT") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.write");
      const pl = plLoadLists();
      pl[plGetMatch[1]] = { ...await readJsonBody(req), id: plGetMatch[1], updatedAt: new Date().toISOString() };
      plSaveLists(pl);
      return { ok: true };
    });
  }
  if (plGetMatch && req.method === "DELETE") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.write");
      const pl = plLoadLists();
      delete pl[plGetMatch[1]];
      plSaveLists(pl);
      return { ok: true };
    });
  }

  // Connectors (passphrase-locked credential vault)
  if (url.pathname === "/api/connectors/status" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      return plSecure.status();
    });
  }
  if (url.pathname === "/api/connectors/init" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const body = await readJsonBody(req);
      if (plSecure.isInitialised()) { const e = new Error("Already initialised."); e.statusCode = 409; throw e; }
      plSecure.setPassphrase(body.passphrase);
      return { ok: true, ...plSecure.status() };
    });
  }
  if (url.pathname === "/api/connectors/unlock" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const body = await readJsonBody(req);
      const token = plSecure.unlock(body.passphrase || "");
      if (!token) { const e = new Error("Wrong passphrase."); e.statusCode = 401; throw e; }
      return { ok: true, token, status: plSecure.status() };
    });
  }
  if (url.pathname === "/api/connectors/lock" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      plSecure.lock((await readJsonBody(req)).token);
      return { ok: true };
    });
  }
  if (url.pathname === "/api/connectors/reveal" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const body = await readJsonBody(req);
      const key = body.token && plSecure.keyForToken(body.token);
      if (!key) { const e = new Error("Locked — unlock first."); e.statusCode = 401; throw e; }
      return plSecure.reveal(body.token);
    });
  }
  if (url.pathname === "/api/connectors/config" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const body = await readJsonBody(req);
      const key = body.token && plSecure.keyForToken(body.token);
      if (!key) { const e = new Error("Locked — unlock first."); e.statusCode = 401; throw e; }
      return plSecure.saveOptilens(body.token, body);
    });
  }
  if (url.pathname === "/api/connectors/cvapi/config" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const body = await readJsonBody(req);
      const key = body.token && plSecure.keyForToken(body.token);
      if (!key) { const e = new Error("Locked — unlock first."); e.statusCode = 401; throw e; }
      return plSecure.saveCvApi(body.token, body);
    });
  }
  if (url.pathname === "/api/connectors/cvapi/reveal" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const body = await readJsonBody(req);
      const key = body.token && plSecure.keyForToken(body.token);
      if (!key) { const e = new Error("Locked — unlock first."); e.statusCode = 401; throw e; }
      return plSecure.revealCvApi(body.token);
    });
  }
  if (url.pathname === "/api/connectors/cvapi/test" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const body = await readJsonBody(req);
      const key = body.token && plSecure.keyForToken(body.token);
      if (!key) { const e = new Error("Locked — unlock first."); e.statusCode = 401; throw e; }
      let creds;
      try { creds = plSecure.getCvApi(body.token); } catch (e) { e.statusCode = 400; throw e; }
      const base = (creds.baseUrl || PL_CONN_API_BASE).replace(/\/$/, "");
      const get = async (p) => {
        const r = await fetch(base + p, { headers: { "x-api-key": creds.apiKey } });
        let bd = null; try { bd = await r.json(); } catch { /* non-JSON */ }
        return { status: r.status, ok: r.ok, body: bd };
      };
      const cat = await get("/catalog?limit=5");
      if (cat.status === 401) return { ok: false, link: "unauthorized", message: "Key invalid (401)." };
      if (cat.status === 403) return { ok: false, link: "forbidden", message: "Key lacks catalog:read scope (403)." };
      if (!cat.ok) return { ok: false, link: "error", message: `HTTP ${cat.status}.` };
      const rows = (cat.body && cat.body.data) || [];
      const cols = rows.length ? Object.keys(rows[0]) : [];
      const lc = cols.map(x => x.toLowerCase().trim());
      const find = (aliases) => aliases.find(a => lc.includes(a)) || null;
      const parity = Object.fromEntries(Object.entries(PL_PARITY).map(([k, al]) => [k, find(al)]));
      const cust = await get("/customers?limit=1");
      return { ok: true, link: "connected", base, catalogColumns: cols, catalogRows: rows.length, customersOk: cust.ok, parity, costPresent: !!parity.cost };
    });
  }
  // Pull the live Classic Visions catalog (catalog_live) → engine combos.
  if (url.pathname === "/api/connectors/cvapi/pull" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const body = await readJsonBody(req);
      const key = body.token && plSecure.keyForToken(body.token);
      if (!key) { const e = new Error("Locked — unlock first."); e.statusCode = 401; throw e; }
      const creds = plSecure.getCvApi(body.token);
      const summary = await plCvConnector.pull(creds, { write: true, overrides: plReadOverrides() });
      // Live pull wrote the generated catalog — return to it unless fallback is forced.
      if (plSourceMode() === "fallback") plSetSourceMode("auto");
      plReloadCombos();
      return summary;
    });
  }
  // Publish the built pricelist back to the key's draft pricelist_version.
  if (url.pathname === "/api/connectors/cvapi/publish" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const body = await readJsonBody(req);
      const key = body.token && plSecure.keyForToken(body.token);
      if (!key) { const e = new Error("Locked — unlock first."); e.statusCode = 401; throw e; }
      plValidatePricedRowsForProfit(body.pricedRows || [], body.settings || {});
      const creds = plSecure.getCvApi(body.token);
      return plCvConnector.publish(creds, {
        pricedRows: body.pricedRows || [],
        versionName: body.versionName,
        commit: !!body.commit,
      });
    });
  }
  if (url.pathname === "/api/connectors/pull" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const body = await readJsonBody(req);
      const key = body.token && plSecure.keyForToken(body.token);
      if (!key) { const e = new Error("Locked — unlock first."); e.statusCode = 401; throw e; }
      const creds = plSecure.getOptilens(body.token, { needService: false });
      const summary = await plConnector.pull(creds, { write: true, overrides: plReadOverrides() });
      // A successful pull writes the generated catalog; switch back to it
      // automatically (unless the user has explicitly forced fallback) and
      // reload combos in memory.
      if (plSourceMode() === "fallback") plSetSourceMode("auto");
      plReloadCombos();
      return summary;
    });
  }
  if (url.pathname === "/api/connectors/push" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const body = await readJsonBody(req);
      const key = body.token && plSecure.keyForToken(body.token);
      if (!key) { const e = new Error("Locked — unlock first."); e.statusCode = 401; throw e; }
      const commit = !!body.commit;
      plValidatePricedRowsForProfit(body.pricedRows || [], body.settings || {});
      const creds = plSecure.getOptilens(body.token, { needService: commit });
      return plConnector.push(creds, { pricedRows: body.pricedRows || [], versionName: body.versionName, commit });
    });
  }

  // ── Innovations → Classic Visions cloud sync (outbound push) ──────────────
  // On-demand trigger. Dry-run by default; pass { commit:true } to write.
  // Contract: docs/integration-innovations-sync-contract.md (Classic Visions).
  if (url.pathname === "/api/connectors/innovations-sync/run" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const body = await readJsonBody(req);
      const key = body.token && plSecure.keyForToken(body.token);
      if (!key) { const e = new Error("Locked — unlock first."); e.statusCode = 401; throw e; }
      const creds = plSecure.getCvApi(body.token);
      return innovationsSync.sync(creds, {
        entities: Array.isArray(body.entities) && body.entities.length ? body.entities : undefined,
        commit: !!body.commit,
        batchSize: Number(body.batchSize) > 0 ? Number(body.batchSize) : undefined,
        // Only pass this as true for a one-off historical backfill — see
        // innovations-sync.js for why (avoids emailing every customer at once).
        suppressStatementEmails: !!body.suppressStatementEmails,
      });
    });
  }

  // Introspect live source columns (no CV key needed) to match the entity SQL.
  if (url.pathname === "/api/connectors/innovations-sync/schema" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const body = await readJsonBody(req);
      const tables = Array.isArray(body.tables) && body.tables.length
        ? body.tables
        : ["Customers", "Contacts", "CustomerAddresses", "CustomerBalances", "FinExportedInvoices", "FinARStatements", "FinARStatementItems"];
      return innovationsSync.describeTables(tables);
    });
  }

  // Claim + run any pending CV-initiated "Sync now" requests (cloud queues them).
  if (url.pathname === "/api/connectors/innovations-sync/check-requests" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const body = await readJsonBody(req);
      const key = body.token && plSecure.keyForToken(body.token);
      if (!key) { const e = new Error("Locked — unlock first."); e.statusCode = 401; throw e; }
      const creds = plSecure.getCvApi(body.token);
      return innovationsSync.runRequested(creds, {});
    });
  }

  // Recent local operator log. The cloud remains the source of truth for
  // received rows/dead letters; this explains whether the office agent ran.
  if (url.pathname === "/api/connectors/innovations-sync/logs" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "integrations.read");
      return { logFile: innovationsSyncLog.LOG_FILE, events: innovationsSyncLog.readRecent(url.searchParams.get("limit")) };
    });
  }

  // The host monitor is a loopback operator surface. It reads the persisted
  // CV API entry directly from the Credentials Vault, so its self-test and
  // explicit sync actions do not depend on a browser session or passphrase
  // token that disappears on restart.
  if (url.pathname === "/api/monitor/innovations-sync/status" && req.method === "GET") {
    return handleApi(res, async () => {
      requireLoopbackMonitor(req);
      const health = await getIntegrationHealthSnapshot({ force: true });
      const credentials = credentialVault.cvApiFromVault();
      return { ...health.innovationsSync, credentialsConfigured: !!credentials };
    });
  }

  if (url.pathname === "/api/monitor/innovations-sync/logs" && req.method === "GET") {
    return handleApi(res, async () => {
      requireLoopbackMonitor(req);
      return { events: innovationsSyncLog.readRecent(url.searchParams.get("limit") || 80) };
    });
  }

  if (url.pathname === "/api/monitor/innovations-sync/selftest" && req.method === "POST") {
    return handleApi(res, async () => {
      requireLoopbackMonitor(req);
      return runMonitorSyncSelfTest();
    });
  }

  if (url.pathname === "/api/monitor/innovations-sync/run" && req.method === "POST") {
    return handleApi(res, async () => {
      requireLoopbackMonitor(req);
      const body = await readJsonBody(req);
      const credentials = monitorSyncCredentials();
      return innovationsSync.sync(credentials, {
        entities: Array.isArray(body.entities) && body.entities.length ? body.entities : undefined,
        commit: !!body.commit,
        suppressStatementEmails: !!body.suppressStatementEmails,
      });
    });
  }

  if (url.pathname === "/api/monitor/source-backend" && req.method === "GET") {
    return handleApi(res, async () => {
      requireLoopbackMonitor(req);
      return sourceBackend.getStatus();
    });
  }

  if (url.pathname === "/api/monitor/source-backend/switch" && req.method === "POST") {
    return handleApi(res, async () => {
      requireLoopbackMonitor(req);
      const body = await readJsonBody(req);
      return sourceBackend.switchTo(body.target, { force: !!body.force, actorUserId: "local-monitor" });
    });
  }

  if (url.pathname === "/api/monitor/zen-mirror/sync" && req.method === "POST") {
    return handleApi(res, async () => {
      requireLoopbackMonitor(req);
      const body = await readJsonBody(req);
      zenMirrorWorker.runOnce({ full: !!body.full }).catch(() => {});
      return { started: true, full: !!body.full };
    });
  }

  // ── On-demand CV Web live-data gateway ───────────────────────────────────
  // The worker makes outbound-only calls to CV Web and performs strictly
  // allow-listed reads against Innovations and the OptiLens app database.
  if (url.pathname === "/api/connectors/live-gateway/status" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "integrations.read");
      return liveGatewayStatus();
    });
  }

  if (url.pathname === "/api/connectors/live-gateway/direct" && req.method === "POST") {
    return handleApi(res, async () => {
      if (!isLoopbackRequest(req) || !isAllowedLocalOrigin(req.headers.origin || "")) {
        const error = new Error("Local live-data fallback is only available from localhost.");
        error.statusCode = 403;
        throw error;
      }
      const body = await readJsonBody(req);
      const data = await dispatchLiveDataRequest({
        operation: body.operation,
        target: body.target,
        arguments: body.arguments,
      });
      return { data };
    });
  }

  if (url.pathname === "/api/connectors/live-gateway/selftest" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "integrations.read");
      const body = await readJsonBody(req);
      const credentials = body.token && plSecure.keyForToken(body.token) ? getLiveGatewayCredentials(body.token) : null;
      return liveGatewayWorker.selfTest({ credentials, account: body.account });
    });
  }

  if (url.pathname === "/api/connectors/live-gateway/start" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const body = await readJsonBody(req);
      const key = body.token && plSecure.keyForToken(body.token);
      if (!key) { const error = new Error("Locked — unlock the vault first."); error.statusCode = 401; throw error; }
      const credentials = getLiveGatewayCredentials(body.token);
      liveGatewayAutostart.save(credentials);
      liveGatewayWorker.start(credentials);
      return liveGatewayStatus();
    });
  }

  if (url.pathname === "/api/connectors/live-gateway/stop" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      liveGatewayWorker.stop();
      liveGatewayAutostart.clear();
      return liveGatewayStatus();
    });
  }

  // ── Innovations source backend (live vendor MSSQL vs Zen-fed mirror) ─────
  // Temporary bridge while the vendor Innovations MSSQL is unreliable. See
  // docs/operations-agent/IMPLEMENTATION_PLAN.md.
  if (url.pathname === "/api/connectors/source-backend" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "integrations.read");
      return sourceBackend.getStatus();
    });
  }

  if (url.pathname === "/api/connectors/source-backend/switch" && req.method === "POST") {
    return handleApi(res, async () => {
      const user = await requirePermission(req, "credentials.manage");
      const body = await readJsonBody(req);
      return sourceBackend.switchTo(body.target, { force: !!body.force, actorUserId: user.userId });
    });
  }

  if (url.pathname === "/api/connectors/zen-mirror/status" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "integrations.read");
      return zenMirrorWorker.status();
    });
  }

  if (url.pathname === "/api/connectors/zen-mirror/sync" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "credentials.manage");
      const body = await readJsonBody(req);
      // A full sync can run for minutes; kick it off and let the UI poll status.
      zenMirrorWorker.runOnce({ full: !!body.full }).catch(() => {});
      return { started: true, full: !!body.full };
    });
  }

  // ── Doc Studio API ────────────────────────────────────────────────────────

  if (url.pathname === "/api/docstudio/users" && req.method === "GET") {
    return handleApi(res, async () => {
      const user = await requirePermission(req, "docstudio.read");
      const data = await listUsers();
      return {
        users: data.users
          .filter((item) => item.isActive && item.userId !== user.userId)
          .map((item) => ({
            userId: item.userId,
            username: item.username,
            displayName: item.displayName,
            email: item.email || ""
          }))
      };
    });
  }

  if (url.pathname === "/api/docstudio/my-files" && req.method === "GET") {
    return handleApi(res, async () => {
      const user = await requirePermission(req, "docstudio.read");
      return listAllAccessibleFiles(user.userId, { scope: url.searchParams.get("scope") || "all-accessible" });
    });
  }

  if (url.pathname === "/api/docstudio/files" && req.method === "GET") {
    return handleApi(res, async () => {
      const user = await requirePermission(req, "docstudio.read");
      return listFiles(
        user.userId,
        url.searchParams.get("scope") || "all-accessible",
        url.searchParams.get("type") || ""
      );
    });
  }

  if (url.pathname === "/api/docstudio/files" && req.method === "POST") {
    return handleApi(res, async () => {
      const user = await requirePermission(req, "docstudio.write");
      return createFile(await readJsonBody(req), user.userId);
    }, 201);
  }

  const docStudioFileMatch = url.pathname.match(/^\/api\/docstudio\/files\/([^/]+)$/);
  if (docStudioFileMatch && req.method === "GET") {
    return handleApi(res, async () => {
      const user = await requirePermission(req, "docstudio.read");
      return getFile(docStudioFileMatch[1], user.userId);
    });
  }

  if (docStudioFileMatch && req.method === "PUT") {
    return handleApi(res, async () => {
      const user = await requirePermission(req, "docstudio.write");
      return updateFile(docStudioFileMatch[1], await readJsonBody(req), user.userId);
    });
  }

  if (docStudioFileMatch && req.method === "DELETE") {
    return handleApi(res, async () => {
      const user = await requirePermission(req, "docstudio.write");
      return deleteFile(docStudioFileMatch[1], user.userId);
    });
  }

  const docStudioFileAutosaveMatch = url.pathname.match(/^\/api\/docstudio\/files\/([^/]+)\/autosave$/);
  if (docStudioFileAutosaveMatch && req.method === "PUT") {
    return handleApi(res, async () => {
      const user = await requirePermission(req, "docstudio.write");
      return autosaveFile(docStudioFileAutosaveMatch[1], await readJsonBody(req), user.userId);
    });
  }

  const docStudioUnifiedSharesMatch = url.pathname.match(/^\/api\/docstudio\/files\/(file|billing)\/([^/]+)\/shares$/);
  if (docStudioUnifiedSharesMatch && req.method === "PUT") {
    return handleApi(res, async () => {
      const user = await requirePermission(req, "docstudio.write");
      const body = await readJsonBody(req);
      return updateUnifiedShares(docStudioUnifiedSharesMatch[1], docStudioUnifiedSharesMatch[2], body.shares || [], user.userId);
    });
  }

  if (url.pathname === "/api/docstudio/billing-documents" && req.method === "GET") {
    return handleApi(res, async () => {
      const user = await requirePermission(req, "docstudio.read");
      return listBillingDocuments(user.userId, url.searchParams.get("scope") || "all-accessible");
    });
  }

  if (url.pathname === "/api/docstudio/billing-documents" && req.method === "POST") {
    return handleApi(res, async () => {
      const user = await requirePermission(req, "docstudio.write");
      return createBillingDocument(await readJsonBody(req), user.userId);
    }, 201);
  }

  const docStudioBillingMatch = url.pathname.match(/^\/api\/docstudio\/billing-documents\/([^/]+)$/);
  if (docStudioBillingMatch && req.method === "GET") {
    return handleApi(res, async () => {
      const user = await requirePermission(req, "docstudio.read");
      return getBillingDocument(docStudioBillingMatch[1], user.userId);
    });
  }

  if (docStudioBillingMatch && req.method === "PUT") {
    return handleApi(res, async () => {
      const user = await requirePermission(req, "docstudio.write");
      return updateBillingDocument(docStudioBillingMatch[1], await readJsonBody(req), user.userId);
    });
  }

  if (docStudioBillingMatch && req.method === "DELETE") {
    return handleApi(res, async () => {
      const user = await requirePermission(req, "docstudio.write");
      return deleteBillingDocument(docStudioBillingMatch[1], user.userId);
    });
  }

  const docStudioAutosaveMatch = url.pathname.match(/^\/api\/docstudio\/billing-documents\/([^/]+)\/autosave$/);
  if (docStudioAutosaveMatch && req.method === "PUT") {
    return handleApi(res, async () => {
      const user = await requirePermission(req, "docstudio.write");
      return autosaveBillingDocument(docStudioAutosaveMatch[1], await readJsonBody(req), user.userId);
    });
  }

  const docStudioSharesMatch = url.pathname.match(/^\/api\/docstudio\/billing-documents\/([^/]+)\/shares$/);
  if (docStudioSharesMatch && req.method === "PUT") {
    return handleApi(res, async () => {
      const user = await requirePermission(req, "docstudio.write");
      const body = await readJsonBody(req);
      return updateBillingDocumentShares(docStudioSharesMatch[1], body.shares || [], user.userId);
    });
  }

  // ── Statement API ──────────────────────────────────────────────────────────
  const statementMatch = url.pathname.match(/^\/api\/statement\/([^/]+)$/);
  if (statementMatch && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "docstudio.read");
      const data = await getStatement(statementMatch[1]);
      return data;
    });
  }

  if (url.pathname.startsWith("/api/")) {
    return sendJson(res, { error: "Not found" }, 404);
  }

  if (isInteractivePageRequest(url.pathname) && !isPublicInteractivePage(url.pathname)) {
    const user = await optionalCurrentUser(req);
    if (!user) {
      return redirectToSignIn(res);
    }
    if (!canAccessPage(url.pathname, user)) {
      return sendText(res, "Forbidden", 403);
    }
  }

  const filePath = resolveStaticPath(url.pathname);
  if (!filePath) {
    return sendText(res, "Not found", 404);
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      return sendText(res, error.code === "ENOENT" ? "Not found" : "Server error", error.code === "ENOENT" ? 404 : 500);
    }

    const ext = path.extname(filePath).toLowerCase();
    writeSecurityHeaders(res, url.pathname);
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  });
});

function isInteractivePageRequest(requestPath) {
  const normalized = normalizeRoutePath(requestPath);
  const ext = path.extname(normalized).toLowerCase();

  if (!ext) return true;
  return ext === ".html";
}

function isPublicInteractivePage(requestPath) {
  const route = normalizeRoutePath(requestPath);
  return route === "/"
    || route === "/index.html";
}

function normalizeRoutePath(requestPath) {
  if (!requestPath || requestPath === "/") return "/";
  return requestPath.endsWith("/") && requestPath.length > 1
    ? requestPath.slice(0, -1)
    : requestPath;
}

function redirectToSignIn(res) {
  writeSecurityHeaders(res);
  res.writeHead(302, {
    "Location": "/",
    "Cache-Control": "no-store"
  });
  res.end();
}

function canAccessPage(requestPath, user) {
  if (!user) return false;
  const route = normalizeRoutePath(requestPath);
  const permissions = new Set(user.permissions || []);
  if (permissions.has("platform.admin")) return true;

  const pagePermissions = {
    "/settings": ["platform.admin"],
    "/settings.html": ["platform.admin"],
    "/credentials": ["credentials.manage"],
    "/credentials.html": ["credentials.manage"],
    "/admin/users": ["users.manage"],
    "/admin-users.html": ["users.manage"],
    "/modules/delivery-export": ["delivery.read"],
    "/delivery-export.html": ["delivery.read"],
    "/modules/pricing-automation": ["pricing.read"],
    "/pricing-automation.html": ["pricing.read"],
    "/tools/pricing-automation/index.html": ["pricing.read"],
    "/modules/integrations": ["integrations.read"],
    "/integrations.html": ["integrations.read"],
    "/modules/automation": ["automation.read", "automation.manage"],
    "/automation.html": ["automation.read", "automation.manage"],
    "/modules/doc-studio": ["docstudio.read", "docstudio.write"],
    "/doc-studio.html": ["docstudio.read", "docstudio.write"],
    "/modules/business-metrics": ["platform.admin"],
    "/business-metrics.html": ["platform.admin"]
  };

  const required = pagePermissions[route];
  if (!required) return true;
  return required.some((permission) => permissions.has(permission));
}

function filterModulesForUser(modules, user) {
  if (!user) return [];
  const permissions = new Set(user.permissions || []);
  if (permissions.has("platform.admin")) return modules;

  const accessByModule = new Map(MODULE_ACCESS.map((module) => [
    module.code,
    module.readPermissions.concat(module.fullPermissions)
  ]));

  return modules.filter((module) => {
    const requiredPermissions = accessByModule.get(module.id);
    if (!requiredPermissions) return false;
    return requiredPermissions.some((permission) => permissions.has(permission));
  });
}

function resolveStaticPath(requestPath) {
  const route = requestPath === "/" ? "/index.html" : requestPath;
  const candidate = path.normalize(path.join(publicDir, route));
  const relative = path.relative(publicDir, candidate);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  const pageRoutes = {
    "/login":                       "login.html",
    "/release-notes":               "release-notes.html",
    "/settings":                    "settings.html",
    "/credentials":                 "credentials.html",
    "/modules/delivery-export":     "delivery-export.html",
    "/modules/pricing-automation":  "tools/pricing-automation/index.html",
    "/pricing-automation.html":     "tools/pricing-automation/index.html",
    "/tools/pricing-automation/index.html": "tools/pricing-automation/index.html",
    "/modules/integrations":        "integrations.html",
    "/modules/automation":          "automation.html",
    "/modules/doc-studio":          "doc-studio.html",
    "/modules/business-metrics":    "business-metrics.html",
    "/admin/users":                 "admin-users.html"
  };
  if (pageRoutes[route]) {
    return path.join(publicDir, pageRoutes[route]);
  }

  if (route.startsWith("/modules/")) {
    return path.join(publicDir, "index.html");
  }

  return candidate;
}

function sendJson(res, data, status = 200) {
  writeSecurityHeaders(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendText(res, text, status = 200) {
  writeSecurityHeaders(res);
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function sendHtml(res, html, status = 200) {
  writeSecurityHeaders(res);
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

async function handleApi(res, action, status = 200) {
  try {
    return sendJson(res, await action(), status);
  } catch (error) {
    return sendJson(res, {
      error: error.message || "Server error"
    }, error.statusCode || 500);
  }
}

async function handleHtml(res, action, status = 200) {
  try {
    return sendHtml(res, await action(), status);
  } catch (error) {
    return sendHtml(res, `<p>${escapeHtmlServer(error.message || "Server error")}</p>`, error.statusCode || 500);
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      const err = new Error("Request body is too large.");
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("Invalid JSON in request body.");
    err.statusCode = 400;
    throw err;
  }
}

function renderCommercialInvoiceHtml(preview) {
  const money = (value) => Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const tariffRows = preview.tariffHeadings?.length
    ? preview.tariffHeadings.map((heading) => `${escapeHtmlServer(heading.heading)}<br>${escapeHtmlServer(heading.hsCode)}`).join("<br>")
    : `${escapeHtmlServer(preview.declarationText)}<br>${escapeHtmlServer(preview.declarationHsCode)}`;
  const rows = (preview.items || []).map((item) => `
    <tr>
      <td>${escapeHtmlServer(item.lineNumber)}</td>
      <td>${escapeHtmlServer(item.ref)}</td>
      <td>${escapeHtmlServer(item.specification)}</td>
      <td>${escapeHtmlServer(item.hsCode)}</td>
      <td>${escapeHtmlServer(item.origin)}</td>
      <td>${escapeHtmlServer(item.quantity)}</td>
      <td><span>$</span>${money(item.unitPrice)}</td>
      <td><span>$</span>${money(item.amount)}</td>
    </tr>
  `).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Commercial Invoice ${escapeHtmlServer(preview.invoiceNo)}</title>
  <style>
    @page { size: Letter; margin: 0.35in; }
    body { margin: 0; font-family: Arial, sans-serif; color: #08213d; font-size: 10px; }
    .invoice { width: 100%; }
    h1 { margin: 0 0 6px; font-size: 24px; color: #001b35; border-bottom: 2px solid #d89023; }
    .brand { float: right; margin-top: -28px; color: #0082a8; font-size: 8px; letter-spacing: 3px; font-weight: 700; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #b7c4d3; border-bottom: 0; }
    .cell { min-height: 38px; padding: 7px 8px; border-right: 1px solid #b7c4d3; border-bottom: 1px solid #b7c4d3; }
    .cell:nth-child(even) { border-right: 0; }
    .label { display: block; text-transform: uppercase; color: #3b628a; font-size: 7px; letter-spacing: .6px; font-weight: 700; margin-bottom: 5px; }
    .strong { font-weight: 700; color: #001b35; }
    .declaration { text-align: center; background: #fff6e2; color: #001b35; font-weight: 800; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 9px; }
    th { background: #071d35; color: white; text-transform: uppercase; font-size: 7px; padding: 8px 6px; }
    td { vertical-align: top; padding: 6px; border-bottom: 1px solid #d7e0ea; }
    td:nth-child(1), td:nth-child(2), td:nth-child(4), td:nth-child(5), td:nth-child(6), td:nth-child(7), td:nth-child(8) { text-align: center; white-space: nowrap; }
    td:nth-child(3) { width: 30%; overflow-wrap: anywhere; }
    .bottom { display: grid; grid-template-columns: 1.2fr .8fr; gap: 22px; margin-top: 10px; }
    .cert { display: flex; min-height: 126px; flex-direction: column; padding: 8px 4px; color: #315b83; line-height: 1.4; }
    .sig { margin-top: auto; border-top: 1px solid #071d35; width: 210px; padding-top: 10px; color: #001b35; font-weight: 800; }
    .totals { border: 1px solid #071d35; align-self: start; }
    .total-row { display: grid; grid-template-columns: 1fr 90px; padding: 7px 10px; border-bottom: 1px solid #c8d4e0; font-weight: 800; }
    .total-row:last-child { border-bottom: 0; background: #071d35; color: white; font-size: 14px; }
    .total-row span:last-child { text-align: right; }
    footer { margin-top: 18px; padding-top: 6px; border-top: 1px solid #c8d4e0; color: #6d86a1; font-size: 7px; display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <section class="invoice">
    <h1>Commercial Invoice</h1>
    <div class="brand">CLASSIC VISIONS · EXPORT</div>
    <div class="grid">
      <div class="cell"><span class="label">Seller (name, full address, country)</span><div class="strong">${escapeHtmlServer(preview.seller.name)}</div>${escapeHtmlServer((preview.seller.addressLines || []).join(", "))}<br>${escapeHtmlServer(preview.seller.phone)}</div>
      <div class="cell"><span class="label">Date / Inv No / Customer Order No</span><span class="strong">${escapeHtmlServer(preview.invoiceDate)} · ${escapeHtmlServer(preview.invoiceNo)} · ${escapeHtmlServer(preview.customerOrderNo)}</span></div>
      <div class="cell"><span class="label">Consignee</span><div class="strong">${escapeHtmlServer(preview.consignee.name)}</div>${escapeHtmlServer(preview.consignee.address)}<br>${escapeHtmlServer(preview.consignee.country)} ${escapeHtmlServer(preview.consignee.phone)}</div>
      <div class="cell"><span class="label">PO Numbers</span><span class="strong">${escapeHtmlServer(preview.poNumbers)}</span></div>
      <div class="cell"><span class="label">Port of Loading / Destination</span><span class="strong">${escapeHtmlServer(preview.transport.portOfLoading)} → ${escapeHtmlServer(preview.transport.countryOfDestination)}</span></div>
      <div class="cell"><span class="label">Bank / Origin / Terms</span>${escapeHtmlServer(preview.presentingBank)}<br><span class="strong">${escapeHtmlServer(preview.countryOfOriginOfGoods)}</span><br>${escapeHtmlServer(preview.deliveryTerms)}</div>
      <div class="cell"><span class="label">Transportation / Marks</span><span class="strong">${escapeHtmlServer(preview.transport.carrier)}</span> ${escapeHtmlServer(preview.transport.trackingNumber)}<br>${escapeHtmlServer(preview.transport.marksAndNumbers)}</div>
      <div class="cell declaration"><span class="label">Declaration</span>${tariffRows}</div>
    </div>
    <table>
      <thead><tr><th>Line #</th><th>Ref #</th><th>Specification of Commodities</th><th>HS Code</th><th>Origin</th><th>Quant.</th><th>Unit Price</th><th>Amount</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="8">No invoice lines.</td></tr>`}</tbody>
    </table>
    <div class="bottom">
      <div class="cert">
        <p>${escapeHtmlServer(preview.itemCount)} Items &nbsp;&nbsp; ${escapeHtmlServer(preview.noChargeNote)}</p>
        <p>${escapeHtmlServer(preview.certificationText)}</p>
        <div class="sig">Classic Visions<br><small>AUTHORISED SIGNATURE FOR CLASSIC VISIONS</small></div>
      </div>
      <div class="totals">
        <div class="total-row"><span>Sub Total</span><span>$${money(preview.totals.subTotal)}</span></div>
        <div class="total-row"><span>Packaging</span><span>$${money(preview.totals.packaging)}</span></div>
        <div class="total-row"><span>Freight</span><span>$${money(preview.totals.freight)}</span></div>
        <div class="total-row"><span>Other Costs</span><span>$${money(preview.totals.other)}</span></div>
        <div class="total-row"><span>Insurance</span><span>$${money(preview.totals.insurance)}</span></div>
        <div class="total-row"><span>Invoice Total</span><span>$${money(preview.totals.invoiceTotal)}</span></div>
      </div>
    </div>
    <footer><span>Classic Visions · TIN# 1000006494000 · Uplands, St. John, Barbados · Tel 246-433-4928</span><span>Generated ${escapeHtmlServer(preview.generatedAt)}</span></footer>
  </section>
</body>
</html>`;
}

function escapeHtmlServer(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function enrichShipmentSessions(sessions) {
  const customerMap = await buildCustomerMap();
  return sessions.map((session) => {
    const customer = customerMap.get(String(session.customer_account || "").toUpperCase());
    return {
      ...session,
      item_count: Number(session.source_item_count ?? session.item_count ?? 0),
      customer_name: customer?.customerName || "",
      // The session's own synced shipping method (per-shipment, from
      // Innovations) wins; the customer's default is only a fallback for
      // sessions that predate the sync.
      shipping_method_id: session.shipping_method_id ?? customer?.shippingMethodId ?? null,
      shipping_method_name: session.shipping_method_name || customer?.shippingMethodName || "",
      shipment_bin: customer?.shipmentBin || "",
      is_export_customer: Boolean(customer?.isExportCustomer)
    };
  });
}

async function buildCustomerMap() {
  try {
    const customers = await listCustomers("");
    return new Map(customers.map((customer) => [
      String(customer.customerAccount || "").toUpperCase(),
      {
        customerName: customer.customerName || "",
        shippingMethodId: customer.shippingMethodId,
        shippingMethodName: customer.shippingMethodName || "",
        shipmentBin: customer.shipmentBin || "",
        isExportCustomer: Boolean(customer.isExportCustomer)
      }
    ]));
  } catch {
    return new Map();
  }
}

async function buildShipmentItems(sessionId) {
  const session = await getShipmentSession(sessionId);
  const appItems = await listShipmentSessionItems(sessionId);
  let sourceItems = [];

  if (session.source_shipment_id) {
    sourceItems = await listShipmentItems({
      customerAccount: session.customer_account || "",
      shipmentId: session.source_shipment_id
    }).catch(() => []);
  }

  return [
    ...sourceItems.map((item) => normalizeSourceShipmentItem(item)),
    ...appItems.map((item) => normalizeAppShipmentItem(item))
  ];
}

function normalizeSourceShipmentItem(item) {
  return {
    origin: "source",
    shipmentItemId: item.shipmentItemId || "",
    shipmentId: item.shipmentId || "",
    orderId: item.orderId || "",
    orderType: item.orderTypeName || item.orderType || "Rx",
    customerAccount: item.customerAccount || "",
    invoiceNumber: item.invoiceNumber || "",
    rxNumber: item.rxNumber || "",
    patientName: item.patientName || "",
    price: item.price ?? null,
    itemState: Number(item.sourceShipped) === 1 ? "shipped" : "open",
    sourceShipped: item.sourceShipped,
    createdAt: item.sourceShippedTime || null
  };
}

function normalizeAppShipmentItem(item) {
  return {
    origin: "app",
    shipmentSessionItemId: item.shipmentSessionItemId,
    shipmentItemId: item.shipmentItemId || "",
    shipmentId: "",
    orderId: item.orderId || "",
    orderType: item.orderType || "Rx",
    customerAccount: "",
    invoiceNumber: item.invoiceNumber || "",
    rxNumber: item.rxNumber || "",
    patientName: item.patientName || "",
    price: item.price ?? null,
    itemState: item.itemState || "prep",
    addedMethod: item.addedMethod || "",
    createdAt: item.createdAt || null
  };
}

function createAuthSession(user) {
  const token = nodeCrypto.randomBytes(32).toString("hex");
  authSessions.set(token, {
    userId: user.userId,
    expiresAt: Date.now() + AUTH_TTL
  });
  persistAuthSessions();
  return token;
}

function destroyAuthSession(token) {
  if (token && authSessions.delete(token)) persistAuthSessions();
}

async function currentUser(req) {
  const token = readAuthToken(req);
  const session = token ? authSessions.get(token) : null;

  if (!session) {
    throwAuthError("Authentication required.");
  }

  if (Date.now() > session.expiresAt) {
    authSessions.delete(token);
    persistAuthSessions();
    throwAuthError("Session expired.");
  }

  return getUserAccess(session.userId);
}

function loadAuthSessions() {
  try {
    return parseAuthSessions(unprotectString(fs.readFileSync(authSessionFile, "utf8")));
  } catch {
    try {
      const sessions = parseAuthSessions(fs.readFileSync(legacyAuthSessionFile, "utf8"));
      migrateLegacyAuthSessions = true;
      return sessions;
    } catch {
      return new Map();
    }
  }
}

function parseAuthSessions(serialized) {
  const saved = JSON.parse(serialized);
  const now = Date.now();
  const entries = Array.isArray(saved) ? saved : [];
  const valid = entries.filter(([token, session]) => (
    typeof token === "string"
    && /^[a-f0-9]{64}$/i.test(token)
    && session
    && typeof session.userId === "string"
    && Number(session.expiresAt) > now
  ));
  return new Map(valid.map(([token, session]) => [token, {
    userId: session.userId,
    expiresAt: Number(session.expiresAt)
  }]));
}

function persistAuthSessions() {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const temporaryFile = `${authSessionFile}.tmp`;
    const protectedSessions = protectString(JSON.stringify([...authSessions]));
    fs.writeFileSync(temporaryFile, protectedSessions, { mode: 0o600 });
    fs.renameSync(temporaryFile, authSessionFile);
    return true;
  } catch (error) {
    console.error("Could not persist authenticated sessions:", error.message);
    return false;
  }
}

async function optionalCurrentUser(req) {
  try {
    return await currentUser(req);
  } catch {
    return null;
  }
}

async function requirePermission(req, permissionCode) {
  const user = await currentUser(req);
  if (!user.permissions.includes(permissionCode)) {
    const error = new Error("You do not have permission to perform this action.");
    error.statusCode = 403;
    throw error;
  }
  return user;
}

async function requireMigrationAccess(req) {
  try {
    return await requirePermission(req, "platform.admin");
  } catch (error) {
    if (error.statusCode !== 401) throw error;

    const state = await getBootstrapState().catch(() => ({ needsBootstrap: true }));
    if (state.needsBootstrap) return null;
    throw error;
  }
}

function throwAuthError(message) {
  const error = new Error(message);
  error.statusCode = 401;
  throw error;
}

function readAuthToken(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies[AUTH_COOKIE] || "";
}

function parseCookies(cookieHeader) {
  return cookieHeader.split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");
    if (index < 0) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function setAuthCookie(res, token, req) {
  res.setHeader("Set-Cookie", cookieHeader(AUTH_COOKIE, token, req, Math.floor(AUTH_TTL / 1000)));
}

function clearAuthCookie(res, req) {
  res.setHeader("Set-Cookie", cookieHeader(AUTH_COOKIE, "", req, 0));
}

function cookieHeader(name, value, req, maxAge) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`
  ];

  if (isSecureRequest(req)) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function isSecureRequest(req) {
  return req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
}

function writeSecurityHeaders(res, pathname = "") {
  // CSP scoped per-path: /ds/ assets get 'unsafe-eval' for the Doc Studio runtime.
  res.setHeader("X-Content-Type-Options", "nosniff");
  // SAMEORIGIN allows the doc-studio iframe (/ds/studio.html) to load within the same origin
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  // The embedded Doc Studio runtime (/ds/support.js) compiles component logic classes
  // with new Function(), which requires 'unsafe-eval'. Scope that relaxation to /ds/
  // assets only so the rest of the platform keeps the stricter policy.
  const scriptSrc = pathname.startsWith("/ds/")
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; connect-src 'self' https://xstmeirxhfbiyayrrsob.supabase.co; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; ${scriptSrc}; base-uri 'self'; frame-ancestors 'self'`
  );
}

function liveGatewayStatus() {
  return {
    ...liveGatewayWorker.status(),
    autostart: liveGatewayAutostartStatus(),
  };
}

function liveGatewayAutostartStatus() {
  if (process.env.OPTILENS_SYNC_PASSPHRASE) {
    return { enabled: true, source: "environment", updatedAt: null };
  }
  const state = liveGatewayAutostart.status();
  return {
    ...state,
    source: state.enabled ? "windows-protected-store" : null,
  };
}

function loadLiveGatewayStartupCredentials() {
  const passphrase = process.env.OPTILENS_SYNC_PASSPHRASE || "";
  if (passphrase) {
    const token = plSecure.unlock(passphrase);
    if (!token) throw new Error("configured passphrase did not unlock the vault");
    try {
      return { credentials: getLiveGatewayCredentials(token), source: "environment" };
    } finally {
      plSecure.lock(token);
    }
  }

  const credentials = liveGatewayAutostart.load();
  return credentials ? { credentials, source: "windows-protected-store" } : null;
}

function requireLoopbackMonitor(req) {
  if (!isLoopbackRequest(req) || !isAllowedLocalOrigin(req.headers.origin || "")) {
    const error = new Error("Monitor actions are only available from localhost.");
    error.statusCode = 403;
    throw error;
  }
}

function monitorSyncCredentials() {
  const credentials = credentialVault.cvApiFromVault();
  if (!credentials) {
    const error = new Error("Classic Visions API credentials are not configured in the Credentials Vault.");
    error.statusCode = 400;
    throw error;
  }
  return credentials;
}

async function runMonitorSyncSelfTest() {
  const credentials = monitorSyncCredentials();
  const health = await getIntegrationHealthSnapshot({ force: true });
  const receiver = await innovationsSync.receiverVersion(innovationsSync.functionsBase(credentials.baseUrl));
  const source = health.sourceDatabase || {};
  const steps = [
    {
      name: "credentials store",
      ok: true,
      detail: `Using persisted ${credentials.entryName || "Classic Visions"} API credentials.`,
    },
    {
      name: "Innovations source",
      ok: source.state === "online",
      detail: source.detail || source.state || "Source status unavailable.",
    },
    {
      name: "Classic Visions receiver",
      ok: !!receiver,
      detail: receiver ? `innovations-sync ${receiver.version} accepts ${receiver.entities.length} entities.` : "Receiver version endpoint is unreachable.",
    },
  ];
  return { ok: steps.every((step) => step.ok), steps, ran_at: new Date().toISOString() };
}

function getLiveGatewayCredentials(token) {
  const cv = plSecure.getCvApi(token);
  const optilens = plSecure.getOptilens(token, { needService: false });
  if (!optilens.anonKey) {
    const error = new Error("Supabase project anon key is required for the live gateway. Configure the OptiLens connector first.");
    error.statusCode = 400;
    throw error;
  }
  return { ...cv, anonKey: optilens.anonKey };
}

function startLiveGatewayOnBoot() {
  try {
    const startup = loadLiveGatewayStartupCredentials();
    if (!startup) return;
    liveGatewayWorker.start(startup.credentials);
    console.log(`OptiLens live-data gateway worker started from ${startup.source}.`);
  } catch (error) {
    console.error("OptiLens live-data gateway did not start:", error.message);
  }
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

server.listen(port, host, () => {
  console.log(`OptiLens Local listening on http://${host}:${port}`);
  refreshGitUpdatesOnSchedule().catch(() => {});
  const gitUpdateTimer = setInterval(() => {
    refreshGitUpdatesOnSchedule().catch(() => {});
  }, 5 * 60 * 1000);
  gitUpdateTimer.unref();
  const mirrorWorkerState = zenMirrorWorker.start();
  console.log(`Zen mirror sync worker: ${mirrorWorkerState.detail}`);
  startLiveGatewayOnBoot();
});
