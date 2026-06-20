/* Classic Visions — Pricelist Builder
 * Folded into OptiLens Local /modules/pricing-automation.
 * API base: same origin — /api/v2/*, /api/pl/customers, /api/pricelists, /api/connectors
 */
'use strict';

const BBD_RATE = 2.0;

const MATERIALS = ['1.50', '1.56', 'TRIVEX', 'POLY', '1.60', '1.67', '1.74'];

const TIER_DISPLAY = {
  'Progressive - Best':        { grade: 'Best',          name: 'Endless Steady' },
  'Progressive - Better':      { grade: 'Better',        name: 'Essential Steady' },
  'Progressive - Good':        { grade: 'Good',          name: 'Classic PAL' },
  'Specific Use - Office':     { grade: 'Office',        name: 'Endless Office' },
  'Specific Use - Sport':      { grade: 'Sport',         name: 'Endless Sport' },
  'Anti-Fatigue':              { grade: 'Anti-Fatigue',  name: 'Endless Anti-Fatigue' },
  'Single Vision - HD':        { grade: 'Single Vision', name: 'Endless SV' },
  'Single Vision - Regular':   { grade: 'Single Vision', name: 'Conventional Single Vision' },
  'Specific Use - Bifocal':    { grade: 'Bifocal',       name: 'Endless BF' },
};

const TIER_ORDER = [
  'Progressive - Best', 'Progressive - Better', 'Progressive - Good',
  'Specific Use - Office', 'Specific Use - Sport', 'Anti-Fatigue',
  'Single Vision - HD', 'Single Vision - Regular', 'Specific Use - Bifocal',
];

const TREATMENT_ORDER = [
  'Clear', 'UV420',
  'Photochromic - Gray', 'Photochromic - Brown',
  'Trans Gen S™', 'Trans® XtrActive® New Gen', 'Trans® XtrActive® Polarized',
  'Polarized',
];

const SUPPLIER_COLORS = {
  'TOG Rx Lab':         '#1A8A9C',
  'Vision Rx Lab':      '#2563eb',
  'Optex Laboratories': '#C89130',
  'SkyLab':             '#9333ea',
};
const SUP_ABBR = {
  'TOG Rx Lab': 'TOG', 'Vision Rx Lab': 'VisionRx',
  'Optex Laboratories': 'Optex', 'SkyLab': 'SkyLab',
};
const DEFAULT_PRIORITY = ['TOG Rx Lab', 'Vision Rx Lab', 'Optex Laboratories', 'SkyLab'];

const ADDONS = [
  { label: 'Super AR+ (Blue Hue)', price: 25 },
  { label: 'Standard AR (Green Hue)', price: 20 },
  { label: 'Solid Tint', price: 5 },
  { label: 'Gradient Tint', price: 12 },
  { label: 'Edging (per lens)', price: 10 },
  { label: 'Hi-Power Sphere (over ±8.0)', price: 10 },
  { label: 'Hi-Power Cyl (over -3.0)', price: 15 },
  { label: 'Prism (per 4° per lens)', price: 5 },
];

// ── State ──────────────────────────────────────────────────────────────
let combos = [];
let comboByKey = {};
let customers = [];
let prices = {};
let currency = 'USD';
let priceMode = 'wholesale';
let currentCustomer = null;
let currentPricelistId = null;
let currentPricelistName = null;
let currentAuditKey = null;
let overrides = { combos: [], suppliers: {} };
let sources = { sources: [], live: [] };
let collapsed = {};

const settings = {
  floorMargin: 0.15,
  minMargin: 0.15,
  rounding: 0.5,
  wholesaleFloor: 10,
  priority: DEFAULT_PRIORITY.slice(),
  excluded: [],
  markup: { type: 'pct', value: 100 },
  smooth: true,
  costModel: {
    freightPct: { default: 0.12, 'TOG Rx Lab': 0.12, 'Vision Rx Lab': 0.12, 'Optex Laboratories': 0.10, 'SkyLab': 0.10 },
    dutyPct: 0,
    leviesPct: 0.01,
    clearancePct: 0.03,
    brokeragePerPair: 0.50,
  },
};

// ── Helpers ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const sym = () => (currency === 'BBD' ? 'B$' : '$');
const toDisplay = (usd) => (currency === 'BBD' ? usd * BBD_RATE : usd);
const toUSD = (val) => (currency === 'BBD' ? val / BBD_RATE : val);
const getKey = (t, ti, m) => `${t}||${ti}||${m}`;
const getCombo = (t, ti, m) => comboByKey[getKey(t, ti, m)];

function marginClass(m) {
  return m >= 0.45 ? 'm-ok' : m >= 0.30 ? 'm-thin' : m >= 0.15 ? 'm-floor' : 'm-low';
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}

// ── Boot ───────────────────────────────────────────────────────────────
// Note: applyTheme / wireThemeToggle are provided by shared.js (loaded before this file)
async function boot() {
  const [cb, cs, ov, sr] = await Promise.all([
    fetch('/api/v2/combos').then(r => r.json()).catch(() => []),
    fetch('/api/pl/customers').then(r => r.json()).catch(() => []),
    fetch('/api/v2/overrides').then(r => r.json()).catch(() => ({ combos: [], suppliers: {} })),
    fetch('/api/v2/sources').then(r => r.json()).catch(() => ({ sources: [], live: [] })),
  ]);
  combos = cb;
  comboByKey = Object.fromEntries(combos.map(c => [c.key, c]));
  customers = Array.isArray(cs) ? cs : [];
  overrides = ov && ov.combos ? ov : { combos: [], suppliers: {} };
  sources = sr || { sources: [], live: [] };
  populateCustomers();
  buildSupplierPanel();
  syncSettingsInputs();
  buildMatrix();
  updateEditingIndicator();
}

function populateCustomers() {
  const sel = $('customer-select');
  customers.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.account;
    opt.textContent = `${c.name}  (${c.country || '—'})`;
    sel.appendChild(opt);
  });
}

function onCustomerChange() {
  const acc = $('customer-select').value;
  currentCustomer = customers.find(c => c.account === acc) || null;
  const pill = $('customer-pill');
  if (currentCustomer) {
    pill.textContent = `${currentCustomer.buyingGroup || '—'} · ${currentCustomer.priceList || 'No list assigned'}`;
    pill.style.display = '';
    if (!$('pricelist-name').value) {
      const d = new Date().toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
      $('pricelist-name').value = `${currentCustomer.name} – ${d}`;
    }
    setCurrency(currentCustomer.buyingGroup === 'Export' ? 'USD' : 'BBD');
  } else {
    pill.style.display = 'none';
  }
}

