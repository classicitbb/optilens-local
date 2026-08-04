// Inventory turnover analysis for the Business Metrics → Inventory tab.
//
// Reads live Innovations MSSQL via getLiveSourcePool(), NOT getSourcePool():
// the Zen-fed mirror carries 28 tables and none of the stock ones, so these
// queries have exactly one valid home regardless of the active read profile.
//
// ── What "movement" means here ───────────────────────────────────────────────
// StockTransactions is not a usable consumption feed: over the last 12 months
// it recorded 93 "Rx Usage" rows against ~8,700 jobs, is dominated by
// "Manual Change" and "Cancellation Return", and its signs are inverted
// (PO Receipt sums negative). So lens velocity comes from RxArchive job
// history, which is dense and runs back to 2017.
//
// That has a known cost, and it is disclosed rather than hidden: only ~63% of
// RxArchive rows carry a lens-item reference, so velocity UNDERCOUNTS by
// roughly a third, unevenly. An item can therefore look slower than it is.
// Every payload carries this in `caveats` and the UI prints it.
//
// ── The 2025 boundary ────────────────────────────────────────────────────────
// Stock control was switched on in 2025: lens cycle counts start that year and
// StockUsage jumps 7,602 → 71,657 rows against flat job volume. Anything
// earlier is catalogue history, not inventory history. Cover and stock-derived
// series must not be drawn across it.
//
// ── Identity ─────────────────────────────────────────────────────────────────
// A lens is the six-part compound key (MaterialGroup, Material, MFType,
// LensType, Option, Num). LensItem.Num alone is NOT unique — joining on it
// fans 611 distinct movers out to 2,719 rows.

const sql = require("mssql");
const { getLiveSourcePool, getAppPool } = require("../db");
const { normTreatmentStrict, treatmentGroup } = require("../lens-classifier");

// Stock control went live in 2025; nothing before this is inventory history.
const STOCK_CONTROL_EPOCH = "2025-01-01";

const DEFAULT_THRESHOLDS = {
  windowMonths: 24,
  slowMaxUnits: 5,
  regularMaxUnits: 30,
  coverWarnMonths: 12,
  coverCriticalMonths: 24
};

const SPEED_CLASSES = ["non_mover", "slow", "regular", "fast"];

const SPEED_LABELS = {
  non_mover: "Non-mover",
  slow: "Slow",
  regular: "Regular",
  fast: "Fast"
};

function num(v) { return v == null ? 0 : Number(v); }

/** Read index i of an array field, tolerating a missing series. */
function pluck(series, field, i) {
  if (!series || !series[field] || series[field][i] == null) return "—";
  return series[field][i] + "%";
}

/* ─────────── thresholds & overrides (app DB) ─────────── */

async function loadThresholds() {
  try {
    const pool = await getAppPool();
    const result = await pool.request().query(`
      SELECT setting_key, setting_value
      FROM core.app_settings
      WHERE setting_key LIKE 'inventory_%';
    `);

    const map = {};
    for (const row of result.recordset) map[row.setting_key] = row.setting_value;

    const pick = (key, fallback) => {
      const parsed = Number(map[key]);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };

    return {
      windowMonths: pick("inventory_window_months", DEFAULT_THRESHOLDS.windowMonths),
      slowMaxUnits: pick("inventory_slow_max_units", DEFAULT_THRESHOLDS.slowMaxUnits),
      regularMaxUnits: pick("inventory_regular_max_units", DEFAULT_THRESHOLDS.regularMaxUnits),
      coverWarnMonths: pick("inventory_cover_warn_months", DEFAULT_THRESHOLDS.coverWarnMonths),
      coverCriticalMonths: pick("inventory_cover_critical_months", DEFAULT_THRESHOLDS.coverCriticalMonths)
    };
  } catch {
    // App DB unavailable: analytics still work, just on the documented defaults.
    return { ...DEFAULT_THRESHOLDS };
  }
}

/**
 * Suppressions keyed for O(1) lookup. An override never deletes a row — the tab
 * still lists suppressed items with their reason — it only stops them counting
 * toward an alert.
 */
async function loadOverrides() {
  const empty = { lens: new Map(), misc: new Map(), skuZeroCost: new Map(), total: 0 };
  try {
    const pool = await getAppPool();
    const result = await pool.request().query(`
      SELECT item_kind, material_group, material, mf_type, lens_type, lens_option,
             item_num, misc_item_id, alert_kind, reason, item_label, created_by, created_at
      FROM metrics.inventory_overrides
      WHERE is_suppressed = 1;
    `);

    for (const row of result.recordset) {
      const entry = {
        alertKind: row.alert_kind,
        reason: row.reason,
        itemLabel: row.item_label,
        createdBy: row.created_by,
        createdAt: row.created_at
      };
      if (row.item_kind === "lens") {
        empty.lens.set(lensKeyOf(row.material_group, row.material, row.mf_type,
          row.lens_type, row.lens_option, row.item_num) + "|" + row.alert_kind, entry);
      } else {
        empty.misc.set(row.misc_item_id + "|" + row.alert_kind, entry);
      }
      empty.total += 1;
    }

    await mergeCostExemptions(pool, empty);
    return empty;
  } catch {
    return empty;
  }
}

/**
 * Also honour the invoice-line cost-defect exemptions in
 * pricing.item_cost_exemptions (lib/metrics/data-quality.js).
 *
 * That register answers the same operator question this one does — "is this
 * item's zero cost deliberate?" — but keys on the SKU string, because invoice
 * lines carry no item foreign key. Reading it here means an operator exempts an
 * item once and it stops alerting in both places, instead of having to suppress
 * the same item twice in two screens.
 *
 * Deliberately one-way and best-effort: this module never writes to that table,
 * and a schema change over there degrades to "no extra suppressions" rather
 * than breaking inventory analytics.
 */
