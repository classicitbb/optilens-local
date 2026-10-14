const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const db = require("../lib/db");
const store = require("../lib/inventory/store");
const { setup, liveRow, itemIdOf, fakeSource, brokenSource } = require("./inventory-test-helpers");

const {
  DEFAULT_POLICY, roundUpOrderQuantity, calculateTrend, calculateItemReplenishment
} = require("../lib/inventory/calculator");
const { evaluateConfidence } = require("../lib/inventory/confidence");
const { buildPolicy } = require("../lib/inventory/policy");
const { loadInventoryEvidence, assertReadOnlySql, buildEvidenceQuery } = require("../lib/inventory/source-adapter");
const { writeApprovedSetting, getActiveSetting, getSettingHistory } = require("../lib/inventory/settings-service");
const tasks = require("../lib/inventory/task-service");
const recs = require("../lib/inventory/recommendations-service");
const { runInventoryScan, processPendingRequests, requestFullScan, triggerRecalculationEvent, getLatestScanStatus } = require("../lib/inventory/scan-runner");
const { enqueueRecalculation, listRequests } = require("../lib/inventory/events");
const { recordStockCount, getLatestCounts } = require("../lib/inventory/count-service");
const { generateDraftPoPreview } = require("../lib/inventory/draft-po-service");
const { recordInventoryAudit, listInventoryAudit, runWithAuditContext } = require("../lib/inventory/audit-service");
const { runIdempotent } = require("../lib/inventory/idempotency");
const { getCockpitSummary } = require("../lib/inventory/summary");
const { listConfidenceHistory } = require("../lib/inventory/confidence-store");

const ROOT = path.join(__dirname, "..");

/** Runs the calculator for an item the way a scan does and stores the result. */
async function syncCalc(input, { scanRunId = null, actor = "scanner" } = {}) {
  const confidence = input.confidence || evaluateConfidence({
    onHand: input.onHand, usage30: input.usage30, usage90: input.usage90, openPoQuantity: input.openPoQuantity,
    supplierId: input.supplierId === undefined ? "S1" : input.supplierId,
    settings: input.settings, stockFreshnessDays: 5
  });
  const calculation = calculateItemReplenishment({ supplierId: "S1", supplierName: "Supplier One", unitCost: 10, ...input, confidence });
  const result = await store.withTransaction((tx) => recs.syncRecommendation({ calculation, scanRunId, actor, tx }));
  return { calculation, ...result };
}

const ORDER_MORE_INPUT = { itemId: "t:1", onHand: 4, openPoQuantity: 0, usage30: 45, usage90: 120 };

/* ═════════════════════ 1. DETERMINISTIC ENGINE ═════════════════════ */

test("usage is a weighted blend of the 30- and 90-day windows, both retained, never a lifetime average", () => {
  const result = calculateItemReplenishment({ itemId: "w:1", onHand: 10, usage30: 30, usage90: 60, unitCost: 20 });
  const ev = result.evidence;

  assert.equal(ev.usage30, 30);
  assert.equal(ev.usage90, 60);
  assert.equal(ev.dailyUsage30, 1);
  assert.equal(ev.dailyUsage90, 0.6667);
  assert.equal(ev.weightedDailyUsage, 0.9); // 0.7 * 1 + 0.3 * 0.6667
  assert.deepEqual(ev.weightsUsed, { weight30: 0.7, weight90: 0.3 });

  // A lifetime figure supplied by a caller is ignored, and so is a plain 90-day average.
  const withLifetime = calculateItemReplenishment({ itemId: "w:1", onHand: 10, usage30: 30, usage90: 60, unitCost: 20, lifetimeUnits: 99999, lifetimeDays: 10 });
  assert.deepEqual(withLifetime, result);
  assert.notEqual(ev.weightedDailyUsage, 60 / 90);

  // Recent demand dominates: nothing in 30 days but a busy quarter weights toward the 90-day share only.
  const faded = calculateItemReplenishment({ itemId: "w:2", onHand: 10, usage30: 0, usage90: 90 });
  assert.equal(faded.evidence.weightedDailyUsage, 0.3);
});

test("weights are configurable, normalised to sum to one, and recorded on the evidence", () => {
  const even = calculateItemReplenishment({ itemId: "w:3", onHand: 10, usage30: 30, usage90: 60, policyOverrides: { weight30: 0.5, weight90: 0.5 } });
  assert.deepEqual(even.evidence.weightsUsed, { weight30: 0.5, weight90: 0.5 });
  assert.equal(even.evidence.weightedDailyUsage, 0.8333);

  const unnormalised = calculateItemReplenishment({ itemId: "w:4", onHand: 10, usage30: 30, usage90: 60, policyOverrides: { weight30: 7, weight90: 3 } });
  assert.deepEqual(unnormalised.evidence.weightsUsed, { weight30: 0.7, weight90: 0.3 });

  const invalid = calculateItemReplenishment({ itemId: "w:5", onHand: 10, usage30: 30, usage90: 60, policyOverrides: { weight30: -1, weight90: 0 } });
  assert.deepEqual(invalid.evidence.weightsUsed, { weight30: DEFAULT_POLICY.weight30, weight90: DEFAULT_POLICY.weight90 });
});

test("the documented formulas hold: lead-time demand, order point, coverage, requirement and rounding", () => {
  const r = calculateItemReplenishment({
    itemId: "f:1", onHand: 4, openPoQuantity: 0, usage30: 45, usage90: 120,
    settings: { leadTimeDays: 14, safetyStock: 5, targetCoverDays: 30, minOrderQty: 10, packMultiple: 5, version: 2 },
    confidence: { confidenceScore: 90, confidenceLevel: "HIGH", signals: [] }
  });
  const ev = r.evidence;

  assert.equal(ev.weightedDailyUsage, 1.45); // 1.5 * 0.7 + 1.3333 * 0.3
  assert.equal(ev.leadTimeDemand, 20.3);
  assert.equal(r.proposedSettings.orderPoint, 26); // ceil(20.3 + 5)
  assert.equal(ev.targetCover, 43.5);
  assert.equal(ev.availableCoverage, 4);
  assert.equal(ev.rawOrderQuantity, 65.5); // 25.3 + 43.5 - 4 ... via the integer order point: 26 + 43.5 - 4
  assert.equal(ev.suggestedOrderQuantity % 5, 0, "rounded to the pack multiple");
  assert.ok(ev.suggestedOrderQuantity >= 10, "never below the MOQ");
  assert.equal(ev.suggestedOrderQuantity, 70);
  assert.equal(ev.daysRemaining, 3); // 4 / 1.45
  assert.equal(r.recommendationType, "ORDER_MORE");
});

test("rounding to MOQ and pack multiple applies only when an order is required", () => {
  assert.equal(roundUpOrderQuantity(0, 10, 5), 0, "no requirement is never rounded up to the MOQ");
  assert.equal(roundUpOrderQuantity(-5, 10, 5), 0);
  assert.equal(roundUpOrderQuantity(3, 10, 5), 10);
  assert.equal(roundUpOrderQuantity(12, 10, 5), 15);
  assert.equal(roundUpOrderQuantity(10, 10, 5), 10);
  assert.equal(roundUpOrderQuantity(11, 10, 6), 12);
  assert.equal(roundUpOrderQuantity(0.2, 1, 1), 1);
  assert.equal(roundUpOrderQuantity(NaN, 1, 1), 0);
});

test("trend compares the last 30 days with the trailing 60, and is UNKNOWN on thin evidence", () => {
  assert.equal(calculateTrend(30, 60), "UP"); // 1/day recently vs 0.5/day before
  assert.equal(calculateTrend(5, 60), "DOWN");
  assert.equal(calculateTrend(10, 30), "STABLE");
  assert.equal(calculateTrend(10, 10), "UP", "all recent, nothing before");
  assert.equal(calculateTrend(0, 0), "UNKNOWN");
  assert.equal(calculateTrend(1, 3), "UNKNOWN", "fewer than 5 units in 90 days cannot show a direction");
});

test("open PO supply is subtracted before suggesting an order, and routes to Already Covered when it meets the need", () => {
  const without = calculateItemReplenishment({ ...ORDER_MORE_INPUT });
  const partial = calculateItemReplenishment({ ...ORDER_MORE_INPUT, openPoQuantity: 20 });
  const full = calculateItemReplenishment({ ...ORDER_MORE_INPUT, itemId: "t:2", onHand: 6, openPoQuantity: 50, usage30: 30, usage90: 85 });

  assert.equal(without.recommendationType, "ORDER_MORE");
  assert.equal(partial.recommendationType, "ORDER_MORE");
  assert.equal(without.evidence.suggestedOrderQuantity - partial.evidence.suggestedOrderQuantity, 20, "the PO reduces the suggestion unit for unit");

  assert.equal(full.recommendationType, "ALREADY_COVERED_BY_PO");
  assert.equal(full.evidence.suggestedOrderQuantity, 0);
  assert.equal(full.taskType, null, "informational: no task to action");
  assert.match(full.proposedSettings.rationale, /open PO/);
});

test("negative stock does not offset PO supply and is gated to a shelf check", () => {
  const r = calculateItemReplenishment({
    itemId: "n:1", onHand: -5, openPoQuantity: 10, usage30: 10, usage90: 30,
    confidence: evaluateConfidence({ onHand: -5, usage30: 10, usage90: 30, supplierId: "S1", openPoQuantity: 10 })
  });
  assert.equal(r.evidence.availableCoverage, 10);
  assert.equal(r.recommendationType, "SHELF_CHECK");
  assert.equal(r.taskType, "COUNT_SHELF");
});

