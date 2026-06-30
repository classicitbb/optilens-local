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
  // ASSUMED columns — confirm against the live dbo.Contacts on first dry-run.
  contacts: {
    sql: `
      SELECT ContactID, CustomerID, FirstName, LastName, Email, Phone
      FROM dbo.Contacts
      ORDER BY ContactID
    `,
    map: (r) => ({
      innovations_contact_id: r.ContactID,
      innovations_parent_customer_id: r.CustomerID,
      name: [r.FirstName, r.LastName].filter(Boolean).join(' ').trim() || '(unnamed)',
      email: r.Email || '',
      phone: r.Phone || '',
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

module.exports = { sync, readEntity, functionsBase, ENTITIES };
