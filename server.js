const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const nodeCrypto = require("node:crypto");
const { spawn } = require("node:child_process");
const sql = require("mssql");
const { getConfig } = require("./lib/config");

// ─── Vault — server-side crypto + file storage ────────────────────────────────
// crypto.subtle is unavailable over plain HTTP on LAN devices, so all PIN
// hashing and session management lives here in Node.

const dataDir   = path.join(__dirname, "data");
const vaultFile = path.join(dataDir, "vault.json");
const VAULT_SALT = "optilens-credentials-v1";

/** SHA-256 hash of pin+salt, returned as base64 */
function hashPin(pin) {
  return nodeCrypto.createHash("sha256").update(pin + VAULT_SALT).digest("base64");
}

/** Read vault file → { pinHash, data } */
function readVault() {
  try {
    if (!fs.existsSync(vaultFile)) return { pinHash: null, data: null };
    return JSON.parse(fs.readFileSync(vaultFile, "utf8"));
  } catch { return { pinHash: null, data: null }; }
}

/** Persist vault object to disk */
function writeVault(obj) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(vaultFile, JSON.stringify(obj, null, 2));
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
const { checkAppDatabase, checkSourceDatabase } = require("./lib/db");
const { checkPsqlConfig, checkPsqlDatabase } = require("./lib/psql-odbc");
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
function plLoadCombos() {
  const tryFile = (p) => { try { const d = JSON.parse(fs.readFileSync(p, "utf8")); return Array.isArray(d) && d.length ? d : null; } catch { return null; } };
  const mode = plSourceMode();
  const gen = tryFile(PL_GEN);
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

// ── Classification overrides (Sourcing Review tag pills) ────────────────────
function plReadOverrides() {
  const o = plReadJSON(PL_CLASS_OV, null) || {};
  return { tierByType: o.tierByType || {}, treatmentByType: o.treatmentByType || {} };
}
function plWriteOverrides(o) { plWriteJSON(PL_CLASS_OV, o); }
function plReadRawRows() { return plReadJSON(PL_ROWS, null); }

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
function plCatalogTypes() {
  const rows = plReadRawRows() || [];
  const ov = plReadOverrides();
  const types = {};
  for (const r of rows) {
    if (!plClassifier.APPROVED.includes(r.supplier)) continue;
    if (r.active === false) continue;
    const lk = `${r.mftype}|${r.lenstype}`;
    const t = types[lk] || (types[lk] = { typeKey: lk, mftype: r.mftype, lenstype: r.lenstype, rows: 0, suppliers: {}, samples: [], treatments: {} });
    t.rows++;
    t.suppliers[r.supplier] = (t.suppliers[r.supplier] || 0) + 1;
    if (t.samples.length < 4) t.samples.push(r.name);
    const trt = ov.treatmentByType[lk] || plClassifier.normTreatment(r.name);
    t.treatments[trt] = (t.treatments[trt] || 0) + 1;
  }
  return Object.values(types).map(t => {
    const tier = ov.tierByType[t.typeKey] || plClassifier.TIER_MAP[t.typeKey] || null;
    return {
      typeKey: t.typeKey, mftype: t.mftype, lenstype: t.lenstype, rows: t.rows,
      suppliers: Object.keys(t.suppliers), supplierCount: Object.keys(t.suppliers).length,
      samples: t.samples, tier, classified: !!tier,
      tierOverridden: !!ov.tierByType[t.typeKey],
      treatmentOverride: ov.treatmentByType[t.typeKey] || null,
      groups: Object.keys(t.treatments),
    };
  }).sort((a, b) => (a.classified - b.classified) || a.mftype.localeCompare(b.mftype) || (b.rows - a.rows));
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
const authSessions = new Map(); // token -> { userId, expiresAt }

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

const VAULT_CATEGORIES = ["SQL Server", "PSQL", "ODBC", "Access DB", "API Keys", "Other"];

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

function checkApiKeyVaultEntry(entry) {
  const fields = vaultFieldMap(entry);
  const baseUrl = fields.baseurl || fields.url || fields.endpoint || "";
  const apiKey = fields.apikey || fields.token || fields.key || "";
  if (!baseUrl && !apiKey) {
    return entryConnectivity(entry, "warning", "Credentials incomplete", "Add a base URL and API key before connectivity can be checked.");
  }
  return entryConnectivity(entry, "warning", "Saved", "API key entries are saved, but no safe non-destructive connectivity check is configured.");
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
  const script = [
    "$ErrorActionPreference = \"Stop\"",
    "$inputJson = [Console]::In.ReadToEnd()",
    "$payload = $inputJson | ConvertFrom-Json",
    "$conn = [System.Data.Odbc.OdbcConnection]::new($payload.connectionString)",
    "try {",
    "  $conn.Open()",
    "  [Console]::Out.Write(\"ok\")",
    "}",
    "finally {",
    "  if ($conn.State -eq \"Open\") { $conn.Close() }",
    "}"
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("ODBC health check timed out."));
    }, 8000);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(cleanPowerShellError(stderr) || `ODBC health check failed with exit code ${code}.`));
    });

    child.stdin.end(JSON.stringify({ connectionString }));
  });
}

