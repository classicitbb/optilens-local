const crypto = require("node:crypto");
const sql = require("mssql");
const { getAppPool } = require("../db");
const { recordAuditEvent } = require("../audit");
const { parseSupplierFile } = require("./supplier-parser");
const { matchSupplierReferences } = require("./matching");

const MAX_FIXTURE_BYTES = 5 * 1024 * 1024;
const ALLOWED_STATUSES = new Set(["RECEIVED", "PROCESSING", "WAITING_RETRY", "COMPLETED", "FAILED", "DEAD_LETTER"]);

function sha256(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }
function idempotencyKey(parts) { return parts.map((part) => String(part ?? "").trim()).join(":"); }
function safeJson(value) { return JSON.stringify(value === undefined ? null : value); }
function parseJson(value) { try { return value ? JSON.parse(value) : null; } catch { return null; } }

function validateFixture(buffer, filename) {
  if (!Buffer.isBuffer(buffer)) throw new Error("Supplier fixture must be a binary buffer.");
  if (!buffer.length) throw new Error("Supplier fixture is empty.");
  if (buffer.length > MAX_FIXTURE_BYTES) throw new Error(`Supplier fixture exceeds ${MAX_FIXTURE_BYTES} bytes.`);
  if (!/^[-A-Za-z0-9._ ]{1,180}\.(csv|xlsx)$/i.test(String(filename || ""))) throw new Error("Only sanitized .csv or .xlsx fixtures are supported.");
}

async function createEvent({ eventType, sourceSystem, externalReference = null, payload, key, correlationId = crypto.randomUUID() }) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("event_type", sql.NVarChar(160), eventType)
    .input("source_system", sql.NVarChar(120), sourceSystem)
    .input("external_reference", sql.NVarChar(300), externalReference)
    .input("correlation_id", sql.UniqueIdentifier, correlationId)
    .input("idempotency_key", sql.NVarChar(500), key)
    .input("payload_json", sql.NVarChar(sql.MAX), safeJson(payload))
    .query(`
      IF EXISTS (SELECT 1 FROM ops.Events WHERE idempotency_key = @idempotency_key)
        SELECT event_id, status, idempotency_key, 1 AS duplicate FROM ops.Events WHERE idempotency_key = @idempotency_key;
      ELSE
      BEGIN
        INSERT INTO ops.Events (event_type, source_system, external_reference, correlation_id, idempotency_key, payload_json)
        OUTPUT inserted.event_id, inserted.status, inserted.idempotency_key, 0 AS duplicate
        VALUES (@event_type, @source_system, @external_reference, @correlation_id, @idempotency_key, @payload_json);
      END
    `);
  return result.recordset[0];
}

async function createAttachment({ eventId, filename, contentType, buffer, storagePath }) {
  const digest = sha256(buffer);
  const pool = await getAppPool();
  const result = await pool.request()
    .input("event_id", sql.UniqueIdentifier, eventId)
    .input("original_filename", sql.NVarChar(260), filename)
    .input("stored_filename", sql.NVarChar(260), `${digest}-${filename.replace(/[^A-Za-z0-9._-]/g, "_")}`)
    .input("content_type", sql.NVarChar(160), contentType || null)
    .input("file_size", sql.BigInt, buffer.length)
    .input("sha256", sql.NVarChar(64), digest)
    .input("storage_path", sql.NVarChar(1000), storagePath)
    .query(`
      IF EXISTS (SELECT 1 FROM ops.Attachments WHERE sha256 = @sha256)
        SELECT attachment_id, sha256, 1 AS duplicate FROM ops.Attachments WHERE sha256 = @sha256;
      ELSE
      BEGIN
        INSERT INTO ops.Attachments (event_id, original_filename, stored_filename, content_type, file_size, sha256, storage_path)
        OUTPUT inserted.attachment_id, inserted.sha256, 0 AS duplicate
        VALUES (@event_id, @original_filename, @stored_filename, @content_type, @file_size, @sha256, @storage_path);
      END
    `);
  return result.recordset[0];
}

async function listOperations({ limit = 50, status = null } = {}) {
  const bounded = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const pool = await getAppPool();
  const result = await pool.request()
    .input("status", sql.NVarChar(40), status || null)
    .input("limit", sql.Int, bounded)
    .query(`
      SELECT TOP (@limit) event_id, event_type, source_system, external_reference,
             idempotency_key, status, attempt_count, last_error, created_at, completed_at
      FROM ops.Events
      WHERE (@status IS NULL OR status = @status)
      ORDER BY created_at DESC;
    `);
  return result.recordset;
}