test("no demand evidence never produces an order, and zero-stock dormant items need no action", () => {
  const r = calculateItemReplenishment({ itemId: "d:1", onHand: 0, usage30: 0, usage90: 0 });
  assert.equal(r.recommendationType, null);
  assert.equal(r.evidence.daysRemaining, 0);
  assert.equal(r.evidence.suggestedOrderQuantity > 0 && r.recommendationType === "ORDER_MORE", false);
});

test("non-moving stock routes to Write-Off Review with the value at risk and is not a financial write-off", () => {
  const r = calculateItemReplenishment({ itemId: "wo:1", onHand: 50, usage30: 0, usage90: 0, unitCost: 30 });
  assert.equal(r.recommendationType, "WRITE_OFF_REVIEW");
  assert.equal(r.evidence.daysRemaining, "UNKNOWN");
  assert.equal(r.evidence.valueAtRisk, 1500);
  assert.equal(r.taskType, "REVIEW_WRITE_OFF");
  assert.match(r.proposedSettings.rationale, /not an automatic write-off/);
  assert.equal(r.evidence.thresholds.writeOffDaysThreshold, 365, "the threshold used is stored with the result");
});

test("Order Less fires when the approved order point is materially above what demand supports", () => {
  const r = calculateItemReplenishment({
    itemId: "ol:1", onHand: 20, openPoQuantity: 0, usage30: 3, usage90: 9,
    settings: { orderPoint: 60, reorderQuantity: 40, leadTimeDays: 14, safetyStock: 5, targetCoverDays: 30, minOrderQty: 1, packMultiple: 1, version: 3 }
  });
  assert.equal(r.recommendationType, "ORDER_LESS");
  assert.equal(r.queueRule, "APPROVED_ORDER_POINT_ABOVE_DEMAND");
  assert.equal(r.proposedSettings.orderPoint, 7);
  assert.equal(r.evidence.approvedOrderPoint, 60);
  assert.equal(r.evidence.approvedSettingsVersion, 3);
  assert.equal(r.taskType, "REVIEW_OVERSTOCK");
});

test("Order Less also fires when stock is far above the cover ratio, and not for a modest surplus", () => {
  const over = calculateItemReplenishment({ itemId: "ol:2", onHand: 120, usage30: 30, usage90: 90 });
  assert.equal(over.recommendationType, "ORDER_LESS");
  assert.equal(over.queueRule, "STOCK_ABOVE_COVER_RATIO");

  const modest = calculateItemReplenishment({ itemId: "ol:3", onHand: 80, usage30: 45, usage90: 120 });
  assert.equal(modest.recommendationType, null, "55 days of cover is inside the 60-day tolerance");
});

test("the engine is deterministic: the same input and policy always give the same result", () => {
  const input = { ...ORDER_MORE_INPUT, settings: { leadTimeDays: 21, safetyStock: 8, targetCoverDays: 45, minOrderQty: 6, packMultiple: 6, version: 1 } };
  assert.deepEqual(calculateItemReplenishment(input), calculateItemReplenishment(JSON.parse(JSON.stringify(input))));
});

/* ═════════════════════ 2. CONFIDENCE ═════════════════════ */

test("negative stock is critical and gates ordering; a recent count turns it into a source-data problem", () => {
  const raw = evaluateConfidence({ onHand: -5, usage30: 10, usage90: 30, supplierId: "S1" });
  assert.equal(raw.confidenceLevel, "LOW");
  assert.ok(raw.signals.some((s) => s.code === "NEGATIVE_STOCK" && s.severity === "CRITICAL"));

  const counted = evaluateConfidence({ onHand: -5, usage30: 10, usage90: 30, supplierId: "S1", stockFreshnessDays: 3 });
  assert.ok(counted.signals.some((s) => s.code === "SOURCE_NEGATIVE_AFTER_COUNT"));
  assert.ok(!counted.signals.some((s) => s.code === "NEGATIVE_STOCK"));

  const calc = calculateItemReplenishment({ itemId: "c:1", onHand: -5, usage30: 10, usage90: 30, confidence: counted });
  assert.equal(calc.recommendationType, "DATA_REVIEW");
  assert.equal(calc.taskType, "CORRECT_ITEM_DATA");
});

test("stale counts, unmapped suppliers, missing counts and missing settings each lower confidence and say why", () => {
  const stale = evaluateConfidence({ onHand: 15, stockFreshnessDays: 200, supplierId: "S1", usage30: 1, usage90: 2 });
  assert.ok(stale.signals.some((s) => s.code === "STALE_STOCK_COUNT"));

  const unmapped = evaluateConfidence({ onHand: 15, supplierMappingQuality: "UNMAPPED", usage30: 20, usage90: 60, stockFreshnessDays: 2 });
  assert.ok(unmapped.signals.some((s) => s.code === "UNMAPPED_SUPPLIER"));

  const unverified = evaluateConfidence({ onHand: 15, supplierId: "S1", usage30: 20, usage90: 60 });
  assert.ok(unverified.signals.some((s) => s.code === "UNVERIFIED_STOCK"), "an item never counted is flagged, not assumed fresh");
  assert.ok(unverified.signals.some((s) => s.code === "MISSING_SETTINGS"));

  const incompleteSettings = evaluateConfidence({ onHand: 15, supplierId: "S1", usage30: 20, usage90: 60, settings: { minOrderQty: 0, packMultiple: null, leadTimeDays: null } });
  assert.deepEqual(incompleteSettings.missingSettingsFlags.sort(), ["MISSING_LEAD_TIME", "MISSING_MOQ", "MISSING_PACK_MULTIPLE"]);
});

test("an open PO is flagged as an aggregate balance, and a stale one is flagged as stale", () => {
  const conf = evaluateConfidence({ onHand: 5, openPoQuantity: 20, supplierId: "S1", usage30: 5, usage90: 20, poFreshnessDays: 90 });
  assert.ok(conf.signals.some((s) => s.code === "PO_SOURCE_AGGREGATE"));
  assert.ok(conf.signals.some((s) => s.code === "STALE_OPEN_PO"));
});

test("the LOW threshold is a policy value", () => {
  const params = { onHand: 10, supplierId: "S1", usage30: 0, usage90: 0 }; // 100 - 5 - 15 - 15 = 65
  assert.equal(evaluateConfidence(params).confidenceLevel, "MEDIUM");
  assert.equal(evaluateConfidence(params, { confidenceThreshold: 70 }).confidenceLevel, "LOW");
});

test("an unconfirmed supplier gates ordering to supplier-mapping work whatever the score", () => {
  const confidence = evaluateConfidence({ onHand: 8, usage30: 20, usage90: 55, supplierMappingQuality: "UNMAPPED", stockFreshnessDays: 2, settings: { minOrderQty: 1, packMultiple: 1, leadTimeDays: 14 } });
  assert.notEqual(confidence.confidenceLevel, "LOW", "the score alone would not stop it");
  const calc = calculateItemReplenishment({ itemId: "m:1", onHand: 8, usage30: 20, usage90: 55, confidence });
  assert.equal(calc.recommendationType, "DATA_REVIEW");
  assert.equal(calc.taskType, "RESOLVE_SUPPLIER_MAPPING");
});

/* ═════════════════════ 3. POLICY ═════════════════════ */

test("policy comes from configured settings, ignores invalid values, and is versioned by content", () => {
  const configured = buildPolicy({ inventory_weight_30: "0.6", inventory_weight_90: "0.4", inventory_target_cover_days: "45", inventory_write_off_days: "200" });
  assert.equal(configured.weight30, 0.6);
  assert.equal(configured.targetCoverDays, 45);
  assert.equal(configured.writeOffDaysThreshold, 200);

  const bad = buildPolicy({ inventory_target_cover_days: "-3", inventory_confidence_threshold: "abc" });
  assert.equal(bad.targetCoverDays, DEFAULT_POLICY.targetCoverDays);
  assert.deepEqual(bad.invalidKeys.sort(), ["inventory_confidence_threshold", "inventory_target_cover_days"]);

  assert.notEqual(configured.policyVersion, buildPolicy({}).policyVersion);
  assert.equal(buildPolicy({}).policyVersion, buildPolicy({}).policyVersion);
});

/* ═════════════════════ 4. READ-ONLY SOURCE ADAPTER ═════════════════════ */

test("the source adapter sends only SELECT statements and refuses anything else", () => {
  assertReadOnlySql(buildEvidenceQuery(null));
  assertReadOnlySql(buildEvidenceQuery([[1, 1, 1, 1, 1, 5]]));
  for (const bad of ["UPDATE dbo.LensItem SET OnHand_R = 1", "DELETE FROM dbo.LensItem", "INSERT INTO dbo.LensItem VALUES (1)", "EXEC xp_cmdshell 'dir'", "SELECT 1; DROP TABLE dbo.LensItem", "MERGE dbo.LensItem USING x ON 1=1"]) {
    assert.throws(() => assertReadOnlySql(bad), /read-only/, bad);
  }
});

test("source rows become evidence without inventing freshness, PO completeness or a supplier", async () => {
  setup();
  const statements = fakeSource([
    liveRow({ it: 1, onHand: 5, onOrder: 3, usage30: 2, usage90: 6 }),
    liveRow({ it: 2, onHand: 9, supplierNum: null, manufacturerNum: 0, supplierName: null })
  ]);
  const { items, truncated, source } = await loadInventoryEvidence({});

  assert.equal(items[0].itemId, "1:1:1:1:1:1");
  assert.equal(items[0].supplierMappingQuality, "CONFIRMED");
  assert.equal(items[0].openPoQuantity, 3);
  assert.equal(items[0].stockFreshnessDays, null, "freshness is unknown, not 'recent'");
  assert.equal(items[0].poComplete, null, "PO completeness is unknown, not 'complete'");
  assert.equal(items[1].supplierMappingQuality, "UNMAPPED");
  assert.equal(items[1].supplierId, null);
  assert.equal(truncated, false);
  assert.ok(source.caveats.some((c) => /63%/.test(c)));
  assert.equal(statements.length, 1);
  assertReadOnlySql(statements[0].text);
});

