const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const oq = require("../lib/metrics/order-quality");
const { assertDecision } = require("../lib/metrics/order-quality-decisions");
const { migrationFiles } = require("../lib/migrations");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const redirects = [
  { DesignName: "Resin Photochromic 1.5 Progressive Accolade Trans 8 Gray", DonorName: "Resin Photochromic 1.5 Progressive Ovation TGNS Gray", Priority: 0, RuleID: null },
  { DesignName: "Resin Plastic 1.50 Single Vision Regular Blue Select HMC", DonorName: "Resin Plastic 1.50 Single Vision Regular BLUEPRO SHMC", Priority: 1, RuleID: 7 }
];

test("redirectFor matches short staff-edit names against full redirect names", () => {
  assert.deepEqual(oq.redirectFor(redirects, "Trans 8 Gray", "TGNS Gray"), { exists: true, priority: 0, hasRule: false });
  assert.deepEqual(oq.redirectFor(redirects, "Blue Select HMC", "BLUEPRO SHMC"), { exists: true, priority: 1, hasRule: true });
  assert.deepEqual(oq.redirectFor(redirects, "Spin PhotoGrayBCT", "BLUEPRO+PH GR AR+"), { exists: false });
  assert.equal(oq.redirectFor(redirects, "", "TGNS Gray"), null);
  assert.deepEqual(oq.redirectFor(null, "A", "B"), { exists: false });
});

test("suggestSwap says to check an existing redirect, or to add one", () => {
  assert.equal(oq.suggestSwap({ oldValue: "Trans 8 Gray", newValue: "TGNS Gray" }, redirects).status, "redirect-bypassed");
  const none = oq.suggestSwap({ oldValue: "Spin PhotoGrayBCT", newValue: "BLUEPRO+PH GR AR+" }, redirects);
  assert.equal(none.status, "no-redirect");
  assert.match(none.action, /Add a Lens Redirect/);
});

test("finding keys are stable, case and punctuation insensitive, and ignore counts", () => {
  assert.equal(oq.findingKey("lens-swap", "Trans 8 Gray", "TGNS Gray"), oq.findingKey("lens-swap", " trans  8 GRAY ", "tgns-gray"));
  assert.notEqual(oq.findingKey("lens-swap", "A", "B"), oq.findingKey("lens-swap", "B", "A"));
  assert.ok(oq.findingKey("x", "y".repeat(500)).length <= 300);
});

test("severity thresholds", () => {
  assert.equal(oq.severityFor(25), "high");
  assert.equal(oq.severityFor(8), "medium");
  assert.equal(oq.severityFor(3), "low");
});

test("buildRows shapes all four checks and never exposes staff names", () => {
  const rows = oq.buildRows({
    swaps: [{ oldValue: "Trans 8 Gray", newValue: "TGNS Gray", orders: 28, customers: 13, staffAccounts: 4, lastSeen: "2026-11-10" }],
    unresolved: [{ direction: "lost", name: "TGNS Gray 76S 525", orders: 10, customers: 4, staffAccounts: 2, lastSeen: "2026-11-10" }],
    addons: [{ name: "EDGE TO FIT", added: 0, orders: 38, customers: 9, staffAccounts: 5, lastSeen: "2026-11-10" }],
    errors: [
      { code: 9, message: "Bad LDS result: Lens design 2266 not properly set up.", orders: 13, customers: 2, sampleOrderId: 137441, lastSeen: "2026-11-10" },
      { code: 18, message: "Failed to price job.", orders: 96, customers: 19, sampleOrderId: 136658, lastSeen: "2026-11-10" },
      { code: 11, message: "", orders: 19, customers: 5, sampleOrderId: 137025, lastSeen: "2026-11-10" }
    ]
  }, redirects);
  assert.equal(rows["lens-swap"][0].severity, "high");
  assert.equal(rows["lens-swap"][0].redirect, "redirect-bypassed");
  assert.equal(rows["lens-unresolved"][0].direction, "lost");
  assert.equal(rows["addon-by-hand"][0].change, "Removed by hand");
  assert.match(rows["order-errors"][0].suggestion, /design is not set up/);
  assert.match(rows["order-errors"][1].suggestion, /priced/);
  assert.equal(rows["order-errors"][2].message, "(no message)");
  const text = JSON.stringify(rows);
  assert.ok(!/user|lisa|roy|kevin/i.test(text));
});

