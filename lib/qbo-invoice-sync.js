'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sql = require('mssql');
const { getAppPool, getSourcePool } = require('./db');
const customerSync = require('./qbo-customer-creation-sync');
const { recordAuditEvent } = require('./audit');
const { configured: configuredProtectedStore, save: saveQboTokens } = require('./qbo-secret-store');
const { reportReconnectRequired } = require('./qbo-oauth-exchange');
const reviewModel = require('./qbo-invoice-review');
const postingSettings = require('./qbo-posting-settings');
const reconciliation = require('./qbo-reconciliation');

// Auto-post works through the backlog in small steps so a person can watch the first runs.
const AUTO_POST_PER_RUN = 25;

const TASK_NAME = 'OptiLens QuickBooks Invoice Sync';
const LOG_FILE = path.join(__dirname, '..', 'data', 'logs', 'qbo-invoice-sync.jsonl');
const LOCK_FILE = path.join(__dirname, '..', 'data', 'logs', 'qbo-invoice-sync.lock');
const DEFAULT_INTERVAL_MINUTES = Number(process.env.OPTILENS_QBO_SYNC_INTERVAL_MINUTES || 30);
let activeRun = null;

function configuredEnvironment() {
  const environment = String(process.env.OPTILENS_QBO_ENVIRONMENT || 'sandbox').trim().toLowerCase();
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error('OPTILENS_QBO_ENVIRONMENT must be sandbox or production.');
  }
  return environment;
}

function qboFromProtectedStore() {
  return configuredProtectedStore(configuredEnvironment());
}

