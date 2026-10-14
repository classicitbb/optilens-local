/**
 * Inventory Intelligence scan runner.
 *
 * A scan reads source evidence (read-only), runs the deterministic engine per
 * item, and persists the result through the recommendation/task services. Every
 * scan is a row in inventory.scan_runs with its trigger, source watermarks,
 * policy version, per-action counts and errors, so any recommendation can be
 * traced to the run and the evidence that produced it.
 *
 * Scans are driven by the durable request queue (events.js): a worker claims
 * pending requests in bounded batches and runs one scan per batch. A source
 * outage fails the scan visibly and changes nothing; it never falls back to
 * synthetic data.
 */

const { randomUUID } = require("node:crypto");
const sql = require("mssql");
const store = require("./store");
const { loadInventoryEvidence } = require("./source-adapter");
const { listActiveSettings } = require("./settings-service");
const { evaluateConfidence } = require("./confidence");
const { calculateItemReplenishment } = require("./calculator");
const { loadPolicy } = require("./policy");
const { syncRecommendation, listActiveRecommendationItemIds } = require("./recommendations-service");
const { loadCurrentSignatures, saveConfidence } = require("./confidence-store");
const { getLatestCounts } = require("./count-service");
const { recordInventoryAudit, runWithAuditContext } = require("./audit-service");
const { enqueueRecalculation, claimRequests, finishRequests, FULL_SCAN_TYPES } = require("./events");
const { toSafeError } = require("./errors");

const QUEUES = ["ORDER_MORE", "ORDER_LESS", "WRITE_OFF_REVIEW", "SHELF_CHECK", "ALREADY_COVERED_BY_PO", "DATA_REVIEW"];
const DAY_MS = 86400000;

/* ─────────── scan records ─────────── */

async function insertScan(scan) {
  if (store.isTestMode()) {
    store.mem.scans.set(scan.scanRunId, { ...scan });
    return;
  }
  const req = await store.request();
  await req
    .input("scan_run_id", sql.UniqueIdentifier, scan.scanRunId)
    .input("trigger_type", sql.NVarChar(60), scan.triggerType)
    .input("status", sql.NVarChar(40), "RUNNING")
    .input("source_watermarks_json", sql.NVarChar(sql.MAX), scan.sourceWatermarksJson)
    .input("started_at", sql.DateTime2, new Date(scan.startedAt))
    .query(`
      INSERT INTO inventory.scan_runs (scan_run_id, trigger_type, status, source_watermarks_json, started_at)
      VALUES (@scan_run_id, @trigger_type, @status, @source_watermarks_json, @started_at);
    `);
}

async function finishScan(scan) {
  if (store.isTestMode()) {
    store.mem.scans.set(scan.scanRunId, { ...scan });
    return;
  }
  const req = await store.request();
  await req
    .input("scan_run_id", sql.UniqueIdentifier, scan.scanRunId)
    .input("status", sql.NVarChar(40), scan.status)
    .input("source_watermarks_json", sql.NVarChar(sql.MAX), scan.sourceWatermarksJson)
    .input("items_evaluated", sql.Int, scan.itemsEvaluated)
    .input("recommendations_created", sql.Int, scan.recommendationsCreated)
    .input("recommendations_superseded", sql.Int, scan.recommendationsSuperseded)
    .input("tasks_created", sql.Int, scan.tasksCreated)
    .input("tasks_updated", sql.Int, scan.tasksUpdated)
    .input("summary_json", sql.NVarChar(sql.MAX), scan.summaryJson)
    .input("errors_json", sql.NVarChar(sql.MAX), scan.errorsJson)
    .input("completed_at", sql.DateTime2, new Date(scan.completedAt))
    .query(`
      UPDATE inventory.scan_runs
      SET status = @status, source_watermarks_json = @source_watermarks_json,
          items_evaluated = @items_evaluated, recommendations_created = @recommendations_created,
          recommendations_superseded = @recommendations_superseded, tasks_created = @tasks_created,
          tasks_updated = @tasks_updated, summary_json = @summary_json, errors_json = @errors_json,
          completed_at = @completed_at
      WHERE scan_run_id = @scan_run_id;
    `);
}

function formatScan(row) {
  if (!row) return null;
  return {
    scanRunId: row.scanRunId,
    triggerType: row.triggerType,
    status: row.status,
    itemsEvaluated: row.itemsEvaluated,
    recommendationsCreated: row.recommendationsCreated,
    recommendationsSuperseded: row.recommendationsSuperseded,
    tasksCreated: row.tasksCreated,
    tasksUpdated: row.tasksUpdated,
    sourceWatermarks: store.parseJson(row.sourceWatermarksJson),
    summary: store.parseJson(row.summaryJson),
    errors: store.parseJson(row.errorsJson, []),
    startedAt: store.toIso(row.startedAt),
    completedAt: store.toIso(row.completedAt)
  };
}