async function mergeCostExemptions(pool, overrides) {
  try {
    const result = await pool.request().query(`
      SELECT item_key, item_description, reason, exempted_at
      FROM pricing.item_cost_exemptions
      WHERE check_code = N'zero-cost' AND exemption_state = N'ACTIVE';
    `);
    for (const row of result.recordset) {
      const sku = String(row.item_key || "").trim().toUpperCase();
      if (!sku) continue;
      overrides.skuZeroCost.set(sku, {
        alertKind: "zero_cost",
        reason: row.reason || "Exempted in the item cost defect register",
        itemLabel: row.item_description,
        createdBy: "pricing.item_cost_exemptions",
        createdAt: row.exempted_at
      });
    }
  } catch {
    // Table absent (migration not yet applied) or renamed — not fatal here.
  }
}

function lensKeyOf(mg, mt, mf, lt, op, it) {
  return [mg, mt, mf, lt, op, it].join(":");
}

function isSuppressed(overrides, kind, key, alertKind, item) {
  const map = kind === "lens" ? overrides.lens : overrides.misc;
  if (map.has(key + "|" + alertKind) || map.has(key + "|all")) return true;

  // Cross-register: a zero-cost exemption recorded against the SKU in the
  // invoice-line defect register also silences it here.
  if (alertKind === "zero_cost" && item && overrides.skuZeroCost) {
    for (const sku of [item.sku, item.skuR, item.skuL]) {
      if (sku && overrides.skuZeroCost.has(String(sku).trim().toUpperCase())) return true;
    }
  }
  return false;
}

/* ─────────── classification ─────────── */

function speedClassFor(units, thresholds) {
  if (units <= 0) return "non_mover";
  if (units <= thresholds.slowMaxUnits) return "slow";
  if (units <= thresholds.regularMaxUnits) return "regular";
  return "fast";
}

/**
 * Months of supply. Deliberately null — not Infinity — when nothing moved:
 * cover is undefined for a non-mover, and rendering "∞ months" invites someone
 * to sort by it and read a meaningless order.
 */
function coverMonths(onHand, units, windowMonths) {
  if (units <= 0 || onHand <= 0) return null;
  const perMonth = units / windowMonths;
  return Math.round((onHand / perMonth) * 10) / 10;
}

/* ─────────── lens universe ─────────── */

/**
 * Every active lens that is either stocked now or moved inside the window.
 *
 * "Stocked now OR moved" rather than "stocked now": an item burned down to zero
 * is still a fast mover and still needs reordering — scoping to on-hand alone
 * would erase exactly the items that most need attention. Alerts, separately,
 * only fire where on-hand > 0, since you cannot discount what you do not have.
 */
async function loadLensUniverse(pool, thresholds) {
  const result = await pool.request()
    .input("windowMonths", sql.Int, thresholds.windowMonths)
    .query(`
      WITH mv AS (
        SELECT RLensMG AS mg, RLensMatl AS mt, RLensMF AS mf, RLensType AS lt,
               RLensOption AS op, RLensItem AS it, ShipDate AS d
        FROM dbo.RxArchive
        WHERE ShipDate >= DATEADD(month, -@windowMonths, GETDATE()) AND RLensItem > 0
        UNION ALL
        SELECT LLensMG, LLensMatl, LLensMF, LLensType, LLensOption, LLensItem, ShipDate
        FROM dbo.RxArchive
        WHERE ShipDate >= DATEADD(month, -@windowMonths, GETDATE()) AND LLensItem > 0
      ),
      agg AS (
        SELECT mg, mt, mf, lt, op, it, COUNT(*) AS units, MAX(d) AS lastMoved
        FROM mv GROUP BY mg, mt, mf, lt, op, it
      )
      SELECT
        li.MaterialGroup AS mg, li.Material AS mt, li.MFType AS mf,
        li.LensType AS lt, li.[Option] AS op, li.Num AS it,
        li.Name AS itemName, li.Cost AS cost, li.Add_Cyl AS addCyl, li.Fin_Semi AS finSemi,
        li.OPC_R AS skuR, li.OPC_L AS skuL,
        li.OnHand_R AS onHandR, li.OnHand_L AS onHandL, li.OnHand_P AS onHandPairs,
        (li.OnHand_R + li.OnHand_L + li.OnHand_P * 2) AS onHand,
        (li.OnOrder_R + li.OnOrder_L + li.OnOrder_P * 2) AS onOrder,
        lm.Name AS manufacturer, mtl.Name AS materialName, mft.Name AS mfTypeName,
        lt2.Name AS lensTypeName, lo.Name AS optionName,
        ISNULL(a.units, 0) AS units, a.lastMoved
      FROM dbo.LensItem li
      INNER JOIN dbo.LensMfgr lm ON lm.Num = li.Manufacturer
      INNER JOIN dbo.Materials mtl ON mtl.GroupNum = li.MaterialGroup AND mtl.MtrlNum = li.Material
      INNER JOIN dbo.MFTypes mft ON mft.GroupNum = li.MaterialGroup AND mft.MtrlNum = li.Material
                                AND mft.MFNum = li.MFType
      INNER JOIN dbo.LensType lt2 ON lt2.GroupNum = li.MaterialGroup AND lt2.MatlNum = li.Material
                                 AND lt2.MFNum = li.MFType AND lt2.LNum = li.LensType
      INNER JOIN dbo.LensOptions lo ON lo.GroupNum = li.MaterialGroup AND lo.MatlNum = li.Material
                                   AND lo.MFNum = li.MFType AND lo.LNum = li.LensType
                                   AND lo.Num = li.[Option]
      LEFT JOIN agg a ON a.mg = li.MaterialGroup AND a.mt = li.Material AND a.mf = li.MFType
                     AND a.lt = li.LensType AND a.op = li.[Option] AND a.it = li.Num
      WHERE li.Flags & 2 = 0
        AND ((li.OnHand_R + li.OnHand_L + li.OnHand_P * 2) <> 0 OR a.it IS NOT NULL);
    `);

  return result.recordset.map((r) => {
    const onHand = num(r.onHand);
    const units = num(r.units);
    const cost = num(r.cost);
    const treatment = normTreatmentStrict(
      [r.optionName, r.materialName, r.itemName].filter(Boolean).join(" ")
    );

    return {
      key: lensKeyOf(r.mg, r.mt, r.mf, r.lt, r.op, r.it),
      materialGroup: r.mg, material: r.mt, mfType: r.mf,
      lensType: r.lt, lensOption: r.op, itemNum: r.it,
      label: [r.manufacturer, r.materialName, r.mfTypeName, r.lensTypeName, r.optionName, r.itemName]
        .filter(Boolean).join(" · "),
      manufacturer: r.manufacturer,
      materialName: r.materialName,
      mfTypeName: r.mfTypeName,
      lensTypeName: r.lensTypeName,
      optionName: r.optionName,
      itemName: r.itemName,
      skuR: r.skuR, skuL: r.skuL,
      // A pair is one right and one left lens. Surface stock by eye in the
      // drill-downs so an operator can reconcile the displayed total, while
      // retaining the source pair count for any future pair-specific view.
      onHandR: num(r.onHandR) + num(r.onHandPairs),
      onHandL: num(r.onHandL) + num(r.onHandPairs),
      onHandPairs: num(r.onHandPairs),
      addPower: num(r.addCyl) > 0 ? num(r.addCyl) / 100 : null,
      onHand, onOrder: num(r.onOrder), cost,
      stockValue: Math.round(onHand * cost * 100) / 100,
      units,
      lastMoved: r.lastMoved || null,
      treatment,
      treatmentGroup: treatmentGroup(treatment),
      speedClass: speedClassFor(units, thresholds),
      coverMonths: coverMonths(onHand, units, thresholds.windowMonths)
    };
  });
}

