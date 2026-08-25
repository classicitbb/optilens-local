// Supplier cost list conformance — read-only.
//
// Lens costs are supposed to come from supplier cost lists: dbo.PriceLists rows with
// PricelistGroup = 1, one per lab. The mechanism is right but the data is largely
// missing — most lists are empty or a fraction of what a complete one looks like.
//
// This module measures every supplier cost list against a reference list (the "Costing
// Template") and reports the gap, so someone can fill it in Innovations. It NEVER
// writes to the source.
//
// UNITS. Cost list values are PER EYE, in USD. catalog-rows.generated.json is PER PAIR
// (see the "per pair" comment in lib/pricing-engine.js landedCostFor), so suggested
// costs are halved. Both figures are returned so an operator can check rather than
// trust — a units error here is a silent 2x and looks entirely plausible.
//
// PROFILE. The pricelist tables are queried directly from Innovations MSSQL because
// them). On the mirror profile this returns a clear explanation instead of a SQL error.

const fs = require("fs");
const path = require("path");
const sql = require("mssql");
const { getSourcePool, checkSourceDatabase, getActiveSourceProfile } = require("../db");

/**
 * The reference list every other supplier cost list is measured against.
 * Pinned by id, not name: this list was called "CODEX TEST ACTIAN 20260720" until it was
 * renamed "Costing Template". It is Vision Rx Lab's cost list.
 */
const TEMPLATE_PRICE_LIST_ID = 125;

const SUPPLIER_COST_GROUP = 1; // PriceLists.PricelistGroup: 0 = selling, 1 = supplier cost
const STALE_AFTER_DAYS = 365;
const QUERY_TIMEOUT_MS = 20000;

const CHECKS = {
  "no-sheets": "Active cost list with no price sheets at all",
  "no-costs": "Active cost list with sheets but no priced rows",
  stale: `Cost list not updated in over ${STALE_AFTER_DAYS} days`,
  "duplicate-name": "Two active cost lists share a name, so which one governs is ambiguous",
  "unlisted-lab": "Lab we actively farm out to has no supplier cost list"
};

let crosswalkCache = null;

function loadCrosswalk() {
  if (crosswalkCache) return crosswalkCache;
  // Lives beside this module, not under data/, because .gitignore excludes data/* —
  // a hand-maintained mapping kept there would never reach the host, and the report
  // would silently show no suggested costs at all.
  const file = path.join(__dirname, "supplier-costlist-crosswalk.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    crosswalkCache = new Map((parsed.lists || []).map((r) => [Number(r.priceListId), r]));
  } catch {
    crosswalkCache = new Map();
  }
  return crosswalkCache;
}

let catalogueCache = null;

/** Supplier costs from the spreadsheet-derived catalogue, keyed for lookup. PER PAIR. */
function loadCatalogue() {
  if (catalogueCache) return catalogueCache;
  const file = path.join(__dirname, "..", "..", "data", "pricelist", "catalog-rows.generated.json");
  catalogueCache = new Map();
  try {
    for (const row of JSON.parse(fs.readFileSync(file, "utf8"))) {
      if (!row || row.active === false) continue;
      const key = catalogueKey(row.supplier, row.material, row.mftype, row.lenstype);
      const cost = Number(row.cost);
      if (!key || !Number.isFinite(cost) || cost <= 0) continue;
      // Keep the cheapest when a supplier quotes the same combo more than once.
      const existing = catalogueCache.get(key);
      if (!existing || cost < existing.perPairCost) {
        catalogueCache.set(key, { perPairCost: cost, name: row.name });
      }
    }
  } catch {
    /* catalogue is optional — the report degrades to "no suggestion" */
  }
  return catalogueCache;
}

function norm(value) {
  return String(value == null ? "" : value).trim().toLowerCase().replace(/\s+/g, " ");
}

// Words that appear in almost every lab / price list name and so carry no identifying
// signal. Without stripping these, "Essilor Lab" would match "Skylab - Labtech Prices".
const GENERIC_NAME_WORDS = new Set([
  "lab", "labs", "laboratory", "laboratories", "group", "inc", "ltd", "llc", "co",
  "price", "prices", "pricelist", "list", "cost", "costs", "costing", "stock",
  "finished", "uncut", "uncuts", "template", "usd", "the", "and", "rx",
  // Industry filler. Without these, "Value Optical Ltd" matches "Thai Optical Lab"
  // on the word "optical" and a lab with no cost list is silently treated as covered.
  "optical", "optics", "vision", "visions", "lens", "lenses", "eyewear", "eye"
]);

