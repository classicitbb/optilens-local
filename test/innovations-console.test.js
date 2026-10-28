const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const svc = require("../lib/innovations-console");
const { MODULE_ACCESS, MODULE_PAGES } = require("../lib/auth");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function makeDeps({ rows = [] } = {}) {
  const queries = [];
  const audits = [];
  const sequence = Array.isArray(rows[0]) ? rows : [rows];
  const deps = {
    recordAuditEvent: async (e) => { audits.push(e); },
    backend: {
      status: () => ({ configured: true, configSource: "source database", host: "test-sql" }),
      getTracking: async (i) => { queries.push(["tracking", i]); return { list: [] }; },
      listStatusItems: async () => ({ StatusList: [] }),
      getRxDetails: async (i) => { queries.push(["rx", i]); return { orderDetails: [] }; },
      getStockDescription: async (i) => { queries.push(["stock", i]); return {}; },
    },
  };
  return { deps, queries, audits, sequence };
}

const dbBackend = require("../lib/innovations-console-db");

function fakeDb(responses) {
  const calls = [];
  let i = 0;
  return { calls, deps: { query: async (text, params) => { calls.push({ text, params }); return responses[Math.min(i++, responses.length - 1)]; } } };
}

test("status reports the source database and never claims writes are enabled", async () => {
  const { deps } = makeDeps();
  assert.deepEqual(await svc.status(deps), { configured: true, configSource: "source database", host: "test-sql", writesEnabled: false });
});

test("lookups validate their input before querying", async () => {
  const { deps } = fakeDb([[]]);
  await assert.rejects(dbBackend.getTracking({ searchType: "Bogus", value: "1" }, deps), /Search type/);
  await assert.rejects(dbBackend.getTracking({ searchType: "TrayID", value: "  " }, deps), /Enter a value/);
  await assert.rejects(dbBackend.getTracking({ searchType: "OrderID", value: "1.5" }, deps), /whole number/);
  await assert.rejects(dbBackend.getRxDetails({ trayId: "" }, deps), /tray ID/);
  await assert.rejects(dbBackend.getStockDescription({ opc: "" }, deps), /OPC/);
});

test("tracking by tray returns the vendor single-job shape with status history", async () => {
  const order = { orderID: 7, trayID: "766", patientName: "DOE, JANE", accountID: "A1", billToAccount: "A1", shipToID: "A2", invoiceID: 55, iteration: 0, statusName: "Shipped" };
  const history = [{ statusDate: new Date("2026-10-20T10:00:00Z"), statusName: "Received", iteration: 0, statusUserName: "russell", invoiceID: null }];
  const { deps, calls } = fakeDb([[order], history]);
  const out = await dbBackend.getTracking({ searchType: "TrayID", value: " 766 " }, deps);
  assert.equal(out.TrayID, "766");
  assert.equal(out.shipToAccount, "A2");
  assert.equal(out.detail[0].statusName, "Received");
  assert.equal(out.detail[0].invoiceID, 55, "falls back to the order invoice");
  assert.equal(calls[0].params.v.value, "766", "parameters are trimmed and bound, never concatenated");
  assert.doesNotMatch(calls[0].text, /766/);
});

test("account and patient searches return the vendor list shape", async () => {
  const row = { orderID: 7, trayID: "1", patientName: "P", accountID: "A1", farmOutJob: 1 };
  const { deps } = fakeDb([[row]]);
  const out = await dbBackend.getTracking({ searchType: "AccountID", value: "A1" }, deps);
  assert.deepEqual(out.Parameters, { AccountID: "A1" });
  assert.equal(out.list[0].farmOutJob, true);
});

test("an empty tracking result is the vendor Errors shape", async () => {
  const { deps } = fakeDb([[]]);
  const out = await dbBackend.getTracking({ searchType: "TrayID", value: "none" }, deps);
  assert.equal(out.Errors[0].Code, 404);
});

test("stock description formats stored hundredths and on-hand counts", async () => {
  const lens = { Name: " 65F ", Fin_Semi: 1, Base_Sphere: 400, Add_Cyl: -350, Diameter: 6500, OPC_R: "R1", OPC_L: "L1", OPC_P: null, OnHand_R: 2, OnHand_L: 3, OnHand_P: null, ManufacturerName: "ACME", MaterialName: "Poly" };
  const { deps } = fakeDb([[lens]]);
  const out = (await dbBackend.getStockDescription({ opc: "R1" }, deps)).details;
  assert.equal(out.LensBaseName, "4.00");
  assert.equal(out.LensAdd, "-3.50");
  assert.equal(out.LensOnHand, "2;3;0");
  assert.equal(out.FinishedOrSemiName, "Finished");
});

