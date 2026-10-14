/**
 * Replenishment recommendations: versioned, deterministic, never overwritten once decided.
 *
 * Lifecycle
 *   ORDER_MORE / ORDER_LESS   -> PENDING_APPROVAL -> APPROVED | REJECTED | SUPERSEDED
 *   WRITE_OFF / SHELF / DATA  -> OPEN             -> APPLIED (reviewed) | REJECTED (dismissed) | SUPERSEDED
 *   ALREADY_COVERED_BY_PO     -> OPEN (informational; no task, no decision)
 *
 * Only an approved ORDER_MORE / ORDER_LESS recommendation writes anything, and
 * what it writes is a new ItemReplenishmentSettings version in the app
 * database. Approval, the settings revision, the task transition and the audit
 * record are one transaction: they all commit or none do.
 *
 * A decided recommendation is never edited. A change in evidence that matters
 * creates a new revision linked through previous_recommendation_id.
 */

const { randomUUID } = require("node:crypto");
const sql = require("mssql");
const store = require("./store");
const { recordInventoryAudit } = require("./audit-service");
const { writeApprovedSetting, getActiveSetting, validateSettingValues } = require("./settings-service");
const { syncOperationalTask, updateTaskState, getTask, cancelObsoleteTasks, dueDateFor } = require("./task-service");
const { enqueueRecalculation } = require("./events");
const { SETTINGS_QUEUES } = require("./calculator");
const { badRequest, conflict, notFound } = require("./errors");

const RECOMMENDATION_TYPES = Object.freeze([
  "ORDER_MORE", "ORDER_LESS", "WRITE_OFF_REVIEW", "SHELF_CHECK", "ALREADY_COVERED_BY_PO", "DATA_REVIEW"
]);
const RECOMMENDATION_STATUSES = Object.freeze([
  "OPEN", "PENDING_APPROVAL", "APPROVED", "REJECTED", "SUPERSEDED", "APPLIED", "CANCELLED"
]);
const UNDECIDED = Object.freeze(["OPEN", "PENDING_APPROVAL"]);
const DECIDED = Object.freeze(["APPROVED", "REJECTED", "APPLIED"]);
const PRIORITY_RANK = Object.freeze({ CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 });

const REC_COLUMNS = `
  recommendation_id AS recommendationId,
  item_id AS itemId,
  item_kind AS itemKind,
  item_label AS itemLabel,
  sku,
  supplier_id AS supplierId,
  supplier_name AS supplierName,
  scan_run_id AS scanRunId,
  idempotency_key AS idempotencyKey,
  recommendation_type AS recommendationType,
  status,
  evidence_snapshot_json AS evidenceSnapshotJson,
  evidence_version AS evidenceVersion,
  proposed_settings_json AS proposedSettingsJson,
  calculation_version AS calculationVersion,
  policy_version AS policyVersion,
  confidence_score AS confidenceScore,
  confidence_level AS confidenceLevel,
  previous_recommendation_id AS previousRecommendationId,
  revision_number AS revisionNumber,
  before_settings_snapshot_json AS beforeSettingsSnapshotJson,
  approved_settings_snapshot_json AS approvedSettingsSnapshotJson,
  decision_reason AS decisionReason,
  decision_actor AS decisionActor,
  decision_at AS decisionAt,
  superseded_at AS supersededAt,
  superseded_by_id AS supersededById,
  linked_task_id AS linkedTaskId,
  created_at AS createdAt,
  updated_at AS updatedAt`;

/** camelCase field -> [column, mssql type] for the generic updater. */
const PATCHABLE = Object.freeze({
  status: ["status", sql.NVarChar(50)],
  evidenceSnapshotJson: ["evidence_snapshot_json", sql.NVarChar(sql.MAX)],
  evidenceVersion: ["evidence_version", sql.Int],
  confidenceScore: ["confidence_score", sql.Decimal(5, 2)],
  confidenceLevel: ["confidence_level", sql.NVarChar(20)],
  decisionReason: ["decision_reason", sql.NVarChar(500)],
  decisionActor: ["decision_actor", sql.NVarChar(120)],
  decisionAt: ["decision_at", sql.DateTime2],
  supersededAt: ["superseded_at", sql.DateTime2],
  supersededById: ["superseded_by_id", sql.UniqueIdentifier],
  linkedTaskId: ["linked_task_id", sql.UniqueIdentifier],
  approvedSettingsSnapshotJson: ["approved_settings_snapshot_json", sql.NVarChar(sql.MAX)],
  scanRunId: ["scan_run_id", sql.UniqueIdentifier],
  updatedAt: ["updated_at", sql.DateTime2]
});

const DATE_FIELDS = new Set(["decisionAt", "supersededAt", "updatedAt"]);

function formatRecommendationRow(row) {
  if (!row) return null;
  return {
    ...row,
    confidenceScore: row.confidenceScore == null ? null : Number(row.confidenceScore),
    decisionAt: store.toIso(row.decisionAt),
    supersededAt: store.toIso(row.supersededAt),
    createdAt: store.toIso(row.createdAt),
    updatedAt: store.toIso(row.updatedAt),
    evidence: store.parseJson(row.evidenceSnapshotJson, {}),
    proposedSettings: store.parseJson(row.proposedSettingsJson, {}),
    beforeSettings: store.parseJson(row.beforeSettingsSnapshotJson),
    approvedSettings: store.parseJson(row.approvedSettingsSnapshotJson)
  };
}

function isDuplicateKeyError(error) {
  return Boolean(error) && (error.number === 2601 || error.number === 2627);
}

/* ─────────── low-level persistence ─────────── */

async function getRecommendation(recommendationId, { tx = null, lock = false } = {}) {
  if (!recommendationId) return null;
  if (store.isTestMode()) {
    const r = store.mem.recommendations.get(recommendationId);
    return r ? formatRecommendationRow({ ...r }) : null;
  }
  const req = await store.request(tx);
  const result = await req
    .input("recommendation_id", sql.UniqueIdentifier, recommendationId)
    .query(`SELECT ${REC_COLUMNS} FROM inventory.replenishment_recommendations ${lock ? "WITH (UPDLOCK, HOLDLOCK)" : ""} WHERE recommendation_id = @recommendation_id;`);
  return formatRecommendationRow(result.recordset[0]);
}