/* ─────────── misc items ─────────── */

/**
 * Misc splits into two populations that cannot share a metric.
 *
 * SOLD (Chemistrie clip-ons, snap-ons, magnets, bridges, frames) turn over
 * properly and are measured from invoiced lines — 13,160 lines / 17,869 units
 * over 24 months.
 *
 * CONSUMED (Satisloh parts, lab extras, misc supplies, processes) have no usage
 * record at all: StockUsage carries 18–73 rows PER YEAR for the whole
 * StockItemType=3 population. Innovations was never designed to run stock
 * control over lab consumables. Their rate is therefore a PURCHASING PROXY
 * built from PO receipts, and is labelled as an estimate everywhere it appears.
 *
 * The split is data-driven, not a hard-coded group list: an item that sells is
 * sold, an item that never sells but is bought is consumed. That stays correct
 * as the catalogue changes.
 */
async function loadMiscUniverse(pool, thresholds) {
  const result = await pool.request()
    .input("windowMonths", sql.Int, thresholds.windowMonths)
    .query(`
      WITH sold AS (
        SELECT il.RecordID AS miscItemId, SUM(il.Quantity) AS units,
               COUNT(*) AS lines, MAX(i.InvoiceTime) AS lastSold
        FROM dbo.InvoiceLines il
        INNER JOIN dbo.Invoices i ON i.InvoiceID = il.InvoiceID
        WHERE il.CategoryType = 9
          AND i.InvoiceTime >= DATEADD(month, -@windowMonths, GETDATE())
        GROUP BY il.RecordID
      ),
      received AS (
        SELECT si.MiscItemID AS miscItemId, SUM(rd.QtyAccepted) AS units,
               COUNT(*) AS receipts, MAX(rd.ReceiveDate) AS lastReceived
        FROM dbo.POReceiptDetails rd
        INNER JOIN dbo.POItems pi ON pi.POItemID = rd.POItemID
        INNER JOIN dbo.StockItems si ON si.StockItemID = pi.StockItemID
        WHERE si.StockItemType = 3 AND si.MiscItemID IS NOT NULL
          AND rd.ReceiveDate >= DATEADD(month, -@windowMonths, GETDATE())
        GROUP BY si.MiscItemID
      ),
      counted AS (
        SELECT si.MiscItemID AS miscItemId, MAX(cc.EndDate) AS lastCounted
        FROM dbo.CycleCountItems cci
        INNER JOIN dbo.CycleCounts cc ON cc.CycleCountID = cci.CycleCountID
        INNER JOIN dbo.StockItems si ON si.StockItemID = cci.StockItemID
        WHERE si.StockItemType = 3 AND si.MiscItemID IS NOT NULL AND cc.EndDate IS NOT NULL
        GROUP BY si.MiscItemID
      )
      SELECT
        m.MiscItemID AS miscItemId, m.SKU AS sku, m.Desc1 AS description,
        m.Cost AS cost, m.Price AS price, m.OnHand AS onHand, m.OnOrder AS onOrder,
        m.Flags AS flags,
        g.MiscItemGroupName AS groupName,
        ISNULL(s.units, 0) AS soldUnits, ISNULL(s.lines, 0) AS soldLines, s.lastSold,
        ISNULL(r.units, 0) AS receivedUnits, ISNULL(r.receipts, 0) AS receipts, r.lastReceived,
        c.lastCounted
      FROM dbo.MiscItems m
      LEFT JOIN dbo.MiscItemGroups g ON g.MiscItemGroupID = m.MiscItemGroupID
      LEFT JOIN sold s ON s.miscItemId = m.MiscItemID
      LEFT JOIN received r ON r.miscItemId = m.MiscItemID
      LEFT JOIN counted c ON c.miscItemId = m.MiscItemID
      WHERE m.OnHand <> 0 OR s.miscItemId IS NOT NULL OR r.miscItemId IS NOT NULL;
    `);

  return result.recordset.map((r) => {
    const onHand = num(r.onHand);
    const soldUnits = num(r.soldUnits);
    const receivedUnits = num(r.receivedUnits);
    const cost = num(r.cost);
    // Three populations, not two. Sold items get a true velocity; consumed
    // items only ever get a purchasing proxy; and items with NEITHER sales nor
    // receipts are dormant — filing those under "consumed" would report stock
    // as being used up when nothing has touched it at all.
    const isSold = soldUnits > 0;
    const panel = isSold ? "sold" : (receivedUnits > 0 ? "consumed" : "dormant");
    const rateUnits = isSold ? soldUnits : receivedUnits;

    return {
      key: String(r.miscItemId),
      miscItemId: r.miscItemId,
      sku: r.sku,
      label: r.description || r.sku || `Misc item ${r.miscItemId}`,
      groupName: r.groupName || "(no group)",
      panel,
      isActive: (num(r.flags) & 2) === 0,
      onHand, onOrder: num(r.onOrder), cost, price: num(r.price),
      stockValue: Math.round(onHand * cost * 100) / 100,
      soldUnits, soldLines: num(r.soldLines), lastSold: r.lastSold || null,
      receivedUnits, receipts: num(r.receipts), lastReceived: r.lastReceived || null,
      lastCounted: r.lastCounted || null,
      units: rateUnits,
      basis: isSold ? "invoiced" : "purchase_proxy",
      speedClass: speedClassFor(rateUnits, thresholds),
      coverMonths: coverMonths(onHand, rateUnits, thresholds.windowMonths)
    };
  });
}