/** Distinctive words in a supplier or lab name, for cross-vocabulary matching. */
function coreTokens(value) {
  const tokens = norm(value)
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 2 && !GENERIC_NAME_WORDS.has(t) && !/^\d+$/.test(t));
  return new Set(tokens);
}

function catalogueKey(supplier, material, mfType, lensType) {
  if (!supplier || !material) return null;
  return [norm(supplier), norm(material), norm(mfType), norm(lensType)].join("|");
}

/* ─────────── SQL builders (exported so they can be asserted without a database) ─────────── */

/** Names for the grid attribute tuple. Composite keys — never join on a single num. */
function attributeJoins(alias) {
  return `
    LEFT JOIN dbo.Materials m
      ON m.MtrlNum = ${alias}.MaterialNum AND m.GroupNum = ${alias}.MaterialGroupNum
    LEFT JOIN dbo.MFTypes mf
      ON mf.MFNum = ${alias}.MFTypeNum AND mf.MtrlNum = ${alias}.MaterialNum
     AND mf.GroupNum = ${alias}.MaterialGroupNum
    LEFT JOIN dbo.LensType lt
      ON lt.Lnum = ${alias}.LensTypeNum AND lt.MFnum = ${alias}.MFTypeNum
     AND lt.Matlnum = ${alias}.MaterialNum AND lt.Groupnum = ${alias}.MaterialGroupNum
    LEFT JOIN dbo.LensOptions lo
      ON lo.Num = ${alias}.LensOptionNum AND lo.Lnum = ${alias}.LensTypeNum
     AND lo.MFnum = ${alias}.MFTypeNum AND lo.Matlnum = ${alias}.MaterialNum
     AND lo.Groupnum = ${alias}.MaterialGroupNum`;
}

/**
 * Per-list conformance against the template's distinct grid tuples.
 * Matching is on the attribute tuple, not the sheet name — sheet naming is inconsistent
 * (the template's "Bifocal - MF" sheet contains Progressive rows).
 */
function buildConformanceQuery() {
  return `
    WITH template_cells AS (
      SELECT DISTINCT i.MaterialGroupNum, i.MaterialNum, i.MFTypeNum, i.LensTypeNum, i.LensOptionNum
      FROM dbo.PriceRxPOSItems i
      INNER JOIN dbo.PriceRxPOSSheets s ON s.PriceRxPOSSheetID = i.PriceRxPOSSheetID
      WHERE s.PriceListID = @templateId AND i.Price > 0
    ),
    list_cells AS (
      SELECT s.PriceListID,
             i.MaterialGroupNum, i.MaterialNum, i.MFTypeNum, i.LensTypeNum, i.LensOptionNum,
             MAX(i.Price) AS price, MAX(i.LastUpdated) AS lastUpdated
      FROM dbo.PriceRxPOSItems i
      INNER JOIN dbo.PriceRxPOSSheets s ON s.PriceRxPOSSheetID = i.PriceRxPOSSheetID
      GROUP BY s.PriceListID, i.MaterialGroupNum, i.MaterialNum, i.MFTypeNum,
               i.LensTypeNum, i.LensOptionNum
    )
    SELECT
      pl.PriceListID   AS priceListId,
      pl.PriceListName AS priceListName,
      pl.IsActive      AS isActive,
      pl.CurrencyID    AS currencyId,
      (SELECT COUNT(*) FROM template_cells) AS templateCells,
      (SELECT COUNT(DISTINCT s2.PriceRxPOSSheetID)
         FROM dbo.PriceRxPOSSheets s2 WHERE s2.PriceListID = pl.PriceListID) AS sheets,
      ISNULL(SUM(CASE WHEN lc.price > 0 THEN 1 ELSE 0 END), 0) AS cellsPriced,
      ISNULL(SUM(CASE WHEN lc.PriceListID IS NOT NULL AND ISNULL(lc.price, 0) = 0 THEN 1 ELSE 0 END), 0) AS cellsUnpriced,
      (SELECT COUNT(*) FROM list_cells x WHERE x.PriceListID = pl.PriceListID) AS cellsTotalInList,
      (SELECT MAX(x.lastUpdated) FROM list_cells x WHERE x.PriceListID = pl.PriceListID) AS lastUpdated
    FROM dbo.PriceLists pl
    CROSS JOIN template_cells tc
    LEFT JOIN list_cells lc
      ON lc.PriceListID = pl.PriceListID
     AND lc.MaterialGroupNum = tc.MaterialGroupNum
     AND lc.MaterialNum = tc.MaterialNum
     AND lc.MFTypeNum = tc.MFTypeNum
     AND lc.LensTypeNum = tc.LensTypeNum
     AND lc.LensOptionNum = tc.LensOptionNum
    WHERE pl.PricelistGroup = @costGroup
    GROUP BY pl.PriceListID, pl.PriceListName, pl.IsActive, pl.CurrencyID
    ORDER BY cellsPriced DESC, pl.PriceListName;`;
}

