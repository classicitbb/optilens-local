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
const { getSourcePool, getLiveSourcePool } = require('./db');
const syncLog = require('./innovations-sync-log');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FUNCTIONS_BASE = 'https://xstmeirxhfbiyayrrsob.supabase.co/functions/v1';
const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.OPTILENS_SYNC_FETCH_TIMEOUT_MS ?? 30000);
const DEFAULT_FETCH_RETRIES = Number(process.env.OPTILENS_SYNC_FETCH_RETRIES ?? 2);
const STATEMENT_FETCH_TIMEOUT_MS = Number(process.env.OPTILENS_SYNC_STATEMENT_FETCH_TIMEOUT_MS ?? 120000);
const STATEMENT_FETCH_RETRIES = Number(process.env.OPTILENS_SYNC_STATEMENT_FETCH_RETRIES ?? 0);
const LOCK_DIR = process.env.OPTILENS_SYNC_LOCK_DIR || path.join(__dirname, '..', 'data', 'locks');
const LOCK_FILE = path.join(LOCK_DIR, 'innovations-cloud-sync.lock');
const LOCK_STALE_MS = Number(process.env.OPTILENS_SYNC_LOCK_STALE_MINUTES ?? 180) * 60 * 1000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Statements are a rolling window, not a full history dump. Without this the
// `statements` + `statement_lines` queries re-read every statement ever posted
// on every hourly run: as of 2026-07-25 that was 17.7M line-item rows pushed
// into a 76k-row table, ~232x more write traffic than the data needs. The
// window is applied to the statement's own date so lines stay consistent with
// the headers they belong to. Set to 0 to disable (full history) for a backfill.
const STATEMENT_WINDOW_MONTHS = Number(process.env.OPTILENS_STATEMENT_WINDOW_MONTHS ?? 5);

// A statement's effective date. StatementDate is nullable in FinARStatements,
// so fall back through the period end and then the period start rather than
// silently dropping a statement out of the window.
const STATEMENT_DATE_EXPR = 'COALESCE(s.StatementDate, s.ToDate, s.FromDate)';

function statementWindowClause(months = STATEMENT_WINDOW_MONTHS) {
  const m = Number(months);
  if (!Number.isFinite(m) || m <= 0) return '';
  return `AND ${STATEMENT_DATE_EXPR} >= DATEADD(month, -${Math.floor(m)}, CAST(GETDATE() AS date))`;
}

async function sourceColumnNames(pool, tableName) {
  const result = await pool.request()
    .input('table_name', tableName)
    .query(`
      SELECT c.name
      FROM sys.columns c
      INNER JOIN sys.objects o ON o.object_id = c.object_id
      INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = N'dbo'
        AND o.name = @table_name
    `);
  return new Set((result.recordset || []).map((row) => String(row.name || '').toLowerCase()));
}

function sourceColumnExpression(columnNames, tableAlias, candidates, outAlias, size = 200) {
  const hit = candidates.find((name) => columnNames.has(name.toLowerCase()));
  return hit
    ? `NULLIF(LTRIM(RTRIM(CAST(${tableAlias}.${hit} AS nvarchar(${size})))), '') AS ${outAlias}`
    : `CAST(NULL AS nvarchar(${size})) AS ${outAlias}`;
}

function preferredAddressJoin() {
  return `
      OUTER APPLY (
        SELECT TOP (1) ca.*
        FROM dbo.CustomerAddresses ca
        WHERE ca.CustomerID = c.CustomerID
        ORDER BY
          CASE ca.AddressType
            WHEN 7 THEN 0
            WHEN 2 THEN 1
            ELSE 2
          END,
          ca.CustomerAddressID
      ) a`;
}

