const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const sql = require("mssql");
const { getAppPool, getSourcePool } = require("../db");
const { recordAuditEvent } = require("../audit");
const { mailboxFromVault } = require("../credential-vault");
const { parseSupplierFile } = require("./supplier-parser");
const { matchSupplierReferences, MATCH_FIELDS } = require("./matching");
const { archiveMailboxMessage: moveMailboxMessage, readMailbox } = require("./imap-mailbox");
const { routeMailboxMessage } = require("./mailbox-routing");
const { identifySupplier } = require("./mailbox-routing");
const { reconcileMailboxMessages } = require("./mailbox-reconciliation");
const { parseSkyLabPdf } = require("./skylab-pdf-parser");
const { applyCurrentStatusUpdate, checkSourceWriteCapability } = require("./source-status-writeback");
const { getConfig } = require("../config");
const { AUTO_APPLY_NOTE, eligibilityFromContext, shouldAutoApplySupplierStatus, tryAutoApplyHighConfidenceSupplierStatus } = require("./supplier-status-auto-apply");
const { sendDailyExceptionDigest } = require("./exception-digest");

const MAX_FIXTURE_BYTES = 5 * 1024 * 1024;
const ALLOWED_STATUSES = new Set(["RECEIVED", "PROCESSING", "WAITING_RETRY", "COMPLETED", "FAILED", "DEAD_LETTER"]);

function sha256(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }
function idempotencyKey(parts) { return parts.map((part) => String(part ?? "").trim()).join(":"); }
function safeJson(value) { return JSON.stringify(value === undefined ? null : value); }
function parseJson(value) { try { return value ? JSON.parse(value) : null; } catch { return null; } }

const MAILBOX_STORAGE_ROOT = path.join(__dirname, "..", "..", "data", "supplier-mailbox");

function senderAddress(message) {
  return String(message?.from?.address || message?.from?.value?.[0]?.address || message?.from?.email || "").trim().toLowerCase() || null;
}

function statusKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parserForRule(rule) {
  return String(rule?.parser_code || "").toLowerCase() === "skylabshippedpdfparser"
    ? "skylab"
    : "supplier";
}

function mailboxStoragePath(message, attachment) {
  const mailbox = String(message.mailboxCode || "classic-visions-orders").replace(/[^A-Za-z0-9._-]/g, "_");
  const uid = String(message.uid || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
  const filename = String(attachment.filename || "attachment").replace(/[^A-Za-z0-9._-]/g, "_");
  const folder = path.join(MAILBOX_STORAGE_ROOT, mailbox, uid);
  fs.mkdirSync(folder, { recursive: true });
  return path.join(folder, filename);
}

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

async function getActionDetail(actionId) {
  const pool = await getAppPool();
  const result = await pool.request().input("action_id", sql.UniqueIdentifier, actionId).query(`
    SELECT a.action_id, a.event_id, a.action_type, a.target_type, a.target_reference,
           a.risk_level, a.status, a.proposed_json, a.applied_json, a.created_at, a.decided_at,
           r.record_id, r.supplier_code, r.rule_code, r.supplier_reference, r.supplier_status,
           r.match_result, r.current_status_id, r.current_status_description,
           r.target_status_item_id, r.target_status_description, r.parse_state,
           w.result AS writeback_result, w.error_detail AS writeback_error
    FROM ops.Actions a
    LEFT JOIN ops.SupplierRecords r ON r.action_id = a.action_id
    LEFT JOIN ops.SourceStatusWritebacks w ON w.action_id = a.action_id
    WHERE a.action_id = @action_id;
  `);
  const row = result.recordset[0];
  if (!row) throw Object.assign(new Error("Action not found."), { statusCode: 404 });
  const proposed = parseJson(row.proposed_json) || {};
  let writeCapability = { writable: false, detail: "Source write-back has not been checked." };
  try { writeCapability = await checkSourceWriteCapability(); } catch (error) { writeCapability = { writable: false, detail: error.message }; }
  const blockers = [];
  if (row.status !== "WAITING_APPROVAL") blockers.push(`Action is ${row.status}.`);
  if (!proposed.targetStatusItemId) blockers.push("No confirmed CurrentStatusID mapping is available.");
  if (!writeCapability.writable) blockers.push(writeCapability.detail || "Source write-back is not ready.");
  return { action: { ...row, proposed, applied: parseJson(row.applied_json) }, writeCapability, blockers };
}

async function getExceptionDetail(exceptionId) {
  const pool = await getAppPool();
  const result = await pool.request().input("exception_id", sql.UniqueIdentifier, exceptionId).query(`
    SELECT e.exception_id, e.event_id, e.exception_type, e.severity, e.status,
           e.subject_reference, e.message, e.technical_detail, e.created_at,
           m.mailbox_message_id, m.subject AS mailbox_subject,
           r.record_id, r.rule_code, r.supplier_code, r.supplier_status, r.match_result
    FROM ops.Exceptions e
    LEFT JOIN ops.MailboxMessages m ON m.event_id = e.event_id
    LEFT JOIN ops.SupplierRecords r ON r.event_id = e.event_id
      AND (e.subject_reference IS NULL OR r.supplier_reference = e.subject_reference)
    WHERE e.exception_id = @exception_id;
  `);
  const row = result.recordset[0];
  if (!row) throw Object.assign(new Error("Exception not found."), { statusCode: 404 });
  const detail = parseJson(row.technical_detail) || row.technical_detail || null;
  let remediation = { panel: "mailbox", label: "Open source message", messageId: row.mailbox_message_id || null };
  if (row.exception_type === "STATUS_MAPPING_PENDING") {
    const key = statusKey(row.supplier_status || detail?.supplierStatus);
    const mapping = await pool.request().input("rule_code", sql.NVarChar(120), row.rule_code || detail?.rule || null).input("status_key", sql.NVarChar(160), key).query(`
      SELECT TOP (1) mapping_id FROM ops.SupplierStatusMappings
      WHERE rule_code = @rule_code AND supplier_status_key = @status_key;
    `);
    remediation = { panel: "rules-panel", label: "Confirm status mapping", mappingId: mapping.recordset[0]?.mapping_id || null };
  } else if (/PARSING_ERROR/i.test(row.exception_type)) {
    remediation = { panel: "mailbox", label: "Open message and parser evidence", messageId: row.mailbox_message_id || null };
  } else if (/MATCH|NOT_FOUND|DUPLICATE/i.test(row.exception_type)) {
    remediation = { panel: "mailbox", label: "Open matching evidence", messageId: row.mailbox_message_id || null, recordId: row.record_id || null };
  }
  return { exception: { ...row, detail }, remediation };
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

async function listSupplierRules() {
  const pool = await getAppPool();
  const result = await pool.request().query(`
    SELECT rule_code, supplier_code, supplier_name, sender_address, sender_domain,
           subject_match_type, subject_pattern, report_code, parser_code,
           matching_field, attachment_required, allowed_extensions, priority,
           mapping_state, is_enabled, notes, created_at, updated_at
    FROM ops.SupplierRules ORDER BY priority, rule_code;
  `);
  return result.recordset;
}

const SUBJECT_MATCH_TYPES = new Set(["EXACT", "CONTAINS", "STARTS_WITH", "REGEX"]);
const RULE_MAPPING_STATES = new Set(["PENDING_CONFIRMATION", "CONFIRMED", "DISABLED"]);

function requireNonEmptyString(value, label, { maxLength = 260 } = {}) {
  const text = String(value ?? "").trim();
  if (!text) throw Object.assign(new Error(`${label} is required.`), { statusCode: 400 });
  if (text.length > maxLength) throw Object.assign(new Error(`${label} must be ${maxLength} characters or fewer.`), { statusCode: 400 });
  return text;
}

function optionalString(value, { maxLength = 260 } = {}) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length > maxLength) throw Object.assign(new Error(`Value must be ${maxLength} characters or fewer.`), { statusCode: 400 });
  return text;
}

function normalizeSupplierRulePatch(input = {}) {
  const subjectMatchType = String(input.subject_match_type || "").trim().toUpperCase();
  if (!SUBJECT_MATCH_TYPES.has(subjectMatchType)) throw Object.assign(new Error("Subject match type must be EXACT, CONTAINS, STARTS_WITH, or REGEX."), { statusCode: 400 });
  const mappingState = String(input.mapping_state || "PENDING_CONFIRMATION").trim().toUpperCase();
  if (!RULE_MAPPING_STATES.has(mappingState)) throw Object.assign(new Error("Rule state must be PENDING_CONFIRMATION, CONFIRMED, or DISABLED."), { statusCode: 400 });
  const matchingField = optionalString(input.matching_field, { maxLength: 80 });
  if (matchingField && !MATCH_FIELDS[matchingField]) throw Object.assign(new Error(`Unsupported matching field: ${matchingField}.`), { statusCode: 400 });
  const priority = Number(input.priority);
  const port = Number.isSafeInteger(priority) && priority > 0 ? priority : 100;
  return {
    supplier_code: requireNonEmptyString(input.supplier_code, "Supplier code", { maxLength: 80 }),
    supplier_name: requireNonEmptyString(input.supplier_name, "Supplier name", { maxLength: 200 }),
    sender_address: optionalString(input.sender_address, { maxLength: 260 }),
    sender_domain: optionalString(input.sender_domain, { maxLength: 260 }),
    subject_match_type: subjectMatchType,
    subject_pattern: requireNonEmptyString(input.subject_pattern, "Subject pattern", { maxLength: 500 }),
    report_code: requireNonEmptyString(input.report_code, "Report code", { maxLength: 120 }),
    parser_code: requireNonEmptyString(input.parser_code, "Parser", { maxLength: 120 }),
    matching_field: matchingField,
    attachment_required: Boolean(input.attachment_required),
    allowed_extensions: requireNonEmptyString(input.allowed_extensions, "Allowed extensions", { maxLength: 200 }),
    priority: port,
    is_enabled: Boolean(input.is_enabled),
    mapping_state: mappingState,
    notes: optionalString(input.notes, { maxLength: 4000 })
  };
}

