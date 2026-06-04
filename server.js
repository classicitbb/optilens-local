const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { getConfig } = require("./lib/config");
const { checkAppDatabase, checkSourceDatabase } = require("./lib/db");
const { runMigrations } = require("./lib/migrations");
const {
  createShipmentSession,
  deleteTestShipmentSessions,
  listShipmentEvents,
  listShipmentSessions,
  updateShipmentStatus
} = require("./lib/delivery");
const {
  listDispatchers,
  listExportCustomers,
  listShipmentItems
} = require("./lib/source-innovations");

const config = getConfig();
const host = config.host;
const port = config.port;
const publicDir = path.join(__dirname, "public");

const modules = [
  {
    id: "delivery-export",
    name: "Delivery and Export",
    status: "first-build",
    href: "/modules/delivery-export",
    summary: "Access delivery, shipment prep, commercial invoice, and archive workflows."
  },
  {
    id: "integrations",
    name: "Integrations",
    status: "planned",
    href: "/modules/integrations",
    summary: "MSSQL, PSQL, Access import, website updates, file-share checks, and future service APIs."
  },
  {
    id: "automation",
    name: "Automation",
    status: "planned",
    href: "/modules/automation",
    summary: "Local LLM and rule-based automation tools routed through audited platform APIs."
  }
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

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
    return sendJson(res, { modules });
  }

  if (url.pathname === "/api/dashboard") {
    return sendJson(res, await buildDashboard());
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

  if (route.startsWith("/modules/")) {
    if (route === "/modules/delivery-export") {
      return path.join(publicDir, "delivery-export.html");
    }

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
  return JSON.parse(raw);
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

async function buildDashboard() {
  const appDbHealth = await checkAppDatabase();
  const sourceDbHealth = await checkSourceDatabase();

  return {
    updatedAt: new Date().toISOString(),
    launchUrl: "http://192.168.254.9:8080/",
    metrics: [
      { label: "Open source shipments", value: "PSQL/MSSQL", detail: "Shipments.Shipped = 0" },
      { label: "App-owned closures", value: appDbHealth.state === "online" ? "Ready" : "Setup", detail: `Stored in ${config.appDb.database} first` },
      { label: "Access import source", value: "CV_Accounts_be", detail: "Last 12 months active plus archive" },
      { label: "Write-back", value: config.writeBackEnabled ? "On" : "Off", detail: "Future approved workflow only" }
    ],
    integrationHealth: [
      appDbHealth,
      sourceDbHealth,
      { name: "PSQL Innovations", state: "discovered", detail: "Shipments and ShipmentItems identified" },
      { name: "Access backend", state: "ready-for-import", detail: "CV_Accounts_be.accdb is first historic source" }
    ]
  };
}
