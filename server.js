const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { getConfig } = require("./lib/config");

// ─── Vault file storage ───────────────────────────────────────────────────────

const dataDir  = path.join(__dirname, "data");
const vaultFile = path.join(dataDir, "vault.json");

function readVault() {
  try {
    if (!fs.existsSync(vaultFile)) return { pinHash: null, blob: null };
    return JSON.parse(fs.readFileSync(vaultFile, "utf8"));
  } catch { return { pinHash: null, blob: null }; }
}

function writeVault(data) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(vaultFile, JSON.stringify(data, null, 2));
}
const { checkAppDatabase, checkSourceDatabase } = require("./lib/db");
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

const config = getConfig();
const host = config.host;
const port = config.port;
const publicDir = path.join(__dirname, "public");

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

  // ── Vault API ──────────────────────────────────────────────────────────────

  if (url.pathname === "/api/vault/state" && req.method === "GET") {
    const v = readVault();
    return sendJson(res, { hasPin: !!v.pinHash, pinHash: v.pinHash, blob: v.blob });
  }

  if (url.pathname === "/api/vault/setup" && req.method === "POST") {
    return handleApi(res, async () => {
      const { pinHash, blob } = await readJsonBody(req);
      if (!pinHash || !blob) throw Object.assign(new Error("pinHash and blob are required"), { statusCode: 400 });
      const existing = readVault();
      if (existing.pinHash) throw Object.assign(new Error("Vault already initialised. Reset first."), { statusCode: 409 });
      writeVault({ pinHash, blob });
      return { ok: true };
    }, 201);
  }

  if (url.pathname === "/api/vault/data" && req.method === "PUT") {
    return handleApi(res, async () => {
      const { blob } = await readJsonBody(req);
      if (!blob) throw Object.assign(new Error("blob is required"), { statusCode: 400 });
      const v = readVault();
      if (!v.pinHash) throw Object.assign(new Error("Vault not initialised"), { statusCode: 404 });
      writeVault({ pinHash: v.pinHash, blob });
      return { ok: true };
    });
  }

  if (url.pathname === "/api/vault/reset" && req.method === "POST") {
    return handleApi(res, async () => {
      writeVault({ pinHash: null, blob: null });
      return { ok: true };
    });
  }

  // ──────────────────────────────────────────────────────────────────────────

  if (url.pathname === "/api/health") {
    const appDbHealth = await checkAppDatabase();
    const sourceDbHealth = await checkSourceDatabase();
    return sendJson(res, {
      ok: appDbHealth.state === "online" && sourceDbHealth.state === "online",
      service: "optilens-local",
      time: new Date().toISOString(),
      database: config.appDb.database,
      sourceMode: "read-only",
      writeBack: config.writeBackEnabled ? "enabled" : "disabled",
      appDatabase: appDbHealth,
      sourceDatabase: sourceDbHealth
    });
  }

  if (url.pathname === "/api/modules") {
    return sendJson(res, { modules: defaultModules });
  }

  if (url.pathname === "/api/dashboard" && req.method === "GET") {
    return sendJson(res, await buildDashboard(url.searchParams.get("deviceId")));
  }

  if (url.pathname === "/api/dashboard/tiles" && req.method === "PUT") {
    return handleApi(res, async () => saveDashboardTiles(await readJsonBody(req)));
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
    return handleApi(res, async () => runMigrations());
  }

  if (url.pathname === "/api/admin/cleanup-test-shipments" && req.method === "POST") {
    return handleApi(res, async () => deleteTestShipmentSessions());
  }

  if (url.pathname === "/api/delivery/shipments" && req.method === "GET") {
    return handleApi(res, async () => ({ sessions: await listShipmentSessions() }));
  }

  if (url.pathname === "/api/source/dispatchers" && req.method === "GET") {
    return handleApi(res, async () => ({ dispatchers: await listDispatchers() }));
  }

  if (url.pathname === "/api/source/export-customers" && req.method === "GET") {
    return handleApi(res, async () => ({ customers: await listExportCustomers(url.searchParams.get("q") || "") }));
  }

  if (url.pathname === "/api/source/shipment-items" && req.method === "GET") {
    return handleApi(res, async () => ({
      items: await listShipmentItems({
        customerAccount: url.searchParams.get("customerAccount") || "",
        shipmentId: url.searchParams.get("shipmentId") || ""
      })
    }));
  }

  if (url.pathname === "/api/delivery/shipments" && req.method === "POST") {
    return handleApi(res, async () => ({ session: await createShipmentSession(await readJsonBody(req)) }), 201);
  }

  if (url.pathname === "/api/pricing/rules" && req.method === "GET") {
    return handleApi(res, async () => ({ rules: await listPricingRules() }));
  }

  if (url.pathname === "/api/pricing/rules" && req.method === "POST") {
    return handleApi(res, async () => ({ rule: await createPricingRule(await readJsonBody(req)) }), 201);
  }

  if (url.pathname === "/api/pricing/calculate" && req.method === "POST") {
    return handleApi(res, async () => await calculatePrice(await readJsonBody(req)), 201);
  }

  if (url.pathname === "/api/pricing/calculations" && req.method === "GET") {
    return handleApi(res, async () => ({ calculations: await listPriceCalculations() }));
  }

  const sessionGetMatch = url.pathname.match(/^\/api\/delivery\/shipments\/([^/]+)$/);
  if (sessionGetMatch && req.method === "GET") {
    return handleApi(res, async () => ({ session: await getShipmentSession(sessionGetMatch[1]) }));
  }

  const closeMatch = url.pathname.match(/^\/api\/delivery\/shipments\/([^/]+)\/close$/);
  if (closeMatch && req.method === "POST") {
    return handleApi(res, async () => ({ session: await updateShipmentStatus(closeMatch[1], "closed") }));
  }

  const reopenMatch = url.pathname.match(/^\/api\/delivery\/shipments\/([^/]+)\/reopen$/);
  if (reopenMatch && req.method === "POST") {
    return handleApi(res, async () => ({ session: await updateShipmentStatus(reopenMatch[1], "prep") }));
  }

  const eventsMatch = url.pathname.match(/^\/api\/delivery\/shipments\/([^/]+)\/events$/);
  if (eventsMatch && req.method === "GET") {
    return handleApi(res, async () => ({ events: await listShipmentEvents(eventsMatch[1]) }));
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

  if (!candidate.startsWith(publicDir)) {
    return null;
  }

  // Named page routes
  const pageRoutes = {
    "/settings":                    "settings.html",
    "/credentials":                 "credentials.html",
    "/modules/delivery-export":     "delivery-export.html",
    "/modules/pricing-automation":  "pricing-automation.html",
    "/modules/integrations":        "integrations.html",
    "/modules/automation":          "automation.html",
    "/modules/doc-studio":          "doc-studio.html",
    "/modules/business-metrics":    "business-metrics.html"
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
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendText(res, text, status = 200) {
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
  for await (const chunk of req) {
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