test("applyDecisions hides handled findings and brings back a fixed one that recurs", () => {
  const rows = [
    { findingKey: "a", lastSeen: "2026-11-01T00:00:00Z" },
    { findingKey: "b", lastSeen: "2026-11-01T00:00:00Z" },
    { findingKey: "c", lastSeen: "2026-11-12T00:00:00Z" },
    { findingKey: "d", lastSeen: "2026-11-12T00:00:00Z" }
  ];
  const decisions = new Map([
    ["a", { decision: "dismissed", reason: "ok", decidedAt: "2026-11-05T00:00:00Z" }],
    ["b", { decision: "fixed", reason: "done", decidedAt: "2026-11-05T00:00:00Z" }],
    ["c", { decision: "fixed", reason: "done", decidedAt: "2026-11-05T00:00:00Z" }],
    ["d", { decision: "accepted", reason: "planned", decidedAt: "2026-11-05T00:00:00Z" }]
  ]);
  const result = oq.applyDecisions(rows, decisions);
  assert.deepEqual(result.open.map((r) => r.findingKey), ["c"]);
  assert.equal(result.open[0].cameBack, true);
  assert.equal(result.handledCount, 3);
  assert.deepEqual(result.handled, []);
  const withHandled = oq.applyDecisions(rows, decisions, { includeDecided: true });
  assert.deepEqual(withHandled.handled.map((r) => r.findingKey).sort(), ["a", "b", "d"]);
});

test("assertDecision validates key, decision, check and a reason", () => {
  const ok = { findingKey: "lens-swap|a|b", decision: "fixed", checkCode: "lens-swap", reason: "Added redirect" };
  assert.deepEqual(assertDecision(ok), { key: "lens-swap|a|b", decision: "fixed", checkCode: "lens-swap", reason: "Added redirect" });
  assert.throws(() => assertDecision({ ...ok, findingKey: "" }), /finding key/i);
  assert.throws(() => assertDecision({ ...ok, decision: "deleted" }), /Decision must be/);
  assert.throws(() => assertDecision({ ...ok, checkCode: "nope" }), /Unknown check/);
  assert.throws(() => assertDecision({ ...ok, reason: "  " }), /reason is required/);
});

test("every query is read-only and a single SELECT", () => {
  for (const [name, build] of Object.entries(oq.SQL)) {
    const text = build(90);
    assert.match(text.trim(), /^SELECT/i, name);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|EXEC|TRUNCATE)\b/i.test(text), `${name} must be read-only`);
    assert.ok(!text.includes(";"), `${name} must be a single statement`);
  }
  assert.match(oq.SQL.swaps(7), /DATEADD\(day, -7,/);
});

test("the tab, section, route and migration are wired", () => {
  assert.match(read("public/business-metrics.html"), /data-tab="order-quality"/);
  assert.match(read("public/business-metrics.html"), /id="order-quality"/);
  assert.match(read("lib/metrics/detail.js"), /"order-quality": \{ needsSource: true/);
  assert.match(read("server.js"), /\/api\/business-metrics\/order-quality\/decision/);
  assert.match(read("server.js"), /requirePermission\(req, "business-metrics\.manage"\)[\s\S]{0,200}recordOrderQualityDecision/);
  assert.match(read("public/business-metrics-tabs.js"), /rowActions/);
  assert.ok(migrationFiles.some((m) => m.file === "060-order-quality-review.sql" && m.module === "business-metrics"));
  assert.ok(fs.existsSync(path.join(root, "database", "060-order-quality-review.sql")));
});