/** The newest revision for an item, whatever its status. */
async function getLatestRecommendationForItem(itemId, { tx = null, lock = false } = {}) {
  if (store.isTestMode()) {
    let latest = null;
    for (const r of store.mem.recommendations.values()) {
      if (r.itemId === itemId && (!latest || r.revisionNumber > latest.revisionNumber)) latest = r;
    }
    return latest ? formatRecommendationRow({ ...latest }) : null;
  }
  const req = await store.request(tx);
  const result = await req
    .input("item_id", sql.NVarChar(100), itemId)
    .query(`
      SELECT TOP 1 ${REC_COLUMNS}
      FROM inventory.replenishment_recommendations ${lock ? "WITH (UPDLOCK, HOLDLOCK)" : ""}
      WHERE item_id = @item_id
      ORDER BY revision_number DESC, created_at DESC;
    `);
  return formatRecommendationRow(result.recordset[0]);
}

/**
 * Updates fields on a recommendation. When `onlyIfStatus` is given the update
 * applies only if the row is still in one of those statuses; the return value is
 * the number of rows changed, so callers can detect a lost race.
 */
async function patchRecommendation(recommendationId, fields, { tx = null, onlyIfStatus = null } = {}) {
  const patch = { ...fields, updatedAt: fields.updatedAt || new Date().toISOString() };

  if (store.isTestMode()) {
    const r = store.mem.recommendations.get(recommendationId);
    if (!r) return 0;
    if (onlyIfStatus && !onlyIfStatus.includes(r.status)) return 0;
    Object.assign(r, patch);
    return 1;
  }

  const req = await store.request(tx);
  req.input("recommendation_id", sql.UniqueIdentifier, recommendationId);
  const sets = [];
  for (const [field, value] of Object.entries(patch)) {
    const spec = PATCHABLE[field];
    if (!spec) throw new Error(`Recommendation field ${field} cannot be updated.`);
    const bound = DATE_FIELDS.has(field) && value ? new Date(value) : value;
    req.input(field, spec[1], bound);
    sets.push(`${spec[0]} = @${field}`);
  }
  let where = "recommendation_id = @recommendation_id";
  if (onlyIfStatus) {
    where += ` AND status IN (${onlyIfStatus.map((s) => `N'${s}'`).join(", ")})`;
  }
  const result = await req.query(`UPDATE inventory.replenishment_recommendations SET ${sets.join(", ")} WHERE ${where};`);
  return result.rowsAffected[0];
}

async function insertRecommendation(rec, { tx = null } = {}) {
  if (store.isTestMode()) {
    for (const r of store.mem.recommendations.values()) {
      if (r.idempotencyKey === rec.idempotencyKey) {
        const error = new Error("duplicate idempotency key");
        error.number = 2627;
        throw error;
      }
    }
    store.mem.recommendations.set(rec.recommendationId, { ...rec });
    return;
  }
  const req = await store.request(tx);
  await req
    .input("recommendation_id", sql.UniqueIdentifier, rec.recommendationId)
    .input("item_id", sql.NVarChar(100), rec.itemId)
    .input("item_kind", sql.NVarChar(20), rec.itemKind)
    .input("item_label", sql.NVarChar(400), store.clip(rec.itemLabel, 400))
    .input("sku", sql.NVarChar(100), rec.sku)
    .input("supplier_id", sql.NVarChar(100), rec.supplierId)
    .input("supplier_name", sql.NVarChar(200), store.clip(rec.supplierName, 200))
    .input("scan_run_id", sql.UniqueIdentifier, rec.scanRunId)
    .input("idempotency_key", sql.NVarChar(200), rec.idempotencyKey)
    .input("recommendation_type", sql.NVarChar(50), rec.recommendationType)
    .input("status", sql.NVarChar(50), rec.status)
    .input("evidence_snapshot_json", sql.NVarChar(sql.MAX), rec.evidenceSnapshotJson)
    .input("evidence_version", sql.Int, rec.evidenceVersion)
    .input("proposed_settings_json", sql.NVarChar(sql.MAX), rec.proposedSettingsJson)
    .input("calculation_version", sql.NVarChar(50), rec.calculationVersion)
    .input("policy_version", sql.NVarChar(50), rec.policyVersion)
    .input("confidence_score", sql.Decimal(5, 2), rec.confidenceScore)
    .input("confidence_level", sql.NVarChar(20), rec.confidenceLevel)
    .input("previous_recommendation_id", sql.UniqueIdentifier, rec.previousRecommendationId)
    .input("revision_number", sql.Int, rec.revisionNumber)
    .input("before_settings_snapshot_json", sql.NVarChar(sql.MAX), rec.beforeSettingsSnapshotJson)
    .input("created_at", sql.DateTime2, new Date(rec.createdAt))
    .query(`
      INSERT INTO inventory.replenishment_recommendations (
        recommendation_id, item_id, item_kind, item_label, sku, supplier_id, supplier_name,
        scan_run_id, idempotency_key, recommendation_type, status,
        evidence_snapshot_json, evidence_version, proposed_settings_json,
        calculation_version, policy_version, confidence_score, confidence_level,
        previous_recommendation_id, revision_number, before_settings_snapshot_json,
        created_at, updated_at
      ) VALUES (
        @recommendation_id, @item_id, @item_kind, @item_label, @sku, @supplier_id, @supplier_name,
        @scan_run_id, @idempotency_key, @recommendation_type, @status,
        @evidence_snapshot_json, @evidence_version, @proposed_settings_json,
        @calculation_version, @policy_version, @confidence_score, @confidence_level,
        @previous_recommendation_id, @revision_number, @before_settings_snapshot_json,
        @created_at, @created_at
      );
    `);
}

/* ─────────── change detection ─────────── */

/**
 * Whether the proposed values moved enough to deserve a new revision. Small
 * daily drift in the order point does not: that would supersede a recommendation
 * under a reviewer's eyes every time one more lens ships.
 */
