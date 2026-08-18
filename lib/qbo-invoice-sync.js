'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sql = require('mssql');
const { getAppPool, getSourcePool } = require('./db');
const { recordAuditEvent } = require('./audit');
const { qboFromVault, saveQboTokens } = require('./credential-vault');

const TASK_NAME = 'OptiLens QuickBooks Invoice Sync';
const LOG_FILE = path.join(__dirname, '..', 'data', 'logs', 'qbo-invoice-sync.jsonl');
const LOCK_FILE = path.join(__dirname, '..', 'data', 'logs', 'qbo-invoice-sync.lock');
const DEFAULT_INTERVAL_MINUTES = Number(process.env.OPTILENS_QBO_SYNC_INTERVAL_MINUTES || 30);
let activeRun = null;

function appendLog(event, details = {}) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`);
}
function readRecent() {
  try { return fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean).slice(-100).map(JSON.parse); } catch { return []; }
}
function hashPayload(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
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
  const config = qboFromVault();
  if (!config) throw Object.assign(new Error('QuickBooks credentials are not configured in the Credentials Vault.'), { statusCode: 503 });
  if (tokenStillValid(config)) return config;
  const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const response = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: config.refreshToken })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token || !body.refresh_token) throw new Error(`QuickBooks token refresh failed (${response.status}).`);
  return saveQboTokens({ ...config, accessToken: body.access_token, refreshToken: body.refresh_token, createdAt: Date.now() });
}
async function qboRequest(config, resource, options = {}) {
  const response = await fetch(`${qboBase(config)}${resource}`, {
    method: options.method || 'GET',
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
async function getMappings(config) {
  const [customers, items] = await Promise.all([
    qboQuery(config, 'SELECT * FROM Customer MAXRESULTS 1000'),
    qboQuery(config, 'SELECT * FROM Item MAXRESULTS 1000')
  ]);
  return {
    customers: new Map((customers.Customer || []).map((row) => [String(row.DisplayName || '').trim().toLowerCase(), row])),
    items: new Map((items.Item || []).map((row) => [String(row.Name || '').trim().toLowerCase(), row]))
  };
}

async function discoverSourceInvoices({ fromDate = null, toDate = null } = {}) {
  const pool = await getSourcePool();
  const result = await pool.request()
    .input('fromDate', sql.Date, fromDate || null)
    .input('toDate', sql.Date, toDate || null)
    .query(`
      SELECT TOP (500)
        fsj.InvoiceID AS sourceInvoiceId,
        fsj.CustomerID AS sourceCustomerId,
        c.AccountNumber AS customerAccount,
        c.CustomerName AS customerName,
        CASE WHEN ot.OrderTypeID = 6 THEN N'Stock Orders - ' + ISNULL(bg.BuyinGroupName, N'')
             ELSE ot.OrderTypeName + N' Orders - ' + ISNULL(bg.BuyinGroupName, N'') END AS itemName,
        fsj.Patient AS memo,
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
      WHERE fsj.InvoiceID IS NOT NULL
        AND (@fromDate IS NULL OR CAST(fsj.InvoiceTime AS date) >= @fromDate)
        AND (@toDate IS NULL OR CAST(fsj.InvoiceTime AS date) <= @toDate)
      ORDER BY fsj.InvoiceTime, fsj.InvoiceID
    `);
  return result.recordset;
}

async function findLedger(pool, config, sourceInvoiceId) {
  const result = await pool.request().input('sourceSystem', 'innovations').input('sourceInvoiceId', String(sourceInvoiceId)).input('realmId', config.realmId).query(`SELECT TOP 1 * FROM qbo.invoice_sync_ledger WHERE source_system=@sourceSystem AND source_invoice_id=@sourceInvoiceId AND qbo_realm_id=@realmId`);
  return result.recordset[0] || null;
}
async function upsertLedger(pool, config, invoice, fields = {}) {
  const result = await pool.request()
    .input('sourceSystem', 'innovations').input('sourceInvoiceId', String(invoice.sourceInvoiceId)).input('sourceInvoiceType', invoice.isCredit ? 'credit' : 'invoice')
    .input('realmId', config.realmId).input('customerAccount', invoice.customerAccount || null).input('customerName', invoice.customerName || null)
    .input('total', Number(invoice.total || 0)).input('invoiceTime', invoice.invoiceTime || null).input('payloadHash', fields.payloadHash || null).input('status', fields.status || 'discovered')
    .input('qboType', fields.qboTransactionType || null).input('qboId', fields.qboTransactionId || null).input('docNumber', fields.qboDocNumber || null)
    .input('error', fields.lastError || null).input('resultJson', fields.lastResultJson || null).query(`
      MERGE qbo.invoice_sync_ledger AS target
      USING (SELECT @sourceSystem source_system, @sourceInvoiceId source_invoice_id, @realmId qbo_realm_id) AS source
      ON target.source_system=source.source_system AND target.source_invoice_id=source.source_invoice_id AND target.qbo_realm_id=source.qbo_realm_id
      WHEN MATCHED THEN UPDATE SET source_invoice_type=@sourceInvoiceType, source_customer_account=@customerAccount, source_customer_name=@customerName, source_total=@total, source_invoice_time=@invoiceTime, payload_hash=COALESCE(@payloadHash,target.payload_hash), status=@status, qbo_transaction_type=COALESCE(@qboType,target.qbo_transaction_type), qbo_transaction_id=COALESCE(@qboId,target.qbo_transaction_id), qbo_doc_number=COALESCE(@docNumber,target.qbo_doc_number), last_error=@error, last_result_json=@resultJson, last_attempt_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (source_system,source_invoice_id,source_invoice_type,qbo_realm_id,qbo_transaction_type,qbo_transaction_id,qbo_doc_number,source_customer_account,source_customer_name,source_total,source_invoice_time,payload_hash,status,last_error,last_result_json,last_attempt_at)
      VALUES (@sourceSystem,@sourceInvoiceId,@sourceInvoiceType,@realmId,@qboType,@qboId,@docNumber,@customerAccount,@customerName,@total,@invoiceTime,@payloadHash,@status,@error,@resultJson,SYSUTCDATETIME());
    `);
  return result;
}

function qboPayload(invoice, customer, item, taxCodeId) {
  const amount = Math.abs(Number(invoice.total || 0));
  return {
    DocNumber: String(invoice.sourceInvoiceId), TxnDate: new Date(invoice.invoiceTime).toISOString().slice(0, 10), DueDate: new Date(invoice.dueDate).toISOString().slice(0, 10),
    CustomerRef: { value: String(customer.Id), name: customer.DisplayName },
    Line: [{ DetailType: 'SalesItemLineDetail', Amount: amount, Description: invoice.memo || undefined, SalesItemLineDetail: { ItemRef: { value: String(item.Id), name: item.Name }, Qty: 1, UnitPrice: amount, TaxCodeRef: { value: taxCodeId } } }],
    PrivateNote: `OptiLens source Innovations invoice ${invoice.sourceInvoiceId}`,
    GlobalTaxCalculation: 'NotApplicable'
  };
}

async function syncOne(pool, config, mappings, invoice, { dryRun, actorUserId }) {
  const customerDisplay = `${invoice.customerName || ''} - ${invoice.customerAccount || ''}`.trim();
  const customer = mappings.customers.get(customerDisplay.toLowerCase());
  const item = mappings.items.get(String(invoice.itemName || '').trim().toLowerCase());
  const taxCodeId = Number(invoice.taxAmount || 0) === 0 ? (config.vatZeroTaxCodeId || 'NON') : config.vatStandardTaxCodeId;
  const ledger = await findLedger(pool, config, invoice.sourceInvoiceId);
  if (!customer) return { status: 'exception', reason: `No exact QBO customer mapping for '${customerDisplay}'.` };
  if (!item) return { status: 'exception', reason: `No exact QBO item mapping for '${invoice.itemName}'.` };
  if (!taxCodeId) return { status: 'exception', reason: 'VAT 17.5% requires a configured QBO tax code ID.' };
  const payload = qboPayload(invoice, customer, item, taxCodeId);
  const payloadHash = hashPayload(payload);
  if (ledger?.status === 'synced' && ledger.payload_hash === payloadHash) return { status: 'skipped', reason: 'Already synchronized with the same payload.' };
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

async function syncInvoices({ fromDate = null, toDate = null, dryRun = true, trigger = 'manual', actorUserId = null } = {}) {
  if (activeRun) return activeRun;
  activeRun = (async () => {
    const startedAt = new Date().toISOString();
    const release = acquireLock();
    try {
      const config = await accessConfig();
      const pool = await getAppPool();
      const mappings = await getMappings(config);
      const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const defaultTo = new Date().toISOString().slice(0, 10);
      const invoices = await discoverSourceInvoices({ fromDate: fromDate || defaultFrom, toDate: toDate || defaultTo });
      const counts = { discovered: invoices.length, preview: 0, created: 0, updated: 0, skipped: 0, exception: 0, failed: 0 };
      const results = [];
      for (const invoice of invoices) {
        try {
          const outcome = await syncOne(pool, config, mappings, invoice, { dryRun, actorUserId });
          counts[outcome.status] = (counts[outcome.status] || 0) + 1;
          results.push({ sourceInvoiceId: invoice.sourceInvoiceId, ...outcome });
          if (outcome.status === 'exception') await recordAuditEvent({ moduleCode: 'automation', actorUserId, eventType: 'automation.qbo_invoice_sync.exception', entityType: 'InnovationsInvoice', entityId: String(invoice.sourceInvoiceId), eventData: { reason: outcome.reason } });
        } catch (error) { counts.failed += 1; results.push({ sourceInvoiceId: invoice.sourceInvoiceId, status: 'failed', reason: error.message }); await upsertLedger(pool, config, invoice, { status: 'failed', lastError: error.message }); }
      }
      const result = { ok: true, trigger, dryRun, startedAt, finishedAt: new Date().toISOString(), counts, results: results.slice(0, 200) };
      appendLog('sync.finished', result); return result;
    } catch (error) { appendLog('sync.failed', { ok: false, trigger, dryRun, startedAt, error: error.message }); throw error; }
    finally { release(); }
  })().finally(() => { activeRun = null; });
  return activeRun;
}

async function listQboInvoiceLedger({ limit = 100, status = null } = {}) {
  const bounded = Math.min(Math.max(Number(limit) || 100, 1), 250);
  const pool = await getAppPool();
  const result = await pool.request().input('limit', sql.Int, bounded).input('status', sql.NVarChar(40), status || null).query(`
    SELECT TOP (@limit) sync_ledger_id, source_system, source_invoice_id, source_invoice_type,
           qbo_realm_id, qbo_transaction_type, qbo_transaction_id, qbo_doc_number,
           source_customer_account, source_customer_name, source_total, source_invoice_time,
           payload_hash, status, attempt_count, last_error, first_seen_at, last_attempt_at, synced_at, updated_at
    FROM qbo.invoice_sync_ledger
    WHERE (@status IS NULL OR status = @status)
    ORDER BY updated_at DESC;
  `);
  return result.recordset;
}

function queryTask() {
  if (process.platform !== 'win32') return null;
  try { const out = execFileSync('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 3000 }).trim(); const fields = (out.match(/("(?:[^"]|"")*"|[^,]*)/g) || []).filter(Boolean).map((field) => field.startsWith('"') ? field.slice(1, -1).replace(/""/g, '"') : field); return { name: TASK_NAME, nextRun: fields[1] || null, state: fields[2] || null }; } catch { return null; }
}
function getQboInvoiceSyncStatus() {
  const config = qboFromVault();
  const last = [...readRecent()].reverse().find((event) => event.event === 'sync.finished' || event.event === 'sync.failed');
  return { name: 'Innovations → QuickBooks invoices', state: activeRun ? 'running' : !config ? 'warning' : last?.event === 'sync.failed' ? 'error' : 'online', detail: !config ? 'QuickBooks credentials are not configured in the Credentials Vault.' : last ? `Last ${last.event === 'sync.finished' ? 'run completed' : 'run failed'} at ${last.at}.` : 'Configured; no sync run recorded yet.', task: queryTask(), intervalMinutes: DEFAULT_INTERVAL_MINUTES, lastRun: last?.at || null, running: Boolean(activeRun), lastResult: last || null, environment: config?.environment || null, realmId: config?.realmId || null };
}

module.exports = { DEFAULT_INTERVAL_MINUTES, LOG_FILE, TASK_NAME, getQboInvoiceSyncStatus, listQboInvoiceLedger, syncInvoices };
