/**
 * optilens-connector.js — live pull/push between optilens-local and the
 * Optilens Supabase catalog. Adapted from pricelist-automation; data files
 * write to data/pricelist/ instead of the project root.
 *
 * Classification (APPROVED / TIER_MAP / treatment / material) comes from the
 * shared lens-classifier.js so the live pull and the static export agree.
 */
const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', 'data', 'pricelist');
const { APPROVED, TIER_MAP, normMaterial, normTreatment } = require('./lens-classifier');
const r2 = (n) => Math.round(n * 100) / 100;

// overrides: { tierByType:{ "MF|LensType": tier }, treatmentByType:{ "MF|LensType": treatment } }
// User classifications applied on top of the built-in mapping (persisted, reused on every pull).
function combosFromRows(rows, overrides = {}) {
  const tierOv = overrides.tierByType || {};
  const trtOv = overrides.treatmentByType || {};
  const matOv = overrides.materialByType || {};
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const coverage = {}, meta = {}, prov = {}, supRows = {}, comboTypes = {};
  let approved = 0, mapped = 0;
  for (const r of rows) {
    if (!APPROVED.includes(r.supplier)) continue;
    approved++; supRows[r.supplier] = (supRows[r.supplier] || 0) + 1;
    if (r.active === false) continue;
    const cost = Number(r.cost);
    if (!Number.isFinite(cost) || cost <= 0) continue;
    const lk = `${r.mftype}|${r.lenstype}`;
    const tier = hasOwn(tierOv, lk) ? tierOv[lk] : TIER_MAP[lk]; if (!tier) continue;
    const material = hasOwn(matOv, lk) ? matOv[lk] : normMaterial(r.name, r.material); if (!material) continue;
    const treatment = hasOwn(trtOv, lk) ? trtOv[lk] : normTreatment(r.name); if (!treatment) continue;
    const key = `${treatment}||${tier}||${material}`;
    meta[key] = { treatment, tier, material, mftype: r.mftype };
    const typeMap = comboTypes[key] || (comboTypes[key] = {});
    const typeInfo = typeMap[lk] || (typeMap[lk] = { typeKey: lk, mftype: r.mftype, lenstype: r.lenstype, tier, treatment, rows: 0, suppliers: {} });
    typeInfo.rows++;
    typeInfo.suppliers[r.supplier] = (typeInfo.suppliers[r.supplier] || 0) + 1;
    const cov = coverage[key] || (coverage[key] = {});
    const pr = prov[key] || (prov[key] = {});
    const p = pr[r.supplier] || (pr[r.supplier] = { sourceName: r.name, sourceCost: r2(cost), rowCount: 0, allRows: [] });
    p.rowCount++; p.allRows.push({ name: r.name, cost: r2(cost) });
    if (r2(cost) < p.sourceCost) { p.sourceCost = r2(cost); p.sourceName = r.name; }
    if (cov[r.supplier] == null || cost < cov[r.supplier]) cov[r.supplier] = r2(cost);
    mapped++;
  }
  for (const k in prov) for (const s in prov[k]) prov[k][s].allRows = prov[k][s].allRows.sort((a, b) => a.cost - b.cost).slice(0, 6);
  const combos = Object.entries(coverage).map(([key, sup]) => {
    const items = Object.entries(sup);
    const anchor = items.reduce((a, b) => (b[1] > a[1] ? b : a));
    const cheap = items.reduce((a, b) => (b[1] < a[1] ? b : a));
    const types = Object.values(comboTypes[key] || {}).map(t => ({ ...t, suppliers: Object.keys(t.suppliers) }));
    return { key, ...meta[key], types, suppliers: sup, provenance: prov[key], anchorCost: anchor[1], anchorSupplier: anchor[0], cheapestCost: cheap[1], cheapestSupplier: cheap[0], supplierCount: items.length };
  });
  return { combos, coverage, approved, mapped, supRows };
}

const DEFAULT_SELECT = 'name,base_price,is_active,supplier:supplier_id(name),mftype:mftype_id(name),lenstype:lenstype_id(name),material:material_id(name)';

async function fetchLenses({ url, anonKey, select = DEFAULT_SELECT }) {
  const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  const base = `${url.replace(/\/$/, '')}/rest/v1/lenses?select=${encodeURIComponent(select)}`;
  const out = []; const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const res = await fetch(base, { headers: { ...headers, Range: `${from}-${from + pageSize - 1}`, 'Range-Unit': 'items' } });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

function mapRow(row) {
  const pick = (v) => (v && typeof v === 'object') ? v.name : v;
  return { name: row.name, supplier: pick(row.supplier), mftype: pick(row.mftype), lenstype: pick(row.lenstype), material: pick(row.material), cost: row.base_price, active: row.is_active };
}

async function pull(creds, { write = true, overrides = {} } = {}) {
  const raw = await fetchLenses(creds);
  const rows = raw.map(mapRow);
  const { combos, coverage, approved, mapped, supRows } = combosFromRows(rows, overrides);
  const sources = {
    generatedAt: new Date().toISOString(),
    sources: [{ id: 'optilens-supabase', type: 'database', format: 'supabase', name: 'Optilens catalog (live)', sheet: 'lenses',
      approvedRows: approved, mappedRows: mapped, combos: combos.length,
      suppliers: APPROVED.filter(s => supRows[s]).map(s => ({ name: s, rows: supRows[s] })),
      note: 'LIVE pull from the Optilens Supabase catalog via REST API.' }],
    live: [{ name: 'Optilens Supabase', status: `Connected · ${combos.length} combos · pulled ${new Date().toLocaleString()}` }],
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

async function push(creds, { pricedRows = [], versionName, commit = false } = {}) {
  const lines = pricedRows.filter(r => r.available && r.priceUSD > 0).map(r => ({
    row_key: r.key, treatment: r.treatment, tier: r.tier, material: r.material, wholesale_usd: r.priceUSD, retail_usd: r.retailUSD,
  }));
  const plan = { versionName: versionName || `Classic Pricelist ${new Date().toISOString().slice(0, 10)}`, lineCount: lines.length, target: 'pricelist_versions + matrix_allocations', reversible: 'new version (old versions retained)' };
  if (!commit) return { ok: true, dryRun: true, plan, sample: lines.slice(0, 5) };
  if (!creds.serviceKey) throw new Error('Push requires a service-role key (none supplied).');
  return { ok: false, dryRun: false, error: 'Live write disabled pending first-connect schema confirmation.', plan };
}

module.exports = { pull, push, combosFromRows, DEFAULT_SELECT };
