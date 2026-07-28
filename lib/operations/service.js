const crypto = require("node:crypto");
const sql = require("mssql");
const { getAppPool } = require("../db");
const { recordAuditEvent } = require("../audit");
const { parseSupplierFile } = require("./supplier-parser");

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
  for (const item of parsed.items) {
    const match = { matched: false, outcome: "UNMATCHED", targetReference: item.supplierReference };
    await pool.request()
      .input("event_id", event.event_id)
      .input("type", match.outcome)
      .input("reference", item.supplierReference)
      .input("message", `No development match was configured for ${item.supplierReference}.`)
      .input("detail", safeJson({ item, match }))
      .query(`INSERT INTO ops.Exceptions (event_id, exception_type, severity, subject_reference, message, technical_detail)
              VALUES (@event_id, @type, N'WARNING', @reference, @message, @detail);`);
  }
  await pool.request().input("event_id", event.event_id).query("UPDATE ops.Events SET status = N'COMPLETED', completed_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() WHERE event_id = @event_id;");
  await recordAuditEvent({ moduleCode: "automation", actorUserId, eventType: "supplier.fixture.processed", entityType: "ops.Event", entityId: event.event_id, eventData: { attachmentId: attachment.attachment_id, itemCount: parsed.items.length, parser: parsed.parser } });
  return { event, attachment, parsed, duplicate: false, actions: [], exceptions: parsed.items.length };
}

module.exports = { ALLOWED_STATUSES, MAX_FIXTURE_BYTES, createAttachment, createEvent, createFixtureWorkflow, idempotencyKey, listActions, listExceptions, listOperations, sha256, validateFixture };