async function listActions({ limit = 50, status = "WAITING_APPROVAL" } = {}) {
  const bounded = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const pool = await getAppPool();
  const result = await pool.request().input("status", status).input("limit", bounded).query(`
    SELECT TOP (@limit) action_id, event_id, action_type, target_type, target_reference,
           risk_level, status, proposed_json, created_at, decided_at
    FROM ops.Actions WHERE status = @status ORDER BY created_at DESC;
  `);
  return result.recordset.map((row) => ({ ...row, proposed: parseJson(row.proposed_json) }));
}

async function listExceptions({ limit = 50, status = "OPEN" } = {}) {
  const bounded = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const pool = await getAppPool();
  const result = await pool.request().input("status", status).input("limit", bounded).query(`
    SELECT TOP (@limit) exception_id, event_id, exception_type, severity, status,
           subject_reference, message, technical_detail, created_at, resolved_at
    FROM ops.Exceptions WHERE status = @status ORDER BY created_at DESC;
  `);
  return result.recordset;
}

function developmentMatch(item) {
  if (!item.supplierReference.startsWith("MATCH-")) return null;
  if (!item.normalizedStatus) return null;
  return {
    targetReference: item.supplierReference.slice("MATCH-".length),
    targetType: "app-owned-status-projection",
    proposedStatus: `SUPPLIER_${item.normalizedStatus}`
  };
}

function sourceMatch(item, result) {
  if (!result || result.matchResult !== "Matched" || !item.normalizedStatus) return null;
  const row = result.matches[0];
  return {
    targetReference: String(row.internal_order_id),
    targetType: "innovations-order",
    proposedStatus: `SUPPLIER_${item.normalizedStatus}`,
    sourceOrder: row
  };
}

async function createProposedAction({ eventId, item, match, actorUserId }) {
  const pool = await getAppPool();
  const key = idempotencyKey(["supplier-status", eventId, item.supplierReference]);
  const result = await pool.request()
    .input("event_id", sql.UniqueIdentifier, eventId)
    .input("action_type", sql.NVarChar(160), "supplier.status_projection.propose")
    .input("target_type", sql.NVarChar(120), match.targetType)
    .input("target_reference", sql.NVarChar(300), match.targetReference)
    .input("idempotency_key", sql.NVarChar(500), key)
    .input("proposed_json", sql.NVarChar(sql.MAX), safeJson({ supplierReference: item.supplierReference, supplierStatus: item.supplierStatus, projectedStatus: match.proposedStatus, sourceEventId: eventId }))
    .input("requested_by", sql.UniqueIdentifier, actorUserId || null)
    .query(`
      IF EXISTS (SELECT 1 FROM ops.Actions WHERE idempotency_key = @idempotency_key)
        SELECT action_id, 1 AS duplicate FROM ops.Actions WHERE idempotency_key = @idempotency_key;
      ELSE
      BEGIN
        INSERT INTO ops.Actions (event_id, action_type, target_type, target_reference, idempotency_key, proposed_json, requested_by)
        OUTPUT inserted.action_id, 0 AS duplicate
        VALUES (@event_id, @action_type, @target_type, @target_reference, @idempotency_key, @proposed_json, @requested_by);
      END
    `);
  return result.recordset[0];
}

