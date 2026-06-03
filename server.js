const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const host = process.env.OPTILENS_HOST || "0.0.0.0";
const port = Number(process.env.OPTILENS_PORT || 8080);
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

const dashboard = {
  updatedAt: new Date().toISOString(),
  launchUrl: "http://192.168.254.9:8080/",
  metrics: [
    { label: "Open source shipments", value: "PSQL/MSSQL", detail: "Shipments.Shipped = 0" },
    { label: "App-owned closures", value: "Pending DB", detail: "Stored in optilens_local first" },
    { label: "Access import source", value: "CV_Accounts_be", detail: "Last 12 months active plus archive" },
    { label: "Write-back", value: "Off", detail: "Future approved workflow only" }
  ],
  integrationHealth: [
    { name: "Private app MSSQL", state: "setup-needed", detail: "Create optilens_local" },
    { name: "Source MSSQL Innovations", state: "credentials-needed", detail: "Integrated auth failed in this session" },
    { name: "PSQL Innovations", state: "discovered", detail: "Shipments and ShipmentItems identified" },
    { name: "Access backend", state: "ready-for-import", detail: "CV_Accounts_be.accdb is first historic source" }
  ]
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/health") {
    return sendJson(res, {
      ok: true,
      service: "optilens-local",
      time: new Date().toISOString(),
      database: process.env.OPTILENS_DB_NAME || "optilens_local",
      sourceMode: "read-only",
      writeBack: "disabled"
    });
  }

  if (url.pathname === "/api/modules") {
    return sendJson(res, { modules });
  }

  if (url.pathname === "/api/dashboard") {
    return sendJson(res, { ...dashboard, updatedAt: new Date().toISOString() });
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

server.listen(port, host, () => {
  console.log(`OptiLens Local listening on http://${host}:${port}`);
});