// ── Settings inputs ────────────────────────────────────────────────────
const FREIGHT_INPUTS = { 'set-fr-tog': 'TOG Rx Lab', 'set-fr-vrx': 'Vision Rx Lab', 'set-fr-optex': 'Optex Laboratories', 'set-fr-sky': 'SkyLab' };

function syncSettingsInputs() {
  $('set-floor').value = Math.round(settings.floorMargin * 100);
  $('set-markup').value = settings.markup.value;
  const cm = settings.costModel;
  if (cm) {
    for (const [id, sup] of Object.entries(FREIGHT_INPUTS)) {
      const v = cm.freightPct[sup] != null ? cm.freightPct[sup] : cm.freightPct.default;
      if ($(id)) $(id).value = Math.round(v * 100);
    }
    if ($('set-duty')) $('set-duty').value = Math.round((cm.dutyPct || 0) * 100);
    if ($('set-levy')) $('set-levy').value = Math.round((cm.leviesPct || 0) * 100);
    if ($('set-clear')) $('set-clear').value = Math.round((cm.clearancePct || 0) * 100);
    if ($('set-broker')) $('set-broker').value = (cm.brokeragePerPair || 0).toFixed(2);
  }
}

function readSettings() {
  const f = parseFloat($('set-floor').value);
  if (!isNaN(f) && f > 0 && f < 90) { settings.floorMargin = f / 100; settings.minMargin = f / 100; }
  const mk = parseFloat($('set-markup').value);
  if (!isNaN(mk) && mk >= 0) settings.markup = { type: 'pct', value: mk };
  const cm = settings.costModel || (settings.costModel = { freightPct: { default: 0.12 }, dutyPct: 0, leviesPct: 0.01, clearancePct: 0.03, brokeragePerPair: 0.5 });
  for (const [id, sup] of Object.entries(FREIGHT_INPUTS)) {
    const v = parseFloat($(id)?.value);
    if (!isNaN(v) && v >= 0) cm.freightPct[sup] = v / 100;
  }
  const num = (id, scale) => { const v = parseFloat($(id)?.value); return isNaN(v) ? null : v / scale; };
  const d = num('set-duty', 100); if (d != null) cm.dutyPct = d;
  const l = num('set-levy', 100); if (l != null) cm.leviesPct = l;
  const c = num('set-clear', 100); if (c != null) cm.clearancePct = c;
  const b = num('set-broker', 1); if (b != null) cm.brokeragePerPair = b;
}

// ── Currency / price-mode ──────────────────────────────────────────────
function setCurrency(c) {
  currency = c;
  $('curr-usd').classList.toggle('active', c === 'USD');
  $('curr-bbd').classList.toggle('active', c === 'BBD');
  buildMatrix();
}
function setMode(m) {
  priceMode = m;
  $('mode-ws').classList.toggle('active', m === 'wholesale');
  $('mode-rt').classList.toggle('active', m === 'retail');
  buildMatrix();
}

// ── Auto-price ─────────────────────────────────────────────────────────
async function autoPrice() {
  readSettings();
  const res = await fetch('/api/v2/price', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...settings, disabled: overrides }),
  }).then(r => r.json());
  let filled = 0;
  res.rows.forEach(row => {
    if (!row.available) return;
    prices[row.key] = {
      priceUSD: row.priceUSD,
      retailUSD: row.retailUSD,
      anchorSupplier: row.anchorSupplier,
      anchorCost: row.anchorCost,
      floorMargin: row.floorMargin,
      preferredSupplier: row.preferredSupplier,
      preferredCost: row.preferredCost,
      preferredMargin: row.preferredMargin,
      safe: row.safe,
      smoothed: row.smoothed || false,
    };
    filled++;
  });
  buildMatrix();
  toast(`Priced ${filled} cells · anchor +${Math.round(settings.floorMargin * 100)}% floor`);
}

function resetPrices() {
  if (!confirm('Clear all prices in this pricelist?')) return;
  prices = {};
  buildMatrix();
  toast('Prices cleared');
}

// ── Manual override ────────────────────────────────────────────────────
async function onCellEdit(key, rawVal) {
  const num = parseFloat(rawVal);
  if (isNaN(num) || num <= 0) { delete prices[key]; buildMatrix(); return; }
  const enteredUSD = toUSD(num);
  if (priceMode === 'retail') {
    const p = prices[key] || {};
    p.retailUSD = enteredUSD;
    prices[key] = p;
    buildMatrix();
    return;
  }
  const ev = await fetch('/api/v2/override', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, enteredPriceUSD: enteredUSD, ...settings }),
  }).then(r => r.json());
  const combo = comboByKey[key];
  if (ev.ok) { storeManual(key, enteredUSD, combo, null); buildMatrix(); return; }
  if (ev.needsConfirmation && ev.constraint) {
    const disp = `${sym()}${toDisplay(enteredUSD).toFixed(2)}`;
    const ok = confirm(
      `${disp} doesn't clear your ${Math.round(settings.minMargin * 100)}% floor against the most expensive lab ` +
      `(anchor margin ${Math.round(ev.anchorMargin * 100)}%).\n\n` +
      `Source only from ${ev.constraint.supplier} (or cheaper) at ${Math.round(ev.constraint.margin * 100)}% margin?\n\n` +
      `OK = accept as source-constrained · Cancel = revert`
    );
    if (ok) { storeManual(key, enteredUSD, combo, ev.constraint.supplier); toast(`Line constrained to ${SUP_ABBR[ev.constraint.supplier] || ev.constraint.supplier}`); }
    buildMatrix();
    return;
  }
  alert(ev.message || 'That price is a loss at every approved supplier.');
  buildMatrix();
}

function storeManual(key, enteredUSD, combo, constraintSupplier) {
  const anchorCost = combo ? combo.anchorCost : 0;
  const floorMargin = anchorCost ? (enteredUSD - anchorCost) / enteredUSD : 0;
  let preferred = null;
  for (const s of settings.priority) {
    if (combo && combo.suppliers[s] != null && !settings.excluded.includes(s)) { preferred = s; break; }
  }
  const preferredCost = preferred ? combo.suppliers[preferred] : anchorCost;
  prices[key] = {
    priceUSD: enteredUSD,
    retailUSD: Math.round(enteredUSD * (1 + settings.markup.value / 100) * 100) / 100,
    anchorSupplier: combo ? combo.anchorSupplier : null,
    anchorCost, floorMargin,
    preferredSupplier: constraintSupplier || preferred,
    preferredCost: constraintSupplier ? combo.suppliers[constraintSupplier] : preferredCost,
    preferredMargin: preferredCost ? (enteredUSD - (constraintSupplier ? combo.suppliers[constraintSupplier] : preferredCost)) / enteredUSD : 0,
    safe: floorMargin >= settings.floorMargin - 1e-6,
    manual: true,
    constraintSupplier: constraintSupplier || null,
  };
}

