const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { mock } = require("node:test");

const db = require("../lib/db");
const store = require("../lib/inventory/store");
const { handleInventoryRoute } = require("../lib/inventory/routes");
const { runInventoryScan } = require("../lib/inventory/scan-runner");
const recs = require("../lib/inventory/recommendations-service");
const { setup, fakeSource, liveRow } = require("./inventory-test-helpers");

const ROOT = path.join(__dirname, "..");

const USERS = {
  admin: { userId: "u-admin", username: "ann", permissions: ["platform.admin", "delivery.read", "delivery.write"] },
  reader: { userId: "u-read", username: "rita", permissions: ["delivery.read"] },
  inventoryReader: { userId: "u-inv", username: "ivan", permissions: ["inventory.read"] },
  inventoryWriter: { userId: "u-invw", username: "wendy", permissions: ["inventory.read", "inventory.write"] },
  deliveryWriter: { userId: "u-dw", username: "dave", permissions: ["delivery.read", "delivery.write"] },
  customer: { userId: "u-cust", username: "carol", permissions: ["rx-capture.read"] },
  nobody: { userId: "u-none", username: "nina", permissions: [] }
};

/** Calls the route handler the way server.js does and captures the response. */
async function call(method, pathname, { user = "admin", body = {}, headers = {}, query = "" } = {}) {
  const url = new URL(`http://localhost${pathname}${query}`);
  const captured = {};
  const req = { method, headers };
  const handled = await handleInventoryRoute({
    req, res: {}, url,
    readJsonBody: async () => body,
    currentUser: async () => {
      if (user === null) { const e = new Error("Authentication required."); e.statusCode = 401; throw e; }
      return USERS[user];
    },
    sendJson: (_res, data, status = 200) => { captured.status = status; captured.body = data; }
  });
  return { handled, status: captured.status, body: captured.body };
}

const API = "/api/inventory-intelligence";

async function seeded() {
  setup();
  await runInventoryScan({ useFixtures: true });
  const orderMore = (await recs.listRecommendations({ queue: "ORDER_MORE" })).items[0];
  return { orderMore };
}

test("the handler ignores every path outside its own prefix", async () => {
  setup();
  for (const p of ["/api/business-metrics/summary", "/api/inventory", "/api/inventory-intelligence-extra", "/", "/business-metrics.html"]) {
    const result = await call("GET", p);
    assert.equal(result.handled, false, p);
  }
});

test("every endpoint requires an authenticated session", async () => {
  await seeded();
  const endpoints = [
    ["GET", "/summary"], ["GET", "/queue"], ["GET", "/item-identity"], ["GET", "/assignees"], ["GET", "/recommendations/00000000-0000-4000-8000-000000000000"],
    ["GET", "/tasks"], ["GET", "/draft-po"], ["GET", "/audit"], ["GET", "/scan/status"], ["GET", "/settings/1:1:1:1:1:101/history"],
    ["POST", "/recommendations/approve-all"], ["POST", "/recommendations/approve-selected"],
    ["POST", "/recommendations/00000000-0000-4000-8000-000000000000/approve"], ["POST", "/tasks/assign-shelf-count"],
    ["POST", "/scan/run"], ["POST", "/recalculate-event"]
  ];
  for (const [method, p] of endpoints) {
    const result = await call(method, API + p, { user: null });
    assert.equal(result.status, 401, `${method} ${p}`);
    assert.deepEqual(Object.keys(result.body).sort(), ["code", "error"], "nothing but the error is returned");
  }
});

test("a customer-facing or unrelated role gets nothing, not even an empty payload", async () => {
  await seeded();
  for (const user of ["customer", "nobody"]) {
    for (const [method, p] of [["GET", "/summary"], ["GET", "/queue"], ["GET", "/audit"], ["GET", "/draft-po"], ["POST", "/scan/run"]]) {
      const result = await call(method, API + p, { user });
      assert.equal(result.status, 403, `${user} ${method} ${p}`);
      assert.equal(result.body.items, undefined);
      assert.equal(result.body.cards, undefined);
    }
  }
});