function materiallyDifferent(previous, next) {
  if (previous.recommendationType !== next.recommendationType) return true;
  const a = previous.proposedSettings || {};
  const b = next.proposedSettings || {};
  for (const key of ["supplierId", "leadTimeDays", "safetyStock", "targetCoverDays", "minOrderQty", "packMultiple"]) {
    if ((a[key] ?? null) !== (b[key] ?? null)) return true;
  }
  const opTolerance = Math.max(1, Math.abs(a.orderPoint || 0) * 0.1);
  if (Math.abs((a.orderPoint || 0) - (b.orderPoint || 0)) > opTolerance) return true;
  const rqTolerance = Math.max(a.packMultiple || 1, Math.abs(a.reorderQuantity || 0) * 0.1);
  if (Math.abs((a.reorderQuantity || 0) - (b.reorderQuantity || 0)) > rqTolerance) return true;
  return false;
}

/** Evidence without provenance timestamps, so a rescan that found nothing new compares equal. */
function stableEvidence(evidence) {
  const { provenance, ...rest } = evidence || {};
  return JSON.stringify(rest);
}

/* ─────────── scan-side synchronisation ─────────── */

/**
 * Applies one calculation result for an item: creates, revises, refreshes,
 * suppresses or retires its recommendation, and creates or reuses its task.
 * Idempotent: running it twice with the same input changes nothing the second time.
 *
 * `calculation.recommendationType === null` means no action is needed; any open
 * recommendation for the item is retired.
 *
 * Returns { action, recommendation, task }.
 */
async function syncRecommendation({ calculation, itemKind = "lens", scanRunId = null, suppressionDays = 30, actor = "system", tx = null }) {
  const itemId = calculation.itemId;
  const latest = await getLatestRecommendationForItem(itemId, { tx, lock: true });
  const now = new Date().toISOString();

  // ---- No action needed: retire whatever is open. ----
  if (!calculation.recommendationType) {
    if (latest && UNDECIDED.includes(latest.status)) {
      const changed = await patchRecommendation(latest.recommendationId, { status: "SUPERSEDED", supersededAt: now }, { tx, onlyIfStatus: UNDECIDED });
      if (changed) {
        const cancelled = await cancelObsoleteTasks({
          itemId, keepTaskType: null, actor, reason: "No action is needed after recalculation", tx
        });
        await recordInventoryAudit({
          scanRunId, recommendationId: latest.recommendationId, actor,
          action: "RECOMMENDATION_RETIRED",
          entityType: "ReplenishmentRecommendation", entityId: latest.recommendationId,
          beforeState: { status: latest.status, recommendationType: latest.recommendationType },
          afterState: { status: "SUPERSEDED", cancelledTasks: cancelled },
          reason: "Recalculation found no action needed", tx
        });
        return { action: "RETIRED", recommendation: latest, task: null };
      }
    }
    return { action: "NONE", recommendation: null, task: null };
  }

  const evidence = { ...calculation.evidence, priority: calculation.priority };
  const status = SETTINGS_QUEUES.includes(calculation.recommendationType) ? "PENDING_APPROVAL" : "OPEN";
  const proposed = calculation.proposedSettings;
  const candidate = { recommendationType: calculation.recommendationType, proposedSettings: proposed };

  if (latest) {
    const sameShape = !materiallyDifferent(latest, candidate);

    // Undecided and unchanged in substance: refresh the evidence in place, keep what the reviewer sees.
    if (UNDECIDED.includes(latest.status) && sameShape) {
      const changed = stableEvidence(latest.evidence) !== stableEvidence(evidence);
      if (changed) {
        await patchRecommendation(latest.recommendationId, {
          evidenceSnapshotJson: JSON.stringify(evidence),
          evidenceVersion: (latest.evidenceVersion || 1) + 1,
          confidenceScore: calculation.confidenceScore,
          confidenceLevel: calculation.confidenceLevel,
          scanRunId
        }, { tx, onlyIfStatus: UNDECIDED });
      }
      // Touch the task only when the evidence moved or the recommendation has none yet,
      // so a quiet rescan writes nothing.
      const ensured = (changed || !latest.linkedTaskId)
        ? await ensureTask({ recommendation: latest, calculation, scanRunId, actor, tx })
        : { task: null, created: false };
      return { action: changed ? "REFRESHED" : "UNCHANGED", recommendation: latest, task: ensured.task, taskCreated: ensured.created };
    }

    // Decided and unchanged: a human already ruled on exactly this. Do not ask again,
    // until the decision is old enough that the situation deserves a fresh look.
    if (DECIDED.includes(latest.status) && sameShape) {
      const ageDays = (Date.now() - new Date(latest.decisionAt || latest.updatedAt).getTime()) / 86400000;
      if (latest.status !== "REJECTED" || ageDays < suppressionDays) {
        return { action: "SUPPRESSED", recommendation: latest, task: null };
      }
    }
  }

  // ---- A new revision. ----
  const settingsBefore = await getActiveSetting(itemId, { tx });
  const revisionNumber = latest ? latest.revisionNumber + 1 : 1;
  const recommendationId = randomUUID();
  const record = {
    recommendationId,
    itemId,
    itemKind,
    itemLabel: calculation.itemLabel,
    sku: calculation.sku,
    supplierId: calculation.supplierId,
    supplierName: calculation.supplierName,
    scanRunId,
    idempotencyKey: `rec:${itemId}:rev${revisionNumber}`,
    recommendationType: calculation.recommendationType,
    status,
    evidenceSnapshotJson: JSON.stringify(evidence),
    evidenceVersion: 1,
    proposedSettingsJson: JSON.stringify(proposed),
    calculationVersion: calculation.calculationVersion,
    policyVersion: calculation.policyVersion,
    confidenceScore: calculation.confidenceScore,
    confidenceLevel: calculation.confidenceLevel,
    previousRecommendationId: latest ? latest.recommendationId : null,
    revisionNumber,
    beforeSettingsSnapshotJson: settingsBefore ? JSON.stringify(settingsBefore) : null,
    approvedSettingsSnapshotJson: null,
    decisionReason: null,
    decisionActor: null,
    decisionAt: null,
    supersededAt: null,
    supersededById: null,
    linkedTaskId: null,
    createdAt: now,
    updatedAt: now
  };

  // Free the item's single undecided slot first, then take it with the new revision.
  if (latest && UNDECIDED.includes(latest.status)) {
    const retired = await patchRecommendation(latest.recommendationId, { status: "SUPERSEDED", supersededAt: now, supersededById: recommendationId }, { tx, onlyIfStatus: UNDECIDED });
    if (!retired) throw conflict("This item's recommendation was changed by someone else during the scan.", "CHANGED_DURING_SCAN");
  }
  try {
    await insertRecommendation(record, { tx });
  } catch (error) {
    // Another scan produced this revision first. Surface it; the item is retried on the next scan.
    if (isDuplicateKeyError(error)) throw conflict("Another scan already produced this revision.", "REVISION_EXISTS");
    throw error;
  }

  const createdRecord = formatRecommendationRow(record);
  const { task, created: taskCreated } = await ensureTask({ recommendation: createdRecord, calculation, scanRunId, actor, tx });

  await recordInventoryAudit({
    scanRunId, recommendationId, taskId: task ? task.taskId : null, actor,
    action: latest ? "RECOMMENDATION_REVISED" : "RECOMMENDATION_GENERATED",
    entityType: "ReplenishmentRecommendation", entityId: recommendationId,
    beforeState: latest ? { recommendationId: latest.recommendationId, status: latest.status, recommendationType: latest.recommendationType } : null,
    afterState: { recommendationType: calculation.recommendationType, status, revisionNumber, itemId, confidenceLevel: calculation.confidenceLevel },
    reason: `Generated ${calculation.recommendationType} (revision ${revisionNumber}): ${calculation.queueRule}`,
    tx
  });

  return { action: latest ? "REVISED" : "CREATED", recommendation: createdRecord, task, taskCreated };
}

