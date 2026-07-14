/**
 * innovations-sync.js — outbound push of selected Innovations MS SQL data to the
 * Classic Visions cloud (Supabase edge fn `innovations-sync`). Direction A:
 * office reads read-only and pushes; the office DB is never exposed inbound.
 *
 * Idempotent: every entity upserts on an immutable Innovations id, so re-runs
 * never duplicate. Dry-run by default; pass { commit:true } to actually write.
 *
 * Contract: docs/integration-innovations-sync-contract.md (Classic Visions repo).
 *
 * ┌─ VERIFY ON FIRST DRY-RUN ──────────────────────────────────────────────┐
 * │ The `customers` SQL uses columns confirmed in lib/source-innovations.js │
 * │ (CustomerID, AccountNumber, CustomerName, IsActive). The `contacts` SQL │
 * │ uses ASSUMED dbo.Contacts columns — adjust the ENTITIES[].sql / .map    │
 * │ below if the first dry-run reports an "Invalid column name" error.      │
 * │ `statements` / `statement_lines` / `balances` / the customer payment    │
 * │ fields (PayByCard/PayByEFT/EFTInstitutionID/DefaultPaymentType) were    │
 * │ confirmed directly against INFORMATION_SCHEMA.COLUMNS on 2026-07-02 —   │
 * │ see dbo.FinARStatements, dbo.FinARStatementItems, dbo.CustomerBalances, │
 * │ dbo.EFTInstitutions.                                                    │
 * └────────────────────────────────────────────────────────────────────────┘
 */
const { getSourcePool } = require('./db');
const syncLog = require('./innovations-sync-log');

const DEFAULT_FUNCTIONS_BASE = 'https://xstmeirxhfbiyayrrsob.supabase.co/functions/v1';