function appendLog(event, details = {}) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`);
}
function readRecent() {
  try { return fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean).slice(-100).map(JSON.parse); } catch { return []; }
}
function hashPayload(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function normalizedCustomerName(value) { return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  try {
    const handle = fs.openSync(LOCK_FILE, 'wx');
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return () => { try { fs.closeSync(handle); } catch {} try { fs.unlinkSync(LOCK_FILE); } catch {} };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let stale = false; try { stale = Date.now() - fs.statSync(LOCK_FILE).mtimeMs > 2 * 60 * 60 * 1000; } catch {}
    if (stale) { fs.unlinkSync(LOCK_FILE); return acquireLock(); }
    throw Object.assign(new Error('A QuickBooks invoice sync is already running.'), { statusCode: 409 });
  }
}

function qboBase(config) {
  return config.environment === 'production'
    ? `https://quickbooks.api.intuit.com/v3/company/${encodeURIComponent(config.realmId)}`
    : `https://sandbox-quickbooks.api.intuit.com/v3/company/${encodeURIComponent(config.realmId)}`;
}
function tokenStillValid(config) { return config.accessToken && config.createdAt && Date.now() < config.createdAt + 50 * 60 * 1000; }
async function accessConfig() {
  const config = qboFromProtectedStore();
  if (!config) throw Object.assign(new Error('QuickBooks credentials are not configured in the protected QBO environment store.'), { statusCode: 503 });
  if (tokenStillValid(config)) return config;
  const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const response = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: config.refreshToken })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token || !body.refresh_token) {
    // invalid_grant = the refresh token expired or was revoked; only a reconnect fixes it.
    if (body.error === 'invalid_grant') {
      const reported = await reportReconnectRequired();
      appendLog('auth.reconnect_required', { environment: config.environment, reportedToCvWeb: reported });
      throw Object.assign(new Error('QuickBooks authorization expired or was revoked; reconnect QuickBooks from CV Web Integrations.'), { statusCode: 401, reconnectRequired: true });
    }
    throw new Error(`QuickBooks token refresh failed (${response.status}).`);
  }
  return saveQboTokens({ ...config, accessToken: body.access_token, refreshToken: body.refresh_token, createdAt: Date.now() });
}
async function qboRequest(config, resource, options = {}) {
  const response = await fetch(`${qboBase(config)}${resource}`, {
    method: options.method || 'GET',
    signal: options.signal || AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${config.accessToken}`, Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body?.Fault?.Error?.[0]?.Message || `QuickBooks request failed (${response.status}).`), { qbo: body, statusCode: response.status });
  return body;
}
async function qboQuery(config, statement) {
  const response = await qboRequest(config, `/query?query=${encodeURIComponent(statement)}`);
  return response.QueryResponse || {};
}
function qboLiteral(value) { return String(value ?? '').replace(/'/g, "''"); }
function isProduction(config) { return config?.environment === 'production'; }
function productionApplyEnabled() { return String(process.env.OPTILENS_QBO_PRODUCTION_APPLY_ENABLED || '').toLowerCase() === 'true'; }
function productionAutoApplyEnabled(settings = postingSettings.readPostingSettings()) { return productionApplyEnabled() && settings.autoPost === true; }
function reviewLimit() { return Number(process.env.OPTILENS_QBO_REVIEW_LIMIT) || undefined; }

// Auto-post only touches what a person would also call "Ready": no exceptions, credit notes, VAT or large totals.
async function setAutoPost({ enabled, actorUserId = null }) {
  if (!productionApplyEnabled()) throw Object.assign(new Error('Posting to QuickBooks is switched off on this server.'), { statusCode: 403 });
  const saved = postingSettings.savePostingSettings({ autoPost: enabled === true, changedBy: actorUserId });
  appendLog('autopost.changed', { enabled: saved.autoPost, actorUserId });
  await recordAuditEvent({ moduleCode: 'automation', actorUserId, eventType: 'automation.qbo_invoice_sync.autopost_' + (saved.autoPost ? 'on' : 'off'), entityType: 'QboPostingSettings', entityId: 'auto-post', eventData: saved });
  return saved;
}
function cutoverDate() {
  const value = String(process.env.OPTILENS_QBO_CUTOVER_DATE || '').trim();
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error('OPTILENS_QBO_CUTOVER_DATE must be a YYYY-MM-DD date.');
  return value;
}
// Invoices dated before the cutover were imported into QBO from the CSV export and are never touched.
function effectiveFromDate(config, requested) {
  const cutover = cutoverDate();
  if (isProduction(config) && !cutover) throw Object.assign(new Error('Production QBO sync requires OPTILENS_QBO_CUTOVER_DATE (YYYY-MM-DD); invoices before it stay as imported from the CSV export.'), { statusCode: 409 });
  if (!cutover) return requested || null;
  return !requested || requested < cutover ? cutover : requested;
}
function transactionSnapshotHash(transaction) { return hashPayload(transaction || {}); }
function sourceNote(invoice) { return `OptiLens source Innovations invoice ${invoice.sourceInvoiceId}`; }
// Memo (QuickBooks PrivateNote): job detail first, then the reconciliation marker as the last line.
function noteHasMarker(note, marker) {
  const lines = String(note || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines[lines.length - 1] === marker;
}
function privateNote(invoice) {
  const marker = sourceNote(invoice);
  return invoice.jobMemo ? `${invoice.jobMemo}\n${marker}` : marker;
}
function classifyExistingTransactions(invoice, transactions) {
  const expectedNote = sourceNote(invoice);
  const exact = transactions.filter(({ transaction }) => String(transaction?.DocNumber || '') === String(invoice.sourceInvoiceId) && noteHasMarker(transaction?.PrivateNote, expectedNote));
  if (exact.length === 1 && transactions.length === 1) return { kind: 'exact', match: exact[0] };
  if (!transactions.length) return { kind: 'none' };
  return { kind: 'ambiguous', count: transactions.length, exactCount: exact.length };
}
async function findExistingQboTransactions(config, invoice) {
  const rows = [];
  for (const resource of ['Invoice', 'CreditMemo']) {
    const result = await qboQuery(config, `SELECT * FROM ${resource} WHERE DocNumber = '${qboLiteral(invoice.sourceInvoiceId)}' MAXRESULTS 1000`);
    for (const transaction of result[resource] || []) rows.push({ resource, transaction });
  }
  return rows;
}
async function listQuickBooksCustomers(config) {
  const customers = [];
  for (let start = 1; ; start += 1000) {
    const { Customer: page = [] } = await qboQuery(config, `SELECT * FROM Customer WHERE Active IN (true, false) ORDERBY Id STARTPOSITION ${start} MAXRESULTS 1000`);
    customers.push(...page);
    if (page.length < 1000) return customers;
  }
}

// Reuse the protected host connection for read-only accounting review modules.
async function openQboReadConnection() {
  const config = await accessConfig();
  return {
    environment: config.environment, realmId: config.realmId,
    query(statement) {
      if (!/^SELECT\s+\*\s+FROM\s+(?:Payment|Deposit|Invoice|CompanyInfo)\b/i.test(statement) || /;/.test(statement)) throw new Error('Unsupported read-only QuickBooks query.');
      return qboQuery(config, statement);
    }
  };
}

async function getMappings(config, pool) {
  const [customers, items, customerMappings] = await Promise.all([
    listQuickBooksCustomers(config),
    qboQuery(config, 'SELECT * FROM Item MAXRESULTS 1000'),
    pool.request().input('realmId', sql.NVarChar(80), config.realmId).query(`
      SELECT source_account, qbo_customer_id
      FROM qbo.customer_mappings
      WHERE qbo_realm_id=@realmId AND mapping_state=N'confirmed'
    `)
  ]);
  const customerById = new Map(customers.map((row) => [String(row.Id), row]));
  return {
    customersBySourceAccount: new Map(customerMappings.recordset
      .map((row) => [String(row.source_account || '').trim(), customerById.get(String(row.qbo_customer_id))])
      .filter(([, customer]) => customer && customer.Active !== false)),
    items: new Map((items.Item || []).map((row) => [String(row.Name || '').trim().toLowerCase(), row]))
  };
}

// Same scope as the QuickBooks CSV export (invoice-export-quickbooks-combined-mssql.sql).
const EXPORT_ORDER_TYPES = [1, 3, 5, 6, 8, 9, 10, 11, 12, 25, 26, 27, 30, 33, 36, 37];
const EXPORT_EXCLUDED_ACCOUNTS = ['3628', '1000', '1001', '650044', 'IDS', 'OSVS', 'BOS', 'PSMT'];

function decodeInstructionText(value) {
  return String(value || '').replace(/&#13;&#10;|&#10;|&#13;/g, '\n').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
// "MILLER-GAIL. OD -0.25 -0.25 x 55 Add +2.00. OS ... . Style, Material, Coating. Frame: MODEL. Lab note."
function buildJobMemo(invoice, texts) {
  const kv = {};
  const notes = [];
  for (const raw of texts) {
    const text = decodeInstructionText(raw);
    if (/(^|\n)usr_/.test(text)) {
      for (const line of text.split(/\n/)) {
        const m = /^(usr_\w+)\s?(.*)$/.exec(line.trim());
        if (m) kv[m[1]] = m[2].trim();
      }
    } else if (text.trim()) notes.push(text.trim());
  }
  if (kv.usr_instructions) notes.push(kv.usr_instructions);
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
  const eye = (side) => {
    const sphere = kv[`usr_rx_${side}_sphere`], cyl = kv[`usr_rx_${side}_cylinder`], axis = kv[`usr_rx_${side}_axis`], add = kv[`usr_rx_${side}_add`];
    const text = [sphere, cyl && axis ? `${cyl} x ${axis}` : cyl, add ? `Add ${add}` : ''].filter(Boolean).join(' ');
    return text ? `${side.toUpperCase()} ${text}` : '';
  };
  const lens = (side) => [kv[`usr_lens_${side}_style_desc`], kv[`usr_lens_${side}_material_desc`], kv[`usr_lens_${side}_color_desc`]].map(clean).filter(Boolean).join(', ');
  const od = lens('od'), os = lens('os');
  const lensText = od && os && od !== os ? `OD ${od}; OS ${os}` : (od || os);
  const uniqueNotes = [...new Set(notes.map(clean).filter(Boolean))];
  const parts = [clean(kv.usr_patient_name || invoice.memo), eye('od'), eye('os'), lensText, kv.usr_frame_model ? `Frame: ${clean(kv.usr_frame_model)}` : '', ...uniqueNotes].filter(Boolean);
  return parts.length > 1 ? `${parts.join('. ')}.` : (parts[0] || '');
}
async function attachJobMemos(pool, rows) {
  const ids = [...new Set(rows.map((row) => Number(row.sourceOrderId)).filter(Number.isFinite))];
  const byOrder = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const { recordset } = await pool.request().query(`SELECT OrderID, InstructionText FROM dbo.OrderInstructions WHERE OrderID IN (${chunk.join(',')}) ORDER BY OrderInstructionID`);
    for (const row of recordset) {
      if (!byOrder.has(row.OrderID)) byOrder.set(row.OrderID, []);
      byOrder.get(row.OrderID).push(row.InstructionText);
    }
  }
  for (const row of rows) row.jobMemo = buildJobMemo(row, byOrder.get(Number(row.sourceOrderId)) || []);
  return rows;
}

async function discoverSourceInvoices({ fromDate = null, toDate = null, sourceInvoiceId = null } = {}) {
  const pool = await getSourcePool();
  const result = await pool.request()
    .input('fromDate', sql.Date, fromDate || null)
    .input('toDate', sql.Date, toDate || null)
    .input('sourceInvoiceId', sql.NVarChar(120), sourceInvoiceId ? String(sourceInvoiceId) : null)
    .query(`
      SELECT
        fsj.InvoiceID AS sourceInvoiceId,
        fsj.CustomerID AS sourceCustomerId,
        c.AccountNumber AS customerAccount,
        c.CustomerName AS customerName,
        CASE WHEN ot.OrderTypeID = 6 THEN N'Stock Orders - ' + ISNULL(bg.BuyinGroupName, N'')
             ELSE ot.OrderTypeName + N' Orders - ' + ISNULL(bg.BuyinGroupName, N'') END AS itemName,
        fsj.Patient AS memo,
        fsj.OrderID AS sourceOrderId,
        ship.ShippingMethodName AS shipMethod,
        CASE WHEN ship.Shipped = 1 THEN ship.ShippedTime END AS shippedTime,
        ship.TrackingNumber AS trackingNumber,
        fsj.Total AS total,
        fsj.SubTotal AS subtotal,
        fsj.TaxAmount AS taxAmount,
        fsj.InvoiceTime AS invoiceTime,
        DATEADD(day, 30, fsj.InvoiceTime) AS dueDate,
        fsj.InvoiceType AS invoiceType,
        fsj.OrderType AS orderType,
        CAST(CASE WHEN ISNULL(ot.Credit, 0) = 1 OR fsj.Total < 0 OR ISNULL(fsj.CreditAmount, 0) > 0 THEN 1 ELSE 0 END AS bit) AS isCredit
      FROM dbo.FinARSalesJournal fsj
      INNER JOIN dbo.OrderTypes ot ON ot.OrderTypeID = fsj.OrderType
      LEFT JOIN dbo.Customers c ON c.CustomerID = fsj.CustomerID
      LEFT JOIN dbo.BuyinGroups bg ON bg.BuyinGroupID = c.BuyinGroupID
      OUTER APPLY (
        SELECT TOP 1 sh.Shipped, sh.ShippedTime, NULLIF(LTRIM(RTRIM(sh.TrackingNumber)), N'') AS TrackingNumber, sm.ShippingMethodName
        FROM dbo.ShipmentItems si
        INNER JOIN dbo.Shipments sh ON sh.ShipmentID = si.ShipmentID AND ISNULL(sh.RecordDeleted, 0) = 0
        LEFT JOIN dbo.ShippingMethods sm ON sm.ShippingMethodID = sh.ShippingMethodID
        WHERE si.OrderID = fsj.OrderID
        ORDER BY sh.ShipmentID DESC
      ) ship
      WHERE fsj.InvoiceID IS NOT NULL
        AND (@sourceInvoiceId IS NULL OR CAST(fsj.InvoiceID AS nvarchar(120)) = @sourceInvoiceId)
        AND (@fromDate IS NULL OR CAST(fsj.InvoiceTime AS date) >= @fromDate)
        AND (@toDate IS NULL OR CAST(fsj.InvoiceTime AS date) <= @toDate)
        AND ot.OrderType IN (${EXPORT_ORDER_TYPES.join(', ')})
        AND (c.AccountNumber IS NULL OR (c.AccountNumber NOT IN (${EXPORT_EXCLUDED_ACCOUNTS.map((a) => `N'${a}'`).join(', ')}) AND c.AccountNumber NOT LIKE N'%ED'))
        AND (c.IsActive <> 0 OR c.IsActive IS NULL)
      UNION ALL

      SELECT i.InvoiceID, i.CustomerID, c.AccountNumber, c.CustomerName,
        CASE WHEN ot.OrderTypeID = 6 THEN N'Stock Orders - ' + bg.BuyinGroupName
             ELSE ot.OrderTypeName + N' Orders - ' + bg.BuyinGroupName END,
        CONVERT(nvarchar(max), o.PatientID), i.OrderID, NULL, NULL, NULL,
        i.Total, i.SubTotal, i.TaxAmount,
        CAST(i.InvoiceTime AS date), DATEADD(day, 30, CAST(i.InvoiceTime AS date)),
        i.InvoiceType, o.OrderType,
        CAST(CASE WHEN ISNULL(ot.Credit, 0) = 1 OR i.Total < 0 THEN 1 ELSE 0 END AS bit)
      FROM dbo.Invoices i
      INNER JOIN dbo.Orders o ON o.OrderID = i.OrderID
      INNER JOIN dbo.OrderTypes ot ON ot.OrderTypeID = o.OrderType
      INNER JOIN dbo.Customers c ON c.CustomerID = i.CustomerID
      LEFT JOIN dbo.BuyinGroups bg ON bg.BuyinGroupID = c.BuyinGroupID
      WHERE c.AccountNumber = N'PSMT'
        AND i.InvoiceID IS NOT NULL
        AND ot.OrderTypeID IN (${EXPORT_ORDER_TYPES.join(', ')})
        AND (@sourceInvoiceId IS NULL OR CAST(i.InvoiceID AS nvarchar(120)) = @sourceInvoiceId)
        AND (@fromDate IS NULL OR CAST(i.InvoiceTime AS date) >= @fromDate)
        AND (@toDate IS NULL OR CAST(i.InvoiceTime AS date) <= @toDate)
      ORDER BY invoiceTime, sourceInvoiceId
    `);
  const seen = new Set();
  for (const invoice of result.recordset) {
    const id = String(invoice.sourceInvoiceId);
    if (seen.has(id)) throw new Error(`Multiple Innovations records use invoice number '${id}'. Resolve the duplicate before syncing.`);
    seen.add(id);
  }
  return attachJobMemos(pool, result.recordset);
}

async function findLedger(pool, config, sourceInvoiceId) {
  const result = await pool.request().input('sourceSystem', 'innovations').input('sourceInvoiceId', String(sourceInvoiceId)).input('realmId', config.realmId).query(`SELECT TOP 1 * FROM qbo.invoice_sync_ledger WHERE source_system=@sourceSystem AND source_invoice_id=@sourceInvoiceId AND qbo_realm_id=@realmId`);
  return result.recordset[0] || null;
}
async function seedExactCustomerMappings({ actorUserId = null } = {}) {
  const config = await accessConfig();
  const appPool = await getAppPool();
  const sourcePool = await getSourcePool();
  const customers = await qboQuery(config, 'SELECT * FROM Customer MAXRESULTS 1000');
  const customerBySourceIdentity = new Map();
  for (const customer of customers.Customer || []) {
    const displayName = String(customer.DisplayName || '').trim();
    const separator = displayName.lastIndexOf(' - ');
    if (separator < 1) continue;
    const sourceName = normalizedCustomerName(displayName.slice(0, separator));
    const sourceAccount = displayName.slice(separator + 3).trim();
    const key = `${sourceName}|${sourceAccount}`;
    if (customerBySourceIdentity.has(key)) customerBySourceIdentity.set(key, null);
    else customerBySourceIdentity.set(key, customer);
  }
  const sourceCustomers = await sourcePool.request().query(`
    SELECT CustomerID AS sourceCustomerId, AccountNumber AS sourceAccount, CustomerName AS sourceName
    FROM dbo.Customers
    WHERE AccountNumber IS NOT NULL AND CustomerName IS NOT NULL
  `);
  const result = { matched: 0, created: 0, existing: 0, unmatched: [] };
  for (const source of sourceCustomers.recordset) {
    const sourceAccount = String(source.sourceAccount).trim();
    const sourceName = String(source.sourceName).trim();
    const qboCustomer = customerBySourceIdentity.get(`${normalizedCustomerName(sourceName)}|${sourceAccount}`);
    if (!qboCustomer) { result.unmatched.push({ sourceAccount, sourceName }); continue; }
    result.matched += 1;
    const existing = await appPool.request().input('realmId', sql.NVarChar(80), config.realmId).input('sourceAccount', sql.NVarChar(120), sourceAccount).query(`
      SELECT TOP 1 qbo_customer_id FROM qbo.customer_mappings WHERE qbo_realm_id=@realmId AND source_account=@sourceAccount
    `);
    const existingId = existing.recordset[0]?.qbo_customer_id;
    if (existingId && String(existingId) !== String(qboCustomer.Id)) {
      throw new Error(`Confirmed QBO customer mapping conflict for Innovations account '${sourceAccount}'.`);
    }
    if (existingId) { result.existing += 1; continue; }
    await appPool.request()
      .input('realmId', sql.NVarChar(80), config.realmId).input('sourceAccount', sql.NVarChar(120), sourceAccount)
      .input('sourceName', sql.NVarChar(300), sourceName).input('qboCustomerId', sql.NVarChar(120), String(qboCustomer.Id))
      .input('qboDisplayName', sql.NVarChar(500), qboCustomer.DisplayName).query(`
        INSERT INTO qbo.customer_mappings (qbo_realm_id, source_account, source_name, qbo_customer_id, qbo_display_name, mapping_state)
        VALUES (@realmId, @sourceAccount, @sourceName, @qboCustomerId, @qboDisplayName, N'confirmed')
      `);
    await recordAuditEvent({ moduleCode: 'automation', actorUserId, eventType: 'automation.qbo_customer_mapping.confirmed', entityType: 'QboCustomerMapping', entityId: sourceAccount, eventData: { qboRealmId: config.realmId, sourceName, qboCustomerId: String(qboCustomer.Id), qboDisplayName: qboCustomer.DisplayName, verification: 'exact source name and account equals QBO display name' } });
    result.created += 1;
  }
  appendLog('customer-mappings.seeded', { ...result, unmatched: result.unmatched.slice(0, 100) });
  return result;
}
async function upsertLedger(pool, config, invoice, fields = {}) {
  const result = await pool.request()
    .input('sourceSystem', 'innovations').input('sourceInvoiceId', String(invoice.sourceInvoiceId)).input('sourceInvoiceType', invoice.isCredit ? 'credit' : 'invoice')
    .input('realmId', config.realmId).input('customerAccount', invoice.customerAccount || null).input('customerName', invoice.customerName || null)
    .input('total', Number(invoice.total || 0)).input('invoiceTime', invoice.invoiceTime || null).input('payloadHash', fields.payloadHash || null).input('status', fields.status || 'discovered')
    .input('qboType', fields.qboTransactionType || null).input('qboId', fields.qboTransactionId || null).input('docNumber', fields.qboDocNumber || null)
    .input('error', fields.lastError || null).input('resultJson', fields.lastResultJson || null)
    .input('approvalState', fields.approvalState || 'not_required').input('approvalRequestedBy', fields.approvalRequestedByUserId || null)
    .input('approvedBy', fields.approvedByUserId || null).input('snapshotHash', fields.qboSnapshotHash || null)
    .input('reconciliationJson', fields.reconciliationJson || null).query(`
      MERGE qbo.invoice_sync_ledger AS target
      USING (SELECT @sourceSystem source_system, @sourceInvoiceId source_invoice_id, @realmId qbo_realm_id) AS source
      ON target.source_system=source.source_system AND target.source_invoice_id=source.source_invoice_id AND target.qbo_realm_id=source.qbo_realm_id
      WHEN MATCHED THEN UPDATE SET source_invoice_type=@sourceInvoiceType, source_customer_account=@customerAccount, source_customer_name=@customerName, source_total=@total, source_invoice_time=@invoiceTime, payload_hash=COALESCE(@payloadHash,target.payload_hash), status=@status, qbo_transaction_type=COALESCE(@qboType,target.qbo_transaction_type), qbo_transaction_id=COALESCE(@qboId,target.qbo_transaction_id), qbo_doc_number=COALESCE(@docNumber,target.qbo_doc_number), last_error=@error, last_result_json=@resultJson, approval_state=@approvalState, approval_requested_at=CASE WHEN @approvalState=N'pending' THEN SYSUTCDATETIME() ELSE target.approval_requested_at END, approval_requested_by_user_id=COALESCE(@approvalRequestedBy,target.approval_requested_by_user_id), approved_at=CASE WHEN @approvedBy IS NOT NULL THEN SYSUTCDATETIME() ELSE target.approved_at END, approved_by_user_id=COALESCE(@approvedBy,target.approved_by_user_id), qbo_snapshot_hash=COALESCE(@snapshotHash,target.qbo_snapshot_hash), reconciliation_json=COALESCE(@reconciliationJson,target.reconciliation_json), last_attempt_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (source_system,source_invoice_id,source_invoice_type,qbo_realm_id,qbo_transaction_type,qbo_transaction_id,qbo_doc_number,source_customer_account,source_customer_name,source_total,source_invoice_time,payload_hash,status,last_error,last_result_json,approval_state,approval_requested_at,approval_requested_by_user_id,approved_at,approved_by_user_id,qbo_snapshot_hash,reconciliation_json,last_attempt_at)
      VALUES (@sourceSystem,@sourceInvoiceId,@sourceInvoiceType,@realmId,@qboType,@qboId,@docNumber,@customerAccount,@customerName,@total,@invoiceTime,@payloadHash,@status,@error,@resultJson,@approvalState,CASE WHEN @approvalState=N'pending' THEN SYSUTCDATETIME() END,@approvalRequestedBy,CASE WHEN @approvedBy IS NOT NULL THEN SYSUTCDATETIME() END,@approvedBy,@snapshotHash,@reconciliationJson,SYSUTCDATETIME());
    `);
  return result;
}

const revenueClassIds = new Map();
// Barbados sales (and any invoice carrying VAT) go to "Local Sales"; non-Barbados export customers to "Export Sales".
async function revenueClassId(config, invoice) {
  const name = `${reviewModel.revenueSegment(invoice)} Sales`;
  const key = `${config.environment}:${config.realmId}:${name}`;
  if (!revenueClassIds.has(key)) {
    const found = await qboQuery(config, `SELECT * FROM Class WHERE FullyQualifiedName = '${qboLiteral(name)}'`);
    revenueClassIds.set(key, (found.Class || [])[0]?.Id || null);
  }
  return revenueClassIds.get(key);
}
const revenueLocationIds = new Map();
// Same Local / Export rule as the class, applied to the QuickBooks Location field.
async function revenueLocationId(config, invoice) {
  const name = reviewModel.revenueSegment(invoice);
  const key = `${config.environment}:${config.realmId}:${name}`;
  if (!revenueLocationIds.has(key)) {
    const found = await qboQuery(config, `SELECT * FROM Department WHERE FullyQualifiedName = '${qboLiteral(name)}'`);
    revenueLocationIds.set(key, (found.Department || [])[0]?.Id || null);
  }
  return revenueLocationIds.get(key);
}
// Ship via / ship date / tracking number from the Innovations shipment (where available).
// The leading route number on method names ("0 Randall Hunte - Delivery") is dropped.
function shippingFields(invoice) {
  const { via, date, tracking } = reviewModel.shippingSummary(invoice);
  return { ...(via ? { ShipMethodRef: { value: via } } : {}), ...(date ? { ShipDate: date } : {}), ...(tracking ? { TrackingNum: tracking } : {}) };
}
function qboPayload(invoice, customer, item, taxCodeId, classId = null, locationId = null) {
  const amount = Math.abs(Number(invoice.total || 0));
  return {
    DocNumber: String(invoice.sourceInvoiceId), TxnDate: new Date(invoice.invoiceTime).toISOString().slice(0, 10), DueDate: new Date(invoice.dueDate).toISOString().slice(0, 10),
    CustomerRef: { value: String(customer.Id), name: customer.DisplayName },
    Line: [{ DetailType: 'SalesItemLineDetail', Amount: amount, Description: invoice.memo || undefined, SalesItemLineDetail: { ItemRef: { value: String(item.Id), name: item.Name }, Qty: 1, UnitPrice: amount, TaxCodeRef: { value: taxCodeId }, ...(classId ? { ClassRef: { value: String(classId) } } : {}) } }],
    PrivateNote: privateNote(invoice),
    GlobalTaxCalculation: 'TaxInclusive',
    ...shippingFields(invoice),
    ...(locationId ? { DepartmentRef: { value: String(locationId) } } : {})
  };
}

async function linkQuickBooksCustomer(pool, config, row) {
  const request = () => pool.request().input('realm', sql.NVarChar(80), config.realmId)
    .input('account', sql.NVarChar(120), row.account).input('local', sql.UniqueIdentifier, row.customer_id);
  const setState = (state, error = null) => request().input('state', sql.NVarChar(20), state)
    .input('error', sql.NVarChar(500), error).query(`
      UPDATE qbo.customer_jobs SET sync_state=@state,last_error=@error WHERE realm_id=@realm AND customer_id=@local
    `);
  try {
    const { recordset: [mapping] } = await request().query(`
      SELECT qbo_customer_id,mapping_state FROM qbo.customer_mappings WHERE qbo_realm_id=@realm AND source_account=@account
    `);
    const marker = `OptiLens account: ${row.account}`;
    const hasAccount = (customer) => customer.Notes === marker ||
      normalizedCustomerName(customer.DisplayName) === normalizedCustomerName(`${row.customer_name} - ${row.account}`);
    const reconcile = async () => {
      if (mapping) {
        if (mapping.mapping_state !== 'confirmed') throw customerSync.review('Confirm the existing QuickBooks mapping.');
        const { Customer } = await qboRequest(config, `/customer/${encodeURIComponent(mapping.qbo_customer_id)}`);
        if (!Customer?.Id || Customer.Active === false) throw customerSync.review('The mapped QuickBooks customer is missing or inactive.');
        return Customer;
      }
      const candidates = (await listQuickBooksCustomers(config)).filter((customer) => hasAccount(customer) ||
        normalizedCustomerName(customer.DisplayName) === normalizedCustomerName(row.customer_name));
      if (!candidates.length) return null;
      if (candidates.length !== 1 || !hasAccount(candidates[0]) || candidates[0].Active === false) {
        throw customerSync.review('QuickBooks has a name-only, inactive, or conflicting customer match. Review and confirm the mapping.');
      }
      return candidates[0];
    };
    const result = await customerSync.syncDestination({
      reconcile,
      markAttempt: async () => {
        if (row.customer_name.length > 100 || row.customer_name.includes(':')) {
          throw customerSync.review('The customer name must fit QuickBooks DisplayName requirements.');
        }
        if (isProduction(config) && !productionApplyEnabled()) throw new Error('QuickBooks production customer creation is disabled.');
        await setState('attempted');
      },
      idempotent: true,
      create: async () => {
        const { Customer } = await qboRequest(config, `/customer?requestid=customer-${row.customer_id}`, {
          method: 'POST', body: { DisplayName: row.customer_name, Notes: marker }, signal: AbortSignal.timeout(30000)
        });
        if (!Customer?.Id) throw new Error('QuickBooks returned no customer ID. Reconcile before retrying.');
        return Customer;
      }
    });
    const customer = result.value;
    await request().input('id', sql.NVarChar(120), String(customer.Id))
      .input('name', sql.NVarChar(300), row.customer_name).input('display', sql.NVarChar(500), customer.DisplayName).query(`
        SET XACT_ABORT ON;
        BEGIN TRANSACTION;
        IF EXISTS (SELECT 1 FROM qbo.customer_mappings WITH (UPDLOCK,HOLDLOCK)
          WHERE qbo_realm_id=@realm AND ((source_account<>@account AND qbo_customer_id=@id)
            OR (source_account=@account AND (qbo_customer_id<>@id OR mapping_state<>N'confirmed'))))
          THROW 50001, 'QuickBooks mapping conflicts with another account or changed during sync.', 1;
        IF NOT EXISTS (SELECT 1 FROM qbo.customer_mappings WHERE qbo_realm_id=@realm AND source_account=@account)
          INSERT INTO qbo.customer_mappings (qbo_realm_id,source_account,source_name,qbo_customer_id,qbo_display_name)
          VALUES (@realm,@account,@name,@id,@display);
        UPDATE qbo.customer_jobs SET sync_state=N'linked',last_error=NULL WHERE realm_id=@realm AND customer_id=@local;
        COMMIT;
      `);
    await customerSync.audit(row, 'quickbooks', result.outcome);
    return { customer };
  } catch (error) {
    const review = error.review || error.number === 50001;
    const reason = (review || !error.qbo ? error.message : `QuickBooks customer request failed (HTTP ${error.statusCode}). Review customer details and retry.`).slice(0, 500);
    await setState(review ? 'review' : 'pending', reason);
    await customerSync.audit(row, 'quickbooks', review ? 'review' : 'failed', reason);
    return { reason };
  }
}

async function saveLocalCustomer({ account, name, actorUserId }) {
  const config = qboFromProtectedStore();
  if (!config?.realmId) throw Object.assign(new Error('Configure a QuickBooks company before saving customers.'), { statusCode: 503 });
  const pool = await getAppPool();
  try {
    if (typeof account !== 'string' || typeof name !== 'string') throw customerSync.review('Provide a customer account and name as text.');
    const customer = customerSync.identity(account, name);
    return await customerSync.locked(pool, async () => {
      const row = await customerSync.saveCustomer(pool, config.realmId, customer, { actorUserId });
      await customerSync.audit(row, 'local', row.was_created ? 'created' : 'reused');
      return { customerId: row.customer_id };
    });
  } catch (error) {
    if (error.review) error.statusCode = 409;
    throw error;
  }
}

async function listCustomerJobs(pool, realmId, pendingOnly = false) {
  const { recordset } = await pool.request().input('realm', sql.NVarChar(80), realmId).query(`
    SELECT ${pendingOnly ? 'TOP (50)' : ''} c.*, j.sync_state AS quickbooks_state, j.last_error AS quickbooks_error
    FROM qbo.customer_jobs j JOIN qbo.local_customers c ON c.customer_id=j.customer_id
    WHERE j.realm_id=@realm
    ${pendingOnly ? "AND c.origin=N'local' AND (c.innovations_state<>N'linked' OR j.sync_state<>N'linked')" : ''}
    ORDER BY j.last_checked_at, c.customer_id
  `);
  return recordset;
}

async function customerJobStatus() {
  const config = qboFromProtectedStore();
  if (!config?.realmId) throw Object.assign(new Error('Configure a QuickBooks company to view customer sync.'), { statusCode: 503 });
  return { rows: await listCustomerJobs(await getAppPool(), config.realmId) };
}

async function drainCustomerJobs(pool, config) {
  for (const candidate of await listCustomerJobs(pool, config.realmId, true)) {
    await customerSync.locked(pool, async () => {
      const { recordset: [row] } = await pool.request()
        .input('realm', sql.NVarChar(80), config.realmId).input('local', sql.UniqueIdentifier, candidate.customer_id).query(`
          UPDATE qbo.customer_jobs SET last_checked_at=SYSUTCDATETIME() WHERE realm_id=@realm AND customer_id=@local;
          SELECT c.*,j.sync_state AS quickbooks_state FROM qbo.customer_jobs j
          JOIN qbo.local_customers c ON c.customer_id=j.customer_id
          WHERE j.realm_id=@realm AND j.customer_id=@local;
        `);
      await customerSync.syncSource(pool, row);
      if (row.quickbooks_state !== 'linked') await linkQuickBooksCustomer(pool, config, row);
    });
  }
}

async function resolveInvoiceCustomer(pool, config, invoice, actorUserId) {
  try {
    const identity = customerSync.identity(invoice.customerAccount, invoice.customerName);
    const source = await customerSync.lookupSource(identity);
    if (!source || String(source.id) !== String(invoice.sourceCustomerId)) {
      throw customerSync.review('The invoice customer ID and account do not resolve to the same active Innovations master record.');
    }
    return await customerSync.locked(pool, async () => {
      const row = await customerSync.saveCustomer(pool, config.realmId,
        customerSync.identity(source.account, source.name), { sourceId: source.id, actorUserId });
      await customerSync.audit(row, 'local', row.was_created ? 'created' : 'linked');
      return linkQuickBooksCustomer(pool, config, row);
    });
  } catch (error) {
    if (error.review) return { reason: error.message };
    throw error;
  }
}

async function syncOne(pool, config, mappings, invoice, { dryRun, actorUserId, resolveCustomer = resolveInvoiceCustomer }) {
  let customer = mappings.customersBySourceAccount.get(String(invoice.customerAccount || '').trim());
  const item = mappings.items.get(String(invoice.itemName || '').trim().toLowerCase());
  const taxCodeId = Number(invoice.taxAmount || 0) === 0 ? (config.vatZeroTaxCodeId || 'NON') : config.vatStandardTaxCodeId;
  const ledger = await findLedger(pool, config, invoice.sourceInvoiceId);
  const exception = async (reason) => {
    if (dryRun || process.env.OPTILENS_CUSTOMER_SYNC_ENABLED === 'true') {
      await upsertLedger(pool, config, invoice, { status: 'exception', approvalState: 'not_required', lastError: reason });
    }
    return { status: 'exception', reason };
  };
  const identityKey = JSON.stringify([invoice.customerAccount, invoice.sourceCustomerId]);
  if (!dryRun && process.env.OPTILENS_CUSTOMER_SYNC_ENABLED === 'true' &&
      !mappings.verifiedCustomers?.has(identityKey)) {
    const result = await resolveCustomer(pool, config, invoice, actorUserId);
    if (!result.customer) return exception(result.reason);
    customer = result.customer;
    (mappings.verifiedCustomers ??= new Set()).add(identityKey);
    mappings.customersBySourceAccount.set(String(invoice.customerAccount).trim(), customer);
  }
  if (!customer) return exception(`No confirmed QBO customer mapping for Innovations account '${invoice.customerAccount || ''}'.`);
  if (!item) return exception(`No exact QBO item mapping for '${invoice.itemName}'.`);
  if (!taxCodeId) return exception('VAT 17.5% requires a configured QBO tax code ID.');
  const payload = qboPayload(invoice, customer, item, taxCodeId, await revenueClassId(config, invoice), await revenueLocationId(config, invoice));
  const payloadHash = hashPayload(payload);
  if (!isProduction(config) && ledger?.status === 'synced' && ledger.payload_hash === payloadHash) return { status: 'skipped', reason: 'Already synchronized with the same payload.' };
  if (isProduction(config)) {
    const existing = classifyExistingTransactions(invoice, await findExistingQboTransactions(config, invoice));
    if (existing.kind === 'ambiguous') {
      const reason = `Production reconciliation found ${existing.count} QBO transaction(s) for source invoice '${invoice.sourceInvoiceId}', with ${existing.exactCount} exact OptiLens marker match(es).`;
      await upsertLedger(pool, config, invoice, { payloadHash, status: 'exception', approvalState: 'not_required', lastError: reason, reconciliationJson: JSON.stringify(existing) });
      return { status: 'exception', reason };
    }
    if (existing.kind === 'exact') {
      const { resource, transaction } = existing.match;
      if (ledger?.qbo_transaction_id && String(ledger.qbo_transaction_id) !== String(transaction.Id)) {
        const reason = `Production reconciliation found a different QBO ${resource} ID for source invoice '${invoice.sourceInvoiceId}'.`;
        await upsertLedger(pool, config, invoice, { payloadHash, status: 'exception', approvalState: 'not_required', lastError: reason });
        return { status: 'exception', reason };
      }
      const snapshotHash = transactionSnapshotHash(transaction);
      if (!ledger?.qbo_transaction_id || ledger.status !== 'synced' || ledger.payload_hash !== payloadHash) {
        const update = Boolean(ledger?.qbo_transaction_id);
        await upsertLedger(pool, config, invoice, { payloadHash, status: update ? 'pending_approval' : 'reconciled_existing', approvalState: update ? 'pending' : 'not_required', qboTransactionType: resource, qboTransactionId: transaction.Id, qboDocNumber: transaction.DocNumber, qboSnapshotHash: snapshotHash, reconciliationJson: JSON.stringify({ kind: update ? 'update_proposed' : 'existing_reconciled', qboId: transaction.Id, resource }) });
        return { status: update ? 'pending_approval' : 'reconciled_existing', qboId: transaction.Id, reason: update ? 'Existing QBO transaction changed in Innovations; approval is required before update.' : 'Existing QBO transaction reconciled without modification.' };
      }
      return { status: 'skipped', reason: 'Production QBO transaction already reconciled with the same payload.' };
    }
    if (ledger?.qbo_transaction_id) {
      const reason = `Production reconciliation could not find the QBO transaction previously recorded for source invoice '${invoice.sourceInvoiceId}'.`;
      await upsertLedger(pool, config, invoice, { payloadHash, status: 'exception', approvalState: 'not_required', lastError: reason });
      return { status: 'exception', reason };
    }
    await upsertLedger(pool, config, invoice, { payloadHash, status: 'pending_approval', approvalState: 'pending', approvalRequestedByUserId: actorUserId, reconciliationJson: JSON.stringify({ kind: 'create_proposed', qboSearch: 'no matching DocNumber/private note' }) });
    return { status: 'pending_approval', reason: 'No matching production QBO transaction; explicit approval is required before creation.' };
  }
  if (dryRun) { await upsertLedger(pool, config, invoice, { payloadHash, status: 'preview' }); return { status: 'preview', payload }; }
  let result;
  const resource = invoice.isCredit ? 'CreditMemo' : 'Invoice';
  if (ledger?.qbo_transaction_id) {
    const current = await qboRequest(config, `/${resource.toLowerCase()}/${ledger.qbo_transaction_id}`);
    result = await qboRequest(config, `/${resource.toLowerCase()}`, { method: 'POST', body: { ...payload, Id: ledger.qbo_transaction_id, SyncToken: current[resource].SyncToken, sparse: true } });
  } else result = await qboRequest(config, `/${resource.toLowerCase()}`, { method: 'POST', body: payload });
  const transaction = result[resource];
  await upsertLedger(pool, config, invoice, { payloadHash, status: 'synced', qboTransactionType: resource, qboTransactionId: transaction.Id, qboDocNumber: transaction.DocNumber, lastResultJson: JSON.stringify({ id: transaction.Id, total: transaction.TotalAmt }) });
  await recordAuditEvent({ moduleCode: 'automation', actorUserId, eventType: `automation.qbo_invoice_sync.${ledger?.qbo_transaction_id ? 'updated' : 'created'}`, entityType: resource, entityId: transaction.Id, eventData: { sourceInvoiceId: invoice.sourceInvoiceId, qboRealmId: config.realmId, total: transaction.TotalAmt } });
  return { status: ledger?.qbo_transaction_id ? 'updated' : 'created', qboId: transaction.Id };
}

async function approveProductionProposal({ sourceInvoiceId, actorUserId = null, automatic = false }) {
  const config = await accessConfig();
  if (!isProduction(config)) throw Object.assign(new Error('Production approval is available only for production QBO credentials.'), { statusCode: 409 });
  if (!productionApplyEnabled()) throw Object.assign(new Error('Production QBO apply is disabled. Set OPTILENS_QBO_PRODUCTION_APPLY_ENABLED=true only after reconciliation approval.'), { statusCode: 403 });
  const pool = await getAppPool();
  const invoice = (await discoverSourceInvoices({ sourceInvoiceId }))[0];
  if (!invoice) throw Object.assign(new Error(`Innovations invoice '${sourceInvoiceId}' was not found.`), { statusCode: 404 });
  const ledger = await findLedger(pool, config, invoice.sourceInvoiceId);
  if (!ledger || ledger.status !== 'pending_approval' || ledger.approval_state !== 'pending') throw Object.assign(new Error('This QBO item does not have a pending production approval.'), { statusCode: 409 });
  const mappings = await getMappings(config, pool);
  const customer = mappings.customersBySourceAccount.get(String(invoice.customerAccount || '').trim());
  const item = mappings.items.get(String(invoice.itemName || '').trim().toLowerCase());
  const taxCodeId = Number(invoice.taxAmount || 0) === 0 ? (config.vatZeroTaxCodeId || 'NON') : config.vatStandardTaxCodeId;
  if (!customer || !item || !taxCodeId) throw Object.assign(new Error('The approved source invoice no longer has valid confirmed QBO mappings.'), { statusCode: 409 });
  const payload = qboPayload(invoice, customer, item, taxCodeId, await revenueClassId(config, invoice), await revenueLocationId(config, invoice));
  const payloadHash = hashPayload(payload);
  if (ledger.payload_hash !== payloadHash) throw Object.assign(new Error('Innovations invoice changed after proposal; run reconciliation again before approval.'), { statusCode: 409 });
  const existing = classifyExistingTransactions(invoice, await findExistingQboTransactions(config, invoice));
  if (existing.kind === 'ambiguous') throw Object.assign(new Error('Production QBO reconciliation is ambiguous; no change was made.'), { statusCode: 409 });
  const resource = invoice.isCredit ? 'CreditMemo' : 'Invoice';
  let transaction;
  if (ledger.qbo_transaction_id) {
    if (existing.kind !== 'exact' || String(existing.match.transaction.Id) !== String(ledger.qbo_transaction_id) || existing.match.resource !== resource) throw Object.assign(new Error('The approved QBO transaction no longer matches the reconciliation result.'), { statusCode: 409 });
    const currentHash = transactionSnapshotHash(existing.match.transaction);
    if (!ledger.qbo_snapshot_hash || ledger.qbo_snapshot_hash !== currentHash) throw Object.assign(new Error('The QBO transaction changed after reconciliation; a new review is required.'), { statusCode: 409 });
    const result = await qboRequest(config, `/${resource.toLowerCase()}`, { method: 'POST', body: { ...payload, Id: ledger.qbo_transaction_id, SyncToken: existing.match.transaction.SyncToken, sparse: true } });
    transaction = result[resource];
  } else {
    if (existing.kind !== 'none') throw Object.assign(new Error('A QBO transaction now exists for this source invoice; reconcile it before approval.'), { statusCode: 409 });
    const result = await qboRequest(config, `/${resource.toLowerCase()}`, { method: 'POST', body: payload });
    transaction = result[resource];
  }
  await upsertLedger(pool, config, invoice, { payloadHash, status: 'synced', approvalState: 'applied', approvedByUserId: actorUserId, qboTransactionType: resource, qboTransactionId: transaction.Id, qboDocNumber: transaction.DocNumber, qboSnapshotHash: transactionSnapshotHash(transaction), lastResultJson: JSON.stringify({ id: transaction.Id, total: transaction.TotalAmt }) });
  await recordAuditEvent({ moduleCode: 'automation', actorUserId, eventType: `automation.qbo_invoice_sync.production_${ledger.qbo_transaction_id ? 'update' : 'create'}_approved`, entityType: resource, entityId: transaction.Id, eventData: { sourceInvoiceId: invoice.sourceInvoiceId, qboRealmId: config.realmId, total: transaction.TotalAmt, approvalPolicy: automatic ? 'automatic-production-apply' : 'explicit-production-approval' } });
  return { status: ledger.qbo_transaction_id ? 'updated' : 'created', qboId: transaction.Id };
}

async function syncInvoices({ fromDate = null, toDate = null, dryRun = true, trigger = 'manual', actorUserId = null } = {}) {
  if (activeRun) return activeRun;
  activeRun = (async () => {
    const startedAt = new Date().toISOString();
    const release = acquireLock();
    try {
      const config = await accessConfig();
      const pool = await getAppPool();
      const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const defaultTo = new Date().toISOString().slice(0, 10);
      const invoices = await discoverSourceInvoices({ fromDate: effectiveFromDate(config, fromDate || defaultFrom), toDate: toDate || defaultTo });
      if (!dryRun && process.env.OPTILENS_CUSTOMER_SYNC_ENABLED === 'true') await drainCustomerJobs(pool, config);
      const mappings = await getMappings(config, pool);
      const autoApply = !dryRun && isProduction(config) && productionAutoApplyEnabled();
      let autoPosted = 0; let autoHalted = false;
      const counts = { discovered: invoices.length, preview: 0, reconciled_existing: 0, pending_approval: 0, created: 0, updated: 0, skipped: 0, exception: 0, failed: 0 };
      const results = [];
      for (const invoice of invoices) {
        try {
          let outcome = await syncOne(pool, config, mappings, invoice, { dryRun, actorUserId });
          if (autoApply && !autoHalted && autoPosted < AUTO_POST_PER_RUN && outcome.status === 'pending_approval' && reviewModel.holdReasons(invoice, { reviewLimit: reviewLimit() }).length === 0) {
            outcome = { ...(await approveProductionProposal({ sourceInvoiceId: invoice.sourceInvoiceId, actorUserId, automatic: true })), reason: 'Posted automatically (auto-post is on).' };
            autoPosted += 1;
          }
          counts[outcome.status] = (counts[outcome.status] || 0) + 1;
          results.push({ sourceInvoiceId: invoice.sourceInvoiceId, ...outcome });
          if (outcome.status === 'exception') await recordAuditEvent({ moduleCode: 'automation', actorUserId, eventType: 'automation.qbo_invoice_sync.exception', entityType: 'InnovationsInvoice', entityId: String(invoice.sourceInvoiceId), eventData: { reason: outcome.reason } });
        } catch (error) { autoHalted = true; counts.failed += 1; results.push({ sourceInvoiceId: invoice.sourceInvoiceId, status: 'failed', reason: error.message }); await upsertLedger(pool, config, invoice, { status: 'failed', lastError: error.message }); }
      }
      const result = { ok: true, trigger, dryRun, startedAt, finishedAt: new Date().toISOString(), counts, results: results.slice(0, 200) };
      appendLog('sync.finished', result); return result;
    } catch (error) { appendLog('sync.failed', { ok: false, trigger, dryRun, startedAt, error: error.message }); throw error; }
    finally { release(); }
  })().finally(() => { activeRun = null; });
  return activeRun;
}

// Everything the review screen needs in one read: Innovations invoices since the cutover, their sync ledger rows
// and the confirmed QuickBooks customer names. It never calls QuickBooks, so it stays fast and safe to poll.
async function loadReview({ fromDate = null } = {}) {
  const config = qboFromProtectedStore();
  if (!config?.realmId) throw Object.assign(new Error('Configure a QuickBooks company to review invoices.'), { statusCode: 503 });
  const pool = await getAppPool();
  const realm = (request) => request.input('realm', sql.NVarChar(80), config.realmId);
  const [invoices, ledger, names] = await Promise.all([
    discoverSourceInvoices({ fromDate: fromDate || effectiveFromDate(config, null) }),
    realm(pool.request()).query(`
      SELECT source_invoice_id, status, approval_state, qbo_transaction_type, qbo_transaction_id, last_error
      FROM qbo.invoice_sync_ledger WHERE qbo_realm_id=@realm`),
    realm(pool.request()).query(`
      SELECT source_account, qbo_display_name FROM qbo.customer_mappings
      WHERE qbo_realm_id=@realm AND mapping_state=N'confirmed'`)
  ]);
  const rows = reviewModel.buildReviewRows({
    invoices,
    ledger: ledger.recordset,
    customerNames: new Map(names.recordset.map((row) => [String(row.source_account).trim(), row.qbo_display_name])),
    reviewLimit: Number(process.env.OPTILENS_QBO_REVIEW_LIMIT) || undefined
  });
  return {
    environment: config.environment,
    realmId: config.realmId,
    canPost: !isProduction(config) || productionApplyEnabled(),
    autoPost: productionAutoApplyEnabled(),
    autoPostSetting: postingSettings.readPostingSettings(),
    autoPostPerRun: AUTO_POST_PER_RUN,
    summary: reviewModel.summarizeRows(rows),
    rows
  };
}

// Reads every QuickBooks invoice and credit memo since the cutover (a week earlier, so date skew cannot hide a
// match) and compares them with Innovations by invoice number. Read-only: nothing is written anywhere.
const QBO_PAGE_SIZE = 1000;
const QBO_MAX_PAGES = 20;
const RECONCILE_DATE_SKEW_DAYS = 7;
// The comparison reaches back before the cutover so invoices imported from the old CSV process are checked too.
const RECONCILE_DEFAULT_FROM = '2026-11-01';
function reconcileFromDate() {
  const value = String(process.env.OPTILENS_QBO_RECONCILE_FROM || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : RECONCILE_DEFAULT_FROM;
}

async function fetchQboDocuments(config, resource, sinceDate) {
  const docs = [];
  for (let page = 0; page < QBO_MAX_PAGES; page += 1) {
    const result = await qboQuery(config, `SELECT Id, DocNumber, TxnDate, TotalAmt, PrivateNote, CustomerRef FROM ${resource} WHERE TxnDate >= '${qboLiteral(sinceDate)}' ORDERBY TxnDate STARTPOSITION ${page * QBO_PAGE_SIZE + 1} MAXRESULTS ${QBO_PAGE_SIZE}`);
    const batch = result[resource] || [];
    docs.push(...batch.map((raw) => reconciliation.normalizeQboDoc(raw, resource)));
    if (batch.length < QBO_PAGE_SIZE) return { docs, truncated: false };
  }
  return { docs, truncated: true };
}

async function loadReconciliation() {
  const config = await accessConfig();
  const from = reconcileFromDate();
  const widened = new Date(`${from}T00:00:00Z`);
  widened.setUTCDate(widened.getUTCDate() - RECONCILE_DATE_SKEW_DAYS);
  const since = widened.toISOString().slice(0, 10);
  const [review, invoices, credits] = await Promise.all([loadReview({ fromDate: from }), fetchQboDocuments(config, 'Invoice', since), fetchQboDocuments(config, 'CreditMemo', since)]);
  const rows = reconciliation.reconcile({ rows: review.rows, qboDocs: invoices.docs.concat(credits.docs), from });
  return { environment: config.environment, realmId: config.realmId, checkedAt: new Date().toISOString(), from, truncated: invoices.truncated || credits.truncated, summary: reconciliation.summarize(rows), rows };
}

async function listQboInvoiceLedger({ limit = 100, status = null } = {}) {
  const bounded = Math.min(Math.max(Number(limit) || 100, 1), 250);
  const pool = await getAppPool();
  const realmId = qboFromProtectedStore()?.realmId || null;
  const result = await pool.request().input('limit', sql.Int, bounded).input('status', sql.NVarChar(40), status || null).input('realm', sql.NVarChar(80), realmId).query(`
    SELECT TOP (@limit) sync_ledger_id, source_system, source_invoice_id, source_invoice_type,
           qbo_realm_id, qbo_transaction_type, qbo_transaction_id, qbo_doc_number,
           source_customer_account, source_customer_name, source_total, source_invoice_time,
           payload_hash, status, approval_state, approval_requested_at, approved_at, qbo_snapshot_hash,
           attempt_count, last_error, first_seen_at, last_attempt_at, synced_at, updated_at
    FROM qbo.invoice_sync_ledger
    WHERE (@status IS NULL OR status = @status) AND (@realm IS NULL OR qbo_realm_id = @realm)
    ORDER BY updated_at DESC;
  `);
  return result.recordset;
}

// Fix paths for the exception review panel. These save a mapping or a setting only; they never write invoices to QBO.
async function getExceptionFixOptions() {
  const config = await accessConfig();
  const [customers, taxCodes] = await Promise.all([
    qboQuery(config, 'SELECT Id, DisplayName FROM Customer WHERE Active = true MAXRESULTS 1000'),
    qboQuery(config, 'SELECT Id, Name, Description FROM TaxCode MAXRESULTS 1000')
  ]);
  return {
    customers: (customers.Customer || []).map((row) => ({ id: String(row.Id), displayName: row.DisplayName })),
    taxCodes: (taxCodes.TaxCode || []).map((row) => ({ id: String(row.Id), name: row.Name, description: row.Description || '' })),
    standardTaxCodeId: config.vatStandardTaxCodeId || null
  };
}
async function confirmCustomerMapping({ sourceAccount, qboCustomerId, actorUserId = null }) {
  const account = String(sourceAccount || '').trim();
  if (!account || !qboCustomerId) throw Object.assign(new Error('An Innovations account and a QBO customer are required.'), { statusCode: 400 });
  const config = await accessConfig();
  const found = await qboQuery(config, `SELECT Id, DisplayName FROM Customer WHERE Id = '${qboLiteral(qboCustomerId)}'`);
  const qboCustomer = (found.Customer || [])[0];
  if (!qboCustomer) throw Object.assign(new Error('That QBO customer was not found.'), { statusCode: 404 });
  const pool = await getAppPool();
  const existing = await pool.request().input('realmId', sql.NVarChar(80), config.realmId).input('sourceAccount', sql.NVarChar(120), account).query(`
    SELECT TOP 1 qbo_customer_id FROM qbo.customer_mappings WHERE qbo_realm_id=@realmId AND source_account=@sourceAccount AND mapping_state=N'confirmed'
  `);
  if (existing.recordset[0]) {
    if (String(existing.recordset[0].qbo_customer_id) === String(qboCustomer.Id)) return { ok: true, unchanged: true };
    throw Object.assign(new Error(`Innovations account '${account}' is already mapped to a different QBO customer.`), { statusCode: 409 });
  }
  const source = await getSourcePool().then((p) => p.request().input('account', sql.NVarChar(120), account).query('SELECT TOP 1 CustomerName FROM dbo.Customers WHERE AccountNumber = @account'));
  await pool.request()
    .input('realmId', sql.NVarChar(80), config.realmId).input('sourceAccount', sql.NVarChar(120), account)
    .input('sourceName', sql.NVarChar(300), source.recordset[0]?.CustomerName || account).input('qboCustomerId', sql.NVarChar(120), String(qboCustomer.Id))
    .input('qboDisplayName', sql.NVarChar(500), qboCustomer.DisplayName).query(`
      INSERT INTO qbo.customer_mappings (qbo_realm_id, source_account, source_name, qbo_customer_id, qbo_display_name, mapping_state)
      VALUES (@realmId, @sourceAccount, @sourceName, @qboCustomerId, @qboDisplayName, N'confirmed')
    `);
  await recordAuditEvent({ moduleCode: 'automation', actorUserId, eventType: 'automation.qbo_customer_mapping.confirmed', entityType: 'QboCustomerMapping', entityId: account, eventData: { qboRealmId: config.realmId, qboCustomerId: String(qboCustomer.Id), via: 'exception_review' } });
  return { ok: true, qboDisplayName: qboCustomer.DisplayName };
}
async function saveStandardTaxCode({ taxCodeId, actorUserId = null }) {
  const config = await accessConfig();
  const found = await qboQuery(config, `SELECT Id, Name FROM TaxCode WHERE Id = '${qboLiteral(taxCodeId)}'`);
  const taxCode = (found.TaxCode || [])[0];
  if (!taxCode) throw Object.assign(new Error('That QBO tax code was not found.'), { statusCode: 404 });
  saveQboTokens({ ...qboFromProtectedStore(), vatStandardTaxCodeId: String(taxCode.Id) });
  await recordAuditEvent({ moduleCode: 'automation', actorUserId, eventType: 'automation.qbo_tax_code.configured', entityType: 'QboTaxCode', entityId: String(taxCode.Id), eventData: { name: taxCode.Name, role: 'vatStandard', via: 'exception_review' } });
  return { ok: true, name: taxCode.Name };
}
// Re-runs the preview check for specific invoices so a fixed exception clears (or shows its next problem) straight away.
async function recheckInvoices({ sourceInvoiceIds = [], actorUserId = null } = {}) {
  const ids = [...new Set(sourceInvoiceIds.map(String))].slice(0, 50);
  const config = await accessConfig();
  const pool = await getAppPool();
  const mappings = await getMappings(config, pool);
  const results = [];
  for (const id of ids) {
    const invoice = (await discoverSourceInvoices({ sourceInvoiceId: id }))[0];
    if (!invoice) { results.push({ sourceInvoiceId: id, status: 'missing', reason: 'No longer in the Innovations export scope.' }); continue; }
    try { results.push({ sourceInvoiceId: id, ...(await syncOne(pool, config, mappings, invoice, { dryRun: true, actorUserId })) }); }
    catch (error) { results.push({ sourceInvoiceId: id, status: 'failed', reason: error.message }); }
  }
  return { results };
}

function queryTask() {
  if (process.platform !== 'win32') return null;
  try { const out = execFileSync('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 3000 }).trim(); const fields = (out.match(/("(?:[^"]|"")*"|[^,]*)/g) || []).filter(Boolean).map((field) => field.startsWith('"') ? field.slice(1, -1).replace(/""/g, '"') : field); return { name: TASK_NAME, nextRun: fields[1] || null, state: fields[2] || null }; } catch { return null; }
}
function getQboInvoiceSyncStatus() {
  const config = qboFromProtectedStore();
  const last = [...readRecent()].reverse().find((event) => event.event === 'sync.finished' || event.event === 'sync.failed');
  const production = isProduction(config);
  const guarded = production && !productionApplyEnabled();
  return { name: 'Innovations → QuickBooks invoices', state: activeRun ? 'running' : !config ? 'warning' : last?.event === 'sync.failed' ? 'error' : 'online', detail: !config ? 'QuickBooks credentials are not configured in the protected QBO environment store.' : production ? `Production reconciliation is ${guarded ? 'guarded: approval apply is disabled' : 'enabled only for explicitly approved proposals'}. ${last ? `Last ${last.event === 'sync.finished' ? 'run completed' : 'run failed'} at ${last.at}.` : 'No sync run recorded yet.'}` : last ? `Last ${last.event === 'sync.finished' ? 'run completed' : 'run failed'} at ${last.at}.` : 'Configured; no sync run recorded yet.', task: queryTask(), intervalMinutes: DEFAULT_INTERVAL_MINUTES, lastRun: last?.at || null, running: Boolean(activeRun), lastResult: last || null, environment: config?.environment || null, realmId: config?.realmId || null, productionApplyEnabled: production ? productionApplyEnabled() : false, productionAutoApply: production ? productionAutoApplyEnabled() : false, cutoverDate: (() => { try { return cutoverDate(); } catch { return 'invalid'; } })() };
}

module.exports = { loadReconciliation, setAutoPost, loadReview, syncOne, saveLocalCustomer, customerJobStatus, confirmCustomerMapping, getExceptionFixOptions, recheckInvoices, saveStandardTaxCode, DEFAULT_INTERVAL_MINUTES, LOG_FILE, TASK_NAME, appendLog, approveProductionProposal, classifyExistingTransactions, configuredEnvironment, cutoverDate, effectiveFromDate, getQboInvoiceSyncStatus, isProduction, listQboInvoiceLedger, productionApplyEnabled, productionAutoApplyEnabled, seedExactCustomerMappings, syncInvoices, transactionSnapshotHash };
module.exports.openQboReadConnection = openQboReadConnection;