const SCAN_COLUMNS = `
  scan_run_id AS scanRunId, trigger_type AS triggerType, status,
  source_watermarks_json AS sourceWatermarksJson,
  items_evaluated AS itemsEvaluated, recommendations_created AS recommendationsCreated,
  recommendations_superseded AS recommendationsSuperseded, tasks_created AS tasksCreated,
  tasks_updated AS tasksUpdated, summary_json AS summaryJson, errors_json AS errorsJson,
  started_at AS startedAt, completed_at AS completedAt`;

async function getLatestScanStatus() {
  if (store.isTestMode()) {
    const all = Array.from(store.mem.scans.values()).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return formatScan(all[0]);
  }
  const req = await store.request();
  const result = await req.query(`SELECT TOP 1 ${SCAN_COLUMNS} FROM inventory.scan_runs ORDER BY started_at DESC;`);
  return formatScan(result.recordset[0]);
}

/** The latest scan that finished successfully (the one the queues reflect). */
async function getLatestCompletedScan() {
  if (store.isTestMode()) {
    const all = Array.from(store.mem.scans.values())
      .filter((s) => s.status === "COMPLETED" || s.status === "COMPLETED_WITH_ERRORS")
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return formatScan(all[0]);
  }
  const req = await store.request();
  const result = await req.query(`
    SELECT TOP 1 ${SCAN_COLUMNS} FROM inventory.scan_runs
    WHERE status IN (N'COMPLETED', N'COMPLETED_WITH_ERRORS') ORDER BY started_at DESC;
  `);
  return formatScan(result.recordset[0]);
}

async function listScanRuns(limit = 20) {
  const take = Math.max(1, Math.min(100, Number(limit) || 20));
  if (store.isTestMode()) {
    return Array.from(store.mem.scans.values()).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, take).map(formatScan);
  }
  const req = await store.request();
  const result = await req.input("take", sql.Int, take).query(`SELECT TOP (@take) ${SCAN_COLUMNS} FROM inventory.scan_runs ORDER BY started_at DESC;`);
  return result.recordset.map(formatScan);
}

/* ─────────── the scan ─────────── */

/**
 * Runs one scan. `itemIds` limits it to those items (a targeted recalculation);
 * without it every item in the source universe is evaluated.
 * Never throws for source or per-item problems; the returned status says what happened.
 */