// ── Matrix ─────────────────────────────────────────────────────────────
function activeMaterials(treatment) {
  return MATERIALS.filter(m => TIER_ORDER.some(ti => getCombo(treatment, ti, m)));
}

function buildMatrix() {
  const container = $('matrix-container');
  container.innerHTML = '';
  TREATMENT_ORDER.forEach(treatment => {
    const tiers = TIER_ORDER.filter(ti => MATERIALS.some(m => getCombo(treatment, ti, m)));
    if (!tiers.length) return;
    const mats = activeMaterials(treatment);
    const isCollapsed = !!collapsed[treatment];
    const setCount = tiers.reduce((n, ti) => n + mats.filter(m => { const k = getKey(treatment, ti, m); return prices[k] && (prices[k].priceUSD || 0) > 0; }).length, 0);
    const card = document.createElement('div');
    card.className = 'matrix-card' + (isCollapsed ? ' collapsed' : '');
    card.innerHTML = `
      <div class="matrix-hdr" onclick="toggleCollapse('${treatment.replace(/'/g, "\\'")}')">
        <h3><span class="chev">${isCollapsed ? '▸' : '▾'}</span> ${treatment}</h3>
        <small>${isCollapsed ? `${setCount} priced · click to expand` : 'Enter sell prices · worst-case &amp; preferred margins shown'}</small>
      </div>`;
    if (isCollapsed) { container.appendChild(card); return; }

    const tbl = document.createElement('table');
    tbl.className = 'matrix';
    tbl.innerHTML = `<thead><tr><th class="label-col">Lens Design</th>${mats.map(m => `<th>${m}</th>`).join('')}</tr></thead>`;
    const tbody = document.createElement('tbody');

    tiers.forEach(ti => {
      const disp = TIER_DISPLAY[ti] || { name: ti, grade: '' };
      const tr = document.createElement('tr');
      const td0 = document.createElement('td');
      td0.className = 'row-label';
      td0.innerHTML = `<span class="tier-grade">${disp.grade}</span><span class="tier-name">${disp.name}</span>`;
      tr.appendChild(td0);

      mats.forEach(m => {
        const td = document.createElement('td');
        const combo = getCombo(treatment, ti, m);
        const key = getKey(treatment, ti, m);
        if (!combo) { td.className = 'dash-cell'; td.textContent = '·'; tr.appendChild(td); return; }
        const kEsc = key.replace(/'/g, "\\'");
        if (overrides.combos.includes(key)) {
          td.innerHTML = `<div class="price-cell off">
            <span class="off-tag">discontinued</span>
            <button class="audit-btn" onclick="openAudit('${kEsc}')">🔍</button></div>`;
          tr.appendChild(td); return;
        }
        const p = prices[key];
        const showUSD = p ? (priceMode === 'retail' ? (p.retailUSD || 0) : (p.priceUSD || 0)) : 0;
        const isSet = showUSD > 0;
        const dispVal = isSet ? toDisplay(showUSD).toFixed(2) : '';
        let infoHtml = '';
        if (p && priceMode === 'wholesale') {
          const fm = p.floorMargin || 0;
          const pm = p.preferredMargin || 0;
          const aAbbr = SUP_ABBR[p.anchorSupplier] || '';
          const prAbbr = SUP_ABBR[p.preferredSupplier] || '';
          const constrained = p.constraintSupplier ? ' constrained' : '';
          infoHtml = `<div class="cell-info${constrained}">
            <span class="mtag ${marginClass(fm)}" title="worst-case margin">⚓${aAbbr} ${(fm*100).toFixed(0)}%</span>
            <span class="mtag ${marginClass(pm)}" title="preferred margin">▶${prAbbr} ${(pm*100).toFixed(0)}%</span>
          </div>`;
        } else if (combo) {
          const aAbbr = SUP_ABBR[combo.anchorSupplier] || '';
          const dot = SUPPLIER_COLORS[combo.anchorSupplier] || '#888';
          infoHtml = `<div class="cell-info"><span class="cost-hint"><span class="dot" style="background:${dot}"></span>${aAbbr} ${sym()}${toDisplay(combo.anchorCost).toFixed(2)} max</span></div>`;
        }
        td.innerHTML = `<div class="price-cell">
          <input type="number" class="price-input ${isSet?'set':''} ${p&&p.constraintSupplier?'constrained':''}"
            data-key="${key}" value="${dispVal}" placeholder="${sym()}0" min="0" step="0.5"
            onchange="onCellEdit('${kEsc}',this.value)" onfocus="this.select()">
          ${infoHtml}
          <button class="audit-btn" onclick="openAudit('${kEsc}')">🔍 audit</button>
        </div>`;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    tbl.appendChild(tbody);
    card.appendChild(tbl);
    const leg = document.createElement('div');
    leg.className = 'legend';
    leg.innerHTML = '<span>⚓ worst-case margin · ▶ preferred margin</span>' +
      '<span><span class="mtag m-ok">≥45%</span><span class="mtag m-thin">30–44%</span><span class="mtag m-floor">15–29%</span><span class="mtag m-low">&lt;15%</span></span>' +
      `<span style="margin-left:auto">Prices in USD · display ${currency} @ ${BBD_RATE} · ${priceMode}</span>`;
    card.appendChild(leg);
    container.appendChild(card);
  });
  if (!container.children.length) container.innerHTML = '<div class="pl-empty-state">No catalog data loaded.</div>';
  refreshAudit();
}

function toggleCollapse(t) { collapsed[t] = !collapsed[t]; buildMatrix(); }
function collapseAll(v) { TREATMENT_ORDER.forEach(t => collapsed[t] = v); buildMatrix(); }

// ── Landed-cost calc (for audit view) ─────────────────────────────────
function landedCalc(fob, supplier) {
  const cm = settings.costModel;
  if (!cm) return { freight: 0, cif: fob, uplift: 0, landed: fob };
  const fr = (cm.freightPct[supplier] != null ? cm.freightPct[supplier] : cm.freightPct.default) || 0;
  const cif = fob * (1 + fr);
  const uplift = (cm.dutyPct || 0) + (cm.leviesPct || 0) + (cm.clearancePct || 0);
  const landed = Math.round((cif * (1 + uplift) + (cm.brokeragePerPair || 0)) * 100) / 100;
  return { freight: fr, cif: Math.round(cif * 100) / 100, uplift, landed };
}

// ── Audit drill-down ───────────────────────────────────────────────────
function openAudit(key) {
  const c = comboByKey[key];
  if (!c) return;
  currentAuditKey = key;
  const [t, ti, m] = key.split('||');
  const disp = TIER_DISPLAY[ti] || { grade: ti, name: '' };
  const p = prices[key];
  const comboDisabled = overrides.combos.includes(key);
  const supDis = overrides.suppliers[key] || [];
  const srcName = (sources.sources && sources.sources[0]) ? sources.sources[0].name : 'master catalog';

  const supRows = Object.entries(c.provenance || {}).map(([sup, pr]) => {
    const lc = landedCalc(pr.sourceCost, sup);
    return { sup, pr, lc, excluded: settings.excluded.includes(sup), disabled: supDis.includes(sup) };
  }).sort((a, b) => b.lc.landed - a.lc.landed);

  const avail = supRows.filter(r => !r.excluded && !r.disabled);
  const anchor = avail.length ? avail.reduce((a, b) => (b.lc.landed > a.lc.landed ? b : a)) : null;

  const supTable = supRows.map(r => {
    const status = r.disabled ? '<span class="ast off">disabled</span>'
      : r.excluded ? '<span class="ast off">excluded</span>'
      : (anchor && r.sup === anchor.sup) ? '<span class="ast anc">⚓ anchor</span>'
      : (p && r.sup === p.preferredSupplier) ? '<span class="ast pref">▶ preferred</span>' : '';
    const kEsc = key.replace(/'/g, "\\'");
    const btn = r.disabled
      ? `<button class="mini-btn" onclick="toggleDisableSupplier('${kEsc}','${r.sup}')">enable</button>`
      : `<button class="mini-btn off" onclick="toggleDisableSupplier('${kEsc}','${r.sup}')">disable</button>`;
    return `<tr class="${(r.disabled||r.excluded)?'dim':''}">
      <td><span class="dot" style="background:${SUPPLIER_COLORS[r.sup]||'#888'}"></span>${SUP_ABBR[r.sup]||r.sup}</td>
      <td class="src">${r.pr.sourceName}${r.pr.rowCount>1?` <span class="muted">(+${r.pr.rowCount-1} more)</span>`:''}</td>
      <td class="num">$${r.pr.sourceCost.toFixed(2)}</td>
      <td class="num">+${(r.lc.freight*100).toFixed(0)}%</td>
      <td class="num">$${r.lc.landed.toFixed(2)}</td>
      <td>${status}</td><td>${btn}</td>
    </tr>`;
  }).join('');

  let calc = '<p class="muted">No price computed yet — run Auto-Price.</p>';
  if (p && anchor) {
    const raw = anchor.lc.landed / (1 - settings.floorMargin);
    calc = `<table class="audit-calc">
      <tr><td>Anchor (worst-case lab)</td><td class="num"><b>${SUP_ABBR[anchor.sup]||anchor.sup}</b> · landed $${anchor.lc.landed.toFixed(2)}</td></tr>
      <tr><td>÷ (1 − floor ${Math.round(settings.floorMargin*100)}%)</td><td class="num">$${raw.toFixed(2)}</td></tr>
      <tr><td>round up to $${settings.rounding}${p.smoothed?' + gap-smoothing':''}</td><td class="num">$${p.priceUSD.toFixed(2)}</td></tr>
      <tr class="hl"><td>Wholesale price (USD)</td><td class="num"><b>$${p.priceUSD.toFixed(2)}</b></td></tr>
      <tr><td>Retail (+${settings.markup.value}% markup)</td><td class="num">$${(p.retailUSD||0).toFixed(2)}</td></tr>
      <tr><td>Worst-case / preferred (${SUP_ABBR[p.preferredSupplier]||p.preferredSupplier})</td><td class="num">${(p.floorMargin*100).toFixed(0)}% / ${(p.preferredMargin*100).toFixed(0)}%</td></tr>
    </table>
    <p class="audit-note">Every figure is derived: source rows from <b>${srcName}</b>; landed cost adds freight + levy + clearance (VAT excluded); the price covers the most expensive available lab at your floor margin.</p>`;
  }

  const kEsc = key.replace(/'/g, "\\'");
  $('audit-body').innerHTML = `
    <div class="audit-head">
      <div class="audit-title">${t} · <b>${disp.grade}</b> <span class="lensname">${disp.name}</span> · ${m}</div>
      <div class="audit-sub">Source: ${srcName} · ${supRows.length} supplier${supRows.length!==1?'s':''} offer this lens</div>
    </div>
    <div class="audit-sup-wrap"><table class="audit-sup"><thead><tr><th>Supplier</th><th>Source row</th><th class="num">FOB</th><th class="num">Freight</th><th class="num">Landed</th><th>Role</th><th></th></tr></thead><tbody>${supTable}</tbody></table></div>
    ${calc}
    <div class="audit-actions">
      ${comboDisabled
        ? `<button class="pl-btn pl-btn-teal" onclick="toggleDisableCombo('${kEsc}')">↩ Restore</button>`
        : `<button class="pl-btn pl-btn-danger" onclick="toggleDisableCombo('${kEsc}')">✕ Discontinue</button>`}
      <button class="pl-btn pl-btn-secondary" onclick="closeAudit()">Close</button>
    </div>`;
  $('audit-overlay').classList.add('open');
}
function closeAuditClick(e) { if (e.target === $('audit-overlay')) closeAudit(); }
function closeAudit() { currentAuditKey = null; $('audit-overlay').classList.remove('open'); }
function refreshAudit() {
  if (currentAuditKey && $('audit-overlay').classList.contains('open')) openAudit(currentAuditKey);
}

async function persistOverrides() {
  await fetch('/api/v2/overrides', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(overrides) });
}
async function toggleDisableCombo(key) {
  const i = overrides.combos.indexOf(key);
  if (i >= 0) overrides.combos.splice(i, 1); else overrides.combos.push(key);
  await persistOverrides();
  await rePrice();
  openAudit(key);
}
async function toggleDisableSupplier(key, sup) {
  const arr = overrides.suppliers[key] || (overrides.suppliers[key] = []);
  const i = arr.indexOf(sup);
  if (i >= 0) arr.splice(i, 1); else arr.push(sup);
  if (!arr.length) delete overrides.suppliers[key];
  await persistOverrides();
  await rePrice();
  openAudit(key);
}

// ── Data Sources view ──────────────────────────────────────────────────
async function buildSourcesView() {
  const ss = await fetch('/api/v2/source-status').then(r => r.json()).catch(() => null);
  const list = sources.sources || [];
  const cards = list.map(s => `
    <div class="source-card">
      <div class="source-hd"><span class="source-type">${(s.format||s.type||'').toUpperCase()}</span><h3>${s.name}</h3></div>
      <div class="source-meta">${s.sheet?`Sheet: ${s.sheet} · `:''}${s.approvedRows} approved rows → ${s.combos} priced combos</div>
      <table class="source-sup"><thead><tr><th>Supplier</th><th class="num">Catalog rows</th><th>In pricing</th></tr></thead><tbody>
        ${(s.suppliers||[]).map(su => {
          const excluded = settings.excluded.includes(su.name);
          return `<tr><td><span class="dot" style="background:${SUPPLIER_COLORS[su.name]||'#888'}"></span>${SUP_ABBR[su.name]||su.name}</td>
            <td class="num">${su.rows}</td>
            <td><button class="mini-btn ${excluded?'off':''}" onclick="toggleExclude('${su.name}');buildSourcesView()">${excluded?'excluded':'included'}</button></td></tr>`;
        }).join('')}
      </tbody></table>
      <p class="source-note">${s.note||''}</p>
    </div>`).join('');
  const live = (sources.live && sources.live.length)
    ? sources.live.map(l => `<div class="source-card"><h3>${l.name}</h3><div class="source-meta">${l.status||''}</div></div>`).join('')
    : `<div class="source-card empty"><h3>Live connections</h3><div class="source-meta">None yet. Connect via Connectors → Pull catalog.</div></div>`;
  const disc = overrides.combos.length;
  let srcBanner = '';
  if (ss) {
    const onFallback = ss.active === 'fallback';
    const isEmpty = ss.active === 'empty';
    const dot = isEmpty ? 'var(--pl-danger)' : onFallback ? 'var(--pl-gold)' : 'var(--pl-success)';
    srcBanner = `<div class="source-card" style="border-left:4px solid ${dot}">
      <div class="source-hd"><h3>Active data source</h3></div>
      <div class="source-meta">${ss.label} · ${ss.count} combos</div>
      <p class="source-note">
        Generated catalog: <b>${ss.generatedExists?'present':'missing'}</b> ·
        Fallback snapshot: <b>${ss.fallbackExists?'ready':'missing'}</b>.
        ${onFallback?'Running on bundled fallback — live pull unavailable or not yet run.':
          isEmpty?'No catalog available. Run a live pull from Connectors.':
          'Live catalog active. Bundled snapshot is the safety net.'}
      </p></div>`;
  }
  $('sources-body').innerHTML = `
    ${srcBanner}
    <div class="src-stat" style="margin-bottom:12px"><div class="ss-num">${list.reduce((n,s)=>n+(s.combos||0),0)}</div><div class="ss-lbl">Priced combos from ${list.length} source${list.length!==1?'s':''} · ${disc} discontinued</div></div>
    ${cards}
    <h4 class="src-h4">Live / external feeds</h4>
    ${live}`;
}

// ── Preview ────────────────────────────────────────────────────────────
function showPreview(forPrint = false) {
  const listName = $('pricelist-name').value || 'RX Lens Prices';
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const s = sym();
  const field = (p) => (priceMode === 'retail' ? (p.retailUSD||0) : (p.priceUSD||0));

  // ── Letterhead ──
  const customerLine = currentCustomer
    ? `<div class="pl-info-bar">
        <div class="pl-info-cell"><div class="pl-info-label">Prepared for</div><div class="pl-info-value">${currentCustomer.name}</div></div>
        <div class="pl-info-cell"><div class="pl-info-label">Account</div><div class="pl-info-value">${currentCustomer.account || '—'}</div></div>
        <div class="pl-info-cell"><div class="pl-info-label">Currency</div><div class="pl-info-value">${currency}</div></div>
        <div class="pl-info-cell"><div class="pl-info-label">Pricing basis</div><div class="pl-info-value">${priceMode === 'retail' ? 'Retail' : 'Wholesale'} · per pair</div></div>
      </div>`
    : `<div class="pl-info-bar">
        <div class="pl-info-cell"><div class="pl-info-label">Document</div><div class="pl-info-value">${listName}</div></div>
        <div class="pl-info-cell"><div class="pl-info-label">Currency</div><div class="pl-info-value">${currency}</div></div>
        <div class="pl-info-cell"><div class="pl-info-label">Pricing basis</div><div class="pl-info-value">${priceMode === 'retail' ? 'Retail' : 'Wholesale'} · per pair</div></div>
      </div>`;

  // ── Price sections ──
  let sections = '';
  TREATMENT_ORDER.forEach(treatment => {
    const tiers = TIER_ORDER.filter(ti => MATERIALS.some(m => { const p = prices[getKey(treatment,ti,m)]; return p && field(p) > 0; }));
    if (!tiers.length) return;
    const mats = MATERIALS.filter(m => tiers.some(ti => { const p = prices[getKey(treatment,ti,m)]; return p && field(p) > 0; }));
    let rows = '';
    tiers.forEach(ti => {
      const disp = TIER_DISPLAY[ti] || { grade: ti, name: '' };
      const cells = mats.map(m => {
        const p = prices[getKey(treatment,ti,m)];
        const v = p ? field(p) : 0;
        return v > 0
          ? `<td><strong>${s}${toDisplay(v).toFixed(2)}</strong></td>`
          : `<td class="pl-dash">—</td>`;
      }).join('');
      rows += `<tr><td class="pl-design"><span class="pl-grade">${disp.grade}</span><span class="pl-lensname">${disp.name}</span></td>${cells}</tr>`;
    });
    sections += `
      <div class="pl-section">
        <div class="pl-sec-hdr"><span>${treatment.toUpperCase()}</span><span class="pl-sec-sub">${s} · per pair · VAT excl.</span></div>
        <table class="pl-table">
          <thead><tr><th>Lens Design</th>${mats.map(m=>`<th>${m}</th>`).join('')}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  });
  if (!sections) sections = '<div class="pl-empty-state">No prices set yet — run Auto-Price first.</div>';

  // ── Add-ons ── split into two columns
  const addonRows = ADDONS.map(a =>
    `<div class="pl-addon-row"><span>${a.label}</span><span><strong>${s}${toDisplay(a.price).toFixed(2)}</strong></span></div>`
  ).join('');

  $('preview-body').innerHTML = `
    <div class="pl-doc">
      <div class="pl-lh">
        <div class="pl-lh-left">
          <div class="pl-lh-logo"><img src="/assets/logo/logo_navy.svg" alt="Classic Visions" onerror="this.style.display='none'"></div>
          <div>
            <div class="pl-lh-brand">Classic Visions</div>
            <div class="pl-lh-tagline">Optical · Caribbean &amp; Export</div>
          </div>
        </div>
        <div class="pl-lh-right">
          <div class="pl-lh-doc-type">RX Lens Prices</div>
          <div class="pl-lh-date">${today} · Valid until further notice</div>
        </div>
      </div>

      ${customerLine}
      ${sections}

      <div class="pl-section" style="page-break-inside:avoid">
        <div class="pl-sec-hdr"><span>AR Coatings &amp; Lens Treatments</span><span class="pl-sec-sub">${s} · add to base price</span></div>
        <div class="pl-addons-grid">${addonRows}</div>
      </div>

      <div class="pl-doc-footer">
        <span>All prices in <strong>${currency}</strong>. Subject to change without notice. Confirm availability at time of order.</span>
        <span><strong>Classic Visions</strong> · classicvisions.net · classicvorders@gmail.com</span>
      </div>
    </div>`;

  $('preview-overlay').classList.add('open');
  if (forPrint) setTimeout(() => window.print(), 320);
}
function closePreviewClick(e) { if (e.target === $('preview-overlay')) $('preview-overlay').classList.remove('open'); }

// ── Save / Load ────────────────────────────────────────────────────────
function pricelistPayload(name) {
  return { name, customer: currentCustomer?.account||null, customerName: currentCustomer?.name||null, currency, priceMode, settings, prices };
}

function updateEditingIndicator() {
  const el = $('editing-status');
  if (!el) return;
  if (currentPricelistId) {
    el.textContent = `Editing: ${currentPricelistName||'saved list'}`;
    el.className = 'editing-pill editing';
    el.title = 'Save updates this list. Save As New creates a copy.';
  } else {
    el.textContent = 'New — unsaved';
    el.className = 'editing-pill new';
    el.title = 'Not yet saved.';
  }
}

async function savePricelist() {
  const name = $('pricelist-name').value.trim();
  if (!name) { toast('Enter a pricelist name first'); return; }
  const payload = pricelistPayload(name);
  if (currentPricelistId) {
    await fetch(`/api/pricelists/${currentPricelistId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    currentPricelistName = name;
    toast(`Saved ✓ "${name}"`);
  } else {
    const r = await fetch('/api/pricelists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json());
    currentPricelistId = r.id; currentPricelistName = name;
    toast(`Pricelist saved ✓ "${name}"`);
  }
  updateEditingIndicator();
}

async function saveAsNewPricelist() {
  const name = $('pricelist-name').value.trim();
  if (!name) { toast('Enter a pricelist name first'); return; }
  if (currentPricelistId && name === currentPricelistName) {
    if (!confirm('This will create a separate new copy with the same name. Continue?')) return;
  }
  const r = await fetch('/api/pricelists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pricelistPayload(name)) }).then(r => r.json());
  currentPricelistId = r.id; currentPricelistName = name;
  updateEditingIndicator();
  toast(`Saved as new ✓ "${name}" — original untouched`);
}

async function loadSavedList() {
  const list = await fetch('/api/pricelists').then(r => r.json());
  const el = $('saved-list');
  if (!list.length) { el.innerHTML = '<div class="pl-empty-state"><p>No saved pricelists yet.</p></div>'; return; }
  el.innerHTML = list.sort((a,b) => new Date(b.updatedAt)-new Date(a.updatedAt)).map(p => `
    <div class="saved-item">
      <div><div class="si-name">${p.name}</div><div class="si-meta">${p.customerName||p.customer||'No customer'} · ${new Date(p.updatedAt).toLocaleDateString()}</div></div>
      <div class="si-actions"><button class="pl-btn pl-btn-secondary" onclick="loadPricelist('${p.id}')">Open</button><button class="pl-btn pl-btn-danger" onclick="deletePricelist('${p.id}')">✕</button></div>
    </div>`).join('');
}

async function loadPricelist(id) {
  const p = await fetch(`/api/pricelists/${id}`).then(r => r.json());
  currentPricelistId = id; currentPricelistName = p.name||'';
  $('pricelist-name').value = p.name||'';
  prices = p.prices||{}; currency = p.currency||'USD'; priceMode = p.priceMode||'wholesale';
  if (p.settings) Object.assign(settings, p.settings);
  if (p.customer) { $('customer-select').value = p.customer; onCustomerChange(); }
  syncSettingsInputs(); setCurrency(currency); setMode(priceMode); updateEditingIndicator();
  showView('builder');
  toast(`Loaded "${p.name||'pricelist'}" — Save updates it, Save As New copies it`);
}

async function deletePricelist(id) {
  if (!confirm('Delete this pricelist?')) return;
  await fetch(`/api/pricelists/${id}`, { method: 'DELETE' });
  if (currentPricelistId === id) { currentPricelistId = null; currentPricelistName = null; updateEditingIndicator(); }
  loadSavedList();
  toast('Deleted');
}

// ── Supplier panel ─────────────────────────────────────────────────────
function buildSupplierPanel() {
  const el = $('sup-legend');
  const n = settings.priority.length;
  el.innerHTML = settings.priority.map((name, i) => {
    const excluded = settings.excluded.includes(name);
    return `<div class="pl-sup-row${excluded?' excluded':''}">
      <span class="sup-dot" style="background:${SUPPLIER_COLORS[name]||'#888'}"></span>
      <span class="sup-name">${SUP_ABBR[name]||name}</span>
      <span class="sup-rank">${i===0?'top':i===n-1?'least':''}</span>
      <span class="sup-ctrls">
        <button class="mini" title="Move up" onclick="moveSupplier(${i},-1)" ${i===0?'disabled':''}>▲</button>
        <button class="mini" title="Move down" onclick="moveSupplier(${i},1)" ${i===n-1?'disabled':''}>▼</button>
        <button class="mini exc ${excluded?'on':''}" onclick="toggleExclude('${name}')">${excluded?'✕':'✓'}</button>
      </span>
    </div>`;
  }).join('');
}
function moveSupplier(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= settings.priority.length) return;
  const p = settings.priority;
  [p[i], p[j]] = [p[j], p[i]];
  buildSupplierPanel(); rePrice();
}
function toggleExclude(name) {
  const idx = settings.excluded.indexOf(name);
  if (idx >= 0) settings.excluded.splice(idx, 1); else settings.excluded.push(name);
  buildSupplierPanel(); rePrice();
}
function rePrice() {
  return Object.keys(prices).length ? autoPrice() : buildMatrix();
}

// ── Sourcing Review ────────────────────────────────────────────────────
function buildSourcingView() {
  const rows = Object.entries(prices).map(([key, p]) => {
    const c = comboByKey[key]; if (!c) return null;
    return { key, p, c, single: c.supplierCount === 1, constrained: !!p.constraintSupplier };
  }).filter(Boolean);
  const priced = rows.length;
  const single = rows.filter(r => r.single);
  const constrained = rows.filter(r => r.constrained);
  const flagged = rows.filter(r => r.single || r.constrained).sort((a,b) => (b.constrained-a.constrained)||(b.single-a.single));
  const fmt = (t,ti,m) => { const d = TIER_DISPLAY[ti]||{grade:ti,name:''}; return `${t} · ${d.grade} (${d.name}) · ${m}`; };
  $('sourcing-summary').innerHTML = `
    <div class="src-stat"><div class="ss-num">${priced}</div><div class="ss-lbl">Priced lines</div></div>
    <div class="src-stat"><div class="ss-num" style="color:var(--pl-gold)">${single.length}</div><div class="ss-lbl">Single-source</div></div>
    <div class="src-stat"><div class="ss-num" style="color:var(--pl-teal)">${constrained.length}</div><div class="ss-lbl">Source-constrained</div></div>`;
  if (!priced) { $('sourcing-body').innerHTML = '<tr><td colspan="6" class="pl-empty-state">Run Auto-Price first.</td></tr>'; return; }
  if (!flagged.length) { $('sourcing-body').innerHTML = '<tr><td colspan="6" class="pl-empty-state">All clear — every priced line has multi-supplier fallback.</td></tr>'; return; }
  $('sourcing-body').innerHTML = flagged.map(r => {
    const [t,ti,m] = r.key.split('||');
    const flag = r.constrained
      ? `<span class="flag flag-con">⚑ ${SUP_ABBR[r.p.constraintSupplier]||r.p.constraintSupplier} only</span>`
      : `<span class="flag flag-sin">single-source</span>`;
    return `<tr>
      <td>${fmt(t,ti,m)}</td>
      <td class="num">${sym()}${toDisplay(r.p.priceUSD).toFixed(2)}</td>
      <td>${SUP_ABBR[r.p.anchorSupplier]||r.p.anchorSupplier} <span class="muted">${(r.p.floorMargin*100).toFixed(0)}%</span></td>
      <td>${SUP_ABBR[r.p.preferredSupplier]||r.p.preferredSupplier} <span class="muted">${(r.p.preferredMargin*100).toFixed(0)}%</span></td>
      <td>${r.c.supplierCount}</td>
      <td>${flag}</td>
    </tr>`;
  }).join('');
}

// ── Connectors ─────────────────────────────────────────────────────────
let connToken = null;
let connStatus = null;
const cpost = async (p, body) => {
  try {
    const res = await fetch('/api/connectors/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body||{}) });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { return { error: `Server error (HTTP ${res.status}).` }; }
    if (!res.ok && !data.error) data.error = `Request failed (HTTP ${res.status}).`;
    return data;
  } catch (e) { return { error: 'Cannot reach the server: ' + e.message }; }
};

async function buildConnectorsView() {
  const el = $('connectors-body');
  let res = null;
  try { res = await fetch('/api/connectors/status'); } catch { /* offline */ }
  if (!res || !res.ok) {
    el.innerHTML = `<div class="conn-card conn-lock"><h3>⚠ Connectors unavailable</h3>
      <p class="conn-note">The connectors API isn't responding. Restart the server and reload.</p></div>`;
    return;
  }
  connStatus = await res.json().catch(() => ({ initialised: false }));
  if (!connStatus.initialised) {
    el.innerHTML = `<div class="conn-card conn-lock"><h3>🔐 Set a passphrase</h3>
      <p class="conn-note">Protects your connection keys. Minimum 6 characters. No recovery — store it safely.</p>
      <input type="password" id="conn-pass1" placeholder="New passphrase" onkeydown="if(event.key==='Enter')connInit()">
      <div style="margin-top:10px"><button class="pl-btn pl-btn-primary" onclick="connInit()">Set passphrase</button></div></div>`;
    return;
  }
  if (!connToken) {
    el.innerHTML = `<div class="conn-card conn-lock"><h3>🔒 Connectors locked</h3>
      <p class="conn-note">Enter your passphrase to view or change credentials.</p>
      <input type="password" id="conn-pass" placeholder="Passphrase" onkeydown="if(event.key==='Enter')connUnlock()">
      <div style="margin-top:10px"><button class="pl-btn pl-btn-primary" onclick="connUnlock()">Unlock</button></div></div>`;
    return;
  }
  const o = connStatus.optilens || {};
  const a = connStatus.cvapi || {};
  el.innerHTML = `
    <div class="conn-card">
      <div class="conn-row"><h3>🔑 Classic Visions API (x-api-key)</h3><button class="pl-btn pl-btn-secondary" onclick="connLock()">🔒 Lock</button></div>
      <p class="conn-note">Scoped REST API for catalog &amp; customers. Key stored encrypted, used server-side only.</p>
      <label>Base URL</label><input id="cv-base" value="${a.baseUrl||''}" placeholder="https://….supabase.co/functions/v1/api-v1">
      <label>API key <span class="muted">current: ${a.apiKeyMasked||'not set'}</span></label><input id="cv-key" type="password" placeholder="paste to set / replace">
      <div class="conn-actions">
        <button class="pl-btn pl-btn-primary" onclick="cvSave()">Save (encrypted)</button>
        <button class="pl-btn pl-btn-secondary" onclick="cvReveal()">👁 Reveal</button>
        <button class="pl-btn pl-btn-teal" onclick="cvTest()">⇄ Test link</button>
      </div>
      <div id="cv-result" class="conn-result">${a.updatedAt?`<span class="muted">Key saved ${new Date(a.updatedAt).toLocaleString()}</span>`:''}</div>
    </div>
    <div class="conn-card">
      <div class="conn-row"><h3>🗄 Optilens (Supabase) catalog</h3><button class="pl-btn pl-btn-secondary" onclick="connLock()">🔒 Lock</button></div>
      <label>Project URL</label><input id="conn-url" value="${o.url||''}" placeholder="https://your-project.supabase.co">
      <label>Anon / publishable key <span class="muted">current: ${o.anonKeyMasked||'not set'}</span></label><input id="conn-anon" type="password" placeholder="paste to set / replace">
      <label>Service-role key — push only <span class="muted">current: ${o.serviceKeyMasked||'not set'}</span></label><input id="conn-svc" type="password" placeholder="paste to set / replace">
      <div class="conn-actions">
        <button class="pl-btn pl-btn-primary" onclick="connSave()">Save (encrypted)</button>
        <button class="pl-btn pl-btn-secondary" onclick="connReveal()">👁 Reveal</button>
      </div>
    </div>
    <div class="conn-card">
      <div class="conn-row"><h3>Sync</h3><span class="muted">${o.updatedAt?'credentials updated '+new Date(o.updatedAt).toLocaleString():''}</span></div>
      <p class="conn-note">Pull is read-only — refreshes catalog &amp; re-prices. Publish writes a new versioned pricelist back (dry-run first).</p>
      <div class="conn-actions">
        <button class="pl-btn pl-btn-teal" onclick="connPull()">⇩ Pull catalog (live sync)</button>
        <button class="pl-btn pl-btn-gold" onclick="connPushDryRun()">⇧ Publish prices… (dry-run)</button>
      </div>
      <div id="conn-result" class="conn-result"></div>
    </div>`;
}

async function connInit() { const r = await cpost('init', { passphrase: $('conn-pass1').value }); if (r.error) return toast(r.error); toast('Passphrase set'); buildConnectorsView(); }
async function connUnlock() { const r = await cpost('unlock', { passphrase: $('conn-pass').value }); if (r.error||!r.token) return toast(r.error||'Wrong passphrase'); connToken = r.token; toast('Unlocked'); buildConnectorsView(); }
function connLock() { if (connToken) cpost('lock', { token: connToken }); connToken = null; buildConnectorsView(); }

async function cvSave() {
  const r = await cpost('cvapi/config', { token: connToken, baseUrl: $('cv-base').value.trim(), apiKey: $('cv-key').value.trim()||undefined });
  if (r.error) return toast(r.error); toast('API key saved (encrypted)'); buildConnectorsView();
}
async function cvReveal() {
  const r = await cpost('cvapi/reveal', { token: connToken }); if (r.error) return toast(r.error);
  if ($('cv-base')) $('cv-base').value = r.baseUrl||'';
  if ($('cv-key')) { $('cv-key').type='text'; $('cv-key').value = r.apiKey||''; }
}
async function cvTest() {
  const box = $('cv-result'); box.innerHTML = '<span class="muted">Testing…</span>';
  const r = await cpost('cvapi/test', { token: connToken });
  if (r.error) { box.innerHTML = `<span class="conn-err">${r.error}</span>`; return; }
  if (!r.ok) { box.innerHTML = `<span class="conn-err">✗ ${r.message||'Link failed'}</span>`; return; }
  const fields = Object.entries(r.parity).map(([k,hit]) => `${hit?'✓':'✗'} ${k}${hit?` → ${hit}`:' missing'}`).join(' · ');
  box.innerHTML = `<div class="conn-dry"><span class="conn-ok">✓ Connected.</span> Catalog rows sampled: <b>${r.catalogRows}</b>; customers: <b>${r.customersOk?'ok':'no'}</b>.<br><span class="muted">Parity:</span> ${fields}</div>`;
}
async function connSave() {
  const r = await cpost('config', { token: connToken, url: $('conn-url').value.trim(), anonKey: $('conn-anon').value.trim()||undefined, serviceKey: $('conn-svc').value.trim()||undefined });
  if (r.error) return toast(r.error); toast('Credentials saved (encrypted)'); buildConnectorsView();
}
async function connReveal() {
  const r = await cpost('reveal', { token: connToken }); if (r.error) return toast(r.error);
  if ($('conn-url')) $('conn-url').value = r.url||'';
  if ($('conn-anon')) { $('conn-anon').type='text'; $('conn-anon').value = r.anonKey||''; }
  if ($('conn-svc')) { $('conn-svc').type='text'; $('conn-svc').value = r.serviceKey||''; }
}
async function connPull() {
  $('conn-result').innerHTML = '<span class="muted">Pulling live catalog…</span>';
  const r = await cpost('pull', { token: connToken });
  if (r.error) { $('conn-result').innerHTML = `<span class="conn-err">Pull failed: ${r.error}</span>`; return; }
  combos = await fetch('/api/v2/combos').then(x => x.json());
  comboByKey = Object.fromEntries(combos.map(c => [c.key, c]));
  sources = await fetch('/api/v2/sources').then(x => x.json());
  await rePrice();
  $('conn-result').innerHTML = `<span class="conn-ok">✓ Pulled ${r.combos} combos from ${r.rawRows} rows. Prices regenerated.</span>`;
  toast('Live catalog synced');
}
async function connPushDryRun() {
  const rows = Object.entries(prices).map(([key,p]) => { const c = comboByKey[key]||{}; return { key, treatment: c.treatment, tier: c.tier, material: c.material, available: true, priceUSD: p.priceUSD, retailUSD: p.retailUSD }; });
  if (!rows.length) return toast('Run Auto-Price first');
  const r = await cpost('push', { token: connToken, pricedRows: rows, commit: false });
  if (r.error) { $('conn-result').innerHTML = `<span class="conn-err">${r.error}</span>`; return; }
  $('conn-result').innerHTML = `<div class="conn-dry"><b>Dry run — nothing sent.</b><br>Would publish <b>${r.plan.lineCount}</b> lines as version "${r.plan.versionName}" → ${r.plan.target} (${r.plan.reversible}).<br><span class="muted">Live write stays disabled until first confirmed connect.</span></div>`;
}

// ── Navigation ─────────────────────────────────────────────────────────
const VIEWS = ['builder', 'saved', 'sourcing', 'sources', 'connectors'];
const VIEW_TITLES = { builder: 'Build Pricelist', saved: 'Saved Pricelists', sourcing: 'Sourcing Review', sources: 'Data Sources', connectors: 'Connectors' };
function showView(view) {
  VIEWS.forEach(v => {
    $(`view-${v}`).style.display = v === view ? '' : 'none';
    const nav = $(`nav-${v}`); if (nav) nav.classList.toggle('active', v === view);
  });
  $('topbar-title').textContent = VIEW_TITLES[view] || view;
  if (view === 'saved') loadSavedList();
  if (view === 'sourcing') buildSourcingView();
  if (view === 'sources') buildSourcesView();
  if (view === 'connectors') buildConnectorsView();
}

window.addEventListener('DOMContentLoaded', boot);
