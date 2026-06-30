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
 * └────────────────────────────────────────────────────────────────────────┘
 */
const { getSourcePool } = require('./db');

const DEFAULT_FUNCTIONS_BASE = 'https://xstmeirxhfbiyayrrsob.supabase.co/functions/v1';

// Per-entity source query + row->CV-record mapper. Keep mapped keys aligned with
// the receiver's allowlist (supabase/functions/innovations-sync/index.ts).
const ENTITIES = {
  customers: {
    sql: `
      SELECT CustomerID, AccountNumber, CustomerName, IsActive
      FROM dbo.Customers
      WHERE IsActive = 1
      ORDER BY CustomerID
    `,
    map: (r) => ({
      innovations_customer_id: r.CustomerID,
      name: r.CustomerName,
      account_number: r.AccountNumber != null ? String(r.AccountNumber) : null,
      pipeline_stage: Number(r.IsActive) === 1 ? 'active' : 'inactive',
      type: 'wholesale',
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
};

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
  return result.recordset.map(def.map);
}

async function postBatch(base, apiKey, entity, records, dryRun) {
  const res = await fetch(`${base}/innovations-sync/${entity}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ dry_run: dryRun, records }),
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
 * @param {{entities?:string[], commit?:boolean, batchSize?:number, sql?:object}} opts
 * @returns {Promise<{commit:boolean, entities:object}>}
 */
async function sync(creds, { entities = ['customers', 'contacts'], commit = false, batchSize = 200, sql = {} } = {}) {
  if (!creds || !creds.apiKey) throw new Error('CV API key not configured (unlock the vault first).');
  const base = functionsBase(creds.baseUrl);
  const dryRun = !commit;
  const out = { commit, dryRun, entities: {} };

  for (const entity of entities) {
    try {
      const records = await readEntity(entity, sql[entity]);
      const totals = { read: records.length, received: 0, upserted: 0, failed: 0, batches: 0, errors: [] };
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        const r = await postBatch(base, creds.apiKey, entity, batch, dryRun);
        totals.batches++;
        totals.received += r.received || 0;
        totals.upserted += r.upserted || 0;
        totals.failed += r.failed || 0;
        if (Array.isArray(r.errors)) for (const e of r.errors) if (totals.errors.length < 10) totals.errors.push(e);
      }
      // An empty result set is still a successful (no-op) sync.
      if (records.length === 0) {
        const r = await postBatch(base, creds.apiKey, entity, [], dryRun);
        totals.batches++;
      }
      totals.ok = totals.failed === 0;
      out.entities[entity] = totals;
    } catch (err) {
      out.entities[entity] = { ok: false, error: String(err.message || err) };
    }
  }

  out.ok = Object.values(out.entities).every((e) => e.ok);
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
  await fetch(`${base}/innovations-sync/_requests/complete`, {
    method: 'POST',
    headers: { 'x-api-key': creds.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ id, ok, result }),
  });
}

// Claim and run any pending CV-initiated requests (writes). Returns what it did.
async function runRequested(creds, { max = 5 } = {}) {
  if (!creds || !creds.apiKey) throw new Error('CV API key not configured (unlock the vault first).');
  const processed = [];
  for (let i = 0; i < max; i++) {
    const reqRow = await fetchNextRequest(creds);
    if (!reqRow) break;
    const entities = Array.isArray(reqRow.entities) && reqRow.entities.length ? reqRow.entities : undefined;
    let result;
    try {
      result = await sync(creds, { commit: true, entities });
    } catch (err) {
      result = { ok: false, error: String(err.message || err) };
    }
    await completeRequest(creds, reqRow.id, !!result.ok, result);
    processed.push({ id: reqRow.id, ok: !!result.ok });
  }
  return { processed, count: processed.length };
}

module.exports = { sync, readEntity, describeTables, functionsBase, ENTITIES, fetchNextRequest, completeRequest, runRequested };