/* ─────────── aggregation ─────────── */

function summariseBySpeed(items) {
  const bands = SPEED_CLASSES.map((cls) => ({
    speedClass: cls,
    label: SPEED_LABELS[cls],
    items: 0, onHand: 0, stockValue: 0, units: 0
  }));
  const index = Object.fromEntries(bands.map((b) => [b.speedClass, b]));

  for (const item of items) {
    const band = index[item.speedClass];
    band.items += 1;
    band.onHand += item.onHand;
    band.stockValue += item.stockValue;
    band.units += item.units;
  }

  for (const band of bands) band.stockValue = Math.round(band.stockValue * 100) / 100;
  return bands;
}

function summariseByKey(items, keyFn, labelKey) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) {
      map.set(key, {
        [labelKey]: key, items: 0, onHand: 0, stockValue: 0, units: 0,
        nonMovers: 0, nonMoverValue: 0
      });
    }
    const row = map.get(key);
    row.items += 1;
    row.onHand += item.onHand;
    row.stockValue += item.stockValue;
    row.units += item.units;
    if (item.speedClass === "non_mover") {
      row.nonMovers += 1;
      row.nonMoverValue += item.stockValue;
    }
  }

  return [...map.values()]
    .map((r) => ({
      ...r,
      stockValue: Math.round(r.stockValue * 100) / 100,
      nonMoverValue: Math.round(r.nonMoverValue * 100) / 100,
      // Annualised turns: how many times this group's stock turned over.
      turnRate: r.onHand > 0 ? Math.round((r.units / r.onHand) * 100) / 100 : null
    }))
    .sort((a, b) => b.stockValue - a.stockValue);
}

/**
 * Exceptions, after overrides. Suppressed rows stay in the payload — with the
 * reason that silenced them — so an override reads as an annotation rather than
 * a disappearance.
 */
function collectExceptions(lensItems, miscItems, overrides) {
  const negative = [];
  const zeroCost = [];
  const suppressed = [];

  const consider = (item, kind) => {
    if (item.onHand < 0) {
      const sup = isSuppressed(overrides, kind, item.key, "negative_qty", item);
      (sup ? suppressed : negative).push({ ...item, kind, alertKind: "negative_qty" });
    }
    if (item.onHand !== 0 && item.cost <= 0) {
      const sup = isSuppressed(overrides, kind, item.key, "zero_cost", item);
      (sup ? suppressed : zeroCost).push({ ...item, kind, alertKind: "zero_cost" });
    }
  };

  for (const item of lensItems) if (item.onHand !== 0) consider(item, "lens");
  for (const item of miscItems) if (item.onHand !== 0 && item.isActive) consider(item, "misc");

  const sumValue = (rows) => Math.round(rows.reduce((t, r) => t + Math.abs(r.stockValue), 0) * 100) / 100;

  return {
    negative: {
      count: negative.length,
      units: negative.reduce((t, r) => t + r.onHand, 0),
      value: sumValue(negative),
      rows: negative.sort((a, b) => a.onHand - b.onHand)
    },
    zeroCost: {
      count: zeroCost.length,
      units: zeroCost.reduce((t, r) => t + r.onHand, 0),
      rows: zeroCost.sort((a, b) => b.onHand - a.onHand)
    },
    suppressed: { count: suppressed.length, rows: suppressed }
  };
}

/* ─────────── universe cache ─────────── */

// Building the universe costs ~3.3s and hits LensItem (1.5M rows) plus 24 months
// of RxArchive. A drill-down asks the same question the tab just asked, so it
// reuses the answer instead of re-running the scan. Short enough that a stock
// correction shows up on the next refresh.
const UNIVERSE_TTL_MS = 60000;
let universeCache = null;

async function getUniverse({ force = false } = {}) {
  if (!force && universeCache && Date.now() - universeCache.at < UNIVERSE_TTL_MS) {
    return universeCache.value;
  }

  const thresholds = await loadThresholds();
  const [pool, overrides] = await Promise.all([getLiveSourcePool(), loadOverrides()]);
  const [lensItems, miscItems] = await Promise.all([
    loadLensUniverse(pool, thresholds),
    loadMiscUniverse(pool, thresholds)
  ]);

  const value = { thresholds, overrides, lensItems, miscItems };
  universeCache = { at: Date.now(), value };
  return value;
}

function invalidateUniverse() { universeCache = null; }

// Phase 2 analytics are cached separately and served as their own section. The
// add-power trends cost ~8.4s (the six-part-key join from RxArchive to
// LensItem), so folding them into the main payload would triple time-to-first-
// paint on a tab whose headline numbers are ready in ~3s.
const TRENDS_TTL_MS = 300000;
let trendsCache = null;

async function getInventoryTrendsSection() {
  if (trendsCache && Date.now() - trendsCache.at < TRENDS_TTL_MS) return trendsCache.value;

  const thresholds = await loadThresholds();
  const { getAddPowerTrends } = require("./inventory-trends");
  const { getChannelSplits } = require("./inventory-channels");

  const [addPowers, channels] = await Promise.all([
    getAddPowerTrends(thresholds.windowMonths),
    getChannelSplits(thresholds.windowMonths)
  ]);

  const value = {
    thresholds,
    generatedAt: new Date().toISOString(),
    addPowers,
    channels,
    caveats: [
      `Add-power channels are normalised to their own monthly totals. "Sold as stock" is roughly 2% the size of "Prescribed" (${addPowers.channels.stockSold.byType.Progressive.total} vs ${addPowers.channels.prescribed.byType.Progressive.total} progressive units), so raw counts would render it as a flat line at the axis.`,
      `Trend slope is percentage points of share per month, used only to rank adds as rising or falling. It is a direction, not a forecast.`,
      `"Consumed from stock" counts only jobs that carry a lens-item reference (~63% of jobs), so it is lower than "Prescribed" by construction — compare shapes and shares, not absolute totals, between channels.`,
      `Export is classified by shipping method: the actual shipment's method where one exists, otherwise the customer's default, otherwise country. ShippingCarrierID is NOT used — the local delivery van carries DHL's carrier id.`,
      `Outsourcing excludes "No Lab Selected", which is a placeholder rather than a decision. "Customer Lens Edge" is customer-supplied edging and is reported separately so it can be excluded if you do not count it as outsourcing.`
    ]
  };

  trendsCache = { at: Date.now(), value };
  return value;
}