/** The template cells a given list is missing, with names resolved for display. */
function buildGapsQuery() {
  return `
    WITH template_cells AS (
      SELECT DISTINCT i.MaterialGroupNum, i.MaterialNum, i.MFTypeNum, i.LensTypeNum,
             i.LensOptionNum, MAX(i.Price) OVER (
               PARTITION BY i.MaterialGroupNum, i.MaterialNum, i.MFTypeNum,
                            i.LensTypeNum, i.LensOptionNum) AS templateCost
      FROM dbo.PriceRxPOSItems i
      INNER JOIN dbo.PriceRxPOSSheets s ON s.PriceRxPOSSheetID = i.PriceRxPOSSheetID
      WHERE s.PriceListID = @templateId AND i.Price > 0
    ),
    list_cells AS (
      SELECT i.MaterialGroupNum, i.MaterialNum, i.MFTypeNum, i.LensTypeNum, i.LensOptionNum,
             MAX(i.Price) AS price
      FROM dbo.PriceRxPOSItems i
      INNER JOIN dbo.PriceRxPOSSheets s ON s.PriceRxPOSSheetID = i.PriceRxPOSSheetID
      WHERE s.PriceListID = @priceListId
      GROUP BY i.MaterialGroupNum, i.MaterialNum, i.MFTypeNum, i.LensTypeNum, i.LensOptionNum
    )
    SELECT TOP (@rowLimit)
      m.Name  AS material,
      mf.Name AS mfType,
      lt.Name AS lensType,
      lo.Name AS lensOption,
      CAST(tc.templateCost AS decimal(18, 2)) AS templateCost,
      CAST(lc.price AS decimal(18, 2))        AS currentCost,
      CASE WHEN lc.MaterialNum IS NULL THEN N'missing' ELSE N'unpriced' END AS gapKind
    FROM template_cells tc
    LEFT JOIN list_cells lc
      ON lc.MaterialGroupNum = tc.MaterialGroupNum
     AND lc.MaterialNum = tc.MaterialNum
     AND lc.MFTypeNum = tc.MFTypeNum
     AND lc.LensTypeNum = tc.LensTypeNum
     AND lc.LensOptionNum = tc.LensOptionNum
    ${attributeJoins("tc")}
    WHERE lc.MaterialNum IS NULL OR ISNULL(lc.price, 0) = 0
    ORDER BY m.Name, mf.Name, lt.Name, lo.Name;`;
}

/** Labs we actually farm out to, so we can spot ones with no cost list. */
function buildFarmoutLabsQuery() {
  return `
    SELECT l.Name AS labName, COUNT(DISTINCT f.OrderID) AS orders,
           MAX(f.TransmitDate) AS lastTransmit
    FROM dbo.Farmouts f
    INNER JOIN dbo.Labs l ON l.num = f.LabID
    WHERE f.TransmitDate >= DATEADD(day, -@lookbackDays, CAST(SYSDATETIME() AS date))
      AND f.Active = 1
    GROUP BY l.Name
    ORDER BY orders DESC;`;
}

/* ─────────── public API ─────────── */

function withTimeout(promise, ms, label) {
  return Promise.race([
    Promise.resolve().then(() => promise),
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { isTimeout: true })), ms)
    )
  ]);
}

/** The pricelist tables are not mirrored, so say so plainly rather than failing on SQL. */
async function assertPricelistsAvailable(pool) {
  const probe = await pool.request().query(
    "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'PriceRxPOSItems'"
  );
  if (Number(probe.recordset[0].n) === 0) {
    const profile = await getActiveSourceProfile();
    const error = new Error(
      `Supplier cost lists are not available on the "${profile}" source profile — the Innovations ` +
      "mirror does not carry the pricelist tables. Switch the source profile to live to use this report."
    );
    error.statusCode = 503;
    throw error;
  }
}