test("database failures surface as a 502 and validation errors keep their status", async () => {
  const { deps } = makeDeps();
  deps.backend.getRxDetails = async () => { const e = new Error("conn"); e.code = "ESOCKET"; throw e; };
  await assert.rejects(svc.getRxDetails({ trayId: "9" }, deps), (e) => e.statusCode === 502 && e.code === "database_error");
  deps.backend.getTracking = async () => dbBackend.getTracking({ searchType: "Bogus", value: "x" }, { query: async () => [] });
  await assert.rejects(svc.getTracking({}, deps), (e) => e.statusCode === 400);
});

test("status update is refused and audited, and never queries", async () => {
  const { deps, queries, audits } = makeDeps();
  await assert.rejects(svc.updateStatus({ trayId: "766", statusId: 27 }, { actorUserId: 3 }, deps), (e) => e.statusCode === 403);
  assert.equal(queries.length, 0);
  assert.deepEqual(audits.map((a) => a.eventType), ["innovations_console.update_status.refused"]);
  assert.equal(audits[0].moduleCode, "innovations-console");
});

test("stock adjustment validates quantity, then is refused and audited", async () => {
  const { deps, audits } = makeDeps();
  await assert.rejects(svc.adjustStock({ opc: "ABC", qty: 0 }, {}, deps), /non-zero/);
  await assert.rejects(svc.adjustStock({ opc: "ABC", qty: 1.5 }, {}, deps), /non-zero/);
  await assert.rejects(svc.adjustStock({ opc: "ABC", qty: 99999 }, {}, deps), /non-zero/);
  await assert.rejects(svc.adjustStock({ opc: "ABC", qty: -2 }, {}, deps), (e) => e.statusCode === 403);
  assert.deepEqual(audits.map((a) => a.eventType), ["innovations_console.adjust_stock.refused"]);
});

test("the console never touches the Job Floor module and only reads the source database", () => {
  for (const file of ["lib/innovations-console.js", "lib/innovations-console-routes.js", "lib/innovations-console-db.js"]) {
    assert.doesNotMatch(read(file), /job-floor/, `${file} must stay separate from Job Floor`);
  }
  const sqlText = read("lib/innovations-console-db.js");
  assert.doesNotMatch(sqlText, /(INSERT|UPDATE|DELETE|MERGE|EXEC)\s/i, "the database backend is read-only");
});

test("the page is wired into routes, permissions, edition, launcher and file map", () => {
  const module = MODULE_ACCESS.find((m) => m.code === "innovations-console");
  assert.ok(module, "module access entry");
  assert.deepEqual(module.readPermissions, ["innovations-console.read"]);
  assert.deepEqual(module.fullPermissions, ["innovations-console.manage"]);
  assert.ok(MODULE_PAGES["innovations-console"].includes("/modules/innovations-console"));
  assert.match(read("server.js"), /"\/modules\/innovations-console":\s+"innovations-console\.html"/);
  assert.match(read("server.js"), /handleInnovationsConsoleRoute/);
  assert.match(read("lib/edition.js"), /\/api\/innovations-console/);
  assert.match(read("public/shared.js"), /id: "innovations-console"/);
  assert.match(read("public/app.js"), /id: "innovations-console"/);
  assert.match(read("editions/file-map.json"), /public\/innovations-console\*/);
  assert.match(read("public/innovations-console.html"), /innovations-console\.js/);
  assert.match(read("public/innovations-console.js"), /\/api\/innovations-console/);
});

test("the page script writes values only through the DOM, never innerHTML", () => {
  assert.doesNotMatch(read("public/innovations-console.js"), /innerHTML|insertAdjacentHTML|document\.write/);
});

test("write routes require the manage permission", () => {
  const routes = read("lib/innovations-console-routes.js");
  assert.match(routes, /requirePermission\(req, 'innovations-console\.manage'\)/);
  assert.match(routes, /\/status-update/);
  assert.match(routes, /\/stock-adjust/);
});