test("a full source page is reported as truncated, and a targeted load asks only for those items", async () => {
  setup();
  const statements = fakeSource([liveRow({ it: 1, onHand: 1 }), liveRow({ it: 2, onHand: 1 })]);
  const page = await loadInventoryEvidence({ limit: 2 });
  assert.equal(page.truncated, true);

  const targeted = await loadInventoryEvidence({ itemIds: ["1:1:1:1:1:2"] });
  assert.deepEqual(targeted.items.map((i) => i.itemId), ["1:1:1:1:1:2"]);
  assert.match(statements.at(-1).text, /li\.Num = @it0/);
  await assert.rejects(loadInventoryEvidence({ itemIds: Array.from({ length: 201 }, (_, i) => `1:1:1:1:1:${i}`) }), /limited to 200/);
});

test("when the source is unreachable the load fails safely; it never substitutes synthetic data", async () => {
  setup();
  brokenSource();
  await assert.rejects(loadInventoryEvidence({}), (error) => {
    assert.equal(error.code, "SOURCE_UNAVAILABLE");
    assert.doesNotMatch(error.message, /hunter2|svc_secret|Login failed/, "no credentials in the message");
    return true;
  });
});

test("synthetic fixtures are refused outside automated tests", async () => {
  setup();
  assert.ok((await loadInventoryEvidence({ useFixtures: true })).items.length > 0);
  store.setTestMode(false);
  try {
    await assert.rejects(loadInventoryEvidence({ useFixtures: true }), /automated tests only/);
  } finally {
    store.setTestMode(true);
  }
});

test("a database failure is an error, never a silent switch to in-memory records", async () => {
  setup();
  const { mock } = require("node:test");
  mock.method(db, "getAppPool", async () => { throw new Error("connect ECONNREFUSED 10.0.0.9:1433 user=sa"); });
  store.setTestMode(false);
  try {
    await assert.rejects(recordInventoryAudit({ actor: "u", action: "X", entityType: "T", entityId: "1" }), (error) => {
      assert.equal(error.code, "UNAVAILABLE");
      assert.doesNotMatch(error.message, /ECONNREFUSED|10\.0\.0\.9|user=sa/);
      return true;
    });
  } finally {
    store.setTestMode(true);
  }
  assert.equal(store.mem.audit.length, 0, "nothing was recorded in memory instead");
});

test("an in-memory unit of work rolls back everything when it throws", async () => {
  setup();
  await assert.rejects(store.withTransaction(async () => {
    await recordInventoryAudit({ actor: "u", action: "A", entityType: "T", entityId: "1" });
    throw new Error("boom");
  }), /boom/);
  assert.equal(store.mem.audit.length, 0);
});

/* ═════════════════════ 5. APPROVED SETTINGS ═════════════════════ */

const SETTING_BASE = { itemId: "s:1", orderPoint: 26, safetyStock: 5, targetCoverDays: 30, leadTimeDays: 14, reorderQuantity: 44, minOrderQty: 1, packMultiple: 1, approvedBy: "ann" };

test("each approval is a new settings version; the old version is closed, not changed", async () => {
  setup();
  const v1 = await store.withTransaction((tx) => writeApprovedSetting({ ...SETTING_BASE, recommendationId: "r-1", expectedVersion: null, tx }));
  assert.equal(v1.setting.version, 1);
  const v2 = await store.withTransaction((tx) => writeApprovedSetting({ ...SETTING_BASE, orderPoint: 30, recommendationId: "r-2", expectedVersion: 1, tx }));
  assert.equal(v2.setting.version, 2);

  const history = await getSettingHistory("s:1");
  assert.deepEqual(history.map((h) => h.version), [2, 1]);
  assert.equal(history[1].orderPoint, 26, "version 1 keeps its original values");
  assert.ok(history[1].effectiveTo, "version 1 was closed");
  assert.equal(history[0].effectiveTo, null);
  assert.equal((await getActiveSetting("s:1")).version, 2);
});

test("writing settings is idempotent per recommendation and refuses a stale view", async () => {
  setup();
  await store.withTransaction((tx) => writeApprovedSetting({ ...SETTING_BASE, recommendationId: "r-1", expectedVersion: null, tx }));
  const again = await store.withTransaction((tx) => writeApprovedSetting({ ...SETTING_BASE, recommendationId: "r-1", expectedVersion: null, tx }));
  assert.equal(again.isDuplicate, true);
  assert.equal((await getSettingHistory("s:1")).length, 1);

  await assert.rejects(
    store.withTransaction((tx) => writeApprovedSetting({ ...SETTING_BASE, recommendationId: "r-9", expectedVersion: null, tx })),
    (error) => error.code === "STALE_SETTINGS"
  );
  assert.equal((await getSettingHistory("s:1")).length, 1);
});

test("setting values are validated", async () => {
  setup();
  for (const bad of [{ orderPoint: -1 }, { packMultiple: 0 }, { minOrderQty: 1.5 }, { reorderQuantity: "lots" }, { leadTimeDays: 0 }]) {
    await assert.rejects(store.withTransaction((tx) => writeApprovedSetting({ ...SETTING_BASE, recommendationId: "r-x", ...bad, tx })), (e) => e.statusCode === 400, JSON.stringify(bad));
  }
  assert.equal((await getSettingHistory("s:1")).length, 0);
});

/* ═════════════════════ 6. OPERATIONAL TASKS ═════════════════════ */

test("repeated scans reuse one unresolved task per item and purpose; a new purpose is a new task", async () => {
  setup();
  const a = await tasks.syncOperationalTask({ recommendationId: "r-1", itemId: "k:1", taskType: "APPROVE_REPLENISHMENT_CHANGE", priority: "HIGH" });
  const b = await tasks.syncOperationalTask({ recommendationId: "r-1", itemId: "k:1", taskType: "APPROVE_REPLENISHMENT_CHANGE", priority: "HIGH" });
  const c = await tasks.syncOperationalTask({ recommendationId: "r-2", itemId: "k:1", taskType: "APPROVE_REPLENISHMENT_CHANGE", priority: "HIGH" });
  const d = await tasks.syncOperationalTask({ recommendationId: "r-3", itemId: "k:1", taskType: "COUNT_SHELF", priority: "HIGH" });

  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.changed, false, "an identical rescan writes nothing");
  assert.equal(c.created, false);
  assert.equal(c.task.taskId, a.task.taskId);
  assert.equal(d.created, true);
  assert.equal((await tasks.listTasks({})).total, 2);

  const history = await tasks.listTaskHistory(a.task.taskId);
  assert.deepEqual(history.map((h) => h.eventType), ["CREATED", "SCAN_REFRESHED"], "only a substantive change is history");
});