async function getCostListConformance() {
  const generatedAt = new Date().toISOString();
  const source = await checkSourceDatabase();

  if (source.state !== "online") {
    return { generatedAt, online: false, source, error: `Innovations (MSSQL) source is ${source.state}.` };
  }

  try {
    const data = await withTimeout(queryConformance(), QUERY_TIMEOUT_MS, "Cost list conformance query");
    return { generatedAt, online: true, source, currency: "USD", costBasis: "per-eye", ...data };
  } catch (error) {
    return { generatedAt, online: false, source, error: error.message };
  }
}

async function queryConformance() {
  const pool = await getSourcePool();
  await assertPricelistsAvailable(pool);

  const conformance = await pool.request()
    .input("templateId", sql.Int, TEMPLATE_PRICE_LIST_ID)
    .input("costGroup", sql.Int, SUPPLIER_COST_GROUP)
    .query(buildConformanceQuery());

  const labs = await pool.request()
    .input("lookbackDays", sql.Int, STALE_AFTER_DAYS)
    .query(buildFarmoutLabsQuery());

  const crosswalk = loadCrosswalk();
  const rows = conformance.recordset.map((r) => {
    const mapped = crosswalk.get(num(r.priceListId)) || {};
    const templateCells = num(r.templateCells);
    const priced = num(r.cellsPriced);
    return {
      priceListId: num(r.priceListId),
      priceListName: (r.priceListName || "").trim(),
      isActive: Boolean(r.isActive),
      isTemplate: num(r.priceListId) === TEMPLATE_PRICE_LIST_ID,
      currencyId: num(r.currencyId),
      catalogueSupplier: mapped.catalogueSupplier || null,
      sheets: num(r.sheets),
      templateCells,
      cellsPriced: priced,
      cellsMissing: Math.max(0, templateCells - priced),
      cellsTotalInList: num(r.cellsTotalInList),
      coveragePct: templateCells > 0 ? Math.round((priced / templateCells) * 1000) / 10 : null,
      lastUpdated: r.lastUpdated || null,
      status: listStatus(r)
    };
  });

  const template = rows.find((r) => r.isTemplate) || null;

  return {
    templatePriceListId: TEMPLATE_PRICE_LIST_ID,
    template,
    lists: rows,
    exceptions: buildExceptions(rows, labs.recordset, crosswalk),
    checks: Object.keys(CHECKS)
  };
}

function listStatus(row) {
  if (num(row.sheets) === 0) return "no-sheets";
  if (num(row.cellsPriced) === 0) return "no-costs";
  const templateCells = num(row.templateCells);
  const pct = templateCells > 0 ? num(row.cellsPriced) / templateCells : 0;
  if (pct >= 0.9) return "parity";
  return "partial";
}

function buildExceptions(rows, labRows, crosswalk) {
  const out = [];
  const active = rows.filter((r) => r.isActive && !r.isTemplate);

  const noSheets = active.filter((r) => r.status === "no-sheets");
  if (noSheets.length) {
    out.push({
      id: "no-sheets", severity: "critical", count: noSheets.length,
      label: "active lists with no price sheets",
      detail: noSheets.map((r) => r.priceListName).join(", "),
      lists: noSheets.map((r) => r.priceListId)
    });
  }

  const noCosts = active.filter((r) => r.status === "no-costs");
  if (noCosts.length) {
    out.push({
      id: "no-costs", severity: "critical", count: noCosts.length,
      label: "active lists with no priced rows",
      detail: noCosts.map((r) => r.priceListName).join(", "),
      lists: noCosts.map((r) => r.priceListId)
    });
  }

  const cutoff = Date.now() - STALE_AFTER_DAYS * 86400000;
  const stale = active.filter((r) => r.lastUpdated && new Date(r.lastUpdated).getTime() < cutoff);
  if (stale.length) {
    out.push({
      id: "stale", severity: "warning", count: stale.length,
      label: `lists not updated in over ${STALE_AFTER_DAYS} days`,
      detail: stale.map((r) => `${r.priceListName} (${String(r.lastUpdated).slice(0, 10)})`).join(", "),
      lists: stale.map((r) => r.priceListId)
    });
  }

  const byName = new Map();
  active.forEach((r) => {
    const key = r.priceListName.toLowerCase();
    byName.set(key, (byName.get(key) || []).concat(r));
  });
  const dupes = [...byName.values()].filter((g) => g.length > 1);
  if (dupes.length) {
    out.push({
      id: "duplicate-name", severity: "warning", count: dupes.length,
      label: "duplicated cost list names",
      detail: dupes.map((g) => `${g[0].priceListName} (ids ${g.map((x) => x.priceListId).join(", ")})`).join("; "),
      lists: dupes.flat().map((r) => r.priceListId)
    });
  }

  // A lab we send work to with no cost list means those jobs have no costable basis.
  // Matching is on distinctive word overlap, not substrings: the same supplier is
  // "Thai Optical Group" in dbo.Labs and "Thai Optical Lab" as a price list, and neither
  // string contains the other.
  const listed = rows
    .filter((r) => r.isActive)
    .map((r) => coreTokens(`${r.priceListName} ${r.catalogueSupplier || ""}`))
    .filter((t) => t.size > 0);

  const unlisted = (labRows || []).filter((l) => {
    const tokens = coreTokens(l.labName);
    if (tokens.size === 0) return false;
    // Not a supplier — this is work edged in-house for a customer.
    if (norm(l.labName).startsWith("customer lens")) return false;
    return !listed.some((known) => [...tokens].some((t) => known.has(t)));
  });
  if (unlisted.length) {
    out.push({
      id: "unlisted-lab", severity: "warning", count: unlisted.length,
      label: "labs farmed out to with no cost list",
      detail: unlisted.map((l) => `${String(l.labName).trim()} (${num(l.orders)} orders)`).join(", "),
      lists: []
    });
  }

  return out;
}

