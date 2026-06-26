/**
 * cv-api-connector.js — live pull/publish between optilens-local and the
 * Classic Visions scoped REST API (api-v1, x-api-key auth).
 *
 * Read : GET /catalog  (the catalog_live view: name, cost, supplier_name,
 *        lenstype, material, mftype, sell_price ...) → engine combos. Reuses
 *        combosFromRows() from optilens-connector so the output format and the
 *        approved-supplier / tier classification stay identical to the existing
 *        pull — only the data SOURCE differs.
 * Write: POST /catalog  rows land in THIS key's draft pricelist_version
 *        (pricelist_catalog_rows), scoped + reversible — never the live catalog.
 *        Dry-run by default; pass { commit:true } to actually write.
 *
 * Contract: docs/api/external-sync-guide.md in the Classic Visions repo.
 */
const fs = require('fs');
const path = require('path');
const { combosFromRows } = require('./optilens-connector');
const { APPROVED } = require('./lens-classifier');

const DATA = path.join(__dirname, '..', 'data', 'pricelist');
const DEFAULT_BASE = 'https://xstmeirxhfbiyayrrsob.supabase.co/functions/v1/api-v1';
// Barbados dollar is pegged 2:1 to USD. The engine prices in USD; the published
// pricelist rows carry bbd_price. Override via creds.bbdRate if the peg changes.
const DEFAULT_BBD_RATE = 2;

// ── Read ───────────────────────────────────────────────────────────────────
async function fetchCatalog({ baseUrl, apiKey }, { pageSize = 500 } = {}) {
  const base = (baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(`${base}/catalog?limit=${pageSize}&offset=${offset}&order=id.asc`,
      { headers: { 'x-api-key': apiKey } });
    if (!res.ok) throw new Error(`CV API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const rows = body.data || [];
    out.push(...rows);
    const count = typeof body.count === 'number' ? body.count : null;
    if (rows.length < pageSize || (count != null && out.length >= count)) break;
  }
  return out;
}

// catalog_live row → the shape combosFromRows() expects. Non-lens rows
// (supplies/addons) have null lenstype/mftype and are dropped by the tier map.
function mapRow(row) {
  return {
    name: row.name,
    supplier: row.supplier_name,
    mftype: row.mftype,
    lenstype: row.lenstype,
    material: row.material,
    cost: row.cost,
    active: row.is_active,
  };
}

async function pull(creds, { write = true, overrides = {} } = {}) {
  const raw = await fetchCatalog(creds);
  const rows = raw.map(mapRow);
  const { combos, coverage, approved, mapped, supRows } = combosFromRows(rows, overrides);
  const sources = {
    generatedAt: new Date().toISOString(),
    sources: [{
      id: 'classic-visions-api', type: 'database', format: 'api-v1',
      name: 'Classic Visions catalog (live)', sheet: 'catalog_live',
      approvedRows: approved, mappedRows: mapped, combos: combos.length,
      suppliers: APPROVED.filter(s => supRows[s]).map(s => ({ name: s, rows: supRows[s] })),
      note: 'LIVE pull from the Classic Visions api-v1 /catalog (catalog_live view).',
    }],
    live: [{ name: 'Classic Visions API', status: `Connected · ${combos.length} combos · pulled ${new Date().toLocaleString()}` }],
  };
  if (write) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, 'lens-data.generated.json'), JSON.stringify(combos, null, 2));
    fs.writeFileSync(path.join(DATA, 'supplier-coverage.generated.json'), JSON.stringify(coverage, null, 2));
    fs.writeFileSync(path.join(DATA, 'sources.generated.json'), JSON.stringify(sources, null, 2));
    // Persist the raw mapped rows so classification overrides can re-bucket without re-pulling.
    fs.writeFileSync(path.join(DATA, 'catalog-rows.generated.json'), JSON.stringify(rows, null, 2));
  }
  return { ok: true, combos: combos.length, approvedRows: approved, mappedRows: mapped, suppliers: sources.sources[0].suppliers, rawRows: raw.length };
}

// ── Write (publish a built pricelist) ────────────────────────────────────────
// Maps the builder's priced rows to pricelist_catalog_rows and POSTs them to
// /catalog, which the edge function routes into this key's draft
// pricelist_version. Required row fields: row_key, row_type, section.
function buildPublishRows(pricedRows, { bbdRate = DEFAULT_BBD_RATE } = {}) {
  return pricedRows
    .filter(r => r.available && r.priceUSD > 0)
    .map((r, i) => ({
      row_key: r.key,
      row_type: 'rx_lens',
      section: r.tier || r.treatment || 'Lenses',
      catalog_type: 'rx_lens_matrix',
      display_description: [r.treatment, r.tier, r.material].filter(Boolean).join(' · '),
      bbd_price: Math.round(r.priceUSD * bbdRate * 100) / 100,
      sort_order: i,
    }));
}

async function publish(creds, { pricedRows = [], versionName, commit = false, bbdRate } = {}) {
  const base = (creds.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  const rows = buildPublishRows(pricedRows, { bbdRate });
  const plan = {
    versionName: versionName || `Classic Pricelist ${new Date().toISOString().slice(0, 10)}`,
    lineCount: rows.length,
    target: 'POST /catalog → this key\'s draft pricelist_version (pricelist_catalog_rows)',
    reversible: 'writes to a draft version, never the live catalog',
  };
  if (!commit) return { ok: true, dryRun: true, plan, sample: rows.slice(0, 5) };

  const results = { ok: true, dryRun: false, posted: 0, failed: 0, errors: [], draftVersionId: null };
  for (const row of rows) {
    const res = await fetch(`${base}/catalog`, {
      method: 'POST',
      headers: { 'x-api-key': creds.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(row),
    });
    if (res.ok) {
      results.posted++;
      const body = await res.json().catch(() => ({}));
      if (body.draft_pricelist_version_id) results.draftVersionId = body.draft_pricelist_version_id;
    } else {
      results.failed++;
      if (results.errors.length < 5) results.errors.push(`${res.status}: ${(await res.text()).slice(0, 120)}`);
    }
  }
  results.ok = results.failed === 0;
  return { ...results, plan };
}

module.exports = { pull, publish, fetchCatalog, mapRow, buildPublishRows };