/* ─────────── public entry point ─────────── */

async function getInventorySection() {
  const { thresholds, overrides, lensItems, miscItems } = await getUniverse();

  const stocked = lensItems.filter((i) => i.onHand > 0);
  const totalValue = Math.round(stocked.reduce((t, i) => t + i.stockValue, 0) * 100) / 100;
  const speedBands = summariseBySpeed(lensItems);
  const nonMoverBand = speedBands.find((b) => b.speedClass === "non_mover");

  const soldMisc = miscItems.filter((i) => i.panel === "sold");
  const consumedMisc = miscItems.filter((i) => i.panel === "consumed");
  const dormantMisc = miscItems.filter((i) => i.panel === "dormant");

  return {
    thresholds,
    generatedAt: new Date().toISOString(),

    headline: {
      trackedItems: lensItems.length,
      stockedItems: stocked.length,
      totalOnHand: stocked.reduce((t, i) => t + i.onHand, 0),
      totalStockValue: totalValue,
      nonMoverItems: nonMoverBand.items,
      nonMoverValue: nonMoverBand.stockValue,
      nonMoverShareOfValue: totalValue > 0
        ? Math.round((nonMoverBand.stockValue / totalValue) * 1000) / 10
        : 0,
      unitsMoved: lensItems.reduce((t, i) => t + i.units, 0)
    },

    speedBands,
    byTreatment: summariseByKey(lensItems, (i) => i.treatmentGroup, "treatmentGroup"),
    byTreatmentDetail: summariseByKey(lensItems, (i) => i.treatment || "Unclassified", "treatment"),
    byMaterial: summariseByKey(lensItems, (i) => i.materialName || "(unknown)", "materialName"),

    misc: {
      sold: {
        basis: "invoiced",
        items: soldMisc.length,
        units: soldMisc.reduce((t, i) => t + i.soldUnits, 0),
        stockValue: Math.round(soldMisc.reduce((t, i) => t + i.stockValue, 0) * 100) / 100,
        byGroup: summariseByKey(soldMisc, (i) => i.groupName, "groupName")
      },
      consumed: {
        basis: "purchase_proxy",
        items: consumedMisc.length,
        receivedUnits: consumedMisc.reduce((t, i) => t + i.receivedUnits, 0),
        stockValue: Math.round(consumedMisc.reduce((t, i) => t + i.stockValue, 0) * 100) / 100,
        byGroup: summariseByKey(consumedMisc, (i) => i.groupName, "groupName")
      },
      // Neither sold nor bought in the window: nothing has touched these.
      dormant: {
        basis: "no_activity",
        items: dormantMisc.length,
        stockValue: Math.round(dormantMisc.reduce((t, i) => t + i.stockValue, 0) * 100) / 100,
        byGroup: summariseByKey(dormantMisc, (i) => i.groupName, "groupName")
      }
    },

    exceptions: collectExceptions(lensItems, miscItems, overrides),
    overridesActive: overrides.total,

    // Travels with the numbers so a reader — human or model — cannot take them
    // for more than they are.
    caveats: [
      `Lens velocity is derived from RxArchive job history. Only ~63% of jobs carry a lens-item reference, so units moved undercount by roughly a third, unevenly across items.`,
      `Stock control was switched on in 2025 (${STOCK_CONTROL_EPOCH}): lens cycle counts start that year and StockUsage jumps from 7,602 to 71,657 rows against flat job volume. This does NOT affect the velocity figures here, which come from RxArchive job history (dense back to 2017) — it means STOCK-LEVEL history before 2025 is catalogue history, not inventory history.`,
      `On-hand quantity has no history in the source: LensItem.OnHand_* is a current value overwritten in place. Cover-over-time is therefore only available from the first captured snapshot onward, not backdated.`,
      `StockTransactions is not used for consumption: it recorded 93 "Rx Usage" rows in 12 months and its quantity signs are inconsistent.`,
      `Misc "consumed" items have no usage record in Innovations. Their rate is a purchasing proxy from PO receipts, not measured consumption.`,
      `Cover is null, not infinite, where nothing moved — months of supply is undefined for a non-mover.`
    ],
    window: {
      months: thresholds.windowMonths,
      stockControlEpoch: STOCK_CONTROL_EPOCH
    }
  };
}

/* ─────────── dashboard counters ─────────── */

/**
 * Just the two exception counts, for the front dashboard.
 *
 * Deliberately NOT built on getUniverse(): that costs ~3.3s cold because it
 * scans LensItem and 24 months of RxArchive, and the dashboard is the landing
 * page. This is two aggregates over indexed columns instead.
 *
 * Overrides are applied by subtracting the suppressed rows that would have
 * counted, so the tile agrees with the Inventory tab rather than quietly
 * disagreeing with it.
 */