// Per-entity source query + row->CV-record mapper. Keep mapped keys aligned with
// the receiver's allowlist (supabase/functions/innovations-sync/index.ts).
const ENTITIES = {
  // The bank directory is intentionally a separate source entity from
  // `customers`: customers refer to it by its *exact* EFTInstitutionName, and
  // the CV app needs the full source list even before a customer happens to
  // use a particular institution.  URLs are deliberately not included here;
  // they are curated in CV and must never be overwritten by an ERP sync.
  banks: {
    sql: `
      SELECT EFTInstitutionID, EFTInstitutionName
      FROM dbo.EFTInstitutions
      WHERE NULLIF(LTRIM(RTRIM(EFTInstitutionName)), '') IS NOT NULL
      ORDER BY EFTInstitutionID
    `,
    map: (r) => ({
      innovations_eft_institution_id: Number(r.EFTInstitutionID),
      // Do not trim this value. It must remain byte-for-byte compatible with
      // dbo.Customers -> customers.eft_institution_name for portal routing.
      bank_name: String(r.EFTInstitutionName),
    }),
  },
  customers: {
    sql: `
      SELECT c.CustomerID, c.AccountNumber, c.CustomerName, c.IsActive,
             c.PayByCard, c.PayByEFT, c.DefaultPaymentType, e.EFTInstitutionName
      FROM dbo.Customers c
      LEFT JOIN dbo.EFTInstitutions e ON e.EFTInstitutionID = c.EFTInstitutionID
      WHERE c.IsActive = 1
      ORDER BY c.CustomerID
    `,
    // `type` and `pipeline_stage` have CHECK constraints in the CV schema
    // (customers_type_check etc.), so we leave them for the CRM to set rather
    // than guess allowed values. Active flag is folded into notes.
    // Payment fields feed the portal's "Pay Balance" routing: card capture vs.
    // redirect to the customer's bank (bank_payment_portals, keyed by
    // eft_institution_name).
    map: (r) => ({
      innovations_customer_id: r.CustomerID,
      name: r.CustomerName,
      account_number: r.AccountNumber != null ? String(r.AccountNumber) : null,
      notes: Number(r.IsActive) === 1 ? 'Innovations: active' : 'Innovations: inactive',
      pay_by_card: !!r.PayByCard,
      pay_by_eft: !!r.PayByEFT,
      eft_institution_name: r.EFTInstitutionName || null,
      default_payment_type: r.DefaultPaymentType != null ? Number(r.DefaultPaymentType) : null,
    }),
  },
  // Columns confirmed against the live dbo.Contacts schema.
  contacts: {
    sql: `
      SELECT ContactID, CustomerID, FirstName, Surname, EmailAddress, PhoneNumber, MobileNumber
      FROM dbo.Contacts
      ORDER BY ContactID
    `,
    map: (r) => ({
      innovations_contact_id: r.ContactID,
      innovations_parent_customer_id: r.CustomerID,
      name: [r.FirstName, r.Surname].filter(Boolean).join(' ').trim() || '(unnamed)',
      email: r.EmailAddress || '',
      phone: r.PhoneNumber || r.MobileNumber || '',
      is_company: false,
    }),
  },
  // Per-customer balance snapshot (source: dbo.CustomerBalances). Refreshed
  // wholesale each run — no history, just current values. Sync after
  // `customers` so the receiver can resolve customer_id/account_number.
  balances: {
    sql: `
      SELECT CustomerID, CreditLimit, CurrentBalance,
             LastStatementAmount, LastStatementDate, LastPaymentAmount, LastPaymentDate
      FROM dbo.CustomerBalances
      ORDER BY CustomerID
    `,
    map: (r) => ({
      innovations_customer_id: r.CustomerID,
      credit_limit: r.CreditLimit != null ? Number(r.CreditLimit) : null,
      current_balance: r.CurrentBalance != null ? Number(r.CurrentBalance) : null,
      last_statement_amount: r.LastStatementAmount != null ? Number(r.LastStatementAmount) : null,
      last_statement_date: r.LastStatementDate || null,
      last_payment_amount: r.LastPaymentAmount != null ? Number(r.LastPaymentAmount) : null,
      last_payment_date: r.LastPaymentDate || null,
    }),
  },
  // Aggregate companion to the portal order view: active Rx/stock work in
  // dbo.Orders plus completed non-cancelled jobs in dbo.RxArchive. It emits
  // one current activity row for every active LMS customer.
  order_activity: {
    sql: `
      WITH run_date AS (
        SELECT CAST(SYSDATETIME() AS date) AS value
      ),
      raw_order_events AS (
        SELECT o.CustomerID, o.OrderID AS order_id, CAST(o.ReceivedTime AS date) AS order_date
        FROM dbo.Orders o
        INNER JOIN dbo.GenStatus gs ON gs.GenStatus = o.GenStatus
        WHERE gs.Active = 1
          AND o.JobID IS NOT NULL
          AND o.JobID <> ''
          AND o.OrderType IN (1, 3)

        UNION ALL

        SELECT o.CustomerID, a.SerialNum AS order_id,
               CAST(CONCAT(CONVERT(varchar(10), a.RxDate, 120), ' ', CONVERT(varchar(8), a.RxTime, 108)) AS datetime2) AS order_date
        FROM dbo.RxArchive a
        INNER JOIN dbo.Orders o ON o.OrderID = a.SerialNum
        WHERE a.TermCode IN (
          SELECT StatusItemID
          FROM dbo.StatusItems
          WHERE Terminating = 1 AND Cancellation = 0
        )
      ),
      -- Avoid counting a job twice while it transitions to archive.
      order_events AS (
        SELECT CustomerID, order_id, MAX(order_date) AS order_date
        FROM raw_order_events
        WHERE order_date IS NOT NULL
        GROUP BY CustomerID, order_id
      ),
      customer_activity AS (
        SELECT
          c.CustomerID,
          MAX(CASE WHEN e.order_date <= d.value THEN e.order_date END) AS last_order_date,
          COUNT(CASE WHEN e.order_date >= DATEADD(day, -6, d.value) AND e.order_date <= d.value THEN e.order_id END) AS orders_last_7_days,
          COUNT(CASE WHEN e.order_date >= DATEADD(day, -29, d.value) AND e.order_date <= d.value THEN e.order_id END) AS orders_last_30_days,
          COUNT(CASE WHEN e.order_date >= DATEADD(day, -89, d.value) AND e.order_date <= d.value THEN e.order_id END) AS orders_last_90_days
        FROM dbo.Customers c
        CROSS JOIN run_date d
        LEFT JOIN order_events e ON e.CustomerID = c.CustomerID
        WHERE c.IsActive = 1
        GROUP BY c.CustomerID
      ),
      recent_distinct_dates AS (
        SELECT DISTINCT e.CustomerID, e.order_date
        FROM order_events e
        CROSS JOIN run_date d
        WHERE e.order_date >= DATEADD(day, -89, d.value) AND e.order_date <= d.value
      ),
      date_gaps AS (
        SELECT CustomerID,
               DATEDIFF(day, LAG(order_date) OVER (PARTITION BY CustomerID ORDER BY order_date), order_date) AS gap_days
        FROM recent_distinct_dates
      ),
      gap_averages AS (
        SELECT CustomerID, AVG(CAST(gap_days AS decimal(12, 4))) AS avg_gap_days
        FROM date_gaps
        WHERE gap_days IS NOT NULL
        GROUP BY CustomerID
      )
      SELECT
        a.CustomerID,
        CONVERT(char(10), a.last_order_date, 23) AS LastOrderDate,
        a.orders_last_7_days AS OrdersLast7Days,
        a.orders_last_30_days AS OrdersLast30Days,
        a.orders_last_90_days AS OrdersLast90Days,
        CASE WHEN a.orders_last_90_days >= 3 THEN g.avg_gap_days ELSE NULL END AS AvgGapDays
      FROM customer_activity a
      LEFT JOIN gap_averages g ON g.CustomerID = a.CustomerID
      ORDER BY a.CustomerID
    `,
    map: (r) => {
      const customerId = Number(r.CustomerID);
      const count = (value, field) => {
        const numeric = Number(value);
        if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error(`Invalid ${field} for customer ${customerId}.`);
        return numeric;
      };
      if (!Number.isSafeInteger(customerId) || customerId <= 0) throw new Error('Invalid Innovations customer id in order activity result.');
      const avgGapDays = r.AvgGapDays == null ? null : Number(r.AvgGapDays);
      if (avgGapDays != null && !Number.isFinite(avgGapDays)) throw new Error(`Invalid avg_gap_days for customer ${customerId}.`);
      return {
        innovations_customer_id: customerId,
        last_order_date: r.LastOrderDate || null,
        orders_last_7_days: count(r.OrdersLast7Days, 'orders_last_7_days'),
        orders_last_30_days: count(r.OrdersLast30Days, 'orders_last_30_days'),
        orders_last_90_days: count(r.OrdersLast90Days, 'orders_last_90_days'),
        avg_gap_days: avgGapDays,
      };
    },
  },
  // Real posted statement headers (source: dbo.FinARStatements). Void
  // statements are excluded — never posted, nothing for a customer to see.
  // Sync after `customers` (customer_id resolution) and before
  // `statement_lines` (FK: statement_lines.innovations_statement_id references
  // this table's innovations_statement_id — the parent must land first).
  statements: {
    sql: `
      SELECT s.FinARStatementID, s.CustomerID, s.FromDate, s.ToDate, s.StatementDate, s.DueDate,
             s.OpeningBalance, s.ClosingBalance, s.Transactions, s.Payments, s.FinanceCharges, s.Discount, s.Allowance,
             s.AgingAmount1, s.AgingAmount2, s.AgingAmount3, s.AgingAmount4,
             s.Status, s.Void, s.Printed, s.EMailed, c.VolumeDiscount
      FROM dbo.FinARStatements s
      INNER JOIN dbo.Customers c ON c.CustomerID = s.CustomerID
      WHERE s.Void = 0
      ORDER BY s.FinARStatementID
    `,
    map: (r) => ({
      innovations_statement_id: r.FinARStatementID,
      innovations_customer_id: r.CustomerID,
      from_date: r.FromDate || null,
      to_date: r.ToDate || null,
      statement_date: r.StatementDate || null,
      due_date: r.DueDate || null,
      opening_balance: r.OpeningBalance != null ? Number(r.OpeningBalance) : null,
      closing_balance: r.ClosingBalance != null ? Number(r.ClosingBalance) : null,
      transactions: r.Transactions != null ? Number(r.Transactions) : null,
      payments: r.Payments != null ? Number(r.Payments) : null,
      finance_charges: r.FinanceCharges != null ? Number(r.FinanceCharges) : null,
      discount: r.Discount != null ? Number(r.Discount) : null,
      allowance: r.Allowance != null ? Number(r.Allowance) : null,
      volume_discount: r.VolumeDiscount != null ? Number(r.VolumeDiscount) : null,
      aging_amount_1: r.AgingAmount1 != null ? Number(r.AgingAmount1) : null,
      aging_amount_2: r.AgingAmount2 != null ? Number(r.AgingAmount2) : null,
      aging_amount_3: r.AgingAmount3 != null ? Number(r.AgingAmount3) : null,
      aging_amount_4: r.AgingAmount4 != null ? Number(r.AgingAmount4) : null,
      status: r.Status != null ? Number(r.Status) : null,
      void: !!r.Void,
      printed: !!r.Printed,
      innovations_emailed: !!r.EMailed,
    }),
  },
  // Statement line items (source: dbo.FinARStatementItems). Only rows already
  // attached to a statement are pulled — FinARStatementID is nullable for
  // items not yet included in a statement run. Must sync AFTER `statements`
  // in the same run (FK dependency on the CV side).
  statement_lines: {
    sql: `
      SELECT i.FinARStatementItemID, i.FinARStatementID, i.OrderType, t.OrderTypeName,
             i.InvoiceID, i.OrderID, i.Reference, i.Patient, i.PaymentMethod, i.PostDate, i.Amount
      FROM dbo.FinARStatementItems i
      INNER JOIN dbo.FinARStatements s ON s.FinARStatementID = i.FinARStatementID
      LEFT JOIN dbo.OrderTypes t ON t.OrderType = i.OrderType
      WHERE i.FinARStatementID IS NOT NULL
        AND i.HideFromStatement = 0
        AND s.Void = 0
      ORDER BY i.FinARStatementItemID
    `,
    map: (r) => ({
      innovations_statement_item_id: r.FinARStatementItemID,
      innovations_statement_id: r.FinARStatementID,
      order_type: r.OrderType != null ? Number(r.OrderType) : null,
      order_type_name: r.OrderTypeName || null,
      invoice_id: r.InvoiceID != null ? Number(r.InvoiceID) : null,
      order_id: r.OrderID != null ? Number(r.OrderID) : null,
      reference: r.Reference || '',
      patient: r.Patient || '',
      payment_method: r.PaymentMethod || null,
      post_date: r.PostDate || null,
      amount: r.Amount != null ? Number(r.Amount) : null,
    }),
  },
};

