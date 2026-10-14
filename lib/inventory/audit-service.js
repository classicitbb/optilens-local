/**
 * Append-only audit logging for Inventory Intelligence.
 *
 * The platform audit facility is not reused because it does not carry
 * before/after state, a correlation id and a reason together. This table is
 * insert-only: nothing in the app updates or deletes `inventory.audit_events`.
 *
 * A correlation id set with runWithAuditContext() (the request's
 * Idempotency-Key, or a scan run id) is attached to every audit record written
 * underneath it, including those written inside a transaction.
 */

const { AsyncLocalStorage } = require("node:async_hooks");
const sql = require("mssql");
const store = require("./store");

const context = new AsyncLocalStorage();

function runWithAuditContext(values, fn) {
  const parent = context.getStore() || {};
  return context.run({ ...parent, ...values }, fn);
}

function currentAuditContext() {
  return context.getStore() || {};
}

/**
 * Records one audit event. Pass `tx` to write inside the caller's transaction.
 * A failure to write the audit record fails the surrounding operation, so a
 * material transition can never happen without its audit trail.
 */
async function recordInventoryAudit({
  scanRunId = null,
  recommendationId = null,
  taskId = null,
  settingId = null,
  actor = "system",
  action,
  entityType,
  entityId,
  beforeState = null,
  afterState = null,
  reason = null,
  correlationId = null,
  tx = null
}) {
  const ctx = currentAuditContext();
  const record = {
    auditId: null,
    scanRunId,
    recommendationId,
    taskId,
    settingId,
    actor: store.clip(actor || ctx.actor || "system", 120),
    action: store.clip(action, 100),
    entityType: store.clip(entityType, 100),
    entityId: store.clip(entityId, 100),
    beforeState: beforeState == null ? null : JSON.parse(JSON.stringify(beforeState)),
    afterState: afterState == null ? null : JSON.parse(JSON.stringify(afterState)),
    reason: store.clip(reason, 500),
    correlationId: store.clip(correlationId || ctx.correlationId || null, 120),
    createdAt: new Date().toISOString()
  };

  if (store.isTestMode()) {
    record.auditId = store.nextSequence();
    store.mem.audit.push(record);
    return record;
  }

  const req = await store.request(tx);
  const result = await req
    .input("scan_run_id", sql.UniqueIdentifier, scanRunId)
    .input("recommendation_id", sql.UniqueIdentifier, recommendationId)
    .input("task_id", sql.UniqueIdentifier, taskId)
    .input("setting_id", sql.UniqueIdentifier, settingId)
    .input("actor", sql.NVarChar(120), record.actor)
    .input("action", sql.NVarChar(100), record.action)
    .input("entity_type", sql.NVarChar(100), record.entityType)
    .input("entity_id", sql.NVarChar(100), record.entityId)
    .input("before_state_json", sql.NVarChar(sql.MAX), record.beforeState == null ? null : JSON.stringify(record.beforeState))
    .input("after_state_json", sql.NVarChar(sql.MAX), record.afterState == null ? null : JSON.stringify(record.afterState))
    .input("reason", sql.NVarChar(500), record.reason)
    .input("correlation_id", sql.NVarChar(120), record.correlationId)
    .query(`
      INSERT INTO inventory.audit_events (
        scan_run_id, recommendation_id, task_id, setting_id,
        actor, action, entity_type, entity_id,
        before_state_json, after_state_json, reason, correlation_id
      ) OUTPUT INSERTED.audit_id AS auditId
      VALUES (
        @scan_run_id, @recommendation_id, @task_id, @setting_id,
        @actor, @action, @entity_type, @entity_id,
        @before_state_json, @after_state_json, @reason, @correlation_id
      );
    `);
  record.auditId = result.recordset[0].auditId;
  return record;
}

function formatAuditRow(row) {
  return {
    auditId: row.auditId,
    scanRunId: row.scanRunId || null,
    recommendationId: row.recommendationId || null,
    taskId: row.taskId || null,
    settingId: row.settingId || null,
    actor: row.actor,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    beforeState: row.beforeState !== undefined ? row.beforeState : store.parseJson(row.beforeStateJson),
    afterState: row.afterState !== undefined ? row.afterState : store.parseJson(row.afterStateJson),
    reason: row.reason || null,
    correlationId: row.correlationId || null,
    createdAt: store.toIso(row.createdAt)
  };
}

/**
 * Filtered, bounded audit query (newest first).
 */
async function listInventoryAudit({
  entityType = null,
  entityId = null,
  recommendationId = null,
  taskId = null,
  scanRunId = null,
  action = null,
  limit = 100,
  offset = 0
} = {}) {
  const pageSize = Math.max(1, Math.min(500, Number(limit) || 100));
  const skip = Math.max(0, Number(offset) || 0);

  if (store.isTestMode()) {
    let list = store.mem.audit.slice();
    if (entityType) list = list.filter((e) => e.entityType === entityType);
    if (entityId) list = list.filter((e) => e.entityId === entityId);
    if (recommendationId) list = list.filter((e) => e.recommendationId === recommendationId);
    if (taskId) list = list.filter((e) => e.taskId === taskId);
    if (scanRunId) list = list.filter((e) => e.scanRunId === scanRunId);
    if (action) list = list.filter((e) => e.action === action);
    list.sort((a, b) => b.auditId - a.auditId);
    return list.slice(skip, skip + pageSize).map(formatAuditRow);
  }

  const req = await store.request();
  let where = "1 = 1";
  if (entityType) { req.input("entity_type", sql.NVarChar(100), entityType); where += " AND entity_type = @entity_type"; }
  if (entityId) { req.input("entity_id", sql.NVarChar(100), entityId); where += " AND entity_id = @entity_id"; }
  if (recommendationId) { req.input("recommendation_id", sql.UniqueIdentifier, recommendationId); where += " AND recommendation_id = @recommendation_id"; }
  if (taskId) { req.input("task_id", sql.UniqueIdentifier, taskId); where += " AND task_id = @task_id"; }
  if (scanRunId) { req.input("scan_run_id", sql.UniqueIdentifier, scanRunId); where += " AND scan_run_id = @scan_run_id"; }
  if (action) { req.input("action", sql.NVarChar(100), action); where += " AND action = @action"; }
  req.input("skip", sql.Int, skip).input("take", sql.Int, pageSize);

  const result = await req.query(`
    SELECT
      audit_id AS auditId,
      scan_run_id AS scanRunId,
      recommendation_id AS recommendationId,
      task_id AS taskId,
      setting_id AS settingId,
      actor, action,
      entity_type AS entityType,
      entity_id AS entityId,
      before_state_json AS beforeStateJson,
      after_state_json AS afterStateJson,
      reason,
      correlation_id AS correlationId,
      created_at AS createdAt
    FROM inventory.audit_events
    WHERE ${where}
    ORDER BY audit_id DESC
    OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY;
  `);
  return result.recordset.map(formatAuditRow);
}

function clearFallbackAuditLog() {
  store.mem.audit.length = 0;
}

module.exports = {
  recordInventoryAudit,
  listInventoryAudit,
  runWithAuditContext,
  currentAuditContext,
  clearFallbackAuditLog
};