async function getInventoryExceptionCounts() {
  const [pool, overrides] = await Promise.all([getLiveSourcePool(), loadOverrides()]);

  const result = await pool.request().query(`
    SELECT
      SUM(CASE WHEN (li.OnHand_R + li.OnHand_L + li.OnHand_P * 2) < 0 THEN 1 ELSE 0 END) AS negItems,
      SUM(CASE WHEN (li.OnHand_R + li.OnHand_L + li.OnHand_P * 2) < 0
               THEN (li.OnHand_R + li.OnHand_L + li.OnHand_P * 2) ELSE 0 END) AS negUnits,
      SUM(CASE WHEN (li.OnHand_R + li.OnHand_L + li.OnHand_P * 2) < 0
               THEN (li.OnHand_R + li.OnHand_L + li.OnHand_P * 2) * ISNULL(li.Cost, 0) ELSE 0 END) AS negValue,
      SUM(CASE WHEN (li.OnHand_R + li.OnHand_L + li.OnHand_P * 2) <> 0
                AND (li.Cost IS NULL OR li.Cost <= 0) THEN 1 ELSE 0 END) AS zeroCostItems
    FROM dbo.LensItem li
    WHERE li.Flags & 2 = 0;

    SELECT
      SUM(CASE WHEN m.OnHand < 0 THEN 1 ELSE 0 END) AS negItems,
      SUM(CASE WHEN m.OnHand < 0 THEN m.OnHand ELSE 0 END) AS negUnits,
      SUM(CASE WHEN m.OnHand < 0 THEN m.OnHand * ISNULL(m.Cost, 0) ELSE 0 END) AS negValue,
      SUM(CASE WHEN m.OnHand <> 0 AND (m.Cost IS NULL OR m.Cost <= 0) THEN 1 ELSE 0 END) AS zeroCostItems
    FROM dbo.MiscItems m
    WHERE m.Flags & 2 = 0;
  `);

  const lens = result.recordsets[0][0] || {};
  const misc = result.recordsets[1][0] || {};

  // Overrides are few (tens at most), so counting them here is cheaper than
  // re-deriving the exception sets.
  let suppressedNegative = 0;
  let suppressedZeroCost = 0;
  for (const map of [overrides.lens, overrides.misc]) {
    for (const key of map.keys()) {
      if (key.endsWith("|negative_qty") || key.endsWith("|all")) suppressedNegative += 1;
      if (key.endsWith("|zero_cost") || key.endsWith("|all")) suppressedZeroCost += 1;
    }
  }

  const negativeCount = Math.max(0, num(lens.negItems) + num(misc.negItems) - suppressedNegative);
  const zeroCostCount = Math.max(0, num(lens.zeroCostItems) + num(misc.zeroCostItems) - suppressedZeroCost);

  return {
    negativeCount,
    negativeUnits: num(lens.negUnits) + num(misc.negUnits),
    negativeValue: Math.round((Math.abs(num(lens.negValue)) + Math.abs(num(misc.negValue))) * 100) / 100,
    zeroCostCount,
    suppressed: suppressedNegative + suppressedZeroCost
  };
}

/* ─────────── drills ─────────── */

// Column sets shared by the lens drills, so every list reads the same way.
const LENS_COLUMNS = [
  { key: "label", label: "Item", format: "text" },
  { key: "skuR", label: "OPC R", format: "text" },
  { key: "skuL", label: "OPC L", format: "text" },
  { key: "treatment", label: "Treatment", format: "text" },
  { key: "onHandR", label: "On hand R", format: "int", align: "right" },
  { key: "onHandL", label: "On hand L", format: "int", align: "right" },
  { key: "units", label: "Units moved", format: "int", align: "right" },
  { key: "coverMonths", label: "Cover (mo)", format: "text", align: "right" },
  { key: "cost", label: "Unit cost", format: "money", align: "right" },
  { key: "stockValue", label: "Stock value", format: "money", align: "right" },
  { key: "lastMoved", label: "Last moved", format: "date", align: "right" }
];

const MISC_COLUMNS = [
  { key: "label", label: "Item", format: "text" },
  { key: "sku", label: "SKU", format: "text" },
  { key: "groupName", label: "Group", format: "text" },
  { key: "onHand", label: "On hand", format: "int", align: "right" },
  { key: "units", label: "Units", format: "int", align: "right" },
  { key: "coverMonths", label: "Cover (mo)", format: "text", align: "right" },
  { key: "stockValue", label: "Stock value", format: "money", align: "right" }
];

// Exception and suppression drawers mix lenses and misc stock. Keep the lens
// identifiers and per-eye quantities visible on every lens row; misc rows
// intentionally render dashes in these fields because they have one SKU and
// one on-hand quantity rather than right/left stock.
const EXCEPTION_COLUMNS = [
  { key: "kind", label: "Type", format: "text" },
  { key: "label", label: "Item", format: "text" },
  { key: "skuR", label: "OPC R", format: "text" },
  { key: "skuL", label: "OPC L", format: "text" },
  { key: "onHandR", label: "On hand R", format: "int", align: "right" },
  { key: "onHandL", label: "On hand L", format: "int", align: "right" },
  { key: "onHand", label: "Total", format: "int", align: "right" }
];

const DRILL_ROW_LIMIT = 500;

function lensRows(items) {
  return items.map((i) => ({
    ...i,
    coverMonths: i.coverMonths == null ? "—" : i.coverMonths,
    treatment: i.treatment || "Unclassified"
  }));
}

function truncate(rows, subtitle) {
  if (rows.length <= DRILL_ROW_LIMIT) return { rows, subtitle };
  // Never silently cut a list — say what was dropped and how to get it all.
  return {
    rows: rows.slice(0, DRILL_ROW_LIMIT),
    subtitle: `${subtitle} · showing top ${DRILL_ROW_LIMIT} of ${rows.length} by value — export CSV for all`
  };
}