async function runInventoryScan(options = {}) {
  const triggerType = options.triggerType || "MANUAL_FULL";
  const actor = options.actor || "system";
  const itemIds = options.itemIds && options.itemIds.length ? Array.from(new Set(options.itemIds)) : null;
  const scanRunId = randomUUID();
  const startedAt = new Date().toISOString();

  const scan = {
    scanRunId, triggerType, status: "RUNNING",
    sourceWatermarksJson: JSON.stringify({ requestedAt: startedAt, scope: itemIds ? "ITEMS" : "FULL", itemCount: itemIds ? itemIds.length : null, requestIds: options.requestIds || [] }),
    itemsEvaluated: 0, recommendationsCreated: 0, recommendationsSuperseded: 0, tasksCreated: 0, tasksUpdated: 0,
    summaryJson: null, errorsJson: null, startedAt, completedAt: null
  };

  return runWithAuditContext({ correlationId: scanRunId, actor }, async () => {
    await insertScan(scan);
    await recordInventoryAudit({
      scanRunId, actor, action: "SCAN_STARTED", entityType: "ScanRun", entityId: scanRunId,
      afterState: { triggerType, scope: itemIds ? "ITEMS" : "FULL" }, reason: `Scan started (${triggerType})`
    });

    const errors = [];
    const actions = { CREATED: 0, REVISED: 0, REFRESHED: 0, UNCHANGED: 0, SUPPRESSED: 0, RETIRED: 0, NONE: 0 };
    const queueCounts = Object.fromEntries(QUEUES.map((q) => [q, 0]));
    let policy = null;
    let evidenceInfo = null;
    let tasksCreated = 0;

    try {
      policy = await loadPolicy(options.policyOverrides || {});
      evidenceInfo = await loadInventoryEvidence({ itemIds, useFixtures: options.useFixtures, limit: options.limit });

      const [settingsMap, counts, signatures] = await Promise.all([
        listActiveSettings(), getLatestCounts(), loadCurrentSignatures()
      ]);
      const nowMs = Date.now();
      const seen = new Set();

      for (const item of evidenceInfo.items) {
        seen.add(item.itemId);
        scan.itemsEvaluated += 1;
        try {
          const settings = settingsMap.get(item.itemId) || null;
          const count = counts.get(item.itemId) || null;
          const stockFreshnessDays = count ? Math.max(0, Math.floor((nowMs - new Date(count.countedAt).getTime()) / DAY_MS)) : item.stockFreshnessDays;
          const lastVerifiedCountDate = count ? count.countedAt : item.lastVerifiedCountDate;

          const confidence = evaluateConfidence({
            onHand: item.onHand, stockFreshnessDays, lastVerifiedCountDate,
            usage30: item.usage30, usage90: item.usage90, openPoQuantity: item.openPoQuantity,
            poComplete: item.poComplete, poFreshnessDays: item.poFreshnessDays,
            supplierId: item.supplierId, supplierMappingQuality: item.supplierMappingQuality, settings
          }, { confidenceThreshold: policy.confidenceThreshold });

          const calculation = calculateItemReplenishment({
            itemId: item.itemId, sku: item.sku, itemLabel: item.itemLabel,
            supplierId: item.supplierId, supplierName: item.supplierName,
            onHand: item.onHand, openPoQuantity: item.openPoQuantity,
            usage30: item.usage30, usage90: item.usage90, unitCost: item.unitCost,
            settings, confidence, policyOverrides: policy,
            provenance: {
              system: evidenceInfo.source.system,
              evidenceAsOf: item.asOf || evidenceInfo.asOf,
              lastMoved: item.lastMoved,
              lastVerifiedCount: count ? { countedAt: count.countedAt, countedQuantity: count.countedQuantity, systemQuantity: count.systemQuantity } : null,
              approvedSettingsVersion: settings ? settings.version : null,
              policyVersion: policy.policyVersion
            }
          });
          calculation.policyVersion = policy.policyVersion;
          if (calculation.recommendationType) queueCounts[calculation.recommendationType] += 1;

          const outcome = await store.withTransaction(async (tx) => {
            const result = await syncRecommendation({
              calculation, itemKind: item.itemKind || "lens", scanRunId,
              suppressionDays: policy.decidedSuppressionDays || 30, actor, tx
            });
            await saveConfidence({ itemId: item.itemId, supplierId: item.supplierId, confidence, knownSignatures: signatures, tx });
            return result;
          });
          actions[outcome.action] = (actions[outcome.action] || 0) + 1;
          if (outcome.taskCreated) tasksCreated += 1;
        } catch (itemError) {
          const safe = toSafeError(itemError);
          errors.push({ itemId: item.itemId, code: safe.code, message: safe.message });
        }
      }

      // Items that left the source universe (no stock, no PO, no movement) no longer need action.
      const complete = itemIds ? true : !evidenceInfo.truncated;
      if (complete) {
        const scope = itemIds || (await listActiveRecommendationItemIds());
        for (const itemId of scope) {
          if (seen.has(itemId)) continue;
          try {
            const outcome = await store.withTransaction((tx) => syncRecommendation({
              calculation: { itemId, recommendationType: null }, scanRunId, actor, tx
            }));
            actions[outcome.action] = (actions[outcome.action] || 0) + 1;
          } catch (retireError) {
            const safe = toSafeError(retireError);
            errors.push({ itemId, code: safe.code, message: safe.message });
          }
        }
      }

      scan.status = errors.length ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
    } catch (scanError) {
      const safe = toSafeError(scanError);
      errors.push({ itemId: null, code: safe.code, message: safe.message });
      scan.status = "FAILED";
    }

    scan.recommendationsCreated = actions.CREATED + actions.REVISED;
    scan.recommendationsSuperseded = actions.REVISED + actions.RETIRED;
    scan.tasksCreated = tasksCreated;
    scan.tasksUpdated = actions.REFRESHED;
    scan.completedAt = new Date().toISOString();
    scan.sourceWatermarksJson = JSON.stringify({
      ...store.parseJson(scan.sourceWatermarksJson, {}),
      evidenceAsOf: evidenceInfo ? evidenceInfo.asOf : null,
      sourceRows: evidenceInfo ? evidenceInfo.items.length : null,
      truncated: evidenceInfo ? evidenceInfo.truncated : null,
      policyVersion: policy ? policy.policyVersion : null,
      policyInvalidKeys: policy ? policy.invalidKeys : null,
      calculationVersion: policy ? policy.calculationVersion : null
    });
    scan.summaryJson = JSON.stringify({
      queueCounts, actions, totalEvaluated: scan.itemsEvaluated, errorCount: errors.length,
      sourceCaveats: evidenceInfo ? evidenceInfo.source.caveats : null
    });
    scan.errorsJson = errors.length ? JSON.stringify(errors.slice(0, 100)) : null;
    await finishScan(scan);

    await recordInventoryAudit({
      scanRunId, actor, action: scan.status === "FAILED" ? "SCAN_FAILED" : "SCAN_COMPLETED",
      entityType: "ScanRun", entityId: scanRunId,
      afterState: { status: scan.status, itemsEvaluated: scan.itemsEvaluated, actions, errorCount: errors.length },
      reason: scan.status === "FAILED" ? (errors[0] ? errors[0].message : "Scan failed") : `Scan finished: ${scan.itemsEvaluated} items evaluated`
    });

    return formatScan(scan);
  });
}

