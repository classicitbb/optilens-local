const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const svc = require("../lib/innovations-console");
const { MODULE_ACCESS, MODULE_PAGES } = require("../lib/auth");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function jwt(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "HS256" })}.${enc(claims)}.sig`;
}

function makeDeps({ writes = "true", login = { valid: true, exp: Date.now() + 3600000 }, replies = {} } = {}) {
  const calls = [];
  const audits = [];
  const deps = {
    getConfig: () => ({ baseUrl: "https://lab.example/rest/", username: "svc", password: "pw", source: "test" }),
    getSetting: async () => writes,
    recordAuditEvent: async (e) => { audits.push(e); },
    httpJson: async (_config, method, endpoint, body) => {
      calls.push({ method, endpoint, body });
      if (endpoint === "GetLogin/") return { result: [{ token: jwt(login) }] };
      const r = replies[endpoint];
      return { result: [typeof r === "function" ? r(body) : (r ?? {})] };
    },
  };
  return { deps, calls, audits };
}

test.beforeEach(() => { svc.resetSession(); delete process.env.INNOVATIONS_CONSOLE_WRITES_ENABLED; });

test("tracking maps the search type onto the vendor payload and logs in once", async () => {
  const { deps, calls } = makeDeps({ replies: { "GetTrackingData/": { list: [] } } });
  await svc.getTracking({ searchType: "OrderID", value: "42" }, deps);
  await svc.getTracking({ searchType: "TrayID", value: " 766 " }, deps);
  assert.equal(calls.filter((c) => c.endpoint === "GetLogin/").length, 1, "token is reused");
  const [first, second] = calls.filter((c) => c.endpoint === "GetTrackingData/").map((c) => c.body);
  assert.deepEqual({ ...first, token: undefined }, { TrayID: "", AccountID: "", OrderID: 42, RxID: "", PatientID: "", token: undefined });
  assert.equal(second.TrayID, "766");
  assert.ok(first.token);
});

test("lookups validate their input before calling the service", async () => {
  const { deps, calls } = makeDeps();
  await assert.rejects(svc.getTracking({ searchType: "Bogus", value: "1" }, deps), /Search type/);
  await assert.rejects(svc.getTracking({ searchType: "TrayID", value: "  " }, deps), /Enter a value/);
  await assert.rejects(svc.getTracking({ searchType: "OrderID", value: "1.5" }, deps), /whole number/);
  await assert.rejects(svc.getRxDetails({ trayId: "" }, deps), /tray ID/);
  await assert.rejects(svc.getStockDescription({ opc: "" }, deps), /OPC/);
  assert.equal(calls.length, 0);
});

test("a rejected login surfaces as a 502, not a token", async () => {
  const { deps } = makeDeps({ login: { valid: false } });
  await assert.rejects(svc.getRxDetails({ trayId: "9" }, deps), (e) => e.statusCode === 502 && e.code === "login_rejected");
});

test("an unconfigured host reports 503 and status says so", async () => {
  const { deps } = makeDeps();
  deps.getConfig = () => null;
  await assert.rejects(svc.listStatusItems(deps), (e) => e.statusCode === 503);
  assert.deepEqual(await svc.status(deps), { configured: false, configSource: null, host: null, writesEnabled: true });
});

test("status update is refused and audited while writes are disabled", async () => {
  const { deps, calls, audits } = makeDeps({ writes: "false" });
  await assert.rejects(svc.updateStatus({ trayId: "766", statusId: 27 }, { actorUserId: 3 }, deps), (e) => e.statusCode === 403);
  assert.equal(calls.length, 0, "nothing reaches the vendor service");
  assert.deepEqual(audits.map((a) => a.eventType), ["innovations_console.update_status.refused"]);
  assert.equal(audits[0].moduleCode, "innovations-console");
});

test("an enabled status update posts the vendor payload and audits attempt and success", async () => {
  const { deps, calls, audits } = makeDeps({ replies: { "UpdateStatus/": { processed: 0, processMessage: "OK" } } });
  const result = await svc.updateStatus({ trayId: " 766 ", statusId: "27", timestamp: 1700000000000 }, { actorUserId: 3 }, deps);
  assert.equal(result.processed, 0);
  const post = calls.find((c) => c.endpoint === "UpdateStatus/").body;
  assert.equal(post.TrayID, "766");
  assert.equal(post.StatusID, 27);
  assert.equal(post.timestamp, 1700000000000);
  assert.deepEqual(audits.map((a) => a.eventType), ["innovations_console.update_status.attempted", "innovations_console.update_status.succeeded"]);
});

test("stock adjustment validates quantity and audits a failure", async () => {
  const { deps, audits } = makeDeps();
  await assert.rejects(svc.adjustStock({ opc: "ABC", qty: 0 }, {}, deps), /non-zero/);
  await assert.rejects(svc.adjustStock({ opc: "ABC", qty: 1.5 }, {}, deps), /non-zero/);
  await assert.rejects(svc.adjustStock({ opc: "ABC", qty: 99999 }, {}, deps), /non-zero/);
  deps.httpJson = async (c, m, e, b) => { if (e === "GetLogin/") return { result: [{ token: jwt({ valid: true, exp: Date.now() + 3600000 }) }] }; throw new Error("boom"); };
  await assert.rejects(svc.adjustStock({ opc: "ABC", qty: -2 }, {}, deps), /boom/);
  assert.deepEqual(audits.map((a) => a.eventType), ["innovations_console.adjust_stock.attempted", "innovations_console.adjust_stock.failed"]);
});

test("the env flag overrides the stored writes setting", async () => {
  const { deps } = makeDeps({ writes: "true" });
  process.env.INNOVATIONS_CONSOLE_WRITES_ENABLED = "false";
  assert.equal(await svc.writesEnabled(deps), false);
});

test("the module never touches the Job Floor module or the source database", () => {
  for (const file of ["lib/innovations-console.js", "lib/innovations-console-routes.js"]) {
    const code = read(file);
    assert.doesNotMatch(code, /job-floor/, `${file} must stay separate from Job Floor`);
    assert.doesNotMatch(code, /require\(['"]mssql['"]\)|getSourcePool|getAppPool/, `${file} must not query SQL directly`);
  }
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