/** Creates or reuses the task for an actionable recommendation; informational ones get none. */
async function ensureTask({ recommendation, calculation, scanRunId, actor, tx }) {
  if (!calculation.taskType) return { task: null, created: false };

  // Tasks for a different purpose that nobody has picked up are obsolete now.
  await cancelObsoleteTasks({
    itemId: calculation.itemId, keepTaskType: calculation.taskType, actor,
    reason: "Replaced by a different recommendation after recalculation", tx
  });

  const { task, created } = await syncOperationalTask({
    recommendationId: recommendation.recommendationId,
    itemId: calculation.itemId,
    supplierId: calculation.supplierId,
    taskType: calculation.taskType,
    priority: calculation.priority === "INFO" ? "LOW" : calculation.priority,
    dueDate: dueDateFor(calculation.priority === "INFO" ? "LOW" : calculation.priority),
    sourceRunId: scanRunId,
    taskPayload: {
      recommendationType: calculation.recommendationType,
      queueRule: calculation.queueRule,
      suggestedOrderQuantity: calculation.evidence.suggestedOrderQuantity,
      onHand: calculation.evidence.onHand,
      openPoQuantity: calculation.evidence.openPoQuantity,
      daysRemaining: calculation.evidence.daysRemaining
    },
    actor, tx
  });

  if (recommendation.linkedTaskId !== task.taskId) {
    await patchRecommendation(recommendation.recommendationId, { linkedTaskId: task.taskId }, { tx });
    recommendation.linkedTaskId = task.taskId;
  }
  return { task, created };
}

/* ─────────── decisions ─────────── */

function requireReason(reason, message) {
  const text = reason == null ? "" : String(reason).trim();
  if (!text) throw badRequest(message);
  if (text.length > 500) throw badRequest("The reason must be 500 characters or fewer.");
  return text;
}

function assertUndecided(rec, verb) {
  if (UNDECIDED.includes(rec.status)) return;
  if (rec.status === "SUPERSEDED") {
    throw conflict("A newer recommendation has replaced this one. Refresh the queue and review the current one.", "SUPERSEDED");
  }
  throw conflict(`This recommendation is already ${rec.status.toLowerCase()} and cannot be ${verb}.`, "ALREADY_DECIDED");
}

function assertSettingsQueue(rec, verb) {
  if (!SETTINGS_QUEUES.includes(rec.recommendationType)) {
    throw conflict(`A ${rec.recommendationType} recommendation does not change replenishment settings, so it cannot be ${verb}. Use its own workflow (count, review or dismiss).`, "NOT_A_SETTINGS_QUEUE");
  }
  if (rec.confidenceLevel === "LOW") {
    throw conflict("Confidence is too low to approve this recommendation. Resolve the data issue first.", "LOW_CONFIDENCE");
  }
}

async function settleTask(rec, { status, note, actor, tx }) {
  if (!rec.linkedTaskId) return;
  const task = await getTask(rec.linkedTaskId, { tx, lock: true });
  if (!task) return;
  if (task.status === status) return;
  if (["APPROVED", "REJECTED", "COMPLETED", "CANCELLED"].includes(task.status)) return;
  await updateTaskState({ taskId: rec.linkedTaskId, status, note, actor, tx });
}