async function createSupplierRule({ ruleCode, actorUserId, ...input }) {
  const code = requireNonEmptyString(ruleCode, "Rule code", { maxLength: 120 });
  if (!/^[a-z0-9][a-z0-9-]{1,119}$/.test(code)) throw Object.assign(new Error("Rule code must be lowercase letters, numbers, and hyphens only."), { statusCode: 400 });
  const patch = normalizeSupplierRulePatch(input);
  const pool = await getAppPool();
  try {
    const result = await pool.request()
      .input("rule_code", sql.NVarChar(120), code)
      .input("supplier_code", sql.NVarChar(80), patch.supplier_code)
      .input("supplier_name", sql.NVarChar(200), patch.supplier_name)
      .input("sender_address", sql.NVarChar(260), patch.sender_address)
      .input("sender_domain", sql.NVarChar(260), patch.sender_domain)
      .input("subject_match_type", sql.NVarChar(30), patch.subject_match_type)
      .input("subject_pattern", sql.NVarChar(500), patch.subject_pattern)
      .input("report_code", sql.NVarChar(120), patch.report_code)
      .input("parser_code", sql.NVarChar(120), patch.parser_code)
      .input("matching_field", sql.NVarChar(80), patch.matching_field)
      .input("attachment_required", sql.Bit, patch.attachment_required)
      .input("allowed_extensions", sql.NVarChar(200), patch.allowed_extensions)
      .input("priority", sql.Int, patch.priority)
      .input("notes", sql.NVarChar(sql.MAX), patch.notes)
      .query(`
        INSERT INTO ops.SupplierRules
          (rule_code, supplier_code, supplier_name, sender_address, sender_domain,
           subject_match_type, subject_pattern, report_code, parser_code,
           matching_field, attachment_required, allowed_extensions, priority, notes)
        OUTPUT inserted.rule_code
        VALUES
          (@rule_code, @supplier_code, @supplier_name, @sender_address, @sender_domain,
           @subject_match_type, @subject_pattern, @report_code, @parser_code,
           @matching_field, @attachment_required, @allowed_extensions, @priority, @notes);
      `);
    await recordAuditEvent({ moduleCode: "automation", actorUserId, eventType: "supplier.rule.created", entityType: "ops.SupplierRule", entityId: result.recordset[0].rule_code, eventData: patch });
  } catch (error) {
    if (String(error.message || "").includes("UQ_ops_supplier_rules_code")) throw Object.assign(new Error(`A rule with code "${code}" already exists.`), { statusCode: 409 });
    throw error;
  }
  return { rules: await listSupplierRules() };
}

async function updateSupplierRule({ ruleCode, actorUserId, ...input }) {
  const code = requireNonEmptyString(ruleCode, "Rule code", { maxLength: 120 });
  const patch = normalizeSupplierRulePatch(input);
  const pool = await getAppPool();
  const result = await pool.request()
    .input("rule_code", sql.NVarChar(120), code)
    .input("supplier_code", sql.NVarChar(80), patch.supplier_code)
    .input("supplier_name", sql.NVarChar(200), patch.supplier_name)
    .input("sender_address", sql.NVarChar(260), patch.sender_address)
    .input("sender_domain", sql.NVarChar(260), patch.sender_domain)
    .input("subject_match_type", sql.NVarChar(30), patch.subject_match_type)
    .input("subject_pattern", sql.NVarChar(500), patch.subject_pattern)
    .input("report_code", sql.NVarChar(120), patch.report_code)
    .input("parser_code", sql.NVarChar(120), patch.parser_code)
    .input("matching_field", sql.NVarChar(80), patch.matching_field)
    .input("attachment_required", sql.Bit, patch.attachment_required)
    .input("allowed_extensions", sql.NVarChar(200), patch.allowed_extensions)
    .input("priority", sql.Int, patch.priority)
    .input("is_enabled", sql.Bit, patch.is_enabled)
    .input("mapping_state", sql.NVarChar(40), patch.mapping_state)
    .input("notes", sql.NVarChar(sql.MAX), patch.notes)
    .query(`
      UPDATE ops.SupplierRules
      SET supplier_code = @supplier_code, supplier_name = @supplier_name,
          sender_address = @sender_address, sender_domain = @sender_domain,
          subject_match_type = @subject_match_type, subject_pattern = @subject_pattern,
          report_code = @report_code, parser_code = @parser_code,
          matching_field = @matching_field, attachment_required = @attachment_required,
          allowed_extensions = @allowed_extensions, priority = @priority,
          is_enabled = @is_enabled, mapping_state = @mapping_state, notes = @notes,
          updated_at = SYSUTCDATETIME()
      WHERE rule_code = @rule_code;
      SELECT @@ROWCOUNT AS affected;
    `);
  if (!result.recordset[0]?.affected) throw Object.assign(new Error(`Rule "${code}" was not found.`), { statusCode: 404 });
  await recordAuditEvent({ moduleCode: "automation", actorUserId, eventType: "supplier.rule.updated", entityType: "ops.SupplierRule", entityId: code, eventData: patch });
  return { rules: await listSupplierRules() };
}

async function deleteSupplierRule({ ruleCode, actorUserId }) {
  const code = requireNonEmptyString(ruleCode, "Rule code", { maxLength: 120 });
  const pool = await getAppPool();
  const existing = await pool.request().input("rule_code", sql.NVarChar(120), code).query(`
    SELECT rule_code, is_enabled FROM ops.SupplierRules WHERE rule_code = @rule_code;
  `);
  const row = existing.recordset[0];
  if (!row) throw Object.assign(new Error(`Rule "${code}" was not found.`), { statusCode: 404 });
  if (row.is_enabled) throw Object.assign(new Error("Disable the rule before deleting it."), { statusCode: 409 });
  await pool.request().input("rule_code", sql.NVarChar(120), code).query(`DELETE FROM ops.SupplierRules WHERE rule_code = @rule_code;`);
  await recordAuditEvent({ moduleCode: "automation", actorUserId, eventType: "supplier.rule.deleted", entityType: "ops.SupplierRule", entityId: code, eventData: {} });
  return { rules: await listSupplierRules() };
}

async function getMailboxConfiguration() {
  const pool = await getAppPool();
  const result = await pool.request().query(`
    SELECT TOP 1 configuration_code, configuration_name, protocol, server_hostname, port,
           ssl_enabled, mailbox_username, folder_name, processed_folder_name,
           scan_previous_days, max_messages_per_run, unread_only, is_enabled,
           created_at, updated_at
    FROM ops.MailboxConfigurations WHERE configuration_code = N'classic-visions-orders';
  `);
  const config = result.recordset[0] || null;
  const credential = mailboxFromVault();
  return { config, credentialConfigured: Boolean(credential), smtpConfigured: Boolean(credential?.smtpHost && credential?.smtpPort) };
}

async function updateMailboxConfiguration({ actorUserId, ...input }) {
  const port = Number(input.port);
  const scanDays = Number(input.scan_previous_days);
  const maxMessages = Number(input.max_messages_per_run);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error("Port must be between 1 and 65535."), { statusCode: 400 });
  if (!Number.isSafeInteger(scanDays) || scanDays < 1 || scanDays > 90) throw Object.assign(new Error("Scan window must be between 1 and 90 days."), { statusCode: 400 });
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 1000) throw Object.assign(new Error("Max messages per run must be between 1 and 1000."), { statusCode: 400 });
  const patch = {
    configuration_name: requireNonEmptyString(input.configuration_name, "Configuration name", { maxLength: 200 }),
    server_hostname: requireNonEmptyString(input.server_hostname, "Server hostname", { maxLength: 260 }),
    port,
    ssl_enabled: Boolean(input.ssl_enabled),
    mailbox_username: requireNonEmptyString(input.mailbox_username, "Mailbox username", { maxLength: 260 }),
    folder_name: requireNonEmptyString(input.folder_name, "Folder to scan", { maxLength: 260 }),
    processed_folder_name: optionalString(input.processed_folder_name, { maxLength: 260 }),
    scan_previous_days: scanDays,
    max_messages_per_run: maxMessages,
    unread_only: Boolean(input.unread_only),
    is_enabled: Boolean(input.is_enabled)
  };
  const pool = await getAppPool();
  const result = await pool.request()
    .input("configuration_name", sql.NVarChar(200), patch.configuration_name)
    .input("server_hostname", sql.NVarChar(260), patch.server_hostname)
    .input("port", sql.Int, patch.port)
    .input("ssl_enabled", sql.Bit, patch.ssl_enabled)
    .input("mailbox_username", sql.NVarChar(260), patch.mailbox_username)
    .input("folder_name", sql.NVarChar(260), patch.folder_name)
    .input("processed_folder_name", sql.NVarChar(260), patch.processed_folder_name)
    .input("scan_previous_days", sql.Int, patch.scan_previous_days)
    .input("max_messages_per_run", sql.Int, patch.max_messages_per_run)
    .input("unread_only", sql.Bit, patch.unread_only)
    .input("is_enabled", sql.Bit, patch.is_enabled)
    .query(`
      UPDATE ops.MailboxConfigurations
      SET configuration_name = @configuration_name, server_hostname = @server_hostname,
          port = @port, ssl_enabled = @ssl_enabled, mailbox_username = @mailbox_username,
          folder_name = @folder_name, processed_folder_name = @processed_folder_name,
          scan_previous_days = @scan_previous_days, max_messages_per_run = @max_messages_per_run,
          unread_only = @unread_only, is_enabled = @is_enabled, updated_at = SYSUTCDATETIME()
      WHERE configuration_code = N'classic-visions-orders';
      SELECT @@ROWCOUNT AS affected;
    `);
  if (!result.recordset[0]?.affected) throw Object.assign(new Error("Mailbox configuration was not found."), { statusCode: 404 });
  await recordAuditEvent({ moduleCode: "automation", actorUserId, eventType: "supplier.mailbox.configuration_updated", entityType: "ops.MailboxConfiguration", entityId: "classic-visions-orders", eventData: patch });
  return getMailboxConfiguration();
}