test("read access does not allow changes; only inventory.write or platform.admin may decide", async () => {
  const { orderMore } = await seeded();
  const approve = `${API}/recommendations/${orderMore.recommendationId}/approve`;

  for (const user of ["reader", "inventoryReader", "deliveryWriter"]) {
    assert.equal((await call("GET", `${API}/queue`, { user })).status, 200, `${user} can read`);
    assert.equal((await call("POST", approve, { user })).status, 403, `${user} cannot approve`);
    assert.equal((await call("POST", `${API}/scan/run`, { user })).status, 403, `${user} cannot scan`);
  }
  assert.equal((await recs.getRecommendation(orderMore.recommendationId)).status, "PENDING_APPROVAL");

  const ok = await call("POST", approve, { user: "inventoryWriter", body: { reason: "ok" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.recommendation.status, "APPROVED");
  assert.equal(ok.body.recommendation.decisionActor, "wendy", "the signed-in user is the approver");
  assert.equal(store.mem.settings[0].approvedBy, "wendy");
});

test("the summary tells the page whether this user can approve", async () => {
  await seeded();
  assert.equal((await call("GET", `${API}/summary`, { user: "admin" })).body.capabilities.canApprove, true);
  assert.equal((await call("GET", `${API}/summary`, { user: "reader" })).body.capabilities.canApprove, false);
});

test("lens identity uses the full source key and returns the readable lens name", async () => {
  setup();
  const statements = fakeSource([liveRow({ materialName: "Polycarbonate", manufacturerName: "Vision-Ease",
    lensTypeName: "Single Vision", optionName: "Clear", itemName: "70S 425/300" })]);
  const result = await call("GET", `${API}/item-identity`, { query: "?itemId=1%3A1%3A1%3A1%3A1%3A100" });
  assert.equal(result.status, 200);
  assert.equal(result.body.identity.name, "Polycarbonate · Vision-Ease · Single Vision · Clear");
  assert.equal(statements.length, 1);
  assert.match(statements[0].text, /FROM dbo\.LensItem li/);
  assert.match(statements[0].text, /li\.MaterialGroup = @mg[\s\S]*li\.Num = @it/);
  assert.equal((await call("GET", `${API}/item-identity`, { query: "?itemId=invalid" })).status, 400);
});

test("assignment choices are limited to active app users and inventory writers", async () => {
  setup();
  let query = "";
  mock.method(db, "getAppPool", async () => ({ request: () => ({ query: async (text) => {
    query = text;
    return { recordset: [{ username: "greg", displayName: "Greg" }] };
  } }) }));
  assert.equal((await call("GET", `${API}/assignees`, { user: "inventoryReader" })).status, 403);
  const result = await call("GET", `${API}/assignees`, { user: "inventoryWriter" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.users, [{ username: "greg", displayName: "Greg" }]);
  assert.match(query, /WHERE is_active = 1/);
});

test("the queue endpoint filters, validates and bounds its parameters", async () => {
  await seeded();
  const all = await call("GET", `${API}/queue`);
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 6);

  const pending = await call("GET", `${API}/queue`, { query: "?queue=PENDING_APPROVAL" });
  assert.equal(pending.body.total, 1);

  assert.equal((await call("GET", `${API}/queue`, { query: "?limit=5000" })).body.limit, 200);
  assert.equal((await call("GET", `${API}/queue`, { query: "?limit=abc" })).status, 400);
  assert.equal((await call("GET", `${API}/queue`, { query: "?queue=EVERYTHING" })).status, 400);
  assert.equal((await call("GET", `${API}/queue`, { query: "?offset=-9" })).body.offset, 0);
});

test("the detail view carries the evidence, task, history, revisions and audit the drawer shows", async () => {
  const { orderMore } = await seeded();
  const result = await call("GET", `${API}/recommendations/${orderMore.recommendationId}`);
  assert.equal(result.status, 200);
  const { recommendation, task, taskHistory, revisions, audit, settingHistory, counts } = result.body;
  assert.equal(recommendation.recommendationId, orderMore.recommendationId);
  assert.equal(task.taskType, "APPROVE_REPLENISHMENT_CHANGE");
  assert.ok(taskHistory.length >= 1);
  assert.equal(revisions.length, 1);
  assert.ok(audit.some((a) => a.action === "RECOMMENDATION_GENERATED"));
  assert.deepEqual(settingHistory, []);
  assert.deepEqual(counts, []);
  assert.ok(recommendation.evidence.provenance);

  assert.equal((await call("GET", `${API}/recommendations/not-a-guid`)).status, 400);
  assert.equal((await call("GET", `${API}/recommendations/00000000-0000-4000-8000-000000000000`)).status, 404);
});

test("unknown paths under the prefix are a 404 and never fall through to a static file", async () => {
  setup();
  const result = await call("GET", `${API}/anything-else`);
  assert.equal(result.handled, true);
  assert.equal(result.status, 404);
});

test("input is validated before anything runs", async () => {
  const { orderMore } = await seeded();
  const cases = [
    ["POST", `${API}/recommendations/approve-selected`, { recommendationIds: [] }],
    ["POST", `${API}/recommendations/approve-selected`, { recommendationIds: ["nope"] }],
    ["POST", `${API}/recommendations/approve-selected`, { recommendationIds: Array.from({ length: 201 }, () => orderMore.recommendationId) }],
    ["POST", `${API}/recommendations/approve-all`, { queue: "SHELF_CHECK" }],
    ["POST", `${API}/recommendations/${orderMore.recommendationId}/reject`, {}],
    ["POST", `${API}/recommendations/${orderMore.recommendationId}/reject`, { reason: "x".repeat(501) }],
    ["POST", `${API}/recommendations/${orderMore.recommendationId}/edit-and-approve`, { orderPoint: 10 }],
    ["POST", `${API}/tasks/assign-shelf-count`, { itemId: "1:1:1:1:1:101" }],
    ["POST", `${API}/recalculate-event`, { eventType: "MANUAL_FULL", itemId: "1:1:1:1:1:101" }],
    ["POST", `${API}/recalculate-event`, { eventType: "EVENT_PO" }]
  ];
  for (const [method, p, body] of cases) {
    const result = await call(method, p, { body });
    assert.equal(result.status, 400, `${p} ${JSON.stringify(body).slice(0, 60)}`);
  }
  assert.equal((await recs.getRecommendation(orderMore.recommendationId)).status, "PENDING_APPROVAL");
});

test("conflicts are reported as 409 with a plain message", async () => {
  const { orderMore } = await seeded();
  await call("POST", `${API}/recommendations/${orderMore.recommendationId}/reject`, { body: { reason: "no" } });
  const result = await call("POST", `${API}/recommendations/${orderMore.recommendationId}/approve`);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "ALREADY_DECIDED");
});

test("an Idempotency-Key makes a repeated approval a replay, not a second write", async () => {
  const { orderMore } = await seeded();
  const headers = { "idempotency-key": "approve-key-0001" };
  const url = `${API}/recommendations/${orderMore.recommendationId}/approve`;

  const first = await call("POST", url, { headers, body: { reason: "ok" } });
  const second = await call("POST", url, { headers, body: { reason: "ok" } });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(store.mem.settings.length, 1);
  assert.equal(store.mem.audit.filter((a) => a.action === "SETTINGS_WRITTEN").length, 1);
  assert.ok(store.mem.audit.filter((a) => a.action === "RECOMMENDATION_APPROVED").every((a) => a.correlationId === "approve-key-0001"));

  const bad = await call("POST", url, { headers: { "idempotency-key": "x" } });
  assert.equal(bad.status, 400);
  const reused = await call("POST", `${API}/recommendations/${orderMore.recommendationId}/reject`, { headers, body: { reason: "no" } });
  assert.equal(reused.status, 409);
});

test("approve selected and approve all report approved and skipped rows", async () => {
  const { orderMore } = await seeded();
  const selected = await call("POST", `${API}/recommendations/approve-selected`, { body: { recommendationIds: [orderMore.recommendationId] } });
  assert.equal(selected.status, 200);
  assert.equal(selected.body.approvedCount, 1);

  const all = await call("POST", `${API}/recommendations/approve-all`, { body: { queue: "ORDER_MORE" } });
  assert.equal(all.body.approvedCount, 0);
  assert.equal(all.body.queue, "ORDER_MORE");
});

test("assigning a shelf count and recording the result work end to end over HTTP", async () => {
  await seeded();
  const shelf = (await recs.listRecommendations({ queue: "SHELF_CHECK" })).items[0];
  const assigned = await call("POST", `${API}/tasks/assign-shelf-count`, { body: { itemId: shelf.itemId, recommendationId: shelf.recommendationId, assignee: "clerk", dueDate: "2026-10-21" } });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.task.status, "ASSIGNED");

  const counted = await call("POST", `${API}/tasks/${assigned.body.task.taskId}/count-result`, { user: "inventoryWriter", body: { countedQuantity: 4 } });
  assert.equal(counted.status, 200);
  assert.equal(counted.body.count.countedQuantity, 4);
  assert.equal(counted.body.count.countedBy, "wendy");

  const detail = await call("GET", `${API}/tasks/${assigned.body.task.taskId}`);
  assert.equal(detail.body.task.status, "COMPLETED");
  assert.ok(detail.body.history.length >= 3);

  const again = await call("POST", `${API}/tasks/${assigned.body.task.taskId}/count-result`, { body: { countedQuantity: 4 } });
  assert.equal(again.status, 409);
});