async function applyApproval({ rec, settingsValues, reason, actor, tx, editedFrom = null }) {
  const now = new Date().toISOString();
  const activeVersion = (await getActiveSetting(rec.itemId, { tx, lock: true }));
  const expectedVersion = rec.beforeSettings ? rec.beforeSettings.version : null;
  if ((activeVersion ? activeVersion.version : null) !== expectedVersion) {
    throw conflict("The approved settings for this item changed after this recommendation was created. Refresh and review it again.", "STALE_SETTINGS");
  }

  const { setting } = await writeApprovedSetting({
    itemId: rec.itemId,
    itemKind: rec.itemKind,
    sku: rec.sku,
    itemLabel: rec.itemLabel,
    supplierId: settingsValues.supplierId ?? rec.supplierId,
    supplierName: settingsValues.supplierName ?? rec.supplierName,
    orderPoint: settingsValues.orderPoint,
    safetyStock: settingsValues.safetyStock,
    targetCoverDays: settingsValues.targetCoverDays,
    leadTimeDays: settingsValues.leadTimeDays,
    leadTimeOverrideReason: settingsValues.leadTimeOverrideReason || null,
    reorderQuantity: settingsValues.reorderQuantity,
    minOrderQty: settingsValues.minOrderQty,
    packMultiple: settingsValues.packMultiple,
    supplierPreference: settingsValues.supplierPreference || null,
    substitutionPolicy: settingsValues.substitutionPolicy || null,
    recommendationId: rec.recommendationId,
    taskId: rec.linkedTaskId,
    approvedBy: actor,
    decisionReason: reason,
    expectedVersion,
    tx
  });

  const changed = await patchRecommendation(rec.recommendationId, {
    status: "APPROVED",
    decisionActor: actor,
    decisionReason: reason,
    decisionAt: now,
    approvedSettingsSnapshotJson: JSON.stringify(setting)
  }, { tx, onlyIfStatus: ["OPEN", "PENDING_APPROVAL"] });
  if (!changed) {
    throw conflict("This recommendation was decided by someone else a moment ago. Refresh the queue.", "ALREADY_DECIDED");
  }

  await settleTask(rec, { status: "APPROVED", note: reason, actor, tx });

  await recordInventoryAudit({
    recommendationId: rec.recommendationId, taskId: rec.linkedTaskId, settingId: setting.settingId, actor,
    action: editedFrom ? "RECOMMENDATION_EDIT_APPROVED" : "RECOMMENDATION_APPROVED",
    entityType: "ReplenishmentRecommendation", entityId: rec.recommendationId,
    beforeState: { status: rec.status, proposedSettings: editedFrom || rec.proposedSettings, settingsVersion: expectedVersion },
    afterState: { status: "APPROVED", settingId: setting.settingId, settingsVersion: setting.version, settings: settingsValues },
    reason, tx
  });

  // An approved settings change is itself a recalculation trigger.
  await enqueueRecalculation({
    eventType: "EVENT_SETTINGS", itemId: rec.itemId, sourceRef: `setting:${setting.settingId}`,
    payload: { settingId: setting.settingId, version: setting.version }, actor, tx
  });

  return setting;
}

/**
 * Approves a recommendation as proposed and writes the approved settings revision.
 * Repeating the call is harmless (returns isDuplicate).
 */
async function approveRecommendation({ recommendationId, reason = null, actor }) {
  if (!actor) throw badRequest("An approver is required.");
  return store.withTransaction(async (tx) => {
    const rec = await getRecommendation(recommendationId, { tx, lock: true });
    if (!rec) throw notFound("That recommendation was not found.");
    if (rec.status === "APPROVED") return { recommendation: rec, setting: rec.approvedSettings, isDuplicate: true };

    assertUndecided(rec, "approved");
    assertSettingsQueue(rec, "approved");

    const decisionReason = store.clip(reason && String(reason).trim() ? reason : "Approved replenishment recommendation", 500);
    const values = validateSettingValues(rec.proposedSettings);
    const setting = await applyApproval({
      rec,
      settingsValues: { ...rec.proposedSettings, ...values },
      reason: decisionReason, actor, tx
    });
    return { recommendation: await getRecommendation(recommendationId, { tx }), setting, isDuplicate: false };
  });
}

/**
 * Edit values, then approve. The human-supplied values become a new proposed
 * revision (the original is superseded, not changed) and that revision is the
 * one approved, so the settings row traces to exactly what the person entered.
 */
async function editAndApproveRecommendation({
  recommendationId, orderPoint, reorderQuantity, leadTimeDays, leadTimeOverrideReason,
  minOrderQty, packMultiple, safetyStock, supplierId, supplierName, reason, actor
}) {
  if (!actor) throw badRequest("An approver is required.");
  const editReason = requireReason(reason, "A reason is required when editing proposed replenishment values.");

  return store.withTransaction(async (tx) => {
    const current = await getRecommendation(recommendationId, { tx, lock: true });
    if (!current) throw notFound("That recommendation was not found.");
    assertUndecided(current, "edited");
    assertSettingsQueue(current, "edited");

    const before = current.proposedSettings;
    const edited = {
      ...before,
      orderPoint: orderPoint ?? before.orderPoint,
      reorderQuantity: reorderQuantity ?? before.reorderQuantity,
      leadTimeDays: leadTimeDays ?? before.leadTimeDays,
      minOrderQty: minOrderQty ?? before.minOrderQty,
      packMultiple: packMultiple ?? before.packMultiple,
      safetyStock: safetyStock ?? before.safetyStock,
      supplierId: supplierId ?? before.supplierId,
      supplierName: supplierName ?? before.supplierName
    };
    const values = validateSettingValues(edited);
    const leadChanged = values.leadTimeDays !== before.leadTimeDays;
    const proposed = {
      ...edited,
      ...values,
      leadTimeOverrideReason: leadChanged ? store.clip(leadTimeOverrideReason && String(leadTimeOverrideReason).trim() ? leadTimeOverrideReason : editReason, 500) : (before.leadTimeOverrideReason || null),
      humanEdited: true,
      editReason,
      editedBy: actor,
      editedAt: new Date().toISOString(),
      editedFromRecommendationId: current.recommendationId,
      originalProposal: {
        orderPoint: before.orderPoint, reorderQuantity: before.reorderQuantity, leadTimeDays: before.leadTimeDays,
        minOrderQty: before.minOrderQty, packMultiple: before.packMultiple, safetyStock: before.safetyStock
      }
    };

    const now = new Date().toISOString();
    const newId = randomUUID();
    const revisionNumber = current.revisionNumber + 1;
    const revision = {
      recommendationId: newId,
      itemId: current.itemId,
      itemKind: current.itemKind,
      itemLabel: current.itemLabel,
      sku: current.sku,
      supplierId: proposed.supplierId ?? current.supplierId,
      supplierName: proposed.supplierName ?? current.supplierName,
      scanRunId: current.scanRunId,
      idempotencyKey: `rec:${current.itemId}:rev${revisionNumber}`,
      recommendationType: current.recommendationType,
      status: "PENDING_APPROVAL",
      evidenceSnapshotJson: current.evidenceSnapshotJson,
      evidenceVersion: current.evidenceVersion,
      proposedSettingsJson: JSON.stringify(proposed),
      calculationVersion: current.calculationVersion,
      policyVersion: current.policyVersion,
      confidenceScore: current.confidenceScore,
      confidenceLevel: current.confidenceLevel,
      previousRecommendationId: current.recommendationId,
      revisionNumber,
      beforeSettingsSnapshotJson: current.beforeSettingsSnapshotJson,
      approvedSettingsSnapshotJson: null,
      decisionReason: null, decisionActor: null, decisionAt: null,
      supersededAt: null, supersededById: null,
      linkedTaskId: current.linkedTaskId,
      createdAt: now, updatedAt: now
    };

    // Order matters: free the item's revision slot, then insert the proposed revision.
    const superseded = await patchRecommendation(current.recommendationId, { status: "SUPERSEDED", supersededAt: now, supersededById: newId }, { tx, onlyIfStatus: UNDECIDED });
    if (!superseded) throw conflict("This recommendation was changed by someone else a moment ago. Refresh the queue.", "ALREADY_DECIDED");
    try {
      await insertRecommendation(revision, { tx });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw conflict("A newer revision of this recommendation already exists. Refresh the queue.", "REVISION_EXISTS");
      throw error;
    }
    if (current.linkedTaskId) {
      // Point the task at the revision that will carry the decision.
      const task = await getTask(current.linkedTaskId, { tx });
      if (task) await syncOperationalTask({ recommendationId: newId, itemId: task.itemId, taskType: task.taskType, priority: task.priority, taskPayload: task.taskPayload, actor, tx });
    }

    await recordInventoryAudit({
      recommendationId: newId, taskId: current.linkedTaskId, actor,
      action: "RECOMMENDATION_EDITED",
      entityType: "ReplenishmentRecommendation", entityId: newId,
      beforeState: { recommendationId: current.recommendationId, proposedSettings: before },
      afterState: { recommendationId: newId, revisionNumber, proposedSettings: proposed },
      reason: editReason, tx
    });

    const rec = await getRecommendation(newId, { tx, lock: true });
    const setting = await applyApproval({
      rec, settingsValues: proposed,
      reason: `Edited and approved: ${editReason}`, actor, tx, editedFrom: before
    });
    return { recommendation: await getRecommendation(newId, { tx }), setting, isDuplicate: false };
  });
}