test("a task carries type, status, assignee, priority and a due date from creation", async () => {
  setup();
  const { task } = await tasks.syncOperationalTask({ recommendationId: "r-1", itemId: "k:2", taskType: "REVIEW_WRITE_OFF", priority: "MEDIUM" });
  assert.equal(task.taskType, "REVIEW_WRITE_OFF");
  assert.equal(task.status, "OPEN");
  assert.equal(task.assignee, null);
  assert.equal(task.priority, "MEDIUM");
  assert.match(task.dueDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(task.dueDate, tasks.dueDateFor("MEDIUM"));
  assert.ok(task.auditCorrelationId);
});

test("a resolved task does not block a fresh one for the same item and purpose", async () => {
  setup();
  const first = await tasks.syncOperationalTask({ recommendationId: "r-1", itemId: "k:3", taskType: "COUNT_SHELF" });
  await tasks.updateTaskState({ taskId: first.task.taskId, status: "COMPLETED", note: "counted", actor: "ann" });
  const second = await tasks.syncOperationalTask({ recommendationId: "r-2", itemId: "k:3", taskType: "COUNT_SHELF" });
  assert.equal(second.created, true);
  assert.notEqual(second.task.taskId, first.task.taskId);
  assert.equal((await tasks.getTask(first.task.taskId)).status, "COMPLETED");
});

test("task status transitions are validated and closed tasks stay closed", async () => {
  setup();
  const { task } = await tasks.syncOperationalTask({ recommendationId: "r-1", itemId: "k:4", taskType: "COUNT_SHELF" });
  await tasks.updateTaskState({ taskId: task.taskId, status: "IN_PROGRESS", actor: "ann" });
  await tasks.updateTaskState({ taskId: task.taskId, status: "COMPLETED", actor: "ann" });

  await assert.rejects(tasks.updateTaskState({ taskId: task.taskId, status: "OPEN", actor: "ann" }), (e) => e.code === "INVALID_TRANSITION");
  await assert.rejects(tasks.updateTaskState({ taskId: task.taskId, assignee: "bob", actor: "ann" }), (e) => e.code === "TASK_CLOSED");
  await assert.rejects(tasks.updateTaskState({ taskId: task.taskId, status: "SHRUG", actor: "ann" }), (e) => e.statusCode === 400);
  await assert.rejects(tasks.updateTaskState({ taskId: "no-such", status: "COMPLETED", actor: "ann" }), (e) => e.statusCode === 404);

  const blocked = (await tasks.syncOperationalTask({ recommendationId: "r-2", itemId: "k:5", taskType: "COUNT_SHELF" })).task;
  await tasks.updateTaskState({ taskId: blocked.taskId, status: "BLOCKED", actor: "ann" });
  await tasks.updateTaskState({ taskId: blocked.taskId, status: "OPEN", actor: "ann" });
});

test("priority only escalates, and the escalation is recorded", async () => {
  setup();
  const a = await tasks.syncOperationalTask({ recommendationId: "r-1", itemId: "k:6", taskType: "COUNT_SHELF", priority: "MEDIUM" });
  const b = await tasks.syncOperationalTask({ recommendationId: "r-1", itemId: "k:6", taskType: "COUNT_SHELF", priority: "CRITICAL" });
  const c = await tasks.syncOperationalTask({ recommendationId: "r-1", itemId: "k:6", taskType: "COUNT_SHELF", priority: "LOW" });
  assert.equal(b.task.priority, "CRITICAL");
  assert.ok(b.task.escalatedAt);
  assert.equal(c.task.priority, "CRITICAL");
  assert.ok((await tasks.listTaskHistory(a.task.taskId)).some((h) => h.eventType === "ESCALATED"));
});

test("assigning a shelf count creates or reuses the single count task, and records who assigned it", async () => {
  setup();
  const first = await tasks.assignShelfCount({ itemId: "k:7", assignee: "clerk", dueDate: "2026-10-20", note: "recount", actor: "manager" });
  assert.equal(first.status, "ASSIGNED");
  assert.equal(first.assignee, "clerk");
  assert.equal(first.dueDate, "2026-10-20");

  const reassigned = await tasks.assignShelfCount({ itemId: "k:7", assignee: "other", actor: "manager" });
  assert.equal(reassigned.taskId, first.taskId, "the same task, reassigned");
  assert.equal((await tasks.listTasks({ taskType: "COUNT_SHELF" })).total, 1);

  const history = await tasks.listTaskHistory(first.taskId);
  assert.ok(history.some((h) => h.eventType === "ASSIGNED" && h.actor === "manager"));
  await assert.rejects(tasks.assignShelfCount({ itemId: "k:7", assignee: "  ", actor: "m" }), (e) => e.statusCode === 400);
  await assert.rejects(tasks.assignShelfCount({ itemId: "k:7", assignee: "x", dueDate: "tomorrow", actor: "m" }), (e) => e.statusCode === 400);
});

test("task listing is filtered and bounded", async () => {
  setup();
  for (let i = 0; i < 5; i += 1) await tasks.syncOperationalTask({ recommendationId: `r-${i}`, itemId: `p:${i}`, taskType: "COUNT_SHELF" });
  assert.equal((await tasks.listTasks({ limit: 2 })).items.length, 2);
  assert.equal((await tasks.listTasks({ limit: 2 })).total, 5);
  assert.equal((await tasks.listTasks({ limit: 100000 })).limit, 500);
  assert.equal((await tasks.listTasks({ itemId: "p:3" })).total, 1);
  await assert.rejects(tasks.listTasks({ status: "NOPE" }), (e) => e.statusCode === 400);
});

/* ═════════════════════ 7. RECOMMENDATION LIFECYCLE ═════════════════════ */

test("a scan creates one recommendation per actionable item, each with a task where action is needed", async () => {
  setup();
  const scan = await runInventoryScan({ useFixtures: true, actor: "scanner" });
  assert.equal(scan.status, "COMPLETED");
  assert.equal(scan.itemsEvaluated, 6);

  const { items } = await recs.listRecommendations({ status: "ALL", limit: 100 });
  const byType = Object.fromEntries(items.map((r) => [r.itemId, r]));
  assert.equal(byType["1:1:1:1:1:101"].recommendationType, "ORDER_MORE");
  assert.equal(byType["1:1:1:1:1:101"].status, "PENDING_APPROVAL");
  assert.equal(byType["1:1:1:1:1:102"].recommendationType, "ALREADY_COVERED_BY_PO");
  assert.equal(byType["1:1:1:1:1:102"].linkedTaskId, null, "informational: no task");
  assert.equal(byType["1:1:1:1:1:103"].recommendationType, "WRITE_OFF_REVIEW");
  assert.equal(byType["1:1:1:1:1:105"].recommendationType, "SHELF_CHECK");
  assert.equal(byType["1:1:1:1:1:106"].recommendationType, "DATA_REVIEW");

  for (const r of items.filter((x) => x.recommendationType !== "ALREADY_COVERED_BY_PO")) {
    const task = await tasks.getTask(r.linkedTaskId);
    assert.ok(task, `${r.itemId} has a task`);
    assert.equal(task.recommendationId, r.recommendationId);
    assert.ok(task.priority && task.dueDate && task.taskType && task.status);
  }
  assert.equal((await tasks.getTask(byType["1:1:1:1:1:106"].linkedTaskId)).taskType, "RESOLVE_SUPPLIER_MAPPING");
  assert.equal((await tasks.getTask(byType["1:1:1:1:1:105"].linkedTaskId)).taskType, "COUNT_SHELF");
});

test("rescanning unchanged data changes nothing: no new recommendations, tasks or history", async () => {
  setup();
  await runInventoryScan({ useFixtures: true });
  const before = { recs: store.mem.recommendations.size, tasks: store.mem.tasks.size, history: store.mem.taskHistory.length };
  const again = await runInventoryScan({ useFixtures: true });
  assert.equal(again.summary.actions.UNCHANGED, 6);
  assert.equal(again.recommendationsCreated, 0);
  assert.equal(store.mem.recommendations.size, before.recs);
  assert.equal(store.mem.tasks.size, before.tasks);
  assert.equal(store.mem.taskHistory.length, before.history);
});

test("approval writes the approved settings revision, closes the task and queues a recalculation, all once", async () => {
  setup();
  await runInventoryScan({ useFixtures: true });
  const rec = (await recs.listRecommendations({ queue: "ORDER_MORE" })).items[0];

  const result = await recs.approveRecommendation({ recommendationId: rec.recommendationId, reason: "Looks right", actor: "ann" });
  assert.equal(result.isDuplicate, false);
  assert.equal(result.recommendation.status, "APPROVED");
  assert.equal(result.recommendation.decisionActor, "ann");
  assert.equal(result.setting.version, 1);
  assert.equal(result.setting.orderPoint, rec.proposedSettings.orderPoint);
  assert.equal(result.setting.reorderQuantity, rec.proposedSettings.reorderQuantity);
  assert.equal(result.setting.approvedRecommendationId, rec.recommendationId);
  assert.equal(result.setting.approvedTaskId, rec.linkedTaskId);
  assert.equal(result.recommendation.approvedSettings.settingId, result.setting.settingId, "the approved snapshot is on the recommendation");
  assert.equal((await tasks.getTask(rec.linkedTaskId)).status, "APPROVED");

  const events = await listRequests({ status: "PENDING" });
  assert.equal(events.filter((e) => e.eventType === "EVENT_SETTINGS" && e.itemId === rec.itemId).length, 1);

  // Duplicate approval is harmless.
  const duplicate = await recs.approveRecommendation({ recommendationId: rec.recommendationId, actor: "ann" });
  assert.equal(duplicate.isDuplicate, true);
  assert.equal((await getSettingHistory(rec.itemId)).length, 1);
  assert.equal((await listRequests({ status: "PENDING" })).filter((e) => e.eventType === "EVENT_SETTINGS").length, 1);
});

test("only replenishment queues can be approved; the others have their own workflow", async () => {
  setup();
  await runInventoryScan({ useFixtures: true });
  for (const queue of ["SHELF_CHECK", "WRITE_OFF_REVIEW", "DATA_REVIEW", "ALREADY_COVERED_BY_PO"]) {
    const rec = (await recs.listRecommendations({ queue })).items[0];
    await assert.rejects(recs.approveRecommendation({ recommendationId: rec.recommendationId, actor: "ann" }), (e) => e.code === "NOT_A_SETTINGS_QUEUE", queue);
  }
  assert.equal((await listRequests({})).filter((e) => e.eventType === "EVENT_SETTINGS").length, 0);
  assert.equal(store.mem.settings.length, 0, "nothing was written");
});

test("a low-confidence recommendation cannot be approved", async () => {
  setup();
  const { calculation } = await syncCalc({ ...ORDER_MORE_INPUT, itemId: "lc:1" });
  const lowCalc = { ...calculation, confidenceLevel: "LOW", confidenceScore: 30, itemId: "lc:2" };
  const { recommendation } = await store.withTransaction((tx) => recs.syncRecommendation({ calculation: lowCalc, tx }));
  await assert.rejects(recs.approveRecommendation({ recommendationId: recommendation.recommendationId, actor: "ann" }), (e) => e.code === "LOW_CONFIDENCE");
});

test("edit-and-approve records the human values as a new revision, supersedes the original, and approves that revision", async () => {
  setup();
  await runInventoryScan({ useFixtures: true });
  const original = (await recs.listRecommendations({ queue: "ORDER_MORE" })).items[0];

  await assert.rejects(recs.editAndApproveRecommendation({ recommendationId: original.recommendationId, orderPoint: 40, actor: "ann" }), (e) => e.statusCode === 400, "a reason is required");
  await assert.rejects(recs.editAndApproveRecommendation({ recommendationId: original.recommendationId, orderPoint: -4, reason: "typo", actor: "ann" }), (e) => e.statusCode === 400);
  assert.equal((await recs.getRecommendation(original.recommendationId)).status, "PENDING_APPROVAL", "a rejected edit changes nothing");

  const result = await recs.editAndApproveRecommendation({
    recommendationId: original.recommendationId, orderPoint: 40, reorderQuantity: 60, leadTimeDays: 21,
    leadTimeOverrideReason: "Supplier quoted 3 weeks", minOrderQty: 12, packMultiple: 6, reason: "Supplier MOQ changed", actor: "ann"
  });

  assert.equal(result.recommendation.revisionNumber, original.revisionNumber + 1);
  assert.equal(result.recommendation.previousRecommendationId, original.recommendationId);
  assert.equal(result.recommendation.status, "APPROVED");
  assert.equal(result.recommendation.proposedSettings.humanEdited, true);
  assert.equal(result.recommendation.proposedSettings.editReason, "Supplier MOQ changed");
  assert.equal(result.recommendation.proposedSettings.originalProposal.orderPoint, original.proposedSettings.orderPoint);
  assert.equal(result.setting.orderPoint, 40);
  assert.equal(result.setting.reorderQuantity, 60);
  assert.equal(result.setting.leadTimeDays, 21);
  assert.equal(result.setting.leadTimeOverrideReason, "Supplier quoted 3 weeks");
  assert.equal(result.setting.minOrderQty, 12);
  assert.equal(result.setting.packMultiple, 6);
  assert.equal(result.setting.approvedRecommendationId, result.recommendation.recommendationId);

  const old = await recs.getRecommendation(original.recommendationId);
  assert.equal(old.status, "SUPERSEDED");
  assert.equal(old.supersededById, result.recommendation.recommendationId);
  assert.equal(old.proposedSettings.orderPoint, original.proposedSettings.orderPoint, "the original proposal is intact");

  const audit = (await listInventoryAudit({ recommendationId: result.recommendation.recommendationId })).map((a) => a.action);
  assert.ok(audit.includes("RECOMMENDATION_EDITED") && audit.includes("RECOMMENDATION_EDIT_APPROVED") && audit.includes("SETTINGS_WRITTEN"));
});

test("a decided or superseded recommendation can never be edited or approved again", async () => {
  setup();
  await runInventoryScan({ useFixtures: true });
  const rec = (await recs.listRecommendations({ queue: "ORDER_MORE" })).items[0];
  await recs.rejectRecommendation({ recommendationId: rec.recommendationId, reason: "not now", actor: "ann" });

  await assert.rejects(recs.editAndApproveRecommendation({ recommendationId: rec.recommendationId, orderPoint: 9, reason: "x", actor: "ann" }), (e) => e.code === "ALREADY_DECIDED");
  await assert.rejects(recs.approveRecommendation({ recommendationId: rec.recommendationId, actor: "ann" }), (e) => e.code === "ALREADY_DECIDED");
  assert.equal((await recs.getRecommendation(rec.recommendationId)).status, "REJECTED");
});

test("rejecting needs a reason, keeps the evidence, writes no settings, and is not re-raised for the same situation", async () => {
  setup();
  await runInventoryScan({ useFixtures: true });
  const rec = (await recs.listRecommendations({ queue: "ORDER_MORE" })).items[0];

  await assert.rejects(recs.rejectRecommendation({ recommendationId: rec.recommendationId, reason: "  ", actor: "ann" }), (e) => e.statusCode === 400);
  const rejected = await recs.rejectRecommendation({ recommendationId: rec.recommendationId, reason: "Supplier on holiday", actor: "ann" });
  assert.equal(rejected.recommendation.status, "REJECTED");
  assert.equal(rejected.recommendation.decisionReason, "Supplier on holiday");
  assert.equal(rejected.recommendation.evidence.onHand, rec.evidence.onHand, "evidence is preserved");
  assert.equal((await tasks.getTask(rec.linkedTaskId)).status, "REJECTED");
  assert.equal(store.mem.settings.length, 0);

  const rescan = await runInventoryScan({ useFixtures: true });
  assert.equal(rescan.summary.actions.SUPPRESSED, 1, "the same situation is not asked about again");
  assert.equal((await recs.listRecommendations({ queue: "ORDER_MORE" })).total, 0);

  // After the suppression window the situation is raised afresh, as a linked new revision.
  store.mem.recommendations.get(rec.recommendationId).decisionAt = new Date(Date.now() - 40 * 86400000).toISOString();
  const later = await runInventoryScan({ useFixtures: true });
  assert.equal(later.summary.actions.REVISED, 1);
  const fresh = (await recs.listRecommendations({ queue: "ORDER_MORE" })).items[0];
  assert.equal(fresh.previousRecommendationId, rec.recommendationId);
  assert.equal(fresh.revisionNumber, rec.revisionNumber + 1);
});

test("a material change revises (supersedes and links); small drift only refreshes the evidence", async () => {
  setup();
  const a = await syncCalc({ ...ORDER_MORE_INPUT, itemId: "rv:1" });
  assert.equal(a.action, "CREATED");

  const drift = await syncCalc({ ...ORDER_MORE_INPUT, itemId: "rv:1", usage30: 46 });
  assert.equal(drift.action, "REFRESHED");
  assert.equal(drift.recommendation.recommendationId, a.recommendation.recommendationId);
  const refreshed = await recs.getRecommendation(a.recommendation.recommendationId);
  assert.equal(refreshed.evidence.usage30, 46);
  assert.equal(refreshed.evidenceVersion, 2);
  assert.deepEqual(refreshed.proposedSettings, a.recommendation.proposedSettings, "what the reviewer sees does not move");

  const jump = await syncCalc({ ...ORDER_MORE_INPUT, itemId: "rv:1", usage30: 120, usage90: 300 });
  assert.equal(jump.action, "REVISED");
  assert.equal((await recs.getRecommendation(a.recommendation.recommendationId)).status, "SUPERSEDED");
  assert.equal(jump.recommendation.previousRecommendationId, a.recommendation.recommendationId);
  assert.equal(jump.task.taskId, a.task.taskId, "the same unresolved task follows the new revision");
  assert.equal((await tasks.getTask(a.task.taskId)).recommendationId, jump.recommendation.recommendationId);
  assert.equal([...store.mem.recommendations.values()].filter((r) => r.itemId === "rv:1" && ["OPEN", "PENDING_APPROVAL"].includes(r.status)).length, 1, "one undecided recommendation per item");
});

test("a different purpose cancels the stale unstarted task and opens the right one", async () => {
  setup();
  const first = await syncCalc({ ...ORDER_MORE_INPUT, itemId: "ch:1" });
  assert.equal(first.task.taskType, "APPROVE_REPLENISHMENT_CHANGE");
  const second = await syncCalc({ itemId: "ch:1", onHand: 120, openPoQuantity: 0, usage30: 30, usage90: 90 });
  assert.equal(second.calculation.recommendationType, "ORDER_LESS");
  assert.equal((await tasks.getTask(first.task.taskId)).status, "CANCELLED");
  assert.equal(second.task.taskType, "REVIEW_OVERSTOCK");
});

test("a task someone has picked up is not cancelled behind their back", async () => {
  setup();
  const first = await syncCalc({ ...ORDER_MORE_INPUT, itemId: "ch:2" });
  await tasks.updateTaskState({ taskId: first.task.taskId, assignee: "bob", actor: "ann" });
  await syncCalc({ itemId: "ch:2", onHand: 120, openPoQuantity: 0, usage30: 30, usage90: 90 });
  assert.equal((await tasks.getTask(first.task.taskId)).status, "ASSIGNED");
});

test("when action is no longer needed the open recommendation is retired and its unstarted task cancelled", async () => {
  setup();
  const first = await syncCalc({ ...ORDER_MORE_INPUT, itemId: "rt:1" });
  const settled = await syncCalc({ itemId: "rt:1", onHand: 80, openPoQuantity: 0, usage30: 45, usage90: 120 });
  assert.equal(settled.calculation.recommendationType, null);
  assert.equal(settled.action, "RETIRED");
  assert.equal((await recs.getRecommendation(first.recommendation.recommendationId)).status, "SUPERSEDED");
  assert.equal((await tasks.getTask(first.task.taskId)).status, "CANCELLED");
});

test("a stale approval is refused when the approved settings moved after the recommendation was made", async () => {
  setup();
  const { recommendation } = await syncCalc({ ...ORDER_MORE_INPUT, itemId: "st:1" });
  await store.withTransaction((tx) => writeApprovedSetting({ ...SETTING_BASE, itemId: "st:1", recommendationId: "other", expectedVersion: null, tx }));

  await assert.rejects(recs.approveRecommendation({ recommendationId: recommendation.recommendationId, actor: "ann" }), (e) => e.code === "STALE_SETTINGS");
  assert.equal((await recs.getRecommendation(recommendation.recommendationId)).status, "PENDING_APPROVAL");
  assert.equal((await getSettingHistory("st:1")).length, 1, "no second version was written");
});

test("a write-off or data review is marked reviewed with a note; it never touches settings", async () => {
  setup();
  await runInventoryScan({ useFixtures: true });
  const rec = (await recs.listRecommendations({ queue: "WRITE_OFF_REVIEW" })).items[0];

  await assert.rejects(recs.completeReview({ recommendationId: rec.recommendationId, reason: "", actor: "ann" }), (e) => e.statusCode === 400);
  const done = await recs.completeReview({ recommendationId: rec.recommendationId, reason: "Moving to clearance", actor: "ann" });
  assert.equal(done.recommendation.status, "APPLIED");
  assert.equal((await tasks.getTask(rec.linkedTaskId)).status, "COMPLETED");
  assert.equal(store.mem.settings.length, 0);

  const order = (await recs.listRecommendations({ queue: "ORDER_MORE" })).items[0];
  await assert.rejects(recs.completeReview({ recommendationId: order.recommendationId, reason: "x", actor: "ann" }), (e) => e.code === "USE_APPROVE");
});

/* ═════════════════════ 8. BULK APPROVAL ═════════════════════ */

async function seedOrderMore(count, { level = "HIGH" } = {}) {
  const made = [];
  for (let i = 0; i < count; i += 1) {
    const { calculation } = await syncCalc({ ...ORDER_MORE_INPUT, itemId: `bulk:${level}:${i}` });
    if (level !== "HIGH") {
      const record = store.mem.recommendations.get((await recs.getLatestRecommendationForItem(calculation.itemId)).recommendationId);
      record.confidenceLevel = level;
    }
    made.push(calculation.itemId);
  }
  return made;
}

test("approve all is homogeneous and eligible-only, and reports each skipped row with its reason", async () => {
  setup();
  await seedOrderMore(2, { level: "HIGH" });
  await seedOrderMore(1, { level: "MEDIUM" });

  await assert.rejects(recs.approveAllEligible({ queue: "SHELF_CHECK", actor: "ann" }), (e) => e.statusCode === 400);
  await assert.rejects(recs.approveAllEligible({ queue: undefined, actor: "ann" }), (e) => e.statusCode === 400);

  const result = await recs.approveAllEligible({ queue: "ORDER_MORE", actor: "ann" });
  assert.equal(result.approvedCount, 2);
  assert.equal(result.skippedCount, 1);
  assert.match(result.skipped[0].reason, /MEDIUM/);
  assert.equal(store.mem.settings.length, 2);

  const second = await recs.approveAllEligible({ queue: "ORDER_MORE", actor: "ann" });
  assert.equal(second.approvedCount, 0, "a repeat approves nothing new");
  assert.equal(store.mem.settings.length, 2);
});

test("approve selected approves the eligible ones and reports the rest", async () => {
  setup();
  const items = await seedOrderMore(2);
  const [a, b] = await Promise.all(items.map((id) => recs.getLatestRecommendationForItem(id)));
  await recs.approveRecommendation({ recommendationId: b.recommendationId, actor: "ann" });

  const result = await recs.approveMany({
    recommendationIds: [a.recommendationId, b.recommendationId, "00000000-0000-4000-8000-000000000000"], actor: "ann"
  });
  assert.equal(result.approvedCount, 1);
  assert.deepEqual(result.skipped.map((s) => s.reason).sort(), ["Already approved.", "Recommendation not found."]);
});

/* ═════════════════════ 9. QUEUE QUERIES ═════════════════════ */

test("the work queue filters, searches, sorts and pages within bounds", async () => {
  setup();
  await runInventoryScan({ useFixtures: true });

  assert.equal((await recs.listRecommendations({})).total, 6, "active work by default");
  assert.equal((await recs.listRecommendations({ queue: "PENDING_APPROVAL" })).total, 1);
  assert.equal((await recs.listRecommendations({ queue: "ORDER_MORE" })).items[0].itemId, "1:1:1:1:1:101");
  assert.equal((await recs.listRecommendations({ search: "polar" })).items[0].itemId, "1:1:1:1:1:105");
  assert.equal((await recs.listRecommendations({ search: "Thai" })).total, 2, "matches supplier name");

  const byUsage = (await recs.listRecommendations({ sortBy: "usage90", sortDir: "DESC" })).items.map((r) => r.evidence.usage90);
  assert.deepEqual(byUsage, [...byUsage].sort((a, b) => b - a));

  const page = await recs.listRecommendations({ limit: 2, offset: 4 });
  assert.equal(page.items.length, 2);
  assert.equal(page.total, 6);
  assert.equal((await recs.listRecommendations({ limit: 99999 })).limit, 500);

  await assert.rejects(recs.listRecommendations({ queue: "NOPE" }), (e) => e.statusCode === 400);
  await assert.rejects(recs.listRecommendations({ status: "NOPE" }), (e) => e.statusCode === 400);
  assert.ok((await recs.listRecommendations({ sortBy: "'; DROP TABLE x;--" })).items.length > 0, "an unknown sort falls back safely");
});

/* ═════════════════════ 10. SCANS, EVENTS AND PROVENANCE ═════════════════════ */

test("a source outage fails the scan visibly, changes nothing, and leaks no credentials", async () => {
  setup();
  await runInventoryScan({ useFixtures: true });
  const before = { recs: store.mem.recommendations.size, tasks: store.mem.tasks.size };

  brokenSource();
  const scan = await runInventoryScan({ actor: "scanner" });
  assert.equal(scan.status, "FAILED");
  assert.equal(scan.errors[0].code, "SOURCE_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(scan), /hunter2|svc_secret/);
  assert.equal(store.mem.recommendations.size, before.recs);
  assert.equal(store.mem.tasks.size, before.tasks);
  assert.equal((await getLatestScanStatus()).status, "FAILED");
  assert.ok((await listInventoryAudit({ action: "SCAN_FAILED" })).length === 1);

  const summary = await getCockpitSummary();
  assert.equal(summary.dataStatus, "last_scan_failed");
  assert.ok(summary.cards.every((c) => c.status !== "unavailable"), "an earlier completed scan still backs the queues");
});

test("a scan records its trigger, watermarks, policy version and per-action counts, and stamps provenance on each recommendation", async () => {
  setup();
  fakeSource([liveRow({ it: 1, onHand: 4, usage30: 45, usage90: 120 })]);
  const scan = await runInventoryScan({ triggerType: "SCHEDULED_FULL", actor: "scheduler" });

  assert.equal(scan.triggerType, "SCHEDULED_FULL");
  assert.equal(scan.status, "COMPLETED");
  assert.ok(scan.sourceWatermarks.evidenceAsOf);
  assert.equal(scan.sourceWatermarks.sourceRows, 1);
  assert.equal(scan.sourceWatermarks.truncated, false);
  assert.match(scan.sourceWatermarks.policyVersion, /^1\.0\.0\+pol-/);
  assert.equal(scan.summary.actions.CREATED, 1);
  assert.equal(scan.summary.queueCounts.ORDER_MORE, 1);
  assert.ok(scan.summary.sourceCaveats.length >= 1);

  const rec = (await recs.listRecommendations({})).items[0];
  assert.equal(rec.policyVersion, scan.sourceWatermarks.policyVersion);
  assert.equal(rec.scanRunId, scan.scanRunId);
  assert.equal(rec.evidence.provenance.system, "Innovations MSSQL (read-only)");
  assert.ok(rec.evidence.provenance.evidenceAsOf);
  assert.equal(rec.evidence.thresholds.writeOffDaysThreshold, 365);
  assert.ok(rec.calculationVersion);
});

test("the source is only ever read: every statement a scan sends is a SELECT", async () => {
  setup();
  const statements = fakeSource([liveRow({ it: 1, onHand: 4, usage30: 45, usage90: 120 }), liveRow({ it: 2, onHand: 50 })]);
  await runInventoryScan({});
  const rec = (await recs.listRecommendations({ queue: "ORDER_MORE" })).items[0];
  await recs.approveRecommendation({ recommendationId: rec.recommendationId, actor: "ann" });
  await generateDraftPoPreview({ actor: "ann" });

  assert.ok(statements.length >= 2);
  for (const s of statements) assertReadOnlySql(s.text);
});

test("items that leave the source universe are retired; a truncated scan retires nothing", async () => {
  setup();
  let rows = [liveRow({ it: 1, onHand: 4, usage30: 45, usage90: 120 }), liveRow({ it: 2, onHand: 4, usage30: 45, usage90: 120 })];
  fakeSource(() => rows);
  await runInventoryScan({});
  assert.equal((await recs.listRecommendations({ queue: "ORDER_MORE" })).total, 2);

  rows = [rows[0]];
  const truncated = await runInventoryScan({ limit: 1 });
  assert.equal(truncated.sourceWatermarks.truncated, true);
  assert.equal((await recs.listRecommendations({ queue: "ORDER_MORE" })).total, 2, "not seen is not the same as gone");

  const complete = await runInventoryScan({});
  assert.equal(complete.summary.actions.RETIRED, 1);
  assert.equal((await recs.listRecommendations({ queue: "ORDER_MORE" })).total, 1);
});

test("usage, stock-adjustment and PO events each queue a recalculation; a replay of the same source event does not", async () => {
  setup();
  fakeSource([liveRow({ it: 1, onHand: 4, usage30: 45, usage90: 120 })]);
  const id = "1:1:1:1:1:1";

  const usage = await enqueueRecalculation({ eventType: "EVENT_USAGE", itemId: id, sourceRef: "rx-batch-8", actor: "feed" });
  const usageReplay = await enqueueRecalculation({ eventType: "EVENT_USAGE", itemId: id, sourceRef: "rx-batch-8", actor: "feed" });
  const adjust = await enqueueRecalculation({ eventType: "EVENT_STOCK_ADJUSTMENT", itemId: id, sourceRef: "adj-3", actor: "feed" });
  const po = await enqueueRecalculation({ eventType: "EVENT_PO", itemId: id, sourceRef: "po-77", actor: "feed" });
  assert.deepEqual([usage.created, usageReplay.created, adjust.created, po.created], [true, false, true, true]);

  await assert.rejects(enqueueRecalculation({ eventType: "EVENT_NOPE", itemId: id }), (e) => e.statusCode === 400);
  await assert.rejects(enqueueRecalculation({ eventType: "EVENT_PO" }), (e) => e.statusCode === 400);

  const scans = await processPendingRequests({ actor: "worker" });
  assert.equal(scans.length, 1, "one bounded batch");
  assert.equal(scans[0].triggerType, "EVENT_BATCH");
  assert.equal(scans[0].sourceWatermarks.scope, "ITEMS");
  assert.equal(scans[0].itemsEvaluated, 1);
  assert.equal(scans[0].sourceWatermarks.requestIds.length, 3);
  assert.equal((await listRequests({ status: "PROCESSED" })).length, 3);
  assert.equal((await listRequests({ status: "PENDING" })).length, 0);
});

test("a manual scan and a scheduled scan take the same path and give the same result", async () => {
  setup();
  fakeSource([liveRow({ it: 1, onHand: 4, usage30: 45, usage90: 120 }), liveRow({ it: 2, onHand: 50 })]);

  const queued = await requestFullScan({ actor: "ann", triggerType: "MANUAL_FULL", background: false });
  assert.equal(queued.created, true);
  const manual = (await getLatestScanStatus());
  assert.equal(manual.triggerType, "MANUAL_FULL");
  assert.equal((await listRequests({ status: "PROCESSED" })).length, 1);

  store.resetMemory();
  await enqueueRecalculation({ eventType: "SCHEDULED_FULL", actor: "scheduler" });
  await processPendingRequests({ actor: "scheduler" });
  const scheduled = await getLatestScanStatus();
  assert.equal(scheduled.triggerType, "SCHEDULED_FULL");
  assert.deepEqual(scheduled.summary.queueCounts, manual.summary.queueCounts);
});

test("a full-scan request is reused while one is already waiting, and only one worker drains the queue at a time", async () => {
  setup();
  fakeSource([liveRow({ it: 1, onHand: 4, usage30: 45, usage90: 120 })]);
  const a = await enqueueRecalculation({ eventType: "MANUAL_FULL", actor: "ann" });
  const b = await enqueueRecalculation({ eventType: "SCHEDULED_FULL", actor: "scheduler" });
  assert.equal(b.created, false);
  assert.equal(b.request.requestId, a.request.requestId);

  const first = processPendingRequests({});
  const second = processPendingRequests({});
  assert.strictEqual(first, second);
  await first;
});

test("a worker that dies mid-scan does not strand its requests", async () => {
  setup();
  fakeSource([liveRow({ it: 1, onHand: 4, usage30: 45, usage90: 120 })]);
  const { request } = await enqueueRecalculation({ eventType: "MANUAL_FULL", actor: "ann" });
  const stored = store.mem.requests.get(request.requestId);
  stored.status = "RUNNING";
  stored.claimedAt = new Date(Date.now() - 45 * 60000).toISOString();

  const scans = await processPendingRequests({});
  assert.equal(scans.length, 1);
  assert.equal(store.mem.requests.get(request.requestId).status, "PROCESSED");
  assert.equal(store.mem.requests.get(request.requestId).attempts, 1);
});

test("confidence is stored with history, and a new row is written only when it changes", async () => {
  setup();
  fakeSource([liveRow({ it: 1, onHand: 4, usage30: 45, usage90: 120 })]);
  await runInventoryScan({});
  await runInventoryScan({});
  const id = "1:1:1:1:1:1";
  assert.equal((await listConfidenceHistory(id)).length, 1, "an unchanged picture is not re-recorded");

  fakeSource([liveRow({ it: 1, onHand: 4, usage30: 45, usage90: 120, supplierNum: null })]);
  await runInventoryScan({});
  const history = await listConfidenceHistory(id);
  assert.equal(history.length, 2);
  assert.equal(history[0].isCurrent, true);
  assert.equal(history[1].isCurrent, false);
  assert.equal(history[0].supplierMappingQuality, "UNMAPPED");
});

/* ═════════════════════ 11. SHELF COUNTS ═════════════════════ */

test("recording a count completes the count task, keeps the variance, and queues one stock-adjustment recalculation", async () => {
  setup();
  await runInventoryScan({ useFixtures: true });
  const rec = (await recs.listRecommendations({ queue: "SHELF_CHECK" })).items[0];
  await tasks.assignShelfCount({ itemId: rec.itemId, recommendationId: rec.recommendationId, assignee: "clerk", actor: "manager" });

  await assert.rejects(recordStockCount({ itemId: rec.itemId, taskId: rec.linkedTaskId, countedQuantity: -1, actor: "clerk" }), (e) => e.statusCode === 400);
  await assert.rejects(recordStockCount({ itemId: "other:1", taskId: rec.linkedTaskId, countedQuantity: 3, actor: "clerk" }), (e) => e.statusCode === 400);

  const count = await recordStockCount({ itemId: rec.itemId, taskId: rec.linkedTaskId, countedQuantity: 3, note: "behind the counter", actor: "clerk" });
  assert.equal(count.systemQuantity, -2);
  assert.equal(count.variance, 5);
  assert.equal((await tasks.getTask(rec.linkedTaskId)).status, "COMPLETED");
  assert.equal((await listRequests({ status: "PENDING" })).filter((r) => r.eventType === "EVENT_STOCK_ADJUSTMENT").length, 1);
  assert.equal((await getLatestCounts()).get(rec.itemId).countedQuantity, 3);
  await assert.rejects(recordStockCount({ itemId: rec.itemId, taskId: rec.linkedTaskId, countedQuantity: 3, actor: "clerk" }), (e) => e.code === "ALREADY_RECORDED");
  assert.equal((await listRequests({})).filter((r) => r.eventType === "EVENT_STOCK_ADJUSTMENT").length, 1, "the rejected repeat queued nothing");
});

test("after a count the engine stops asking for one and flags the source record instead", async () => {
  setup();
  await runInventoryScan({ useFixtures: true });
  const rec = (await recs.listRecommendations({ queue: "SHELF_CHECK" })).items[0];
  await recordStockCount({ itemId: rec.itemId, taskId: rec.linkedTaskId, countedQuantity: 3, actor: "clerk" });

  await processPendingRequests({ useFixtures: true });
  const now = await recs.getLatestRecommendationForItem(rec.itemId);
  assert.equal(now.recommendationType, "DATA_REVIEW");
  assert.ok(now.evidence.confidenceSignals.some((s) => s.code === "SOURCE_NEGATIVE_AFTER_COUNT"));
  assert.equal((await tasks.getTask(now.linkedTaskId)).taskType, "CORRECT_ITEM_DATA");
  assert.equal((await tasks.getTask(rec.linkedTaskId)).status, "COMPLETED", "the finished count task stays finished");
  assert.equal(now.evidence.provenance.lastVerifiedCount.countedQuantity, 3);
});

/* ═════════════════════ 12. DRAFT PURCHASE ORDER ═════════════════════ */

test("a draft PO reads only approved settings: a pending recommendation produces no line", async () => {
  setup();
  await runInventoryScan({ useFixtures: true });
  assert.equal((await recs.listRecommendations({ queue: "ORDER_MORE" })).total, 1, "an order-more recommendation is pending");

  const draft = await generateDraftPoPreview({ useFixtures: true, actor: "ann" });
  assert.equal(draft.totalLines, 0);
  assert.equal(draft.approvedSettingsCount, 0);
});

test("a draft PO line follows the approved setting, with its lineage, and is stable across repeats", async () => {
  setup();
  await runInventoryScan({ useFixtures: true });
  const rec = (await recs.listRecommendations({ queue: "ORDER_MORE" })).items[0];
  const approved = await recs.editAndApproveRecommendation({
    recommendationId: rec.recommendationId, orderPoint: 30, reorderQuantity: 40, minOrderQty: 12, packMultiple: 12, reason: "Case pack", actor: "ann"
  });

  const draft = await generateDraftPoPreview({ useFixtures: true, actor: "ann" });
  assert.equal(draft.totalLines, 1);
  const line = draft.lines[0];
  assert.equal(line.itemId, rec.itemId);
  assert.equal(line.quantity % 12, 0, "MOQ and pack multiple apply");
  assert.equal(line.quantity, 48); // max(40, 30 - 4 = 26) = 40 -> next multiple of 12
  assert.equal(line.currentOnHand, 4, "stock is the live figure, not a setting");
  assert.equal(line.lineage.version, 1);
  assert.equal(line.lineage.approvedBy, "ann");
  assert.equal(line.lineage.settingId, approved.setting.settingId);
  assert.equal(line.lineage.approvedRecommendationId, approved.recommendation.recommendationId);
  assert.equal(line.lineage.approvedTaskId, rec.linkedTaskId);
  assert.equal(line.extendedCost, Number((48 * 12.5).toFixed(2)));
  assert.match(draft.disclaimer, /Nothing is sent to a supplier/);

  const again = await generateDraftPoPreview({ useFixtures: true, actor: "ann" });
  assert.deepEqual(again.lines.map((l) => l.lineId), draft.lines.map((l) => l.lineId), "the same setting yields the same line, never a duplicate");
  assert.equal(again.totalLines, 1);
});

test("an item covered by its stock and open PO gets no line; an item with no live evidence is not guessed at", async () => {
  setup();
  await store.withTransaction((tx) => writeApprovedSetting({ ...SETTING_BASE, itemId: "1:1:1:1:1:102", orderPoint: 20, reorderQuantity: 30, recommendationId: "ra", expectedVersion: null, tx }));
  await store.withTransaction((tx) => writeApprovedSetting({ ...SETTING_BASE, itemId: "9:9:9:9:9:9", orderPoint: 20, reorderQuantity: 30, recommendationId: "rb", expectedVersion: null, tx }));

  const draft = await generateDraftPoPreview({ useFixtures: true });
  assert.equal(draft.totalLines, 0, "102 has 6 on hand and 50 on PO, above its order point of 20");
  assert.deepEqual(draft.notEvaluated.map((n) => n.itemId), ["9:9:9:9:9:9"]);
});

test("a draft PO cannot be built from guesses when the source is down", async () => {
  setup();
  brokenSource();
  await assert.rejects(generateDraftPoPreview({ actor: "ann" }), (e) => e.code === "SOURCE_UNAVAILABLE");
});

/* ═════════════════════ 13. IDEMPOTENCY AND AUDIT ═════════════════════ */

test("a repeated request key runs once, replays the first result, and tags the audit trail with the key", async () => {
  setup();
  let runs = 0;
  const fn = async () => { runs += 1; await recordInventoryAudit({ actor: "ann", action: "DEMO", entityType: "T", entityId: "1" }); return { ok: true, n: runs }; };

  const first = await runIdempotent({ key: "key-abcdef-1", operation: "demo", actor: "ann", fn });
  const second = await runIdempotent({ key: "key-abcdef-1", operation: "demo", actor: "ann", fn });
  assert.equal(runs, 1);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.result, first.result);
  assert.equal(store.mem.audit[0].correlationId, "key-abcdef-1");

  await assert.rejects(runIdempotent({ key: "key-abcdef-1", operation: "other", actor: "ann", fn }), (e) => e.code === "IDEMPOTENCY_KEY_REUSED");
  await assert.rejects(runIdempotent({ key: "short", operation: "demo", actor: "ann", fn }), (e) => e.statusCode === 400);
});

test("a failed request releases its key so it can be retried", async () => {
  setup();
  let attempt = 0;
  const fn = async () => { attempt += 1; if (attempt === 1) throw new Error("transient"); return { ok: true }; };
  await assert.rejects(runIdempotent({ key: "key-retry-001", operation: "demo", actor: "ann", fn }), /transient/);
  const retry = await runIdempotent({ key: "key-retry-001", operation: "demo", actor: "ann", fn });
  assert.equal(retry.replayed, false);
  assert.equal(attempt, 2);
});

test("every material transition leaves a complete audit record", async () => {
  setup();
  fakeSource([
    liveRow({ it: 1, onHand: 4, usage30: 45, usage90: 120 }),
    liveRow({ it: 2, onHand: -3, usage30: 10, usage90: 30 }),
    liveRow({ it: 3, onHand: 50 })
  ]);
  await runInventoryScan({ actor: "scanner" });

  const order = (await recs.listRecommendations({ queue: "ORDER_MORE" })).items[0];
  const shelf = (await recs.listRecommendations({ queue: "SHELF_CHECK" })).items[0];
  const writeOff = (await recs.listRecommendations({ queue: "WRITE_OFF_REVIEW" })).items[0];

  await runWithAuditContext({ correlationId: "req-approve-0001" }, () => recs.editAndApproveRecommendation({
    recommendationId: order.recommendationId, orderPoint: 33, reason: "tuned", actor: "ann"
  }));
  await recs.rejectRecommendation({ recommendationId: writeOff.recommendationId, reason: "keep", actor: "ann" });
  await tasks.assignShelfCount({ itemId: shelf.itemId, recommendationId: shelf.recommendationId, assignee: "clerk", actor: "manager" });
  await recordStockCount({ itemId: shelf.itemId, taskId: shelf.linkedTaskId, countedQuantity: 1, actor: "clerk" });
  await generateDraftPoPreview({ actor: "ann" });

  const seen = new Set((await listInventoryAudit({ limit: 500 })).map((a) => a.action));
  for (const action of [
    "SCAN_STARTED", "SCAN_COMPLETED", "RECOMMENDATION_GENERATED", "TASK_CREATED", "RECOMMENDATION_EDITED", "RECOMMENDATION_EDIT_APPROVED",
    "SETTINGS_WRITTEN", "TASK_STATUS_CHANGE", "RECOMMENDATION_REJECTED", "TASK_ASSIGNED", "STOCK_COUNT_RECORDED",
    "RECALCULATION_REQUESTED", "DRAFT_PO_GENERATED"
  ]) assert.ok(seen.has(action), `${action} is audited`);

  for (const entry of store.mem.audit) {
    assert.ok(entry.actor && entry.action && entry.entityType && entry.entityId && entry.createdAt, `${entry.action} is complete`);
  }

  const approval = (await listInventoryAudit({ action: "SETTINGS_WRITTEN" }))[0];
  assert.equal(approval.correlationId, "req-approve-0001", "the request's correlation id reaches the settings write");
  assert.equal(approval.afterState.orderPoint, 33);
  assert.equal(approval.beforeState, null);
  assert.equal(approval.actor, "ann");
  assert.ok(approval.reason);

  const scanAudit = await listInventoryAudit({ action: "SCAN_COMPLETED" });
  assert.ok(scanAudit[0].scanRunId);
  assert.equal(scanAudit[0].correlationId, scanAudit[0].scanRunId);
});

test("the audit API can only add and read; the database also refuses to change or delete rows", () => {
  const audit = require("../lib/inventory/audit-service");
  assert.deepEqual(Object.keys(audit).sort(), ["clearFallbackAuditLog", "currentAuditContext", "listInventoryAudit", "recordInventoryAudit", "runWithAuditContext"]);

  const sqlText = fs.readFileSync(path.join(ROOT, "database", "053-inventory-intelligence.sql"), "utf8");
  for (const table of ["audit_events", "task_history", "stock_count_results"]) {
    assert.match(sqlText, new RegExp(`ON inventory\\.${table}\\s+INSTEAD OF UPDATE, DELETE`), `${table} is append-only in the database`);
  }
  for (const source of ["audit-service.js", "task-service.js"]) {
    const text = fs.readFileSync(path.join(ROOT, "lib", "inventory", source), "utf8");
    assert.doesNotMatch(text, /(UPDATE|DELETE FROM)\s+inventory\.(audit_events|task_history)/, `${source} never changes history`);
  }
});

/* ═════════════════════ 14. DASHBOARD CARDS ═════════════════════ */

test("before any scan the cards say 'unavailable', never 'no work'", async () => {
  setup();
  const summary = await getCockpitSummary();
  assert.equal(summary.dataStatus, "never_scanned");
  assert.equal(summary.cards.length, 6);
  assert.ok(summary.cards.every((c) => c.status === "unavailable" && c.priority === "NONE"));
  assert.match(summary.message, /No scan has completed/);
});

test("after a scan the six cards show counts, priority and value-at-risk context, and distinguish no-work", async () => {
  setup();
  await runInventoryScan({ useFixtures: true });
  const summary = await getCockpitSummary();
  const card = Object.fromEntries(summary.cards.map((c) => [c.cardKey, c]));

  assert.deepEqual(summary.cards.map((c) => c.cardKey), ["ORDER_MORE", "ORDER_LESS", "WRITE_OFF_REVIEW", "SHELF_CHECK", "PENDING_APPROVAL", "ALREADY_COVERED_BY_PO"]);
  assert.equal(card.ORDER_MORE.count, 1);
  assert.equal(card.ORDER_MORE.status, "ready");
  assert.ok(["CRITICAL", "HIGH"].includes(card.ORDER_MORE.priority));
  assert.match(card.ORDER_MORE.unitCost === undefined ? card.ORDER_MORE.unitContext : card.ORDER_MORE.unitContext, /units short \(\$/);
  assert.equal(card.ORDER_LESS.count, 0);
  assert.equal(card.ORDER_LESS.status, "no_work");
  assert.equal(card.WRITE_OFF_REVIEW.count, 2);
  assert.ok(card.WRITE_OFF_REVIEW.valueAtRisk > 0);
  assert.equal(card.SHELF_CHECK.count, 1);
  assert.equal(card.PENDING_APPROVAL.count, 1);
  assert.equal(card.ALREADY_COVERED_BY_PO.count, 1);
  assert.equal(summary.dataStatus, "ok");
  assert.ok(summary.dataScan.completedAt);

  // A decided recommendation leaves the pending count.
  const rec = (await recs.listRecommendations({ queue: "ORDER_MORE" })).items[0];
  await recs.approveRecommendation({ recommendationId: rec.recommendationId, actor: "ann" });
  const after = Object.fromEntries((await getCockpitSummary()).cards.map((c) => [c.cardKey, c]));
  assert.equal(after.PENDING_APPROVAL.count, 0);
  assert.equal(after.ORDER_MORE.count, 0);
});

/* ═════════════════════ 15. NO WRITE PATH TO SOURCE SYSTEMS ═════════════════════ */

test("no code in lib/inventory can write to LensItem, Innovations, PSQL or a supplier system", () => {
  const dir = path.join(ROOT, "lib", "inventory");
  const writeStatement = /\b(INSERT INTO|UPDATE|DELETE FROM|MERGE(?: INTO)?|TRUNCATE TABLE|ALTER TABLE|DROP TABLE)\s+([\w.[\]]+)/g;

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    assert.doesNotMatch(text, /getSourceWritePool|privileged-data-access|sourceWrite|OPTILENS_WRITEBACK|LensItem\s+SET/i, `${file} has no source-write access`);
    for (const match of text.matchAll(writeStatement)) {
      assert.match(match[2], /^(inventory\.|next$)/, `${file}: write to ${match[2]} is outside the app-owned inventory schema`);
    }
  }

  const adapter = fs.readFileSync(path.join(dir, "source-adapter.js"), "utf8");
  assert.match(adapter, /getLiveSourcePool/);
  assert.doesNotMatch(adapter, /getAppPool|\.batch\(|execute\(/);
});

test("the migration creates every table the build task requires, with the guards that make duplicates impossible", () => {
  const sqlText = fs.readFileSync(path.join(ROOT, "database", "053-inventory-intelligence.sql"), "utf8");
  for (const table of ["scan_runs", "item_replenishment_settings", "confidence", "replenishment_recommendations", "operational_tasks", "task_history", "audit_events", "recalculation_requests", "stock_count_results", "idempotency_keys"]) {
    assert.match(sqlText, new RegExp(`CREATE TABLE inventory\\.${table}\\b`), table);
  }
  assert.match(sqlText, /UQ_inv_task_active[\s\S]*WHERE status IN \(N'OPEN', N'ASSIGNED', N'IN_PROGRESS', N'PENDING_APPROVAL', N'BLOCKED'\)/, "one unresolved task per item and purpose");
  assert.match(sqlText, /UQ_inv_settings_active[\s\S]*WHERE effective_to IS NULL/, "one effective settings row per item");
  assert.match(sqlText, /UQ_inv_rec_item_revision/);
  assert.match(sqlText, /UQ_inv_rec_one_undecided/);
  assert.match(sqlText, /UQ_inv_rec_idempotency/);
  assert.doesNotMatch(sqlText, /\bdbo\.LensItem\b/i, "the migration never touches the source table");

  const migrations = fs.readFileSync(path.join(ROOT, "lib", "migrations.js"), "utf8");
  assert.ok(migrations.indexOf("052-email-signatures.sql") < migrations.indexOf("053-inventory-intelligence.sql"));
});
