const fs = require("node:fs");
const path = require("node:path");
const { createPrivilegedDataAccess } = require("./privileged-data-access");

const service = createPrivilegedDataAccess();
const artifactDir = path.join(__dirname, "..", "data", "privileged-artifacts");

async function handlePrivilegedDataAccessRoute({ req, res, url, handleApi, readJsonBody, requirePermission }) {
  if (!url.pathname.startsWith("/api/admin/data-access")) return false;

  if (url.pathname === "/api/admin/data-access/challenge" && req.method === "POST") {
    return handled(handleApi(res, async () => {
      const actor = await requirePermission(req, "platform.admin");
      return service.requestChallenge(await readJsonBody(req), actor);
    }));
  }

  if (url.pathname === "/api/admin/data-access/execute" && req.method === "POST") {
    return handled(handleApi(res, async () => {
      const actor = await requirePermission(req, "platform.admin");
      return service.execute(await readJsonBody(req), actor);
    }));
  }

  if (url.pathname === "/api/admin/data-access/dashboard-metrics" && req.method === "POST") {
    return handled(handleApi(res, async () => {
      const actor = await requirePermission(req, "platform.admin");
      const body = await readJsonBody(req);
      return service.createDashboardMetric({ title: body.title, description: body.description, executionId: body.executionId }, actor);
    }, 201));
  }

  const artifact = url.pathname.match(/^\/api\/admin\/data-access\/artifacts\/([^/]+)$/);
  if (artifact && req.method === "GET") {
    return handled(handleApi(res, async () => {
      await requirePermission(req, "platform.admin");
      const fileName = path.basename(decodeURIComponent(artifact[1]));
      if (!/^[\w.-]+\.(csv|xlsx|pdf)$/.test(fileName)) throw Object.assign(new Error("Invalid artifact name."), { statusCode: 400 });
      const filePath = path.join(artifactDir, fileName);
      if (!fs.existsSync(filePath)) throw Object.assign(new Error("Artifact not found."), { statusCode: 404 });
      const contentType = fileName.endsWith(".csv") ? "text/csv" : fileName.endsWith(".xlsx") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf";
      res.writeHead(200, { "Content-Type": contentType, "Content-Disposition": `attachment; filename="${fileName}"`, "Cache-Control": "no-store" });
      res.end(fs.readFileSync(filePath));
    }));
  }

  return false;
}

function handled(promise) { return promise.then(() => true); }

module.exports = { handlePrivilegedDataAccessRoute };