/** Rejects (dismisses) a recommendation. A reason is mandatory; evidence is preserved. */
async function rejectRecommendation({ recommendationId, reason, actor }) {
  if (!actor) throw badRequest("An actor is required.");
  const decisionReason = requireReason(reason, "A reason is required to reject a recommendation.");

  return store.withTransaction(async (tx) => {
    const rec = await getRecommendation(recommendationId, { tx, lock: true });
    if (!rec) throw notFound("That recommendation was not found.");
    if (rec.status === "REJECTED") return { recommendation: rec, isDuplicate: true };
    assertUndecided(rec, "rejected");

    const now = new Date().toISOString();
    const changed = await patchRecommendation(recommendationId, {
      status: "REJECTED", decisionActor: actor, decisionReason, decisionAt: now
    }, { tx, onlyIfStatus: UNDECIDED });
    if (!changed) throw conflict("This recommendation was decided by someone else a moment ago. Refresh the queue.", "ALREADY_DECIDED");

    await settleTask(rec, { status: "REJECTED", note: `Rejected: ${decisionReason}`, actor, tx });
    await recordInventoryAudit({
      recommendationId, taskId: rec.linkedTaskId, actor,
      action: "RECOMMENDATION_REJECTED",
      entityType: "ReplenishmentRecommendation", entityId: recommendationId,
      beforeState: { status: rec.status }, afterState: { status: "REJECTED" },
      reason: decisionReason, tx
    });
    return { recommendation: await getRecommendation(recommendationId, { tx }), isDuplicate: false };
  });
}

/**
 * Marks a non-settings recommendation (write-off review, data review) as reviewed.
 * Records the human decision; a write-off here is a review outcome, never an
 * automatic financial write-off.
 */
async function completeReview({ recommendationId, reason, actor }) {
  if (!actor) throw badRequest("An actor is required.");
  const decisionReason = requireReason(reason, "A note describing the review outcome is required.");

  return store.withTransaction(async (tx) => {
    const rec = await getRecommendation(recommendationId, { tx, lock: true });
    if (!rec) throw notFound("That recommendation was not found.");
    if (rec.status === "APPLIED") return { recommendation: rec, isDuplicate: true };
    assertUndecided(rec, "completed");
    if (SETTINGS_QUEUES.includes(rec.recommendationType)) {
      throw conflict("Replenishment recommendations are approved or rejected, not marked reviewed.", "USE_APPROVE");
    }
    if (rec.recommendationType === "ALREADY_COVERED_BY_PO") {
      throw conflict("This is informational; there is nothing to review.", "INFORMATIONAL");
    }

    const now = new Date().toISOString();
    const changed = await patchRecommendation(recommendationId, {
      status: "APPLIED", decisionActor: actor, decisionReason, decisionAt: now
    }, { tx, onlyIfStatus: UNDECIDED });
    if (!changed) throw conflict("This recommendation was decided by someone else a moment ago. Refresh the queue.", "ALREADY_DECIDED");

    await settleTask(rec, { status: "COMPLETED", note: decisionReason, actor, tx });
    await recordInventoryAudit({
      recommendationId, taskId: rec.linkedTaskId, actor,
      action: "RECOMMENDATION_REVIEW_COMPLETED",
      entityType: "ReplenishmentRecommendation", entityId: recommendationId,
      beforeState: { status: rec.status }, afterState: { status: "APPLIED" },
      reason: decisionReason, tx
    });
    return { recommendation: await getRecommendation(recommendationId, { tx }), isDuplicate: false };
  });
}

/**
 * Approves several recommendations one by one (each is its own transaction), so
 * one stale row never blocks the others. Returns what was approved and what was
 * skipped, with the reason for each skip.
 */