/** Drill: the template cells one supplier list is missing, with a suggested cost. */
async function getCostListGaps({ priceListId, rowLimit = 300 } = {}) {
  const id = Number.parseInt(priceListId, 10);
  if (!Number.isFinite(id)) {
    throw Object.assign(new Error('Drill parameter "priceListId" must be a number.'), { statusCode: 400 });
  }

  const pool = await getSourcePool();
  await assertPricelistsAvailable(pool);

  const result = await pool.request()
    .input("templateId", sql.Int, TEMPLATE_PRICE_LIST_ID)
    .input("priceListId", sql.Int, id)
    .input("rowLimit", sql.Int, rowLimit)
    .query(buildGapsQuery());

  const mapped = loadCrosswalk().get(id) || {};
  const catalogue = loadCatalogue();
  let suggested = 0;

  const rows = result.recordset.map((r) => {
    const hit = mapped.catalogueSupplier
      ? catalogue.get(catalogueKey(mapped.catalogueSupplier, r.material, r.mfType, r.lensType))
      : null;
    if (hit) suggested += 1;
    return {
      material: trim(r.material),
      mfType: trim(r.mfType),
      lensType: trim(r.lensType),
      lensOption: trim(r.lensOption),
      gapKind: r.gapKind,
      templateCost: n(r.templateCost),
      currentCost: r.currentCost == null ? null : n(r.currentCost),
      // Catalogue is per pair; cost lists are per eye. Halve it, and show both.
      cataloguePerPair: hit ? hit.perPairCost : null,
      suggestedCost: hit ? Math.round((hit.perPairCost / 2) * 100) / 100 : null
    };
  });

  return {
    kind: "cost-list-gaps",
    title: `${mapped.priceListName || `Price list ${id}`} — missing costs`,
    subtitle: mapped.catalogueSupplier
      ? `Against the Costing Template · suggestions from the ${mapped.catalogueSupplier} catalogue, halved to per eye`
      : "Against the Costing Template · no catalogue supplier mapped, so no suggested costs",
    emptyText: "No gaps — this list covers every template cell.",
    summary: [
      { label: "Gaps", value: rows.length, format: "int" },
      { label: "With a suggested cost", value: suggested, format: "int" },
      { label: "Template cost total", value: rows.reduce((s, r) => s + r.templateCost, 0), format: "money" }
    ],
    columns: [
      { key: "material", label: "Material", format: "text" },
      { key: "mfType", label: "Design", format: "text" },
      { key: "lensType", label: "Lens type", format: "text" },
      { key: "lensOption", label: "Option", format: "text" },
      { key: "gapKind", label: "Gap", format: "text" },
      { key: "templateCost", label: "Template", format: "money", align: "right" },
      { key: "cataloguePerPair", label: "Catalogue (pair)", format: "money", align: "right" },
      { key: "suggestedCost", label: "Suggested (eye)", format: "money", align: "right" }
    ],
    rows
  };
}

function trim(v) { return v == null ? null : String(v).trim() || null; }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function num(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }

module.exports = {
  getCostListConformance,
  getCostListGaps,
  buildConformanceQuery,
  buildGapsQuery,
  buildFarmoutLabsQuery,
  TEMPLATE_PRICE_LIST_ID,
  SUPPLIER_COST_GROUP,
  STALE_AFTER_DAYS,
  COST_LIST_CHECKS: Object.keys(CHECKS)
};