test("starting a scan queues work and answers 202 without waiting for it", async () => {
  setup();
  fakeSource([liveRow()]);
  const result = await call("POST", `${API}/scan/run`);
  assert.equal(result.status, 202);
  assert.equal(result.body.started, true);
  assert.equal(result.body.request.eventType, "MANUAL_FULL");
  // let the background worker finish so it does not outlive the test
  await require("../lib/inventory/scan-runner").processPendingRequests({}).catch(() => {});
});

test("internal errors never reach the caller: no SQL, hosts, users or stack traces", async () => {
  setup();
  mock.method(console, "error", () => {});
  mock.method(db, "getAppPool", async () => ({
    request() {
      const req = { input: () => req, query: async () => { throw new Error("Invalid object name 'inventory.replenishment_recommendations' near SELECT secret_col FROM dbo.Payroll (user=sa, host=10.0.0.9)"); } };
      return req;
    }
  }));
  store.setTestMode(false);
  try {
    const result = await call("GET", `${API}/queue`);
    assert.equal(result.status, 500);
    assert.equal(result.body.error, "The inventory service could not complete the request.");
    assert.doesNotMatch(JSON.stringify(result.body), /Payroll|secret_col|10\.0\.0\.9|user=sa|inventory\./);
  } finally {
    store.setTestMode(true);
  }
});