const INVENTORY_DRILLS = {
  /** Items in one speed class, worst value exposure first. */
  async "inventory-speed"(params) {
    const cls = String(params.class || "non_mover");
    if (!SPEED_CLASSES.includes(cls)) {
      throw Object.assign(new Error(`Unknown speed class "${cls}".`), { statusCode: 400 });
    }

    const { lensItems, thresholds } = await getUniverse();
    const matched = lensItems
      .filter((i) => i.speedClass === cls)
      .sort((a, b) => b.stockValue - a.stockValue);

    const { rows, subtitle } = truncate(
      lensRows(matched),
      `${thresholds.windowMonths}-month window`
    );

    return {
      title: `${SPEED_LABELS[cls]} lens items`,
      subtitle,
      summary: [
        { label: "Items", value: matched.length, format: "int" },
        { label: "On hand", value: matched.reduce((t, i) => t + i.onHand, 0), format: "int" },
        { label: "Stock value", value: matched.reduce((t, i) => t + i.stockValue, 0), format: "money" },
        { label: "Units moved", value: matched.reduce((t, i) => t + i.units, 0), format: "int" }
      ],
      columns: LENS_COLUMNS,
      rows
    };
  },

  /** One treatment group — Clear / Photochromic / Polarized / Other / Unclassified. */
  async "inventory-treatment"(params) {
    const group = String(params.group || "");
    const { lensItems, thresholds } = await getUniverse();
    const matched = lensItems
      .filter((i) => i.treatmentGroup === group)
      .sort((a, b) => b.stockValue - a.stockValue);

    const { rows, subtitle } = truncate(
      lensRows(matched),
      `${thresholds.windowMonths}-month window`
    );

    return {
      title: `${group} lenses`,
      subtitle,
      summary: [
        { label: "Items", value: matched.length, format: "int" },
        { label: "Stock value", value: matched.reduce((t, i) => t + i.stockValue, 0), format: "money" },
        { label: "Non-movers", value: matched.filter((i) => i.speedClass === "non_mover").length, format: "int" }
      ],
      columns: LENS_COLUMNS,
      rows
    };
  },

  /** Active SKUs holding negative stock — a count problem, not a buying problem. */
  async "inventory-negative"() {
    const { lensItems, miscItems, overrides } = await getUniverse();
    const ex = collectExceptions(lensItems, miscItems, overrides);

    return {
      title: "Negative on-hand quantity",
      subtitle: "Active SKUs recording less than zero stock — correct by physical count before any purchasing or disposal decision",
      summary: [
        { label: "Items", value: ex.negative.count, format: "int" },
        { label: "Units", value: ex.negative.units, format: "int" },
        { label: "Value exposed", value: ex.negative.value, format: "money" }
      ],
      columns: [
        ...EXCEPTION_COLUMNS,
        { key: "cost", label: "Unit cost", format: "money", align: "right" },
        { key: "stockValue", label: "Value", format: "money", align: "right" }
      ],
      rows: ex.negative.rows
    };
  },

  /** Active SKUs carrying stock at zero cost — they record no COGS when used. */
  async "inventory-zero-cost"() {
    const { lensItems, miscItems, overrides } = await getUniverse();
    const ex = collectExceptions(lensItems, miscItems, overrides);

    return {
      title: "Zero-cost stock",
      subtitle: "Active SKUs holding quantity at zero cost — these record no COGS when used, silently inflating margin. Written-off stock deliberately held at zero cost can be suppressed with a reason.",
      summary: [
        { label: "Items", value: ex.zeroCost.count, format: "int" },
        { label: "Units", value: ex.zeroCost.units, format: "int" },
        { label: "Suppressed", value: ex.suppressed.count, format: "int" }
      ],
      columns: [
        ...EXCEPTION_COLUMNS,
        { key: "units", label: "Units moved", format: "int", align: "right" },
        { key: "lastMoved", label: "Last moved", format: "date", align: "right" }
      ],
      rows: ex.zeroCost.rows
    };
  },

  /** Overridden items — visible, with the reason that silenced them. */
  async "inventory-suppressed"() {
    const { lensItems, miscItems, overrides } = await getUniverse();
    const ex = collectExceptions(lensItems, miscItems, overrides);
    const byKey = (item) => (item.kind === "lens" ? overrides.lens : overrides.misc);

    const rows = ex.suppressed.rows.map((item) => {
      const skuEntry = [item.sku, item.skuR, item.skuL]
        .map((s) => s && overrides.skuZeroCost.get(String(s).trim().toUpperCase()))
        .find(Boolean);
      const entry = byKey(item).get(item.key + "|" + item.alertKind)
        || byKey(item).get(item.key + "|all") || skuEntry || {};
      return {
        ...item,
        reason: entry.reason || "—",
        suppressedBy: entry.createdBy || "—",
        suppressedAt: entry.createdAt || null
      };
    });

    return {
      title: "Suppressed alerts",
      subtitle: "Items excluded from exception counts by an explicit override. Nothing is hidden — the reason is recorded here.",
      summary: [{ label: "Suppressed", value: rows.length, format: "int" }],
      columns: [
        ...EXCEPTION_COLUMNS,
        { key: "alertKind", label: "Alert", format: "text" },
        { key: "reason", label: "Reason", format: "text" },
        { key: "suppressedBy", label: "By", format: "text" },
        { key: "suppressedAt", label: "When", format: "date", align: "right" }
      ],
      rows,
      emptyText: "No overrides are in place — every exception is counted."
    };
  },

  /** One add power across all three channels plus what is held. */
  async "inventory-add"(params) {
    const addX100 = Number(params.add);
    const mfType = String(params.mf || "Progressive");
    const t = await getInventoryTrendsSection();
    const ap = t.addPowers;

    const find = (channel) => {
      const byType = ap.channels[channel] && ap.channels[channel].byType[mfType];
      return byType ? byType.series.find((s) => s.addX100 === addX100) : null;
    };
    const heldType = ap.held.byType[mfType];
    const heldRow = heldType ? heldType.series.find((s) => s.addX100 === addX100) : null;
    const label = (find("prescribed") || heldRow || {}).label || String(addX100 / 100);

    // One row per month, all channels side by side — the shape a person needs
    // to judge whether the channels agree.
    const rows = ap.months.map((month, i) => ({
      month,
      prescribedShare: pluck(find("prescribed"), "monthlyShare", i),
      consumedShare: pluck(find("consumed"), "monthlyShare", i),
      stockSoldShare: pluck(find("stockSold"), "monthlyShare", i)
    }));

    const gap = (ap.mismatch[mfType] || []).find((m) => m.addX100 === addX100);

    return {
      title: `Add ${label} · ${mfType}`,
      subtitle: `Share of ${mfType.toLowerCase()} volume per month, by channel · ${t.thresholds.windowMonths}-month window`,
      summary: [
        { label: "Prescribed", value: (find("prescribed") || {}).units || 0, format: "int" },
        { label: "Consumed", value: (find("consumed") || {}).units || 0, format: "int" },
        { label: "Sold as stock", value: (find("stockSold") || {}).units || 0, format: "int" },
        { label: "Held", value: heldRow ? heldRow.units : 0, format: "int" },
        ...(gap ? [{ label: "Demand − held", value: gap.gap, format: "text" }] : [])
      ],
      columns: [
        { key: "month", label: "Month", format: "text" },
        { key: "prescribedShare", label: "Prescribed %", format: "text", align: "right" },
        { key: "consumedShare", label: "Consumed %", format: "text", align: "right" },
        { key: "stockSoldShare", label: "Stock sold %", format: "text", align: "right" }
      ],
      rows
    };
  },

  /** Customers behind one export channel. */
  async "inventory-channel"(params) {
    const channel = String(params.channel || "export");
    const t = await getInventoryTrendsSection();
    const rows = t.channels.export.byCountry
      .filter((r) => r.channel === channel)
      .sort((a, b) => b.jobs - a.jobs);

    const LABELS = { export: "Export", local: "Local", unknown: "Unclassified" };
    return {
      title: `${LABELS[channel] || channel} shipments`,
      subtitle: channel === "unknown"
        ? "No shipping method and no country recorded — fix the customer record to classify these"
        : `Classified by shipping method, falling back to customer default then country · ${t.thresholds.windowMonths}-month window`,
      summary: [
        { label: "Jobs", value: rows.reduce((s, r) => s + r.jobs, 0), format: "int" },
        { label: "Lenses", value: rows.reduce((s, r) => s + r.lensUnits, 0), format: "int" },
        { label: "Revenue", value: rows.reduce((s, r) => s + r.revenue, 0), format: "money" }
      ],
      columns: [
        { key: "countryName", label: "Country", format: "text" },
        { key: "customers", label: "Customers", format: "int", align: "right" },
        { key: "jobs", label: "Jobs", format: "int", align: "right" },
        { key: "lensUnits", label: "Lenses", format: "int", align: "right" },
        { key: "revenue", label: "Revenue", format: "money", align: "right" }
      ],
      rows,
      emptyText: "No orders fell into this channel."
    };
  },

  /** Labs behind the outsourced split. */
  async "inventory-fulfilment"(params) {
    const kind = params.kind === "in_house" ? "in_house" : "outsourced";
    const t = await getInventoryTrendsSection();
    const fu = t.channels.fulfilment;

    if (kind === "in_house") {
      const row = fu.rows.find((r) => r.fulfilment === "in_house") || {};
      return {
        title: "In-house production",
        subtitle: `Jobs with no active farmout · ${t.thresholds.windowMonths}-month window`,
        summary: [
          { label: "Jobs", value: row.jobs || 0, format: "int" },
          { label: "Lenses", value: row.lensUnits || 0, format: "int" },
          { label: "Revenue", value: row.revenue || 0, format: "money" }
        ],
        columns: [{ key: "note", label: "Note", format: "text" }],
        rows: [{
          note: `${row.jobs || 0} jobs produced in-house (${row.jobShare || 0}% of all jobs). ` +
                `"No Lab Selected" farmout rows count as in-house — they are a placeholder, not an outsourcing decision.`
        }]
      };
    }

    return {
      title: "Outsourced jobs by lab",
      subtitle: `Farmouts.LabID joined to Labs.num · excludes "No Lab Selected" · ${t.thresholds.windowMonths}-month window`,
      summary: [
        { label: "Labs", value: fu.byLab.length, format: "int" },
        { label: "Jobs", value: fu.byLab.reduce((s, r) => s + r.jobs, 0), format: "int" },
        { label: "Revenue", value: fu.byLab.reduce((s, r) => s + r.revenue, 0), format: "money" }
      ],
      columns: [
        { key: "labName", label: "Lab", format: "text" },
        { key: "jobs", label: "Jobs", format: "int", align: "right" },
        { key: "jobShare", label: "% of all jobs", format: "pct", align: "right" },
        { key: "lensUnits", label: "Lenses", format: "int", align: "right" },
        { key: "revenue", label: "Revenue", format: "money", align: "right" }
      ],
      rows: fu.byLab
    };
  },

  /** Misc items, split by whether they are sold or internally consumed. */
  async "inventory-misc"(params) {
    const requested = String(params.panel || "sold");
    const panel = ["sold", "consumed", "dormant"].includes(requested) ? requested : "sold";
    const { miscItems, thresholds } = await getUniverse();
    const matched = miscItems
      .filter((i) => i.panel === panel)
      .sort((a, b) => b.stockValue - a.stockValue)
      .map((i) => ({ ...i, coverMonths: i.coverMonths == null ? "—" : i.coverMonths }));

    const sold = panel === "sold";
    const TITLES = {
      sold: "Misc items sold",
      consumed: "Misc items consumed",
      dormant: "Misc items with no activity"
    };
    const SUBTITLES = {
      sold: `Turn measured from invoiced lines · ${thresholds.windowMonths}-month window`,
      consumed: `PURCHASING PROXY — Innovations records no usage for these. Rate is PO receipts, not measured consumption · ${thresholds.windowMonths}-month window`,
      dormant: `Neither sold nor purchased in the last ${thresholds.windowMonths} months — capital sitting still`
    };

    return {
      title: TITLES[panel],
      subtitle: SUBTITLES[panel],
      summary: [
        { label: "Items", value: matched.length, format: "int" },
        panel === "dormant"
          ? { label: "On hand", value: matched.reduce((t, i) => t + i.onHand, 0), format: "int" }
          : { label: sold ? "Units sold" : "Units received",
              value: matched.reduce((t, i) => t + (sold ? i.soldUnits : i.receivedUnits), 0), format: "int" },
        { label: "Stock value", value: matched.reduce((t, i) => t + i.stockValue, 0), format: "money" }
      ],
      columns: MISC_COLUMNS,
      rows: matched
    };
  }
};

module.exports = {
  getInventorySection,
  getInventoryTrendsSection,
  getInventoryExceptionCounts,
  INVENTORY_DRILLS,
  getUniverse,
  invalidateUniverse,
  loadThresholds,
  loadOverrides,
  loadLensUniverse,
  loadMiscUniverse,
  speedClassFor,
  coverMonths,
  lensKeyOf,
  SPEED_CLASSES,
  SPEED_LABELS,
  STOCK_CONTROL_EPOCH,
  DEFAULT_THRESHOLDS
};