const ENTITY_ORDER = ['banks', 'customers', 'contacts', 'balances', 'order_activity', 'statements', 'statement_lines'];

function normalizeEntitySelection(entities = ENTITY_ORDER) {
  const selected = new Set((Array.isArray(entities) ? entities : ENTITY_ORDER).filter((entity) => ENTITIES[entity]));
  if (selected.has('statements')) selected.add('statement_lines');
  return ENTITY_ORDER.filter((entity) => selected.has(entity));
}

function functionsBase(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) return DEFAULT_FUNCTIONS_BASE;
  // creds.baseUrl points at .../functions/v1/api-v1 — strip the function name.
  if (/\/functions\/v1\/[^/]+$/.test(b)) return b.replace(/\/[^/]+$/, '');
  if (/\/functions\/v1$/.test(b)) return b;
  return DEFAULT_FUNCTIONS_BASE;
}

// Introspect real column names so the entity SQL can be matched to the live
// schema (no more guessing one bad column at a time). No CV key required.
async function describeTables(tableNames = []) {
  const names = tableNames.map((t) => String(t).trim()).filter(Boolean);
  if (!names.length) return {};
  const pool = await getSourcePool();
  const request = pool.request();
  const placeholders = names.map((n, i) => { request.input(`t${i}`, n); return `@t${i}`; }).join(',');
  const result = await request.query(`
    SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, ORDINAL_POSITION
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME IN (${placeholders})
    ORDER BY TABLE_NAME, ORDINAL_POSITION
  `);
  const out = {};
  for (const r of result.recordset) {
    if (!out[r.TABLE_NAME]) out[r.TABLE_NAME] = [];
    out[r.TABLE_NAME].push({ column: r.COLUMN_NAME, type: r.DATA_TYPE, nullable: r.IS_NULLABLE === 'YES' });
  }
  return out;
}