async function listMailboxReconciliation() {
  const pool = await getAppPool();
  const configResult = await pool.request().query(`
    SELECT TOP 1 configuration_code, protocol, server_hostname, port, ssl_enabled,
           mailbox_username, folder_name, scan_previous_days, max_messages_per_run,
           unread_only, is_enabled
    FROM ops.MailboxConfigurations WHERE configuration_code = N'classic-visions-orders';
  `);
  const config = configResult.recordset[0];
  if (!config) return { state: "not-configured", scanned: 0, rows: [] };
  const credential = mailboxFromVault();
  if (!credential) return { state: "credentials-needed", configuration: config.configuration_code, scanned: 0, rows: [] };
  const rules = (await pool.request().query(`
    SELECT rule_code, sender_address, sender_domain, subject_match_type,
           subject_pattern, allowed_extensions, attachment_required,
           mapping_state, is_enabled, priority
    FROM ops.SupplierRules ORDER BY priority, rule_code;
  `)).recordset;
  const processedResult = await pool.request().query(`SELECT idempotency_key FROM ops.Events WHERE source_system = N'supplier-mailbox';`);
  const processedKeys = new Set(processedResult.recordset.map((row) => row.idempotency_key));
  const scan = await readMailbox({
    config: {
      ...config,
      is_enabled: true,
      server_hostname: credential.host || config.server_hostname,
      port: credential.port || config.port,
      mailbox_username: credential.username || config.mailbox_username,
      folder_name: credential.folder || config.folder_name
    },
    credential,
    rules,
    onMessage: async (message) => {
      const routed = routeMailboxMessage(message, rules);
      return {
        uid: message.uid,
        messageId: message.messageId,
        subject: message.subject,
        date: message.date,
        isRead: message.isRead,
        idempotencyKey: message.idempotencyKey,
        routingState: routed.reason,
        ruleCode: routed.rule?.rule_code || null,
        acceptedAttachmentCount: routed.acceptedAttachments.length
      };
    }
  });
  const reconciliation = reconcileMailboxMessages(scan.results.map((entry) => entry.result), processedKeys);
  return { state: "connected", configuration: config.configuration_code, ...reconciliation };
}

async function upsertMailboxMessage({ pool, eventId, config, message, supplier, routed }) {
  const result = await pool.request()
    .input("event_id", sql.UniqueIdentifier, eventId)
    .input("mailbox_code", sql.NVarChar(120), config.configuration_code)
    .input("uid", sql.BigInt, Number(message.uid))
    .input("message_key", sql.NVarChar(128), message.idempotencyKey)
    .input("message_id", sql.NVarChar(500), message.messageId || null)
    .input("supplier_code", sql.NVarChar(80), supplier.supplierCode)
    .input("supplier_name", sql.NVarChar(200), supplier.supplierName)
    .input("sender_address", sql.NVarChar(260), senderAddress(message))
    .input("subject", sql.NVarChar(1000), message.subject || "")
    .input("received_at", sql.DateTime2, message.date ? new Date(message.date) : null)
    .input("is_read", sql.Bit, Boolean(message.isRead))
    .input("routing_state", sql.NVarChar(60), routed.reason)
    .input("processing_state", sql.NVarChar(60), ["MATCHED", "DISCOVERY_PENDING"].includes(routed.reason) ? "WAITING_PROCESSING" : "NOT_PROCESSED")
    .input("rule_code", sql.NVarChar(120), routed.rule?.rule_code || supplier.rule?.rule_code || null)
    .input("attachment_count", sql.Int, Array.isArray(message.attachments) ? message.attachments.length : 0)
    .query(`
      IF EXISTS (SELECT 1 FROM ops.MailboxMessages WHERE message_key = @message_key)
      BEGIN
        UPDATE ops.MailboxMessages
        SET event_id = @event_id,
            uid = @uid,
            message_id = @message_id,
            supplier_code = @supplier_code,
            supplier_name = @supplier_name,
            sender_address = @sender_address,
            subject = @subject,
            received_at = @received_at,
            is_read = @is_read,
            routing_state = @routing_state,
            processing_state = @processing_state,
            rule_code = @rule_code,
            attachment_count = @attachment_count,
            updated_at = SYSUTCDATETIME()
        WHERE message_key = @message_key;
      END
      ELSE
      BEGIN
        INSERT INTO ops.MailboxMessages
          (event_id, mailbox_code, uid, message_key, message_id, supplier_code, supplier_name,
           sender_address, subject, received_at, is_read, routing_state, processing_state,
           rule_code, attachment_count)
        VALUES
          (@event_id, @mailbox_code, @uid, @message_key, @message_id, @supplier_code, @supplier_name,
           @sender_address, @subject, @received_at, @is_read, @routing_state, @processing_state,
           @rule_code, @attachment_count);
      END
      SELECT mailbox_message_id FROM ops.MailboxMessages WHERE message_key = @message_key;
    `);
  return result.recordset[0]?.mailbox_message_id;
}

async function ensureStatusMapping({ pool, rule, item }) {
  const key = statusKey(item.supplierStatus || item.normalizedStatus);
  if (!key) return null;
  await pool.request()
    .input("rule_code", sql.NVarChar(120), rule.rule_code)
    .input("supplier_code", sql.NVarChar(80), rule.supplier_code)
    .input("supplier_status_key", sql.NVarChar(160), key)
    .input("supplier_status_label", sql.NVarChar(160), item.supplierStatus || item.normalizedStatus)
    .query(`
      IF NOT EXISTS (SELECT 1 FROM ops.SupplierStatusMappings WHERE rule_code = @rule_code AND supplier_status_key = @supplier_status_key)
        INSERT INTO ops.SupplierStatusMappings (rule_code, supplier_code, supplier_status_key, supplier_status_label)
        VALUES (@rule_code, @supplier_code, @supplier_status_key, @supplier_status_label);
    `);
  const result = await pool.request()
    .input("rule_code", sql.NVarChar(120), rule.rule_code)
    .input("supplier_status_key", sql.NVarChar(160), key)
    .query(`
      SELECT TOP (1) mapping_id, target_status_item_id, target_status_description, mapping_state
      FROM ops.SupplierStatusMappings
      WHERE rule_code = @rule_code AND supplier_status_key = @supplier_status_key;
    `);
  return result.recordset[0] || null;
}

async function parseMailboxAttachment({ attachment, rule }) {
  const buffer = Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.from(attachment.content || "");
  if (parserForRule(rule) === "skylab") return parseSkyLabPdf(buffer, attachment.filename);
  return parseSupplierFile({ buffer, filename: attachment.filename, contentType: attachment.contentType });
}

async function insertMailboxException(pool, { eventId, reference = null, type, message, detail = null }) {
  await pool.request()
    .input("event_id", sql.UniqueIdentifier, eventId)
    .input("type", sql.NVarChar(120), type)
    .input("reference", sql.NVarChar(300), reference)
    .input("message", sql.NVarChar(1000), message)
    .input("detail", sql.NVarChar(sql.MAX), detail ? safeJson(detail) : null)
    .query(`
      INSERT INTO ops.Exceptions (event_id, exception_type, severity, subject_reference, message, technical_detail)
      VALUES (@event_id, @type, N'WARNING', @reference, @message, @detail);
    `);
}

