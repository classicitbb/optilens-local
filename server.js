const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const nodeCrypto = require("node:crypto");
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
const { checkPsqlDatabase } = require("./lib/psql-odbc");
const {
  buildDashboard,
  createDeviceRegistration,
  defaultModules,
  saveDashboardTiles
} = require("./lib/dashboard");
const { runMigrations } = require("./lib/migrations");
const {
  createShipmentSession,
  deleteTestShipmentSessions,
  getShipmentSession,
  listShipmentEvents,
  listShipmentSessions,
  updateShipmentStatus
} = require("./lib/delivery");
const {
  listDispatchers,
  listExportCustomers,
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
  createUser,
  getBootstrapState,
  getUserAccess,
  listUsers,
  updateUser
} = require("./lib/auth");

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

function plSourceStatus() {
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

  const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUserMatch && req.method === "PATCH") {
    return handleApi(res, async () => {
      const actor = await requirePermission(req, "users.manage");
      return { user: await updateUser(adminUserMatch[1], await readJsonBody(req), actor.userId) };
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
    return sendJson(res, { modules: defaultModules });
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
      return { sessions: await listShipmentSessions() };
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
      return { session: await getShipmentSession(sessionGetMatch[1]) };
    });
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
      return { settings, rows: plPricedMatrix(plCombos, settings) };
    });
  }
  if (url.pathname === "/api/v2/override" && req.method === "POST") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      const body = await readJsonBody(req);
      const combo = plComboByKey[body.key];
      if (!combo) { const e = new Error("combo not found"); e.statusCode = 404; throw e; }
      return PE.evaluateOverride(combo, Number(body.enteredPriceUSD), body);
    });
  }

  // Pricelist builder customers (separate from delivery customers)
  if (url.pathname === "/api/pl/customers" && req.method === "GET") {
    return handleApi(res, async () => {
      await requirePermission(req, "pricing.read");
      return plReadJSON(PL_CUSTOMERS, []);
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
      const summary = await plCvConnector.pull(creds, { write: true });
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
      const summary = await plConnector.pull(creds, { write: true });
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

  if (url.pathname.startsWith("/api/")) {
    return sendJson(res, { error: "Not found" }, 404);
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