async function decideAction(actionId, decision, actorUserId, note = "") {
  if (!["APPROVED", "REJECTED"].includes(decision)) throw new Error("Action decision must be APPROVED or REJECTED.");
  const pool = await getAppPool();
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    const request = new sql.Request(transaction);
    request.input("action_id", sql.UniqueIdentifier, actionId)
      .input("decision", sql.NVarChar(30), decision)
      .input("note", sql.NVarChar(sql.MAX), note || null)
      .input("decided_by", sql.UniqueIdentifier, actorUserId || null);
    const result = await request.query(`
      SELECT action_id, event_id, target_reference, proposed_json, status
      FROM ops.Actions WITH (UPDLOCK, ROWLOCK) WHERE action_id = @action_id;
    `);
    const action = result.recordset[0];
    if (!action) throw Object.assign(new Error("Action not found."), { statusCode: 404 });
    if (!["WAITING_APPROVAL"].includes(action.status)) {
      await transaction.commit();
      return { actionId, status: action.status, duplicate: true };
    }
    await new sql.Request(transaction)
      .input("action_id", sql.UniqueIdentifier, actionId)
      .input("decision", sql.NVarChar(30), decision)
      .input("note", sql.NVarChar(sql.MAX), note || null)
      .input("decided_by", sql.UniqueIdentifier, actorUserId || null)
      .query(`
        INSERT INTO ops.Approvals (action_id, decision, note, decided_by) VALUES (@action_id, @decision, @note, @decided_by);
        UPDATE ops.Actions SET status = @decision, decided_by = @decided_by, decision_note = @note, decided_at = SYSUTCDATETIME() WHERE action_id = @action_id;
      `);
    if (decision === "APPROVED") {
      const proposed = parseJson(action.proposed_json) || {};
      await new sql.Request(transaction)
        .input("action_id", sql.UniqueIdentifier, actionId)
        .input("event_id", sql.UniqueIdentifier, action.event_id)
        .input("target_reference", sql.NVarChar(300), action.target_reference)
        .input("supplier_code", sql.NVarChar(80), "SUPPLIER_FIXTURE")
        .input("supplier_status", sql.NVarChar(160), proposed.supplierStatus || "")
        .input("projected_status", sql.NVarChar(160), proposed.projectedStatus || "")
        .input("created_by", sql.UniqueIdentifier, actorUserId || null)
        .query(`
          INSERT INTO ops.StatusProjection (target_reference, supplier_code, supplier_status, projected_status, source_event_id, created_by)
          SELECT @target_reference, @supplier_code, @supplier_status, @projected_status, @event_id, @created_by
          WHERE NOT EXISTS (SELECT 1 FROM ops.StatusProjection WHERE source_event_id = @event_id AND target_reference = @target_reference);
          INSERT INTO ops.NotificationOutbox (action_id, notification_type, recipient_reference, payload_json, idempotency_key)
          SELECT @action_id, N'supplier.status_projection.applied', @target_reference, N'{}', CONCAT(N'supplier-status-notification:', @action_id)
          WHERE NOT EXISTS (SELECT 1 FROM ops.NotificationOutbox WHERE action_id = @action_id);
          UPDATE ops.Actions SET status = N'APPLIED', applied_json = @projected_status WHERE action_id = @action_id;
        `);
    }
    await new sql.Request(transaction)
      .input("action_id", sql.UniqueIdentifier, actionId)
      .input("actor", sql.UniqueIdentifier, actorUserId || null)
      .input("detail", sql.NVarChar(sql.MAX), safeJson({ decision, note }))
      .query("INSERT INTO ops.ActivityLog (action_id, activity_type, actor_user_id, detail_json) VALUES (@action_id, N'action.decision', @actor, @detail);");
    await transaction.commit();
    await recordAuditEvent({ moduleCode: "automation", actorUserId, eventType: `supplier.action.${decision.toLowerCase()}`, entityType: "ops.Action", entityId: actionId, eventData: { note } });
    return { actionId, status: decision === "APPROVED" ? "APPLIED" : "REJECTED", duplicate: false };
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  }
}

async function resolveException(exceptionId, status, actorUserId, note = "") {
  if (!["RESOLVED", "DISMISSED"].includes(status)) throw new Error("Exception resolution must be RESOLVED or DISMISSED.");
  const pool = await getAppPool();
  const result = await pool.request()
    .input("exception_id", sql.UniqueIdentifier, exceptionId)
    .input("status", sql.NVarChar(30), status)
    .input("note", sql.NVarChar(sql.MAX), note || null)
    .input("actor", sql.UniqueIdentifier, actorUserId || null)
    .query(`
      UPDATE ops.Exceptions SET status = @status, resolution_note = @note, resolved_at = SYSUTCDATETIME() WHERE exception_id = @exception_id AND status IN (N'OPEN', N'REVIEWING');
      INSERT INTO ops.ActivityLog (exception_id, activity_type, actor_user_id, detail_json) VALUES (@exception_id, N'exception.resolved', @actor, @note);
      SELECT exception_id, status, resolution_note, resolved_at FROM ops.Exceptions WHERE exception_id = @exception_id;
    `);
  const row = result.recordsets.at(-1)?.[0];
  if (!row) throw Object.assign(new Error("Exception not found."), { statusCode: 404 });
  await recordAuditEvent({ moduleCode: "automation", actorUserId, eventType: `supplier.exception.${status.toLowerCase()}`, entityType: "ops.Exception", entityId: exceptionId, eventData: { note } });
  return row;
}