async function insertSupplierRecord({ pool, mailboxMessageId, eventId, attachmentId, rowNumber, rule, item, sourceResult, mapping, state, errorDetail = null }) {
  const match = sourceResult?.matches?.[0] || null;
  const result = await pool.request()
    .input("mailbox_message_id", sql.UniqueIdentifier, mailboxMessageId)
    .input("event_id", sql.UniqueIdentifier, eventId)
    .input("attachment_id", sql.UniqueIdentifier, attachmentId)
    .input("row_number", sql.Int, rowNumber)
    .input("supplier_code", sql.NVarChar(80), rule.supplier_code)
    .input("rule_code", sql.NVarChar(120), rule.rule_code)
    .input("supplier_reference", sql.NVarChar(300), item.supplierReference)
    .input("supplier_status", sql.NVarChar(160), item.supplierStatus || null)
    .input("normalized_status", sql.NVarChar(160), item.normalizedStatus || null)
    .input("record_kind", sql.NVarChar(40), item.invType || null)
    .input("raw_json", sql.NVarChar(sql.MAX), safeJson(item))
    .input("parse_state", sql.NVarChar(40), state)
    .input("match_result", sql.NVarChar(60), sourceResult?.matchResult || null)
    .input("internal_order_id", sql.Int, match?.internal_order_id || null)
    .input("current_status_id", sql.Int, match?.current_status_id || null)
    .input("current_status_description", sql.NVarChar(300), match?.current_status_description || null)
    .input("patient_id", sql.NVarChar(300), match?.patient_id || null)
    .input("customer_id", sql.Int, match?.customer_id || null)
    .input("customer_name", sql.NVarChar(220), match?.customer_name || null)
    .input("customer_account", sql.NVarChar(120), match?.customer_account || null)
    .input("received_at", sql.DateTime2, match?.received_at ? new Date(match.received_at) : null)
    .input("target_status_item_id", sql.Int, mapping?.target_status_item_id || null)
    .input("target_status_description", sql.NVarChar(300), mapping?.target_status_description || null)
    .input("error_detail", sql.NVarChar(sql.MAX), errorDetail ? safeJson(errorDetail) : null)
    .input("is_active", sql.Bit, match?.is_active === false ? false : true)
    .query(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      BEGIN TRY
      DECLARE @record_id uniqueidentifier;
      DECLARE @inserted_record_ids TABLE (record_id uniqueidentifier);
      SELECT @record_id = record_id
      FROM ops.SupplierRecords WITH (UPDLOCK, HOLDLOCK)
      WHERE internal_order_id = @internal_order_id AND lifecycle_state = N'ACTIVE';

      IF @record_id IS NULL AND @internal_order_id IS NOT NULL AND @is_active = 0
        SELECT TOP (1) @record_id = record_id
        FROM ops.SupplierRecords WITH (UPDLOCK, HOLDLOCK)
        WHERE internal_order_id = @internal_order_id
        ORDER BY last_observed_at DESC, updated_at DESC;

      -- Reuse an existing unresolved placeholder for this reference so a
      -- still-unmatched job reappearing in the next report updates in place
      -- instead of piling up a fresh exception row every time it is resent,
      -- and so it can be promoted to Matched once the source order appears.
      IF @record_id IS NULL
        SELECT TOP (1) @record_id = record_id
        FROM ops.SupplierRecords WITH (UPDLOCK, HOLDLOCK)
        WHERE rule_code = @rule_code
          AND supplier_reference = @supplier_reference
          AND internal_order_id IS NULL
          AND lifecycle_state = N'ACTIVE'
        ORDER BY last_observed_at DESC, updated_at DESC;

      IF @record_id IS NULL
        SELECT @record_id = record_id
        FROM ops.SupplierRecords WITH (UPDLOCK, HOLDLOCK)
        WHERE event_id = @event_id AND attachment_id = @attachment_id AND row_number = @row_number;

      IF @record_id IS NOT NULL
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM ops.SupplierRecordOccurrences
          WHERE event_id = @event_id AND attachment_id = @attachment_id AND row_number = @row_number
        )
          UPDATE ops.Actions
          SET status = N'FAILED',
              decision_note = N'Superseded by a newer supplier email before operator action.',
              decided_at = SYSUTCDATETIME()
          WHERE action_id = (SELECT action_id FROM ops.SupplierRecords WHERE record_id = @record_id)
            AND status = N'WAITING_APPROVAL';

        UPDATE ops.SupplierRecords
        SET mailbox_message_id = @mailbox_message_id,
            supplier_code = @supplier_code,
            rule_code = @rule_code,
            supplier_reference = @supplier_reference,
            supplier_status = @supplier_status,
            normalized_status = @normalized_status,
            record_kind = @record_kind,
            raw_json = @raw_json,
            parse_state = CASE WHEN action_id IS NULL THEN @parse_state ELSE parse_state END,
            match_result = @match_result,
            internal_order_id = @internal_order_id,
            current_status_id = @current_status_id,
            current_status_description = @current_status_description,
            patient_id = @patient_id,
            customer_id = @customer_id,
            customer_name = @customer_name,
            customer_account = @customer_account,
            received_at = @received_at,
            target_status_item_id = @target_status_item_id,
            target_status_description = @target_status_description,
            error_detail = @error_detail,
            lifecycle_state = CASE WHEN @internal_order_id IS NOT NULL AND @is_active = 0 THEN N'ARCHIVED' ELSE lifecycle_state END,
            lifecycle_archive_reason = CASE WHEN @internal_order_id IS NOT NULL AND @is_active = 0 THEN N'TERMINATED' ELSE lifecycle_archive_reason END,
            first_observed_at = COALESCE(first_observed_at, created_at, SYSUTCDATETIME()),
            last_observed_at = SYSUTCDATETIME(),
            terminated_at = CASE WHEN @internal_order_id IS NOT NULL AND @is_active = 0 THEN COALESCE(terminated_at, SYSUTCDATETIME()) ELSE terminated_at END,
            updated_at = SYSUTCDATETIME()
        WHERE record_id = @record_id;
      END
      ELSE
      BEGIN
        INSERT INTO ops.SupplierRecords
          (mailbox_message_id, event_id, attachment_id, row_number, supplier_code, rule_code,
           supplier_reference, supplier_status, normalized_status, record_kind, raw_json, parse_state,
           match_result, internal_order_id, current_status_id, current_status_description,
           patient_id, customer_id, customer_name, customer_account, received_at,
           target_status_item_id, target_status_description, error_detail,
           lifecycle_state, lifecycle_archive_reason, first_observed_at, last_observed_at, terminated_at)
        OUTPUT inserted.record_id INTO @inserted_record_ids
        VALUES
          (@mailbox_message_id, @event_id, @attachment_id, @row_number, @supplier_code, @rule_code,
           @supplier_reference, @supplier_status, @normalized_status, @record_kind, @raw_json, @parse_state,
           @match_result, @internal_order_id, @current_status_id, @current_status_description,
           @patient_id, @customer_id, @customer_name, @customer_account, @received_at,
           @target_status_item_id, @target_status_description, @error_detail,
           CASE WHEN @internal_order_id IS NOT NULL AND @is_active = 0 THEN N'ARCHIVED' ELSE N'ACTIVE' END,
           CASE WHEN @internal_order_id IS NOT NULL AND @is_active = 0 THEN N'TERMINATED' ELSE NULL END,
           SYSUTCDATETIME(), SYSUTCDATETIME(),
           CASE WHEN @internal_order_id IS NOT NULL AND @is_active = 0 THEN SYSUTCDATETIME() ELSE NULL END);
      END

      IF @record_id IS NULL SELECT @record_id = record_id FROM @inserted_record_ids;
      IF NOT EXISTS (SELECT 1 FROM ops.SupplierRecordOccurrences WHERE event_id = @event_id AND attachment_id = @attachment_id AND row_number = @row_number)
        INSERT INTO ops.SupplierRecordOccurrences (record_id, mailbox_message_id, event_id, attachment_id, row_number)
        VALUES (@record_id, @mailbox_message_id, @event_id, @attachment_id, @row_number);
      SELECT @record_id AS record_id;
      COMMIT TRANSACTION;
      END TRY
      BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
      END CATCH
    `);
  return result.recordset[0]?.record_id;
}

async function processMailboxMessage({ pool, config, message, mailboxMessageId, eventId, rule, routed, actorUserId }) {
  if (!rule || !["MATCHED", "DISCOVERY_PENDING"].includes(routed.reason) || !routed.acceptedAttachments.length) {
    await pool.request().input("message_id", sql.UniqueIdentifier, mailboxMessageId).query(`
      UPDATE ops.MailboxMessages SET processing_state = N'NOT_PROCESSED', updated_at = SYSUTCDATETIME()
      WHERE mailbox_message_id = @message_id;
    `);
    return { parsed: 0, actions: 0, exceptions: 0 };
  }

  let parsedCount = 0;
  let actionCount = 0;
  let appliedCount = 0;
  let exceptionCount = 0;
  for (const attachment of routed.acceptedAttachments) {
    const storagePath = mailboxStoragePath({ mailboxCode: config.configuration_code, uid: message.uid }, attachment);
    fs.writeFileSync(storagePath, attachment.content, { flag: "w" });
    const stored = await createAttachment({
      eventId,
      filename: attachment.filename,
      contentType: attachment.contentType,
      buffer: attachment.content,
      storagePath
    });
    let parsed;
    try {
      parsed = await parseMailboxAttachment({ attachment, rule });
      await pool.request()
        .input("attachment_id", sql.UniqueIdentifier, stored.attachment_id)
        .input("parser_code", sql.NVarChar(120), rule.parser_code)
        .query(`UPDATE ops.Attachments SET parser_code = @parser_code, processing_status = N'COMPLETED' WHERE attachment_id = @attachment_id;`);
    } catch (error) {
      exceptionCount += 1;
      await pool.request()
        .input("attachment_id", sql.UniqueIdentifier, stored.attachment_id)
        .input("parser_code", sql.NVarChar(120), rule.parser_code)
        .input("detail", sql.NVarChar(sql.MAX), error.message)
        .query(`UPDATE ops.Attachments SET parser_code = @parser_code, processing_status = N'FAILED', error_detail = @detail WHERE attachment_id = @attachment_id;`);
      await insertMailboxException(pool, { eventId, type: "PARSING_ERROR", message: error.message, detail: { attachment: attachment.filename, rule: rule.rule_code } });
      continue;
    }

    const references = parsed.items.map((item) => item.supplierReference);
    const sourceResults = new Map((await matchSupplierReferences(references, { matchingField: rule.matching_field })).map((item) => [item.supplierReference, item]));
    for (const item of parsed.items) {
      parsedCount += 1;
      const sourceResult = sourceResults.get(item.supplierReference) || { matchResult: "Not Found", matches: [] };
      const mapping = await ensureStatusMapping({ pool, rule, item });
      const canCreateAction = routed.reason === "MATCHED" && rule.is_enabled === true && String(rule.mapping_state).toUpperCase() === "CONFIRMED";
      const mapped = canCreateAction && mapping?.mapping_state === "CONFIRMED" && Number(mapping.target_status_item_id) > 0;
      const matched = sourceResult.matchResult === "Matched" && sourceResult.matches.length === 1;
      const state = !matched ? "MATCH_EXCEPTION" : !mapped ? "WAITING_MAPPING" : "WAITING_APPROVAL";
      const recordId = await insertSupplierRecord({ pool, mailboxMessageId, eventId, attachmentId: stored.attachment_id, rowNumber: item.sourceRow || parsedCount, rule, item, sourceResult, mapping: mapped ? mapping : null, state, errorDetail: !matched ? sourceResult.matchResult : !mapped ? "Status mapping is not confirmed." : null });
      if (!matched) {
        exceptionCount += 1;
        await insertMailboxException(pool, { eventId, reference: item.supplierReference, type: String(sourceResult.matchResult || "MATCH_EXCEPTION").toUpperCase().replaceAll(" ", "_"), message: `${sourceResult.matchResult || "Not Found"}: ${item.supplierReference}.`, detail: sourceResult });
        continue;
      }
      if (!mapped) {
        exceptionCount += 1;
        await insertMailboxException(pool, { eventId, reference: item.supplierReference, type: "STATUS_MAPPING_PENDING", message: `No confirmed CurrentStatusID mapping exists for ${item.supplierStatus || item.normalizedStatus}.`, detail: { rule: rule.rule_code, supplierStatus: item.supplierStatus } });
        continue;
      }

      const action = await createProposedAction({
        eventId,
        item,
        match: {
          targetReference: String(sourceResult.matches[0].internal_order_id),
          targetType: "innovations-order",
          proposedStatus: mapping.target_status_description,
          sourceOrder: sourceResult.matches[0]
        },
        targetStatusItemId: mapping.target_status_item_id,
        targetStatusDescription: mapping.target_status_description,
        recordId,
        mailboxMessageId,
        actorUserId
      });
      actionCount += action.duplicate ? 0 : 1;
      if (action.action_id) {
        await pool.request()
          .input("record_id", sql.UniqueIdentifier, recordId)
          .input("action_id", sql.UniqueIdentifier, action.action_id)
          .query(`UPDATE ops.SupplierRecords SET action_id = @action_id, updated_at = SYSUTCDATETIME() WHERE record_id = @record_id;`);
        let autoApply = { applied: false };
        try {
          autoApply = await autoApplyCreatedSupplierAction({ action, rule, mapping, sourceResult, actorUserId });
        } catch (error) {
          autoApply = { applied: false, reason: "writeback_failed", error: error.message };
        }
        if (autoApply.applied) appliedCount += 1;
      }
    }
  }
  const waitingCount = actionCount - appliedCount;
  const state = exceptionCount
    ? ((waitingCount || appliedCount) ? "PARTIALLY_PROCESSED" : "EXCEPTION")
    : waitingCount
      ? "WAITING_APPROVAL"
      : appliedCount
        ? "PROCESSED"
        : routed.reason === "DISCOVERY_PENDING" ? "DISCOVERY_ONLY" : "PROCESSED";
  await pool.request()
    .input("message_id", sql.UniqueIdentifier, mailboxMessageId)
    .input("state", sql.NVarChar(60), state)
    .query(`UPDATE ops.MailboxMessages SET processing_state = @state, updated_at = SYSUTCDATETIME() WHERE mailbox_message_id = @message_id;`);
  return { parsed: parsedCount, actions: actionCount, exceptions: exceptionCount };
}

async function captureMailboxMessage({ pool, config, rules, message, actorUserId }) {
  const supplier = identifySupplier(message, rules);
  if (!supplier.supplierCode) return null;
  let routed = routeMailboxMessage(message, rules);
  if (["NO_CONFIRMED_RULE", "REQUIRED_ATTACHMENT_NOT_FOUND"].includes(routed.reason)) {
    const discoveryRoute = routeMailboxMessage(message, rules, { discovery: true });
    if (discoveryRoute.matched || discoveryRoute.reason === "REQUIRED_ATTACHMENT_NOT_FOUND") routed = discoveryRoute;
  }
  const event = await createEvent({
    eventType: "supplier.mailbox.message.captured",
    sourceSystem: "supplier-mailbox",
    externalReference: message.messageId || String(message.uid),
    key: idempotencyKey(["supplier-mailbox-message", message.idempotencyKey]),
    payload: { uid: message.uid, messageId: message.messageId, subject: message.subject, supplierCode: supplier.supplierCode, routingState: routed.reason }
  });
  const mailboxMessageId = await upsertMailboxMessage({ pool, eventId: event.event_id, config, message, supplier, routed });
  const outcome = await processMailboxMessage({ pool, config, message, mailboxMessageId, eventId: event.event_id, rule: routed.rule, routed, actorUserId });
  let archive = { status: "NOT_READY" };
  if (outcome.parsed === 0 && outcome.actions === 0 && outcome.exceptions === 0) {
    try {
      archive = await autoArchiveEmptySupplierMessage({ mailboxMessageId, actorUserId, message, routed });
    } catch (archiveError) {
      archive = { status: "ARCHIVE_FAILED", detail: archiveError.message };
    }
  }
  await pool.request()
    .input("event_id", sql.UniqueIdentifier, event.event_id)
    .query(`UPDATE ops.Events SET status = N'COMPLETED', completed_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME() WHERE event_id = @event_id;`);
  return { event, mailboxMessageId, routingState: routed.reason, archive, ...outcome };
}

async function mailboxConfigAndRules() {
  const pool = await getAppPool();
  const configResult = await pool.request().query(`
    SELECT TOP 1 configuration_code, protocol, server_hostname, port, ssl_enabled,
           mailbox_username, folder_name, scan_previous_days, max_messages_per_run,
           unread_only, is_enabled
    FROM ops.MailboxConfigurations WHERE configuration_code = N'classic-visions-orders';
  `);
  const config = configResult.recordset[0];
  const rules = (await pool.request().query(`
    SELECT rule_code, supplier_code, supplier_name, sender_address, sender_domain,
           subject_match_type, subject_pattern, allowed_extensions, attachment_required,
           parser_code, matching_field, mapping_state, is_enabled, priority
    FROM ops.SupplierRules ORDER BY priority, rule_code;
  `)).recordset;
  return { pool, config, rules };
}

async function syncMailbox({ actorUserId = null } = {}) {
  const { pool, config, rules } = await mailboxConfigAndRules();
  if (!config) return { state: "not-configured", scanned: 0, captured: 0 };
  const credential = mailboxFromVault();
  if (!credential) return { state: "credentials-needed", configuration: config.configuration_code, scanned: 0, captured: 0 };
  const scan = await readMailbox({
    config: {
      ...config,
      is_enabled: true,
      server_hostname: credential.host || config.server_hostname,
      port: credential.port || config.port,
      mailbox_username: credential.username || config.mailbox_username,
      folder_name: credential.folder || config.folder_name
    },
    credential,
    rules,
    onMessage: async (message) => {
      const captured = await captureMailboxMessage({ pool, config, rules, message: { ...message, mailboxCode: config.configuration_code }, actorUserId });
      return { ...message, supplierCode: identifySupplier(message, rules).supplierCode, captured };
    }
  });
  const result = {
    state: "connected",
    configuration: config.configuration_code,
    scanned: scan.scanned,
    captured: scan.results.filter((item) => item.result?.supplierCode).length,
    results: scan.results.map((item) => item.result)
  };
  const digest = await sendDailyExceptionDigest({ pool, credential, enabled: getConfig().supplierExceptionDigestEnabled });
  return { ...result, digest };
}

function isShippedSupplierStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["shipped", "dispatch", "dispatched"].includes(normalized);
}

function isShippedCurrentStatus(value) {
  return /\bshipped\b|\bdispatched\b|\bdispatch\b/i.test(String(value || ""));
}

async function readSourceStatusItems() {
  const source = await getSourcePool();
  const result = await source.request().query(`
      SELECT TOP (500) StatusItemID AS status_item_id, StatusItemName AS status_item_name,
             Inactive AS inactive, Terminating AS terminating, Cancellation AS cancellation
      FROM dbo.StatusItems
      ORDER BY Inactive, StatusItemName, StatusItemID;
    `);
  return result.recordset;
}

async function refreshLiveOrderStatuses(records) {
  const rows = Array.isArray(records) ? records : [];
  const orderIds = [...new Set(rows
    .filter((row) => row.lifecycle_state !== "ARCHIVED")
    .map((row) => Number(row.internal_order_id))
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!orderIds.length) return { records: rows, state: "not-needed" };

  const source = await getSourcePool();
  const statusRows = [];
    for (let offset = 0; offset < orderIds.length; offset += 500) {
      const batch = orderIds.slice(offset, offset + 500);
      const request = source.request();
      const placeholders = batch.map((id, index) => {
        const name = `order_id_${index}`;
        request.input(name, sql.Int, id);
        return `@${name}`;
      }).join(", ");
      const result = await request.query(`
        SELECT o.OrderID AS internal_order_id,
               CAST(o.CustomerTrayID AS nvarchar(120)) AS tray_number,
               o.CurrentStatusID AS current_status_id,
               si.StatusItemName AS current_status_description,
               COALESCE(o.CustomerTime, o.ReceivedTime) AS received_at
        FROM dbo.Orders o
        LEFT JOIN dbo.StatusItems si ON si.StatusItemID = o.CurrentStatusID
        WHERE o.OrderID IN (${placeholders});
      `);
      statusRows.push(...result.recordset);
    }

  const current = new Map();
  for (const row of statusRows) current.set(Number(row.internal_order_id), row);

  return {
    state: "live",
    records: rows.map((row) => {
      if (row.lifecycle_state === "ARCHIVED") {
        return { ...row, live_status_state: "archived-snapshot" };
      }
      const live = current.get(Number(row.internal_order_id));
      if (!live) return { ...row, live_status_state: "not-found" };
      return {
        ...row,
        tray_number: live.tray_number ?? row.tray_number ?? null,
        current_status_id: live.current_status_id,
        current_status_description: live.current_status_description,
        received_at: live.received_at || row.received_at,
        is_shipped: isShippedCurrentStatus(live.current_status_description),
        live_status_state: "live"
      };
    })
  };
}

async function autoArchiveAppliedSupplierMessage({ mailboxMessageId, actorUserId }) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("mailbox_message_id", sql.UniqueIdentifier, mailboxMessageId)
    .query(`
      SELECT
        COUNT(*) AS record_count,
        SUM(CASE WHEN parse_state = N'APPLIED' THEN 1 ELSE 0 END) AS applied_count,
        SUM(CASE WHEN LOWER(LTRIM(RTRIM(COALESCE(normalized_status, supplier_status, N'')))) IN (N'shipped', N'dispatch', N'dispatched') THEN 1 ELSE 0 END) AS shipped_count
      FROM ops.SupplierRecords
      WHERE EXISTS (
        SELECT 1 FROM ops.SupplierRecordOccurrences o
        WHERE o.record_id = ops.SupplierRecords.record_id
          AND o.mailbox_message_id = @mailbox_message_id
      );
    `);
  const counts = result.recordset[0] || {};
  const recordCount = Number(counts.record_count || 0);
  if (!recordCount || Number(counts.applied_count || 0) !== recordCount) return { status: "NOT_READY" };
  if (Number(counts.shipped_count || 0) < 1) return { status: "NOT_SHIPPED" };
  return archiveSupplierMessage({ mailboxMessageId, actorUserId });
}

async function autoArchiveEmptySupplierMessage({ mailboxMessageId, actorUserId, message, routed }) {
  const noAttachments = !Array.isArray(message.attachments) || message.attachments.length === 0;
  const requiredAttachmentMissing = routed.reason === "REQUIRED_ATTACHMENT_NOT_FOUND";
  const parsedWithoutRows = routed.reason === "MATCHED" || routed.reason === "DISCOVERY_PENDING";
  if (!noAttachments && !requiredAttachmentMissing && !parsedWithoutRows) return { status: "NOT_EMPTY" };
  return archiveSupplierMessage({ mailboxMessageId, actorUserId });
}

async function archiveSupplierMessage({ mailboxMessageId, actorUserId }) {
  const pool = await getAppPool();
  const messageResult = await pool.request()
    .input("mailbox_message_id", sql.UniqueIdentifier, mailboxMessageId)
    .query(`
        SELECT TOP (1) mailbox_message_id, mailbox_code, uid, archive_state,
             processing_state, routing_state, attachment_count, mailbox_code AS configuration_code
      FROM ops.MailboxMessages WHERE mailbox_message_id = @mailbox_message_id;
    `);
  const message = messageResult.recordset[0];
  if (!message) throw Object.assign(new Error("Mailbox message not found."), { statusCode: 404 });
  if (message.archive_state === "ARCHIVED") return { mailboxMessageId, status: "ARCHIVED", duplicate: true };

  const records = await pool.request()
    .input("mailbox_message_id", sql.UniqueIdentifier, mailboxMessageId)
    .query(`
      SELECT COUNT(*) AS actionable_count,
             SUM(CASE WHEN parse_state = N'APPLIED' THEN 1 ELSE 0 END) AS applied_count
      FROM ops.SupplierRecords r
      WHERE EXISTS (
        SELECT 1 FROM ops.SupplierRecordOccurrences o
        WHERE o.record_id = r.record_id AND o.mailbox_message_id = @mailbox_message_id
      );
    `);
  const counts = records.recordset[0] || {};
  const emptyMessage = Number(counts.actionable_count || 0) === 0 && (
    Number(message.attachment_count || 0) === 0 ||
    message.routing_state === "REQUIRED_ATTACHMENT_NOT_FOUND" ||
    message.processing_state === "PROCESSED"
  );
  if (!emptyMessage && (Number(counts.actionable_count) < 1 || Number(counts.applied_count) !== Number(counts.actionable_count))) {
    throw Object.assign(new Error("This email can only be archived after every actionable record has an applied CurrentStatusID update."), { statusCode: 409, code: "archive_not_ready" });
  }

  const configResult = await pool.request().query(`
    SELECT TOP (1) configuration_code, protocol, server_hostname, port, ssl_enabled,
           mailbox_username, folder_name, processed_folder_name
    FROM ops.MailboxConfigurations WHERE configuration_code = N'classic-visions-orders';
  `);
  const config = configResult.recordset[0];
  const credential = mailboxFromVault();
  if (!config || !credential) throw new Error("Mailbox credential is not configured in the secure vault.");
  const folder = String(config.processed_folder_name || "").trim();
  if (!folder) throw new Error("Configure a processed mailbox folder before archiving.");
  const moved = await moveMailboxMessage({ config: { ...config, is_enabled: true, server_hostname: credential.host || config.server_hostname, port: credential.port || config.port, mailbox_username: credential.username || config.mailbox_username, folder_name: credential.folder || config.folder_name }, credential, uid: message.uid, folder });
  await pool.request()
    .input("mailbox_message_id", sql.UniqueIdentifier, mailboxMessageId)
    .input("folder", sql.NVarChar(260), folder)
    .query(`UPDATE ops.MailboxMessages SET archive_state = N'ARCHIVED', archive_folder = @folder, updated_at = SYSUTCDATETIME() WHERE mailbox_message_id = @mailbox_message_id;`);
  await recordAuditEvent({ moduleCode: "automation", actorUserId, eventType: "supplier.mailbox.archived", entityType: "ops.MailboxMessage", entityId: mailboxMessageId, eventData: moved });
  return { mailboxMessageId, status: "ARCHIVED", folder, duplicate: false };
}

async function listMailboxWorkspace({ supplierCode = null, mailboxMessageId = null, limit = 250 } = {}) {
  const bounded = Math.min(Math.max(Number(limit) || 250, 1), 500);
  const pool = await getAppPool();
  const messages = await pool.request()
    .input("supplier_code", sql.NVarChar(80), supplierCode || null)
    .input("limit", sql.Int, bounded)
    .query(`
      SELECT TOP (@limit)
        mailbox_message_id, mailbox_code, uid, message_key, message_id,
        supplier_code, supplier_name, sender_address, subject, received_at,
        is_read, routing_state, processing_state, archive_state, rule_code,
        attachment_count, last_error
      FROM ops.MailboxMessages
      WHERE archive_state = N'IN_INBOX'
        AND (@supplier_code IS NULL OR supplier_code = @supplier_code)
      ORDER BY received_at DESC, mailbox_message_id DESC;
    `);
  const records = await pool.request()
    .input("supplier_code", sql.NVarChar(80), supplierCode || null)
    .input("mailbox_message_id", sql.UniqueIdentifier, mailboxMessageId || null)
    .input("limit", sql.Int, bounded * 10)
    .query(`
      SELECT TOP (@limit)
        r.record_id, r.mailbox_message_id, r.event_id, r.attachment_id,
        r.row_number, r.supplier_code, r.rule_code, r.supplier_reference,
        r.supplier_status, r.normalized_status, r.record_kind, r.parse_state,
        r.match_result, r.internal_order_id, r.current_status_id,
        r.current_status_description, r.patient_id, r.customer_id,
        r.customer_name, r.customer_account,
        r.received_at, r.target_status_item_id,
        r.target_status_description, r.action_id, r.error_detail,
        r.created_at, r.lifecycle_state, r.lifecycle_archive_reason, r.first_observed_at,
        r.last_observed_at, r.terminated_at, a.status AS action_status
      FROM ops.SupplierRecords r
      LEFT JOIN ops.Actions a ON a.action_id = r.action_id
      WHERE (@supplier_code IS NULL OR r.supplier_code = @supplier_code)
        AND (
          (@mailbox_message_id IS NULL AND (
            (r.lifecycle_state = N'ARCHIVED' AND COALESCE(r.lifecycle_archive_reason, N'') <> N'SUPERSEDED')
            OR EXISTS (
              SELECT 1
              FROM ops.SupplierRecordOccurrences o
              INNER JOIN ops.MailboxMessages m ON m.mailbox_message_id = o.mailbox_message_id
              WHERE o.record_id = r.record_id AND m.archive_state = N'IN_INBOX'
            )
          ))
          OR
          (@mailbox_message_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM ops.SupplierRecordOccurrences o
            WHERE o.record_id = r.record_id AND o.mailbox_message_id = @mailbox_message_id
          ))
        )
      ORDER BY r.last_observed_at DESC, r.created_at DESC, r.row_number;
    `);
  const suppliers = await pool.request().query(`
    SELECT r.supplier_code, MAX(r.supplier_name) AS supplier_name,
           COUNT(*) AS message_count
    FROM ops.MailboxMessages r
    WHERE r.archive_state = N'IN_INBOX'
      AND r.supplier_code IS NOT NULL
    GROUP BY r.supplier_code
    ORDER BY supplier_name, supplier_code;
  `);
  let liveStatus = { state: "not-requested" };
  let liveRecords = records.recordset;
  try {
    const refreshed = await refreshLiveOrderStatuses(liveRecords);
    liveRecords = refreshed.records;
    liveStatus = { state: refreshed.state };
  } catch (error) {
    liveStatus = { state: "unavailable", detail: error.message };
  }
  return {
    state: "ready",
    selectedSupplier: supplierCode || null,
    selectedMessage: mailboxMessageId || null,
    suppliers: suppliers.recordset,
    messages: messages.recordset,
    records: liveRecords,
    liveStatus,
    summary: {
      messages: messages.recordset.length,
      records: records.recordset.length,
      processed: messages.recordset.filter((row) => ["PROCESSED", "WAITING_APPROVAL", "PARTIALLY_PROCESSED"].includes(row.processing_state)).length,
      exceptions: messages.recordset.filter((row) => row.processing_state === "EXCEPTION").length
    }
  };
}

async function listStatusMappings() {
  const pool = await getAppPool();
  const mappings = await pool.request().query(`
    SELECT mapping_id, rule_code, supplier_code, supplier_status_key,
           supplier_status_label, target_status_item_id, target_status_description,
           mapping_state, confirmed_by, confirmed_at, notes
    FROM ops.SupplierStatusMappings ORDER BY supplier_code, rule_code, supplier_status_label;
  `);
  const statusItems = await readSourceStatusItems();
  return { mappings: mappings.recordset, statusItems };
}

async function confirmStatusMapping({ mappingId, targetStatusItemId, actorUserId, notes = "" }) {
  const target = Number(targetStatusItemId);
  if (!Number.isSafeInteger(target) || target <= 0) throw new Error("A valid CurrentStatusID target is required.");
  const source = await getSourcePool();
  const statusResult = await source.request().input("status_item_id", sql.Int, target).query(`
    SELECT TOP (1) StatusItemID AS status_item_id, StatusItemName AS status_item_name, Inactive AS inactive
    FROM dbo.StatusItems WHERE StatusItemID = @status_item_id;
  `);
  const status = statusResult.recordset[0];
  if (!status) throw Object.assign(new Error("The selected CurrentStatusID does not exist in the live source."), { statusCode: 400 });
  if (Number(status.inactive) === 1) throw Object.assign(new Error("Inactive CurrentStatusID values cannot be mapped."), { statusCode: 400 });
  const pool = await getAppPool();
  const result = await pool.request()
    .input("mapping_id", sql.UniqueIdentifier, mappingId)
    .input("target_status_item_id", sql.Int, target)
    .input("target_status_description", sql.NVarChar(300), status.status_item_name)
    .input("confirmed_by", sql.UniqueIdentifier, actorUserId || null)
    .input("notes", sql.NVarChar(sql.MAX), notes || null)
    .query(`
      UPDATE ops.SupplierStatusMappings
      SET target_status_item_id = @target_status_item_id,
          target_status_description = @target_status_description,
          mapping_state = N'CONFIRMED',
          confirmed_by = @confirmed_by,
          confirmed_at = SYSUTCDATETIME(),
          notes = @notes,
          updated_at = SYSUTCDATETIME()
      WHERE mapping_id = @mapping_id;
      SELECT mapping_id, rule_code, supplier_code, supplier_status_key,
             target_status_item_id, target_status_description, mapping_state
      FROM ops.SupplierStatusMappings WHERE mapping_id = @mapping_id;
  `);
  const row = result.recordset[0];
  if (!row) throw Object.assign(new Error("Status mapping not found."), { statusCode: 404 });
  const reprocessed = await requeueRecordsForConfirmedMapping({ mappingId: row.mapping_id, actorUserId });
  await recordAuditEvent({ moduleCode: "automation", actorUserId, eventType: "supplier.status_mapping.confirmed", entityType: "ops.SupplierStatusMapping", entityId: row.mapping_id, eventData: { targetStatusItemId: target } });
  return { ...row, ...reprocessed };
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

async function createProposedAction({ eventId, item, match, targetStatusItemId = null, targetStatusDescription = null, recordId = null, mailboxMessageId = null, actorUserId }) {
  const pool = await getAppPool();
  const key = idempotencyKey(["supplier-status", eventId, item.supplierReference]);
  const result = await pool.request()
    .input("event_id", sql.UniqueIdentifier, eventId)
    .input("action_type", sql.NVarChar(160), "supplier.status_projection.propose")
    .input("target_type", sql.NVarChar(120), match.targetType)
    .input("target_reference", sql.NVarChar(300), match.targetReference)
    .input("idempotency_key", sql.NVarChar(500), key)
    .input("proposed_json", sql.NVarChar(sql.MAX), safeJson({
      supplierReference: item.supplierReference,
      supplierStatus: item.supplierStatus,
      projectedStatus: match.proposedStatus,
      targetStatusItemId,
      targetStatusDescription,
      recordId,
      mailboxMessageId,
      expectedCurrentStatusId: match.sourceOrder?.current_status_id ?? null,
      sourceEventId: eventId
    }))
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

async function requeueRecordsForConfirmedMapping({ mappingId, actorUserId }) {
  const pool = await getAppPool();
  const mappingResult = await pool.request()
    .input("mapping_id", sql.UniqueIdentifier, mappingId)
    .query(`
      SELECT mapping_id, rule_code, supplier_code, supplier_status_key,
             target_status_item_id, target_status_description, mapping_state
      FROM ops.SupplierStatusMappings
      WHERE mapping_id = @mapping_id AND mapping_state = N'CONFIRMED';
    `);
  const mapping = mappingResult.recordset[0];
  if (!mapping) return { reprocessed: 0, ruleEnabled: false };

  const records = await pool.request()
    .input("rule_code", sql.NVarChar(120), mapping.rule_code)
    .input("supplier_code", sql.NVarChar(80), mapping.supplier_code)
    .input("supplier_status_key", sql.NVarChar(160), mapping.supplier_status_key)
    .query(`
      SELECT record_id, event_id, mailbox_message_id, supplier_reference,
             supplier_status, normalized_status, internal_order_id, current_status_id
      FROM ops.SupplierRecords
      WHERE rule_code = @rule_code
        AND supplier_code = @supplier_code
        AND LOWER(LTRIM(RTRIM(COALESCE(supplier_status, normalized_status, N'')))) = @supplier_status_key
        AND match_result = N'Matched'
        AND internal_order_id IS NOT NULL
        AND action_id IS NULL
        AND parse_state = N'WAITING_MAPPING';
    `);

  let reprocessed = 0;
  const created = [];
  for (const record of records.recordset) {
    const action = await createProposedAction({
      eventId: record.event_id,
      item: { supplierReference: record.supplier_reference, supplierStatus: record.supplier_status, normalizedStatus: record.normalized_status },
      match: {
        targetReference: String(record.internal_order_id),
        targetType: "innovations-order",
        proposedStatus: `SUPPLIER_${record.normalized_status || record.supplier_status}`,
        sourceOrder: { current_status_id: record.current_status_id }
      },
      targetStatusItemId: mapping.target_status_item_id,
      targetStatusDescription: mapping.target_status_description,
      recordId: record.record_id,
      mailboxMessageId: record.mailbox_message_id,
      actorUserId
    });
    await pool.request()
      .input("record_id", sql.UniqueIdentifier, record.record_id)
      .input("action_id", sql.UniqueIdentifier, action.action_id)
      .input("target_status_item_id", sql.Int, mapping.target_status_item_id)
      .input("target_status_description", sql.NVarChar(300), mapping.target_status_description)
      .query(`
        UPDATE ops.SupplierRecords
        SET target_status_item_id = @target_status_item_id,
            target_status_description = @target_status_description,
            parse_state = N'WAITING_APPROVAL',
            error_detail = NULL,
            action_id = @action_id,
            updated_at = SYSUTCDATETIME()
        WHERE record_id = @record_id AND action_id IS NULL;
      `);
    if (!action.duplicate) reprocessed += 1;
    if (action.action_id) created.push({ action, record });
  }

  const enabled = await pool.request()
    .input("rule_code", sql.NVarChar(120), mapping.rule_code)
    .query(`
      UPDATE ops.SupplierRules
      SET mapping_state = N'CONFIRMED', is_enabled = 1, updated_at = SYSUTCDATETIME()
      WHERE rule_code = @rule_code
        AND NOT EXISTS (
          SELECT 1 FROM ops.SupplierStatusMappings
          WHERE rule_code = @rule_code AND mapping_state <> N'CONFIRMED'
        );
      SELECT is_enabled FROM ops.SupplierRules WHERE rule_code = @rule_code;
    `);
  const ruleEnabled = Boolean(enabled.recordset[0]?.is_enabled);
  let autoApplied = 0;
  if (ruleEnabled) {
    for (const item of created) {
      const autoApply = await autoApplyCreatedSupplierAction({
        action: item.action,
        rule: { is_enabled: true },
        mapping,
        sourceResult: {
          matchResult: "Matched",
          matches: [{ internal_order_id: item.record.internal_order_id, current_status_id: item.record.current_status_id }]
        },
        actorUserId
      });
      if (autoApply.applied) autoApplied += 1;
    }
  }
  return { reprocessed, ruleEnabled, autoApplied };
}

async function recordPendingSourceStatusWriteback({ actionId, recordId, orderId, beforeStatusId, targetStatusId }) {
  const pool = await getAppPool();
  await pool.request()
    .input("action_id", sql.UniqueIdentifier, actionId)
    .input("record_id", sql.UniqueIdentifier, recordId || null)
    .input("order_id", sql.Int, orderId)
    .input("before_status_id", sql.Int, beforeStatusId || null)
    .input("target_status_id", sql.Int, targetStatusId)
    .query(`
      IF NOT EXISTS (SELECT 1 FROM ops.SourceStatusWritebacks WHERE action_id = @action_id)
        INSERT INTO ops.SourceStatusWritebacks (action_id, record_id, order_id, before_status_id, target_status_id)
        VALUES (@action_id, @record_id, @order_id, @before_status_id, @target_status_id);
    `);
}

async function markSourceStatusActionApplied({ actionId, recordId, actorUserId, applied, note, mailboxMessageId, autoApply = false }) {
  const writebackPool = await getAppPool();
  const appliedJson = safeJson({ ...applied, note, autoApply: Boolean(autoApply) });
  await writebackPool.request()
    .input("action_id", sql.UniqueIdentifier, actionId)
    .input("record_id", sql.UniqueIdentifier, recordId || null)
    .input("applied_json", sql.NVarChar(sql.MAX), appliedJson)
    .input("verified_status_id", sql.Int, applied.verifiedStatusId)
    .input("actor", sql.UniqueIdentifier, actorUserId || null)
    .query(`
      UPDATE ops.Actions SET status = N'APPLIED', applied_json = @applied_json WHERE action_id = @action_id;
      UPDATE ops.SourceStatusWritebacks SET result = N'APPLIED', verified_status_id = @verified_status_id, completed_at = SYSUTCDATETIME() WHERE action_id = @action_id;
      UPDATE ops.SupplierRecords SET parse_state = N'APPLIED', updated_at = SYSUTCDATETIME() WHERE record_id = @record_id;
      INSERT INTO ops.ActivityLog (action_id, activity_type, actor_user_id, detail_json) VALUES (@action_id, N'source.current_status_id.applied', @actor, @applied_json);
    `);
  let archive = { status: "NOT_READY" };
  try {
    archive = await autoArchiveAppliedSupplierMessage({ mailboxMessageId, actorUserId });
  } catch (archiveError) {
    archive = { status: "ARCHIVE_FAILED", detail: archiveError.message };
    if (mailboxMessageId) {
      await recordAuditEvent({ moduleCode: "automation", actorUserId, eventType: "supplier.mailbox.archive_failed", entityType: "ops.MailboxMessage", entityId: mailboxMessageId, eventData: { actionId, error: archiveError.message } });
    }
  }
  await recordAuditEvent({
    moduleCode: "automation",
    actorUserId,
    eventType: autoApply ? "supplier.action.auto_applied" : "supplier.action.approved",
    entityType: "ops.Action",
    entityId: actionId,
    eventData: { note, mode: "source-current-status-id", autoApply: Boolean(autoApply), applied, archive }
  });
  return { actionId, status: "APPLIED", duplicate: false, applied, archive };
}

async function autoApplyCreatedSupplierAction({ action, rule, mapping, sourceResult, actorUserId }) {
  const config = getConfig();
  const eligibility = eligibilityFromContext({ rule, mapping, sourceResult, config });
  const decision = shouldAutoApplySupplierStatus(eligibility);
  if (!decision.apply) return { applied: false, reason: decision.reason };
  if (!action?.action_id) return { applied: false, reason: "no_action" };

  try {
    const pool = await getAppPool();
    const loaded = await pool.request()
      .input("action_id", sql.UniqueIdentifier, action.action_id)
      .query(`SELECT action_id, event_id, target_type, target_reference, proposed_json, status FROM ops.Actions WHERE action_id = @action_id;`);
    const row = loaded.recordset[0];
    const actionState = row ? { ...row, proposed: parseJson(row.proposed_json) || {} } : null;
    let writable = false;
    try {
      writable = Boolean((await checkSourceWriteCapability()).writable);
    } catch (error) {
      return { applied: false, reason: "writeback_not_ready", error: error.message };
    }
    return tryAutoApplyHighConfidenceSupplierStatus({
      action,
      eligibility,
      actionState,
      writable,
      applyUpdate: applyCurrentStatusUpdate,
      persistApplied: async ({ result }) => {
        const proposed = actionState?.proposed || {};
        await recordPendingSourceStatusWriteback({
          actionId: action.action_id,
          recordId: proposed.recordId || null,
          orderId: Number(actionState.target_reference),
          beforeStatusId: proposed.expectedCurrentStatusId || null,
          targetStatusId: Number(proposed.targetStatusItemId)
        });
        await pool.request()
          .input("action_id", sql.UniqueIdentifier, action.action_id)
          .input("note", sql.NVarChar(sql.MAX), AUTO_APPLY_NOTE)
          .input("detail", sql.NVarChar(sql.MAX), safeJson({ decision: "APPROVED", note: AUTO_APPLY_NOTE, autoApply: true }))
          .input("actor", sql.UniqueIdentifier, actorUserId || null)
          .query(`
            INSERT INTO ops.Approvals (action_id, decision, note, decided_by) VALUES (@action_id, N'APPROVED', @note, @actor);
            UPDATE ops.Actions
            SET decided_by = @actor, decision_note = @note, decided_at = SYSUTCDATETIME()
            WHERE action_id = @action_id AND status = N'WAITING_APPROVAL';
            INSERT INTO ops.ActivityLog (action_id, activity_type, actor_user_id, detail_json)
            VALUES (@action_id, N'action.decision', @actor, @detail);
          `);
        await markSourceStatusActionApplied({
          actionId: action.action_id,
          recordId: proposed.recordId || null,
          actorUserId,
          applied: result,
          note: AUTO_APPLY_NOTE,
          mailboxMessageId: proposed.mailboxMessageId,
          autoApply: true
        });
      }
    });
  } catch (error) {
    return { applied: false, reason: "writeback_failed", error: error.message };
  }
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
      SELECT action_id, event_id, target_type, target_reference, proposed_json, status
      FROM ops.Actions WITH (UPDLOCK, ROWLOCK) WHERE action_id = @action_id;
    `);
    const action = result.recordset[0];
    if (!action) throw Object.assign(new Error("Action not found."), { statusCode: 404 });
    if (!["WAITING_APPROVAL"].includes(action.status)) {
      await transaction.commit();
      return { actionId, status: action.status, duplicate: true };
    }
    const proposed = parseJson(action.proposed_json) || {};
    if (decision === "APPROVED" && action.target_type === "innovations-order") {
      const capability = await checkSourceWriteCapability();
      if (!capability.writable) {
        throw Object.assign(new Error(capability.detail || "Live source write-back is not ready."), { statusCode: 409, code: "writeback_not_ready" });
      }
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
    if (decision === "REJECTED") {
      await new sql.Request(transaction)
        .input("action_id", sql.UniqueIdentifier, actionId)
        .input("actor", sql.UniqueIdentifier, actorUserId || null)
        .input("detail", sql.NVarChar(sql.MAX), safeJson({ decision, note }))
        .query("INSERT INTO ops.ActivityLog (action_id, activity_type, actor_user_id, detail_json) VALUES (@action_id, N'action.decision', @actor, @detail);");
      await transaction.commit();
      await recordAuditEvent({ moduleCode: "automation", actorUserId, eventType: "supplier.action.rejected", entityType: "ops.Action", entityId: actionId, eventData: { note } });
      return { actionId, status: "REJECTED", duplicate: false };
    }

    if (action.target_type !== "innovations-order") {
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
      await new sql.Request(transaction)
        .input("action_id", sql.UniqueIdentifier, actionId)
        .input("actor", sql.UniqueIdentifier, actorUserId || null)
        .input("detail", sql.NVarChar(sql.MAX), safeJson({ decision, note }))
        .query("INSERT INTO ops.ActivityLog (action_id, activity_type, actor_user_id, detail_json) VALUES (@action_id, N'action.decision', @actor, @detail);");
      await transaction.commit();
      await recordAuditEvent({ moduleCode: "automation", actorUserId, eventType: "supplier.action.approved", entityType: "ops.Action", entityId: actionId, eventData: { note, mode: "projection" } });
      return { actionId, status: "APPLIED", duplicate: false };
    }

    await new sql.Request(transaction)
      .input("action_id", sql.UniqueIdentifier, actionId)
      .input("actor", sql.UniqueIdentifier, actorUserId || null)
      .input("detail", sql.NVarChar(sql.MAX), safeJson({ decision, note }))
      .query("INSERT INTO ops.ActivityLog (action_id, activity_type, actor_user_id, detail_json) VALUES (@action_id, N'action.decision', @actor, @detail);");
    await transaction.commit();

    const writebackPool = await getAppPool();
    await recordPendingSourceStatusWriteback({
      actionId,
      recordId: proposed.recordId || null,
      orderId: Number(action.target_reference),
      beforeStatusId: proposed.expectedCurrentStatusId || null,
      targetStatusId: Number(proposed.targetStatusItemId)
    });
    try {
      const applied = await applyCurrentStatusUpdate({
        orderId: action.target_reference,
        targetStatusId: proposed.targetStatusItemId,
        expectedCurrentStatusId: proposed.expectedCurrentStatusId
      });
      return await markSourceStatusActionApplied({
        actionId,
        recordId: proposed.recordId || null,
        actorUserId,
        applied,
        note,
        mailboxMessageId: proposed.mailboxMessageId,
        autoApply: false
      });
    } catch (error) {
      await writebackPool.request()
        .input("action_id", sql.UniqueIdentifier, actionId)
        .input("error_detail", sql.NVarChar(sql.MAX), error.message)
        .query(`
          UPDATE ops.Actions SET status = N'FAILED', applied_json = @error_detail WHERE action_id = @action_id;
          UPDATE ops.SourceStatusWritebacks SET result = N'FAILED', error_detail = @error_detail, completed_at = SYSUTCDATETIME() WHERE action_id = @action_id;
        `);
      await recordAuditEvent({ moduleCode: "automation", actorUserId, eventType: "supplier.action.failed", entityType: "ops.Action", entityId: actionId, eventData: { error: error.message, mode: "source-current-status-id" } });
      throw error;
    }
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

module.exports = {
  ALLOWED_STATUSES,
  MAX_FIXTURE_BYTES,
  archiveSupplierMessage,
  captureMailboxMessage,
  confirmStatusMapping,
  createAttachment,
  createEvent,
  createFixtureWorkflow,
  createSupplierRule,
  decideAction,
  deleteSupplierRule,
  getActionDetail,
  getExceptionDetail,
  getMailboxConfiguration,
  idempotencyKey,
  listActions,
  listExceptions,
  listMailboxReconciliation,
  listMailboxWorkspace,
  listOperations,
  listStatusMappings,
  listSupplierRules,
  resolveException,
  requeueRecordsForConfirmedMapping,
  sha256,
  syncMailbox,
  updateMailboxConfiguration,
  updateSupplierRule,
  validateFixture
};