async function customerAddressSelects(pool) {
  const addressCols = await sourceColumnNames(pool, 'CustomerAddresses');
  const countryCols = await sourceColumnNames(pool, 'Countries');
  const pick = (candidates, outAlias, size = 200) =>
    sourceColumnExpression(addressCols, 'a', candidates, outAlias, size);
  return {
    line1: pick(['Address1', 'AddressLine1', 'Line1', 'Street1', 'Street'], 'AddressLine1'),
    line2: pick(['Address2', 'AddressLine2', 'Line2', 'Street2'], 'AddressLine2'),
    line3: pick(['Address3', 'AddressLine3', 'Line3'], 'AddressLine3'),
    city: pick(['Locality', 'City', 'Town'], 'City', 100),
    state: pick(['Region', 'Province', 'State'], 'State', 100),
    zip: pick(['PostalCode', 'PostCode', 'ZipCode', 'Zip'], 'PostalCode', 40),
    countryCode: sourceColumnExpression(countryCols, 'co', ['CountryCode', 'Iso2', 'ISO2', 'ShortName'], 'CountryCode', 20),
  };
}

// Per-entity source query + row->CV-record mapper. Keep mapped keys aligned with
// the receiver's allowlist (supabase/functions/innovations-sync/index.ts).
// Entities may define either `sql` (+`map`, read from MS SQL) or `read`
// (an async function returning already-mapped records — used for sources
// that aren't MS SQL, like the Zen-DB-derived rx catalog JSON).
const ENTITIES = {
  // Lens alias catalog → CV `innovations_lens_aliases`. Source is NOT MS SQL:
  // rx-catalog-sync.js reads the Zen DB (LensAlias + dimension tables) and
  // writes data/rx/catalog.generated.json — this entity just pushes that file.
  // Run `node -e "require('./lib/rx-catalog-sync').sync()"` (or the admin
  // button) first if the file is stale. Changes rarely; nightly is plenty.
  lens_aliases: {
    read: async () => {
      const file = path.join(__dirname, '..', 'data', 'rx', 'catalog.generated.json');
      let rows;
      try {
        rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        throw new Error(`lens_aliases: cannot read ${file} — run the rx catalog sync first (${err.message})`);
      }
      if (!Array.isArray(rows)) throw new Error('lens_aliases: catalog.generated.json is not an array.');
      const syncedAt = new Date().toISOString();
      return rows.map((r) => ({
        alias: String(r.alias),
        material_code: String(r.materialCode ?? ''),
        material_description: String(r.materialDescription ?? ''),
        style_code: String(r.styleCode ?? ''),
        style_description: String(r.styleDescription ?? ''),
        color_code: String(r.colorCode ?? ''),
        color_description: String(r.colorDescription ?? ''),
        mf_type: String(r.mfType ?? ''),
        category: String(r.category ?? ''),
        suppliers: Array.isArray(r.suppliers) ? r.suppliers.map(String) : [],
        pricing_key: String(r.pricingKey ?? ''),
        is_active: true,
        synced_at: syncedAt,
      }));
    },
  },
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
    sql: async (pool) => {
      const address = await customerAddressSelects(pool);
      return `
      SELECT c.CustomerID, c.AccountNumber, c.CustomerName, c.IsActive,
             c.PayByCard, c.PayByEFT, c.DefaultPaymentType, e.EFTInstitutionName,
             NULLIF(LTRIM(RTRIM(CAST(COALESCE(c.GeneralEmailAddress, c.AccountsEmailAddress, c.WIPEmailAddress) AS nvarchar(320)))), '') AS EmailAddress,
             NULLIF(LTRIM(RTRIM(CAST(c.PhoneNumber AS nvarchar(80)))), '') AS PhoneNumber,
             ${address.line1},
             ${address.line2},
             ${address.line3},
             ${address.city},
             ${address.state},
             ${address.zip},
             NULLIF(LTRIM(RTRIM(CAST(co.CountryName AS nvarchar(100)))), '') AS CountryName,
             ${address.countryCode}
      FROM dbo.Customers c
      LEFT JOIN dbo.EFTInstitutions e ON e.EFTInstitutionID = c.EFTInstitutionID
      ${preferredAddressJoin()}
      LEFT JOIN dbo.Countries co ON co.CountryID = a.CountryID
      WHERE c.IsActive = 1
      ORDER BY c.CustomerID
    `;
    },
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
      address: [r.AddressLine1, r.AddressLine2, r.AddressLine3, r.City, r.State, r.PostalCode, r.CountryName].filter(Boolean).join(', ') || null,
      country_code: r.CountryCode || null,
      email: r.EmailAddress || null,
      phone: r.PhoneNumber || null,
      notes: Number(r.IsActive) === 1 ? 'Innovations: active' : 'Innovations: inactive',
      pay_by_card: !!r.PayByCard,
      pay_by_eft: !!r.PayByEFT,
      eft_institution_name: r.EFTInstitutionName || null,
      default_payment_type: r.DefaultPaymentType != null ? Number(r.DefaultPaymentType) : null,
    }),
  },
  // Columns confirmed against the live dbo.Contacts schema.
  contacts: {
    sql: async (pool) => {
      const address = await customerAddressSelects(pool);
      return `
      SELECT ct.ContactID, ct.CustomerID, ct.FirstName, ct.Surname, ct.EmailAddress, ct.PhoneNumber, ct.MobileNumber,
             c.CustomerName,
             ${address.line1},
             ${address.line2},
             ${address.city},
             ${address.state},
             ${address.zip},
             NULLIF(LTRIM(RTRIM(CAST(co.CountryName AS nvarchar(100)))), '') AS CountryName,
             ${address.countryCode}
      FROM dbo.Contacts ct
      LEFT JOIN dbo.Customers c ON c.CustomerID = ct.CustomerID
      ${preferredAddressJoin()}
      LEFT JOIN dbo.Countries co ON co.CountryID = a.CountryID
      ORDER BY ct.ContactID
    `;
    },
    map: (r) => ({
      innovations_contact_id: r.ContactID,
      innovations_parent_customer_id: r.CustomerID,
      name: [r.FirstName, r.Surname].filter(Boolean).join(' ').trim() || '(unnamed)',
      business_name: r.CustomerName || null,
      email: r.EmailAddress || '',
      phone: r.PhoneNumber || r.MobileNumber || '',
      street: r.AddressLine1 || null,
      street2: r.AddressLine2 || null,
      city: r.City || null,
      state: r.State || null,
      zip: r.PostalCode || null,
      country: r.CountryName || null,
      country_code: r.CountryCode || null,
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
    sql: () => `
      SELECT s.FinARStatementID, s.CustomerID, s.FromDate, s.ToDate, s.StatementDate, s.DueDate,
             s.OpeningBalance, s.ClosingBalance, s.Transactions, s.Payments, s.FinanceCharges, s.Discount, s.Allowance,
             s.AgingAmount1, s.AgingAmount2, s.AgingAmount3, s.AgingAmount4,
             s.Status, s.Void, s.Printed, s.EMailed, c.VolumeDiscount
      FROM dbo.FinARStatements s
      INNER JOIN dbo.Customers c ON c.CustomerID = s.CustomerID
      WHERE s.Void = 0
        ${statementWindowClause()}
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
    // Same window as `statements`, applied to the parent statement's date so a
    // line can never arrive without its header (FK dependency on the CV side).
    sql: () => `
      SELECT i.FinARStatementItemID, i.FinARStatementID, i.OrderType, t.OrderTypeName,
             i.InvoiceID, i.OrderID, i.Reference, i.Patient, i.PaymentMethod, i.PostDate, i.Amount
      FROM dbo.FinARStatementItems i
      INNER JOIN dbo.FinARStatements s ON s.FinARStatementID = i.FinARStatementID
      LEFT JOIN dbo.OrderTypes t ON t.OrderType = i.OrderType
      WHERE i.FinARStatementID IS NOT NULL
        AND i.HideFromStatement = 0
        AND s.Void = 0
        ${statementWindowClause()}
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
  // Physical stocked items → CV `supplies` (Product Catalog). Source: Innovations
  // dbo.MiscItems, filtered to "Stocked Item" checked and not Inactive — both are
  // bits in the Flags bitmask, confirmed against live data on 2026-08-02 (see
  // docs/ERP_ITEM_SYNC_PLAN.md §7 in the Classic Visions repo): bit 2 (value 4) =
  // Stocked Item, bit 0 (value 1) = Inactive when set. NOTE: this is NOT the same
  // bit lib/metrics/inventory.js uses for a different table (Flags & 2) — that
  // convention does not hold for MiscItems (confirmed set on two known-active
  // items); bit 0 was isolated directly against a confirmed-Inactive item
  // (MiscItemID 501) and checks out at population scale (set on only 1.9% of
  // all 724 rows). Excludes coatings/tints/services, which live in the same
  // table but aren't "Stocked Item" and are handled separately by
  // rx-catalog-sync.js's coatings sync.
  //
  // sell_price is deliberately not mapped — the ERP's Price column is always 0
  // for stocked items (confirmed live); real prices live in a separate
  // multi-pricelist system with no single value per item. Cost is the one clean,
  // unambiguous field, so only that syncs; sell price stays a reviewed staff step
  // on the website side (see the CV-repo sync contract note on the supplies entity).
  //
  // usesLivePool: the mirror DB does not carry MiscItems/stock tables at all
  // (see lib/db.js's getLiveSourcePool comment) — this entity must always read
  // from live Innovations regardless of the active source_backend switch.
  supplies: {
    usesLivePool: true,
    sql: `
      SELECT m.MiscItemID, m.SKU, m.Desc1, m.Cost, m.OnHand,
             g.MiscItemGroupName
      FROM dbo.MiscItems m
      LEFT JOIN dbo.MiscItemGroups g ON g.MiscItemGroupID = m.MiscItemGroupID
      WHERE (m.Flags & 4) <> 0 AND (m.Flags & 1) = 0
        AND NULLIF(LTRIM(RTRIM(m.SKU)), '') IS NOT NULL
      ORDER BY m.MiscItemID
    `,
    map: (r) => ({
      innovations_misc_item_id: Number(r.MiscItemID),
      sku: String(r.SKU || '').trim(),
      name: String(r.Desc1 || '').trim(),
      category: String(r.MiscItemGroupName || '').trim() || 'Supplies',
      base_price: r.Cost != null ? Number(r.Cost) : null,
      inventory_qty: r.OnHand != null ? Number(r.OnHand) : null,
      is_active: true,
      source: 'innovations',
      last_synced_at: new Date().toISOString(),
    }),
  },
};

const ENTITY_ORDER = ['banks', 'customers', 'contacts', 'balances', 'order_activity', 'statements', 'statement_lines', 'lens_aliases', 'supplies'];

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
  if (typeof def.read === 'function') return def.read();
  // Some entities (e.g. supplies) query stock tables the Zen-fed mirror never
  // carries — those must always hit live Innovations, regardless of the
  // active source_backend profile switch. See lib/db.js's getLiveSourcePool.
  const pool = def.usesLivePool ? await getLiveSourcePool() : await getSourcePool();
  const query = sqlOverride || (typeof def.sql === 'function' ? await def.sql(pool) : def.sql);
  const result = await pool.request().query(query);
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

/**
 * Ask the receiver which entities it actually supports.
 *
 * The cloud receiver is an edge function deployed by CI; when a deploy silently
 * stops landing, the receiver keeps answering 200 for the entities it knew
 * about at deploy time and 404s the rest. That reads as "sync works, mostly" —
 * which is exactly how balances/statements went missing for three weeks in
 * July 2026. Checking the version up front turns that into one loud error.
 *
 * Public endpoint, no key required. Returns null if unreachable/unparseable so
 * a flaky probe can never block a sync that would otherwise succeed.
 */
async function receiverVersion(base) {
  try {
    const res = await fetchWithRetry(`${base}/innovations-sync/version`, {}, { timeoutMs: 8000, retries: 1 });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || !Array.isArray(body.entities)) return null;
    return { version: String(body.version || 'unknown'), entities: body.entities };
  } catch {
    return null;
  }
}

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function timeoutSignal(timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0 || typeof AbortSignal === 'undefined' || !AbortSignal.timeout) return undefined;
  return AbortSignal.timeout(ms);
}