test("a database outage is reported as 'unavailable', not as an empty queue", async () => {
  setup();
  mock.method(db, "getAppPool", async () => { throw new Error("connect ECONNREFUSED 10.0.0.9:1433"); });
  store.setTestMode(false);
  try {
    const summary = await call("GET", `${API}/summary`);
    const queue = await call("GET", `${API}/queue`);
    for (const result of [summary, queue]) {
      assert.equal(result.status, 503);
      assert.equal(result.body.code, "UNAVAILABLE");
      assert.equal(result.body.items, undefined);
      assert.doesNotMatch(JSON.stringify(result.body), /ECONNREFUSED|10\.0\.0\.9/);
    }
  } finally {
    store.setTestMode(true);
  }
});

/* ─────────── visibility: no customer-facing surface ─────────── */

test("the dedicated cockpit route is administrator-only", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(server, /"\/inventory-intelligence\.html": \["platform\.admin"\]/);
  assert.match(server, /"\/modules\/inventory-intelligence": \["platform\.admin"\]/);
  assert.match(server, /"\/modules\/inventory-intelligence": "inventory-intelligence\.html"/);
  assert.match(server, /handleInventoryRoute\(\{ req, res, url, readJsonBody, currentUser, sendJson \}\)/);
});

test("only staff-side code references the cockpit: no portal, website connector or public API does", () => {
  const allowed = new Set([
    "server.js", "lib/migrations.js", "public/business-metrics.html", "public/inventory-intelligence.html",
    "public/app.js", "public/shared.js", "public/business-metrics-inventory-intelligence.js",
    "public/styles/pages/inventory-intelligence.css", "scripts/run-inventory-intelligence-scan.js",
    "docs/INVENTORY_INTELLIGENCE_COCKPIT_BUILD_TASK.md", "docs/INVENTORY_INTELLIGENCE.md",
    "docs/agent/PROJECT_KNOWLEDGE.md", "docs/agent/HANDOFF.md"
  ]);
  const roots = ["server.js", "lib", "public", "scripts", "extensions", "templates", "docs"];
  const hits = [];

  function walk(target) {
    const full = path.join(ROOT, target);
    if (!fs.existsSync(full)) return;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (["node_modules", ".git", "data", "outputs", "_snapshots", "test-results"].includes(path.basename(full))) return;
      for (const entry of fs.readdirSync(full)) walk(path.join(target, entry));
    } else if (/\.(js|html|css|json|md|sql|ps1)$/i.test(full) && stat.size < 3_000_000) {
      const text = fs.readFileSync(full, "utf8");
      if (/inventory-intelligence|lib\/inventory\/|\.\/inventory\//.test(text)) hits.push(target.replace(/\\/g, "/"));
    }
  }
  roots.forEach(walk);

  const unexpected = hits.filter((f) => !allowed.has(f) && !f.startsWith("lib/inventory/"));
  assert.deepEqual(unexpected, [], "unexpected references to the staff-only cockpit");

  for (const connector of ["lib/cv-api-connector.js", "lib/optilens-connector.js", "lib/live-data-gateway.js"]) {
    const text = fs.readFileSync(path.join(ROOT, connector), "utf8");
    assert.doesNotMatch(text, /inventory-intelligence|ReplenishmentRecommendation|replenishment/i, `${connector} does not expose the cockpit`);
  }
});

test("Business Metrics links to the dedicated cockpit workspace", () => {
  const metrics = fs.readFileSync(path.join(ROOT, "public", "business-metrics.html"), "utf8");
  assert.match(metrics, /href="\/modules\/inventory-intelligence">Inventory Intelligence<\/a>/);
  assert.doesNotMatch(metrics, /id="inventoryIntelligenceRoot"/);
  const html = fs.readFileSync(path.join(ROOT, "public", "inventory-intelligence.html"), "utf8");
  assert.match(html, /id="inventoryIntelligenceRoot"/);
  assert.match(html, /href="\/styles\/pages\/inventory-intelligence\.css"/);
  assert.match(html, /src="\/business-metrics-inventory-intelligence\.js"/);
  assert.ok(html.indexOf("/styles/system.css") < html.indexOf("inventory-intelligence.css"), "workspace styles follow the shared system stylesheet");

  const script = fs.readFileSync(path.join(ROOT, "public", "business-metrics-inventory-intelligence.js"), "utf8");
  assert.doesNotThrow(() => new Function(script), "the page script parses");
  assert.doesNotMatch(script, /\balert\(|\bconfirm\(/, "decisions use accessible dialogs, not browser popups");
  assert.match(script, /Idempotency-Key/);
});