/* ─────────── request queue worker ─────────── */

let inFlight = null;

/**
 * Drains the recalculation request queue in bounded batches. Only one drain runs
 * per process at a time; a second caller gets the running one's promise.
 */
function processPendingRequests({ actor = "system", maxBatches = 10, useFixtures = false } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const scans = [];
    try {
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const claimed = await claimRequests({ limit: 200 });
        if (!claimed.length) break;

        const fullRequest = claimed.find((r) => FULL_SCAN_TYPES.has(r.eventType));
        const itemIds = fullRequest ? null : Array.from(new Set(claimed.map((r) => r.itemId).filter(Boolean)));
        const types = new Set(claimed.map((r) => r.eventType));
        const triggerType = fullRequest ? fullRequest.eventType : (types.size === 1 ? Array.from(types)[0] : "EVENT_BATCH");

        const scan = await runInventoryScan({
          triggerType, actor, itemIds, useFixtures,
          requestIds: claimed.map((r) => r.requestId)
        });
        scans.push(scan);
        await finishRequests(claimed.map((r) => r.requestId), {
          status: scan.status === "FAILED" ? "FAILED" : "PROCESSED",
          scanRunId: scan.scanRunId,
          error: scan.status === "FAILED" && scan.errors[0] ? scan.errors[0].message : null
        });
        if (fullRequest) break;
      }
    } finally {
      inFlight = null;
    }
    return scans;
  })();
  return inFlight;
}

let autoDrain = true;
let drainTimer = null;

/** Tests turn the background drain off and call processPendingRequests() themselves. */
function setAutoDrain(enabled) {
  autoDrain = Boolean(enabled);
  if (!autoDrain) clearTimeout(drainTimer);
}

/**
 * Drains the queue shortly after a decision or a count queued something, so the
 * affected item is re-evaluated without waiting for the next scheduled scan. The
 * short delay lets a burst of approvals collapse into one batch.
 */
function scheduleDrain({ actor = "system", delayMs = 2000 } = {}) {
  if (!autoDrain) return;
  clearTimeout(drainTimer);
  drainTimer = setTimeout(() => {
    processPendingRequests({ actor }).catch((error) => { toSafeError(error); });
  }, delayMs);
  if (drainTimer.unref) drainTimer.unref();
}

/**
 * Queues a full scan and starts draining the queue in the background. Returns
 * immediately; the UI watches scan status.
 */
async function requestFullScan({ actor = "system", triggerType = "MANUAL_FULL", background = true } = {}) {
  const { request, created } = await enqueueRecalculation({ eventType: triggerType, actor });
  const running = processPendingRequests({ actor });
  if (!background) await running;
  else running.catch((error) => { toSafeError(error); });
  return { request, created, started: true };
}

/**
 * Queues a recalculation for one item (usage, stock adjustment, PO or settings
 * event). `sourceRef` makes replays of the same source event harmless.
 */
async function triggerRecalculationEvent(eventType, payload = {}, actor = "system") {
  const { request, created } = await enqueueRecalculation({
    eventType, itemId: payload.itemId || null, sourceRef: payload.sourceRef || null, payload, actor
  });
  const running = processPendingRequests({ actor });
  running.catch((error) => { toSafeError(error); });
  return { request, created };
}

function clearFallbackScans() {
  store.mem.scans.clear();
}

module.exports = {
  runInventoryScan,
  processPendingRequests,
  requestFullScan,
  triggerRecalculationEvent,
  scheduleDrain,
  setAutoDrain,
  getLatestScanStatus,
  getLatestCompletedScan,
  listScanRuns,
  clearFallbackScans
};