async function fetchWithRetry(url, options = {}, { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, retries = DEFAULT_FETCH_RETRIES, fetchImpl = fetch } = {}) {
  const attempts = Math.max(1, 1 + (Number.isFinite(Number(retries)) ? Number(retries) : 0));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, { ...options, signal: options.signal || timeoutSignal(timeoutMs) });
      if (!retryableStatus(res.status) || attempt === attempts) return res;
    } catch (err) {
      lastError = err;
      if (attempt === attempts) throw err;
    }
    await delay(Math.min(5000, 500 * (2 ** (attempt - 1))));
  }
  throw lastError || new Error('fetch failed');
}

function entityFetchOptions(entity) {
  if (entity === 'statements') {
    return {
      timeoutMs: STATEMENT_FETCH_TIMEOUT_MS,
      retries: STATEMENT_FETCH_RETRIES,
    };
  }
  return {
    timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    retries: DEFAULT_FETCH_RETRIES,
  };
}

function readLockAgeMs(lockFile = LOCK_FILE) {
  try {
    return Date.now() - fs.statSync(lockFile).mtimeMs;
  } catch {
    return null;
  }
}

function acquireSyncLock({ lockFile = LOCK_FILE, staleMs = LOCK_STALE_MS } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return {
      acquired: true,
      release() {
        try { fs.closeSync(fd); } catch {}
        try { fs.rmSync(lockFile, { force: true }); } catch {}
      },
    };
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const ageMs = readLockAgeMs(lockFile);
      if (ageMs != null && Number(staleMs) > 0 && ageMs > Number(staleMs)) {
        try { fs.rmSync(lockFile, { force: true }); } catch {}
        return acquireSyncLock({ lockFile, staleMs });
      }
      return { acquired: false, ageMs, release() {} };
    }
    throw err;
  }
}

