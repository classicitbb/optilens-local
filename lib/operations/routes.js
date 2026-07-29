const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createFixtureWorkflow, decideAction, listActions, listExceptions, listMailboxReconciliation, listOperations, listSupplierRules, resolveException } = require("./service");

async function handleOperationsRoute({ req, res, url, handleApi, readJsonBody, requirePermission }) {
  if (!url.pathname.startsWith("/api/operations/")) return false;
  if (url.pathname === "/api/operations/summary" && req.method === "GET") {
    await handleApi(res, async () => {
      await requirePermission(req, "automation.read");
      const [events, actions, exceptions] = await Promise.all([listOperations({ limit: 200 }), listActions({ limit: 200 }), listExceptions({ limit: 200 })]);
      return { received: events.length, waitingApproval: actions.length, openExceptions: exceptions.length, failed: events.filter((event) => event.status === "FAILED").length, statusUpdatesEnabled: false };
    });
    return true;
  }
  if (url.pathname === "/api/operations/events" && req.method === "GET") {
    await handleApi(res, async () => { await requirePermission(req, "automation.read"); return { events: await listOperations({ limit: url.searchParams.get("limit"), status: url.searchParams.get("status") }) }; });
    return true;
  }
  if (url.pathname === "/api/operations/actions" && req.method === "GET") {
    await handleApi(res, async () => { await requirePermission(req, "automation.read"); return { actions: await listActions({ limit: url.searchParams.get("limit"), status: url.searchParams.get("status") || "WAITING_APPROVAL" }) }; });
    return true;
  }
  if (url.pathname === "/api/operations/exceptions" && req.method === "GET") {
    await handleApi(res, async () => { await requirePermission(req, "automation.read"); return { exceptions: await listExceptions({ limit: url.searchParams.get("limit"), status: url.searchParams.get("status") || "OPEN" }) }; });
    return true;
  }
  if (url.pathname === "/api/operations/supplier-rules" && req.method === "GET") {
    await handleApi(res, async () => { await requirePermission(req, "automation.read"); return { rules: await listSupplierRules() }; });
    return true;
  }
  if (url.pathname === "/api/operations/mailbox/reconciliation" && req.method === "GET") {
    await handleApi(res, async () => { await requirePermission(req, "automation.read"); return listMailboxReconciliation(); });
    return true;
  }
  const actionDecision = url.pathname.match(/^\/api\/operations\/actions\/([^/]+)\/(approve|reject)$/);
  if (actionDecision && req.method === "POST") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "automation.manage");
      const body = await readJsonBody(req);
      return decideAction(actionDecision[1], actionDecision[2] === "approve" ? "APPROVED" : "REJECTED", actor.userId, body.note || "");
    });
    return true;
  }
  const exceptionDecision = url.pathname.match(/^\/api\/operations\/exceptions\/([^/]+)\/(resolve|dismiss)$/);
  if (exceptionDecision && req.method === "POST") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "automation.manage");
      const body = await readJsonBody(req);
      return resolveException(exceptionDecision[1], exceptionDecision[2] === "resolve" ? "RESOLVED" : "DISMISSED", actor.userId, body.note || "");
    });
    return true;
  }
  if (url.pathname === "/api/operations/events/simulate-supplier-file" && req.method === "POST") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "automation.manage");
      if (!["development", "test"].includes(process.env.NODE_ENV || "development")) throw Object.assign(new Error("Simulation endpoint is disabled outside development and test."), { statusCode: 404 });
      const body = await readJsonBody(req);
      const filename = String(body.filename || "supplier-fixture.csv");
      const content = Buffer.from(String(body.content || ""), "utf8");
      const tempDir = path.join(os.tmpdir(), "optilens-supplier-fixtures");
      fs.mkdirSync(tempDir, { recursive: true });
      const storagePath = path.join(tempDir, `${Date.now()}-${filename.replace(/[^A-Za-z0-9._-]/g, "_")}`);
      fs.writeFileSync(storagePath, content, { flag: "wx" });
      try {
        return await createFixtureWorkflow({ filename, contentType: body.contentType || "text/csv", buffer: content, actorUserId: actor.userId, storagePath });
      } finally {
        fs.rmSync(storagePath, { force: true });
      }
    });
    return true;
  }
  return false;
}

module.exports = { handleOperationsRoute };