async function createFixtureWorkflow({ filename, contentType, buffer, actorUserId, storagePath }) {
  validateFixture(buffer, filename);
  const digest = sha256(buffer);
  const event = await createEvent({
    eventType: "supplier.status_file.received",
    sourceSystem: "supplier-fixture",
    externalReference: filename,
    key: idempotencyKey(["supplier-status-file", digest]),
    payload: { filename, contentType, sha256: digest, phase: "foundation", statusUpdatesEnabled: false }
  });
  if (event.duplicate) return { event, duplicate: true };
  const attachment = await createAttachment({ eventId: event.event_id, filename, contentType, buffer, storagePath });
  let parsed;
  try {
    parsed = await parseSupplierFile({ buffer, filename, contentType });
  } catch (error) {
    const pool = await getAppPool();
    await pool.request().input("event_id", event.event_id).input("type", "PARSING_ERROR").input("message", error.message).query(`
      INSERT INTO ops.Exceptions (event_id, exception_type, severity, message, technical_detail)
      VALUES (@event_id, @type, N'ERROR', @message, @message);
      UPDATE ops.Events SET status = N'FAILED', last_error = @message, updated_at = SYSUTCDATETIME() WHERE event_id = @event_id;
    `);
    throw error;
  }
  const pool = await getAppPool();
  const actions = [];
  let exceptions = 0;
  const sourceMode = String(process.env.OPTILENS_SUPPLIER_MATCH_MODE || "mock").toLowerCase() === "source";
  const sourceMatchingField = process.env.OPTILENS_SUPPLIER_MATCH_FIELD || "customer_order_reference";
  const sourceMatches = sourceMode
    ? new Map((await matchSupplierReferences(parsed.items.map((item) => item.supplierReference), { matchingField: sourceMatchingField })).map((result) => [result.supplierReference, result]))
    : new Map();
  for (const item of parsed.items) {
    const sourceResult = sourceMatches.get(item.supplierReference);
    const match = sourceMode ? sourceMatch(item, sourceResult) : developmentMatch(item);
    if (match) {
      actions.push(await createProposedAction({ eventId: event.event_id, item, match, actorUserId }));
      continue;
    }
    exceptions += 1;
    const outcome = item.warning ? "UNKNOWN_SUPPLIER_STATUS" : sourceMode ? (sourceResult?.matchResult || "Not Found").toUpperCase().replaceAll(" ", "_") : "UNMATCHED";
    await pool.request()
      .input("event_id", event.event_id)
      .input("type", outcome)
      .input("reference", item.supplierReference)
      .input("message", sourceMode ? `${sourceResult?.matchResult || "Not Found"}: ${item.supplierReference}.` : `No development match was configured for ${item.supplierReference}.`)
      .input("detail", safeJson({ item, match: sourceResult || { matched: false, outcome, targetReference: item.supplierReference }, matchingField: sourceMode ? sourceMatchingField : "development-mock" }))
      .query(`INSERT INTO ops.Exceptions (event_id, exception_type, severity, subject_reference, message, technical_detail)
              VALUES (@event_id, @type, N'WARNING', @reference, @message, @detail);`);
  }
  await pool.request().input("event_id", event.event_id).query("UPDATE ops.Events SET status = N'COMPLETED', completed_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() WHERE event_id = @event_id;");
  await recordAuditEvent({ moduleCode: "automation", actorUserId, eventType: "supplier.fixture.processed", entityType: "ops.Event", entityId: event.event_id, eventData: { attachmentId: attachment.attachment_id, itemCount: parsed.items.length, parser: parsed.parser } });
  return { event, attachment, parsed, duplicate: false, actions, exceptions };
}

module.exports = { ALLOWED_STATUSES, MAX_FIXTURE_BYTES, createAttachment, createEvent, createFixtureWorkflow, decideAction, idempotencyKey, listActions, listExceptions, listOperations, resolveException, sha256, validateFixture };