async function approveMany({ recommendationIds, actor, reason }) {
  const approved = [];
  const skipped = [];
  for (const id of recommendationIds) {
    try {
      const preview = await getRecommendation(id);
      if (!preview) { skipped.push({ recommendationId: id, itemId: null, reason: "Recommendation not found." }); continue; }
      const result = await approveRecommendation({ recommendationId: id, reason, actor });
      if (result.isDuplicate) {
        skipped.push({ recommendationId: id, itemId: preview.itemId, reason: "Already approved." });
      } else {
        approved.push({ recommendationId: id, itemId: preview.itemId, settingVersion: result.setting.version });
      }
    } catch (error) {
      if (error && error.expose) {
        const rec = await getRecommendation(id).catch(() => null);
        skipped.push({ recommendationId: id, itemId: rec ? rec.itemId : null, reason: error.message });
      } else {
        throw error;
      }
    }
  }
  return { approvedCount: approved.length, skippedCount: skipped.length, approved, skipped };
}

/**
 * Approve all eligible: one homogeneous settings queue, HIGH confidence only,
 * undecided only. Everything else in the queue is reported as skipped.
 */
async function approveAllEligible({ queue, actor, maxRows = 500 }) {
  if (!SETTINGS_QUEUES.includes(queue)) {
    throw badRequest("Approve all applies to one replenishment queue at a time: ORDER_MORE or ORDER_LESS.");
  }
  const { items, total } = await listRecommendations({ queue, status: "ACTIVE", limit: maxRows, offset: 0, sortBy: "createdAt", sortDir: "ASC" });

  const eligible = [];
  const skipped = [];
  for (const item of items) {
    if (item.confidenceLevel !== "HIGH") {
      skipped.push({ recommendationId: item.recommendationId, itemId: item.itemId, reason: `Confidence is ${item.confidenceLevel}; it needs individual review.` });
    } else {
      eligible.push(item.recommendationId);
    }
  }
  const result = await approveMany({
    recommendationIds: eligible, actor,
    reason: "Bulk approval of eligible high-confidence recommendations"
  });
  const allSkipped = skipped.concat(result.skipped);
  return {
    queue,
    approvedCount: result.approvedCount,
    skippedCount: allSkipped.length,
    approved: result.approved,
    skipped: allSkipped,
    notProcessed: Math.max(0, total - items.length)
  };
}

/* ─────────── queries ─────────── */

const SORTS = Object.freeze({
  onHand: { json: "evidence", path: "$.onHand", type: "float" },
  openPoQuantity: { json: "evidence", path: "$.openPoQuantity", type: "float" },
  usage30: { json: "evidence", path: "$.usage30", type: "float" },
  usage90: { json: "evidence", path: "$.usage90", type: "float" },
  daysRemaining: { json: "evidence", path: "$.daysRemaining", type: "float" },
  valueAtRisk: { json: "evidence", path: "$.valueAtRisk", type: "float" },
  suggestedOrderQuantity: { json: "proposed", path: "$.suggestedOrderQuantity", type: "float" },
  leadTimeDays: { json: "proposed", path: "$.leadTimeDays", type: "float" },
  confidenceScore: { column: "confidence_score", type: "float", mem: "confidenceScore" },
  itemLabel: { column: "item_label", type: "text", mem: "itemLabel" },
  supplierName: { column: "supplier_name", type: "text", mem: "supplierName" },
  createdAt: { column: "created_at", type: "date", mem: "createdAt" }
});

function statusFilter(status) {
  switch (status || "ACTIVE") {
    case "ACTIVE": return UNDECIDED.slice();
    case "DECIDED": return DECIDED.slice();
    case "ALL": return null;
    default:
      if (!RECOMMENDATION_STATUSES.includes(status)) throw badRequest(`Unknown status filter ${status}.`);
      return [status];
  }
}

function resolveQueue(queue) {
  if (!queue || queue === "ALL") return { type: null, status: null };
  if (queue === "PENDING_APPROVAL") return { type: null, status: ["PENDING_APPROVAL"] };
  if (!RECOMMENDATION_TYPES.includes(queue)) throw badRequest(`Unknown queue ${queue}.`);
  return { type: queue, status: null };
}

function memorySortValue(row, key) {
  const spec = SORTS[key];
  if (spec.mem) return row[spec.mem];
  const source = spec.json === "evidence" ? row.evidence : row.proposedSettings;
  const field = spec.path.slice(2);
  return source ? source[field] : undefined;
}

/**
 * Work queue page. queue: ALL | a recommendation type | PENDING_APPROVAL.
 * status: ACTIVE (default) | DECIDED | ALL | a single status.
 * Returns { items, total, limit, offset }.
 */