async function readEntity(name, sqlOverride) {
  const def = ENTITIES[name];
  if (!def) throw new Error(`Unknown entity '${name}'.`);
  const pool = await getSourcePool();
  const result = await pool.request().query(sqlOverride || def.sql);
  const records = [];
  for (const row of result.recordset) {
    try {
      records.push(def.map(row));
    } catch (err) {
      // Bad source data for one customer must not abort the scheduled run.
      if (name !== 'order_activity') throw err;
      syncLog.write('sync.order_activity.customer_failed', {
        innovationsCustomerId: row.CustomerID ?? null,
        error: syncLog.trim(err.message || err),
      });
    }
  }
  return records;
}

async function postBatch(base, apiKey, entity, records, dryRun, suppressEmail) {
  const reqBody = { dry_run: dryRun, records };
  // Only meaningful for `statements` — the receiver ignores it for other entities.
  if (suppressEmail) reqBody.suppress_email = true;
  const res = await fetch(`${base}/innovations-sync/${entity}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(reqBody),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  if (!res.ok && res.status !== 200) {
    throw new Error(`receiver ${res.status}: ${body.error || text.slice(0, 200)}`);
  }
  return body;
}

/**
 * Run the sync.
 * @param {{baseUrl:string, apiKey:string}} creds  CV API creds from the vault.
 * @param {{entities?:string[], commit?:boolean, batchSize?:number, sql?:object, suppressStatementEmails?:boolean}} opts
 * @returns {Promise<{commit:boolean, entities:object}>}
 */
// Order matters: `customers` must land before `balances`/`statements` (the
// receiver resolves customer_id/account_number by looking up the
// already-synced customers row), and `statements` must land before
// `statement_lines` (FK on the CV side).
//
// suppressStatementEmails: pass true for the first historical backfill —
// otherwise every pre-existing statement looks "new" to the receiver and
// triggers a "statement ready" email to every customer at once. Leave false
// (default) for normal ongoing runs so real new statements email as intended.
async function sync(
  creds,
  {
    entities = ENTITY_ORDER,
    commit = false,
    batchSize = 200,
    sql = {},
    suppressStatementEmails = false,
  } = {},
) {
  if (!creds || !creds.apiKey) throw new Error('CV API key not configured (unlock the vault first).');
  const selectedEntities = normalizeEntitySelection(entities);
  const base = functionsBase(creds.baseUrl);
  const dryRun = !commit;
  const out = { commit, dryRun, entities: {} };
  syncLog.write('sync.started', { commit, dryRun, entities: selectedEntities, batchSize });

  for (const entity of selectedEntities) {
    try {
      const records = await readEntity(entity, sql[entity]);
      const suppressEmail = entity === 'statements' && suppressStatementEmails;
      const totals = { read: records.length, received: 0, upserted: 0, failed: 0, batches: 0, errors: [] };
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        const r = await postBatch(base, creds.apiKey, entity, batch, dryRun, suppressEmail);
        totals.batches++;
        totals.received += r.received || 0;
        totals.upserted += r.upserted || 0;
        totals.failed += r.failed || 0;
        if (Array.isArray(r.errors)) for (const e of r.errors) {
          if (totals.errors.length < 10) totals.errors.push(e);
          if (entity === 'order_activity') {
            syncLog.write('sync.order_activity.customer_failed', { error: syncLog.trim(typeof e === 'string' ? e : JSON.stringify(e)) });
          }
        }
      }
      // An empty result set is still a successful (no-op) sync.
      if (records.length === 0) {
        const r = await postBatch(base, creds.apiKey, entity, [], dryRun, suppressEmail);
        totals.batches++;
      }
      totals.ok = totals.failed === 0;
      out.entities[entity] = totals;
      syncLog.write('sync.entity.finished', {
        entity,
        ok: totals.ok,
        read: totals.read,
        received: totals.received,
        upserted: totals.upserted,
        failed: totals.failed,
        batches: totals.batches,
        errors: totals.errors.map((error) => syncLog.trim(error, 300)),
      });
    } catch (err) {
      out.entities[entity] = { ok: false, error: String(err.message || err) };
      syncLog.write('sync.entity.failed', { entity, error: syncLog.trim(err.message || err) });
    }
  }

  out.ok = Object.values(out.entities).every((e) => e.ok);
  syncLog.write('sync.finished', { ok: out.ok, commit, dryRun, entities: syncLog.summarizeEntities(out.entities) });
  return out;
}

// ── CV-initiated request queue (cloud "Sync now") ────────────────────────────
// The cloud cannot call the office, so it queues a request; we claim and run it.
async function fetchNextRequest(creds) {
  const base = functionsBase(creds.baseUrl);
  const res = await fetch(`${base}/innovations-sync/_requests/next`, { headers: { 'x-api-key': creds.apiKey } });
  if (!res.ok) throw new Error(`requests/next ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json().catch(() => ({}));
  return body.request || null;
}

async function completeRequest(creds, id, ok, result) {
  const base = functionsBase(creds.baseUrl);
  const res = await fetch(`${base}/innovations-sync/_requests/complete`, {
    method: 'POST',
    headers: { 'x-api-key': creds.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ id, ok, result }),
  });
  if (!res.ok) throw new Error(`requests/complete ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// Claim and run any pending CV-initiated requests (writes). Returns what it did.
async function runRequested(creds, { max = 5 } = {}) {
  if (!creds || !creds.apiKey) throw new Error('CV API key not configured (unlock the vault first).');
  const processed = [];
  for (let i = 0; i < max; i++) {
    const reqRow = await fetchNextRequest(creds);
    if (!reqRow) break;
    syncLog.write('queue.request.claimed', { requestId: reqRow.id, entities: reqRow.entities || [] });
    const entities = Array.isArray(reqRow.entities) && reqRow.entities.length ? reqRow.entities : undefined;
    let result;
    try {
      result = await sync(creds, { commit: true, entities });
    } catch (err) {
      result = { ok: false, error: String(err.message || err) };
    }
    try {
      await completeRequest(creds, reqRow.id, !!result.ok, result);
      syncLog.write('queue.request.finished', { requestId: reqRow.id, ok: !!result.ok, entities: syncLog.summarizeEntities(result.entities) });
      processed.push({ id: reqRow.id, ok: !!result.ok });
    } catch (err) {
      syncLog.write('queue.request.complete_failed', { requestId: reqRow.id, error: syncLog.trim(err.message || err) });
      throw err;
    }
  }
  return { processed, count: processed.length };
}

module.exports = { sync, readEntity, describeTables, functionsBase, ENTITIES, ENTITY_ORDER, normalizeEntitySelection, fetchNextRequest, completeRequest, runRequested };