function cleanPowerShellError(stderr) {
  return String(stderr || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // ── Platform Auth API ─────────────────────────────────────────────────────

  if (url.pathname === "/api/auth/bootstrap-state" && req.method === "GET") {
    return handleApi(res, async () => getBootstrapState());
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

  if (url.pathname === "/api/health") {
    const [appDbHealth, sourceDbHealth, psqlDbHealth] = await Promise.all([
      checkAppDatabase(),
      checkSourceDatabase(),
      checkPsqlDatabase()
    ]);
    return sendJson(res, {
      ok: appDbHealth.state === "online" && sourceDbHealth.state === "online" && psqlDbHealth.state === "online",
      service: "optilens-local",
      time: new Date().toISOString(),
      database: config.appDb.database,
      sourceMode: "read-only",
      writeBack: config.writeBackEnabled ? "enabled" : "disabled",
      appDatabase: appDbHealth,
      sourceDatabase: sourceDbHealth,
      psqlDatabase: psqlDbHealth
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
      const sessions = await listShipmentSessions({
        fromDate: url.searchParams.get("fromDate") || "",
        toDate: url.searchParams.get("toDate") || ""
      });
      return { sessions: await enrichShipmentSessions(sessions) };
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
      return { types: plCatalogTypes(), tiers: PL_TIER_OPTIONS, groups: PL_GROUP_OPTIONS, overrides: plReadOverrides() };
    });
  }
  // Tag-pill classify: set/clear a type's category (tier) and/or group (treatment), then re-bucket + re-price.
  if (url.pathname === "/api/v2/classify" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.write");
      const body = await readJsonBody(req);
      const typeKey = body && body.typeKey;
      if (!typeKey) { const e = new Error("typeKey required."); e.statusCode = 400; throw e; }
      const ov = plReadOverrides();
      if ('tier' in body) { if (body.tier) ov.tierByType[typeKey] = body.tier; else delete ov.tierByType[typeKey]; }
      if ('treatment' in body) { if (body.treatment) ov.treatmentByType[typeKey] = body.treatment; else delete ov.treatmentByType[typeKey]; }
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
      plRefreshCombos();
      const settings = await readJsonBody(req);
      if (!settings.disabled) settings.disabled = plLoadOverrides();
      return { settings, rows: plPricedMatrix(plCombos, settings) };
    });
  }
  if (url.pathname === "/api/v2/override" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      plRefreshCombos();
      const body = await readJsonBody(req);
      const combo = plComboByKey[body.key];
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
      const creds = plSecure.getOptilens(body.token, { needService: commit });
      return plConnector.push(creds, { pricedRows: body.pricedRows || [], versionName: body.versionName, commit });
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
    "/settings":                    "settings.html",
    "/credentials":                 "credentials.html",
    "/modules/delivery-export":     "delivery-export.html",
    "/modules/pricing-automation":  "pricing-automation.html",
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

async function handleApi(res, action, status = 200) {
  try {
    return sendJson(res, await action(), status);
  } catch (error) {
    return sendJson(res, {
      error: error.message || "Server error"
    }, error.statusCode || 500);
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

async function enrichShipmentSessions(sessions) {
  const customerMap = await buildCustomerMap();
  return sessions.map((session) => {
    const customer = customerMap.get(String(session.customer_account || "").toUpperCase());
    return {
      ...session,
      item_count: Number(session.item_count || 0),
      customer_name: customer?.customerName || "",
      shipping_method_id: customer?.shippingMethodId ?? null,
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
    orderId: item.orderId || "",
    invoiceNumber: item.invoiceNumber || "",
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
    orderId: item.orderId || "",
    invoiceNumber: item.invoiceNumber || "",
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
  return token;
}

function destroyAuthSession(token) {
  if (token) authSessions.delete(token);
}

async function currentUser(req) {
  const token = readAuthToken(req);
  const session = token ? authSessions.get(token) : null;

  if (!session) {
    throwAuthError("Authentication required.");
  }

  if (Date.now() > session.expiresAt) {
    authSessions.delete(token);
    throwAuthError("Session expired.");
  }

  return getUserAccess(session.userId);
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

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

server.listen(port, host, () => {
  console.log(`OptiLens Local listening on http://${host}:${port}`);
});