async function postBatch(base, apiKey, entity, records, dryRun, suppressEmail) {
  const reqBody = { dry_run: dryRun, records };
  // Only meaningful for `statements` — the receiver ignores it for other entities.
  if (suppressEmail) reqBody.suppress_email = true;
  const res = await fetchWithRetry(`${base}/innovations-sync/${entity}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(reqBody),
  }, entityFetchOptions(entity));
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
    useLock = true,
  } = {},
) {
  if (!creds || !creds.apiKey) throw new Error('CV API key not configured (unlock the vault first).');
  const lock = useLock ? acquireSyncLock() : { acquired: true, release() {} };
  if (!lock.acquired) {
    const reason = `Innovations cloud sync is already running${lock.ageMs != null ? ` (${Math.round(lock.ageMs / 1000)}s old)` : ''}.`;
    syncLog.write('sync.skipped', { reason });
    return { ok: true, skipped: true, reason };
  }
  const startedAt = Date.now();
  try {
  const selectedEntities = normalizeEntitySelection(entities);
  const base = functionsBase(creds.baseUrl);
  const dryRun = !commit;
  const out = { commit, dryRun, entities: {}, startedAt: new Date(startedAt).toISOString() };
  syncLog.write('sync.started', {
    commit, dryRun, entities: selectedEntities, batchSize,
    statementWindowMonths: STATEMENT_WINDOW_MONTHS || 'all',
  });

  // Preflight: fail loudly on a stale receiver rather than 404-ing entity by
  // entity. `out.receiver` is surfaced in the sync result so the UI can show it.
  const receiver = await receiverVersion(base);
  if (receiver) {
    const unsupported = selectedEntities.filter((e) => !receiver.entities.includes(e));
    out.receiver = { version: receiver.version, entities: receiver.entities, unsupported };
    if (unsupported.length) {
      out.receiverStale = true;
      syncLog.write('sync.receiver.stale', {
        version: receiver.version,
        supported: receiver.entities,
        unsupported,
      });
    }
  } else {
    out.receiver = null;
    syncLog.write('sync.receiver.unreachable', { base });
  }

  for (const entity of selectedEntities) {
    const entityStartedAt = Date.now();
    try {
      const records = await readEntity(entity, sql[entity]);
      const suppressEmail = entity === 'statements' && suppressStatementEmails;
      const totals = { read: records.length, received: 0, upserted: 0, failed: 0, batches: 0, errors: [], warnings: [] };
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        const r = await postBatch(base, creds.apiKey, entity, batch, dryRun, suppressEmail);
        totals.batches++;
        totals.received += r.received || 0;
        totals.upserted += r.upserted || 0;
        totals.failed += r.failed || 0;
        // Records that synced but lost a field to a constraint clash. Not
        // failures, but they must not vanish into a green "success" run.
        if (Array.isArray(r.warnings)) for (const w of r.warnings) {
          if (totals.warnings.length < 20) totals.warnings.push(w);
        }
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
      totals.durationMs = Date.now() - entityStartedAt;
      out.entities[entity] = totals;
      syncLog.write('sync.entity.finished', {
        entity,
        ok: totals.ok,
        read: totals.read,
        received: totals.received,
        upserted: totals.upserted,
        failed: totals.failed,
        batches: totals.batches,
        durationMs: totals.durationMs,
        errors: totals.errors.map((error) => syncLog.trim(error, 300)),
        warnings: totals.warnings.map((warning) => syncLog.trim(warning, 300)),
      });
    } catch (err) {
      out.entities[entity] = { ok: false, error: String(err.message || err), durationMs: Date.now() - entityStartedAt };
      syncLog.write('sync.entity.failed', { entity, durationMs: out.entities[entity].durationMs, error: syncLog.trim(err.message || err) });
    }
  }

  out.ok = Object.values(out.entities).every((e) => e.ok);
  out.finishedAt = new Date().toISOString();
  out.durationMs = Date.now() - startedAt;
  syncLog.write('sync.finished', { ok: out.ok, commit, dryRun, durationMs: out.durationMs, entities: syncLog.summarizeEntities(out.entities) });
  return out;
  } finally {
    lock.release();
  }
}

// ── CV-initiated request queue (cloud "Sync now") ────────────────────────────
// The cloud cannot call the office, so it queues a request; we claim and run it.
async function fetchNextRequest(creds) {
  const base = functionsBase(creds.baseUrl);
  const res = await fetchWithRetry(`${base}/innovations-sync/_requests/next`, { headers: { 'x-api-key': creds.apiKey } }, { timeoutMs: 15000 });
  if (!res.ok) throw new Error(`requests/next ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json().catch(() => ({}));
  return body.request || null;
}

async function completeRequest(creds, id, ok, result) {
  const base = functionsBase(creds.baseUrl);
  const res = await fetchWithRetry(`${base}/innovations-sync/_requests/complete`, {
    method: 'POST',
    headers: { 'x-api-key': creds.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ id, ok, result }),
  }, { timeoutMs: 15000 });
  if (!res.ok) throw new Error(`requests/complete ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// Claim and run any pending CV-initiated requests (writes). Returns what it did.
async function runRequested(creds, { max = 1 } = {}) {
  if (!creds || !creds.apiKey) throw new Error('CV API key not configured (unlock the vault first).');
  const lock = acquireSyncLock();
  if (!lock.acquired) {
    const reason = `Innovations cloud sync is already running${lock.ageMs != null ? ` (${Math.round(lock.ageMs / 1000)}s old)` : ''}; request poll deferred.`;
    syncLog.write('queue.request.deferred', { reason });
    return { processed: [], count: 0, skipped: true, reason };
  }
  const processed = [];
  try {
    for (let i = 0; i < max; i++) {
      const reqRow = await fetchNextRequest(creds);
      if (!reqRow) break;
      syncLog.write('queue.request.claimed', { requestId: reqRow.id, entities: reqRow.entities || [] });
      const entities = Array.isArray(reqRow.entities) && reqRow.entities.length ? reqRow.entities : undefined;
      let result;
      try {
        result = await sync(creds, { commit: true, entities, useLock: false });
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
  } finally {
    lock.release();
  }
  return { processed, count: processed.length };
}

module.exports = { sync, readEntity, describeTables, functionsBase, receiverVersion, statementWindowClause, STATEMENT_WINDOW_MONTHS, ENTITIES, ENTITY_ORDER, normalizeEntitySelection, fetchNextRequest, completeRequest, runRequested, fetchWithRetry, entityFetchOptions, acquireSyncLock, LOCK_FILE };