async function listRecommendations({ queue = "ALL", status = "ACTIVE", search = null, sortBy = "onHand", sortDir = "ASC", limit = 100, offset = 0, itemId = null } = {}) {
  const take = Math.max(1, Math.min(500, Number(limit) || 100));
  const skip = Math.max(0, Number(offset) || 0);
  const dir = String(sortDir).toUpperCase() === "DESC" ? "DESC" : "ASC";
  const sort = SORTS[sortBy] ? sortBy : "onHand";
  const queueSpec = resolveQueue(queue);
  const statuses = queueSpec.status || statusFilter(status);
  const needle = search ? String(search).trim().slice(0, 100) : "";

  if (store.isTestMode()) {
    let list = Array.from(store.mem.recommendations.values()).map((r) => formatRecommendationRow({ ...r }));
    if (queueSpec.type) list = list.filter((r) => r.recommendationType === queueSpec.type);
    if (statuses) list = list.filter((r) => statuses.includes(r.status));
    if (itemId) list = list.filter((r) => r.itemId === itemId);
    if (needle) {
      const q = needle.toLowerCase();
      list = list.filter((r) => [r.itemLabel, r.sku, r.supplierName, r.itemId].some((v) => v && String(v).toLowerCase().includes(q)));
    }
    const factor = dir === "DESC" ? -1 : 1;
    list.sort((a, b) => {
      let va = memorySortValue(a, sort);
      let vb = memorySortValue(b, sort);
      const nullA = va == null || va === "UNKNOWN";
      const nullB = vb == null || vb === "UNKNOWN";
      if (nullA !== nullB) return nullA ? 1 : -1;
      if (!nullA) {
        if (typeof va === "string") { va = va.toLowerCase(); vb = String(vb).toLowerCase(); }
        if (va < vb) return -1 * factor;
        if (va > vb) return 1 * factor;
      }
      return a.recommendationId < b.recommendationId ? -1 : 1;
    });
    return { items: list.slice(skip, skip + take), total: list.length, limit: take, offset: skip };
  }

  const req = await store.request();
  let where = "1 = 1";
  if (queueSpec.type) { req.input("queue", sql.NVarChar(50), queueSpec.type); where += " AND recommendation_type = @queue"; }
  if (statuses) where += ` AND status IN (${statuses.map((s) => `N'${s}'`).join(", ")})`;
  if (itemId) { req.input("item_id", sql.NVarChar(100), itemId); where += " AND item_id = @item_id"; }
  if (needle) {
    req.input("search", sql.NVarChar(120), `%${needle.replace(/[%_[]/g, "[$&]")}%`);
    where += " AND (item_label LIKE @search OR sku LIKE @search OR supplier_name LIKE @search OR item_id LIKE @search)";
  }

  const spec = SORTS[sort];
  let sortExpr;
  if (spec.column) {
    sortExpr = spec.column;
  } else {
    const jsonColumn = spec.json === "evidence" ? "evidence_snapshot_json" : "proposed_settings_json";
    sortExpr = `TRY_CAST(JSON_VALUE(${jsonColumn}, '${spec.path}') AS float)`;
  }
  // Unknown/NULL values sort last in both directions.
  const orderBy = `CASE WHEN ${sortExpr} IS NULL THEN 1 ELSE 0 END, ${sortExpr} ${dir}, recommendation_id`;

  req.input("skip", sql.Int, skip).input("take", sql.Int, take);
  const result = await req.query(`
    SELECT COUNT(*) AS total FROM inventory.replenishment_recommendations WHERE ${where};
    SELECT ${REC_COLUMNS}
    FROM inventory.replenishment_recommendations
    WHERE ${where}
    ORDER BY ${orderBy}
    OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY;
  `);
  return {
    items: result.recordsets[1].map(formatRecommendationRow),
    total: result.recordsets[0][0].total,
    limit: take,
    offset: skip
  };
}

/**
 * Per-queue aggregates over undecided recommendations, for the dashboard cards.
 * Returns rows of { recommendationType, status, count, valueAtRisk, contextUnits, maxPriorityRank }.
 */
async function summarizeActive() {
  if (store.isTestMode()) {
    const groups = new Map();
    for (const r of store.mem.recommendations.values()) {
      if (!UNDECIDED.includes(r.status)) continue;
      const evidence = store.parseJson(r.evidenceSnapshotJson, {});
      const key = `${r.recommendationType}|${r.status}`;
      const g = groups.get(key) || { recommendationType: r.recommendationType, status: r.status, count: 0, valueAtRisk: 0, contextUnits: 0, maxPriorityRank: 0 };
      g.count += 1;
      g.valueAtRisk += Number(evidence.valueAtRisk) || 0;
      g.contextUnits += Number(evidence.contextUnits) || 0;
      g.maxPriorityRank = Math.max(g.maxPriorityRank, PRIORITY_RANK[evidence.priority] || 0);
      groups.set(key, g);
    }
    return Array.from(groups.values());
  }
  const req = await store.request();
  const result = await req.query(`
    SELECT recommendation_type AS recommendationType, status, COUNT(*) AS [count],
           SUM(ISNULL(TRY_CAST(JSON_VALUE(evidence_snapshot_json, '$.valueAtRisk') AS float), 0)) AS valueAtRisk,
           SUM(ISNULL(TRY_CAST(JSON_VALUE(evidence_snapshot_json, '$.contextUnits') AS float), 0)) AS contextUnits,
           MAX(CASE JSON_VALUE(evidence_snapshot_json, '$.priority')
                 WHEN 'CRITICAL' THEN 5 WHEN 'HIGH' THEN 4 WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 2 WHEN 'INFO' THEN 1 ELSE 0 END) AS maxPriorityRank
    FROM inventory.replenishment_recommendations
    WHERE status IN (N'OPEN', N'PENDING_APPROVAL')
    GROUP BY recommendation_type, status;
  `);
  return result.recordset.map((r) => ({ ...r, valueAtRisk: Number(r.valueAtRisk) || 0, contextUnits: Number(r.contextUnits) || 0 }));
}

/** Item ids that currently hold an undecided recommendation (for retiring ones that left the source). */
async function listActiveRecommendationItemIds() {
  if (store.isTestMode()) {
    const ids = new Set();
    for (const r of store.mem.recommendations.values()) if (UNDECIDED.includes(r.status)) ids.add(r.itemId);
    return Array.from(ids);
  }
  const req = await store.request();
  const result = await req.query(`
    SELECT DISTINCT item_id AS itemId FROM inventory.replenishment_recommendations
    WHERE status IN (N'OPEN', N'PENDING_APPROVAL');
  `);
  return result.recordset.map((r) => r.itemId);
}

/** The revision chain for one item, newest first. */
async function listRevisions(itemId) {
  const { items } = await listRecommendations({ status: "ALL", itemId, sortBy: "createdAt", sortDir: "DESC", limit: 50 });
  return items.map((r) => ({
    recommendationId: r.recommendationId,
    revisionNumber: r.revisionNumber,
    recommendationType: r.recommendationType,
    status: r.status,
    decisionActor: r.decisionActor,
    decisionReason: r.decisionReason,
    decisionAt: r.decisionAt,
    createdAt: r.createdAt
  }));
}

function clearFallbackRecommendations() {
  store.mem.recommendations.clear();
}

module.exports = {
  RECOMMENDATION_TYPES,
  RECOMMENDATION_STATUSES,
  UNDECIDED,
  materiallyDifferent,
  syncRecommendation,
  getRecommendation,
  getLatestRecommendationForItem,
  approveRecommendation,
  editAndApproveRecommendation,
  rejectRecommendation,
  completeReview,
  approveMany,
  approveAllEligible,
  listRecommendations,
  listRevisions,
  listActiveRecommendationItemIds,
  summarizeActive,
  clearFallbackRecommendations
};
