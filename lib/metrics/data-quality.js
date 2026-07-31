// Item-level cost defect register — read-only against Innovations.
//
// Replaces the old 7-day zero-cost invoice KPI. A costing fault is not a transient event:
// it persists until someone fixes the item, so it is reported per ITEM over a year and
// disappears the moment the source is corrected. There is no app-side status tracking —
// the only app-owned state is the exemption list (lib/metrics/item-exemptions.js).
//
// The three rules, as stated by the business:
//   (a) no active, already-sold item should have zero cost, except trigger items
//   (b) no item should have a cost equal to or greater than its price
//   (c) no invoiced item should have zero price
//
// WHAT "ACTIVE" MEANS. dbo.StockItems has ActiveDate / DiscontinueDate /
// IsSellableInCatalog / ContractCost and every one of them is unpopulated across all
// 1.97M rows, so there is no usable active flag. "Active" is therefore defined
// behaviourally as "sold within the window", which is also exactly the population rule
// (a) cares about.
//
// UNITS. Invoice lines are per eye: Quantity is 1 on 88% of lens lines, a pair appears as
// two lines, and CostPrice matches LensItem.Cost to the cent. Cost lists are per eye too.
// Nothing here needs a pair/eye conversion — but do not introduce one without re-checking.
//
// PACKAGES. CategoryType 16 is Package, which carries zero cost by design because its
// components are costed on their own lines. Excluded from the cost rules throughout.

const sql = require("mssql");
const { getSourcePool, checkSourceDatabase } = require("../db");
const { loadActiveExemptions } = require("./item-exemptions");

const LOOKBACK_DAYS = 365;
const ROW_LIMIT = 500;
const QUERY_TIMEOUT_MS = 25000;

// 1=Lens plus the add-on categories. 16 (Package) is deliberately absent.
const COSTABLE_CATEGORIES = "1, 4, 6, 7, 10, 11, 13";

const CHECKS = {
  "zero-cost": {
    label: "Sold items with no cost",
    detail: "Active items sold in the last year whose master cost is zero"
  },
  "cost-exceeds-price": {
    label: "Items costing more than they sell for",
    detail: "Master cost is at or above the price actually charged"
  },
  "zero-price": {
    label: "Invoiced items with no price",
    detail: "Items invoiced at zero on a real (non-placeholder) line"
  }
};

function withTimeout(promise, ms, label) {
  return Promise.race([
    Promise.resolve().then(() => promise),
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { isTimeout: true })), ms)
    )
  ]);
}

/**
 * Aggregates a year of sold lines to one row per SKU, then resolves each SKU's master
 * cost exactly once.
 *
 * Built as a temp table rather than repeated per check on purpose. InvoiceLines carries
 * only a SKU string, so reaching the item master means grouping vw.StockItems (1.97M
 * rows) by SKU. Doing that inline in each of the four checks took the whole thing past
 * the driver's 15s request timeout. Here it happens once, against the ~2,500 SKUs that
 * were actually sold.
 */
function buildSoldItemsBatch() {
  return `
    IF OBJECT_ID('tempdb..#sold_items') IS NOT NULL DROP TABLE #sold_items;

    SELECT
      LTRIM(RTRIM(d.SKU)) AS itemKey,
      MAX(d.Description) AS description,
      MAX(d.CategoryType) AS categoryType,
      COUNT(*) AS lines,
      COUNT(DISTINCT c.InvoiceID) AS invoices,
      CAST(SUM(COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0)) AS decimal(18, 2)) AS revenue,
      CAST(SUM(CASE WHEN d.InvoiceLineType = 1 AND COALESCE(d.InvoicePrice, 0) = 0
                    THEN COALESCE(d.Quantity, 0) ELSE 0 END) AS decimal(18, 2)) AS zeroPriceQty,
      SUM(CASE WHEN d.InvoiceLineType = 1 AND COALESCE(d.InvoicePrice, 0) = 0 THEN 1 ELSE 0 END) AS zeroPriceLines,
      COUNT(DISTINCT CASE WHEN d.InvoiceLineType = 1 AND COALESCE(d.InvoicePrice, 0) = 0
                          THEN c.InvoiceID END) AS zeroPriceInvoices,
      CAST(MIN(NULLIF(d.InvoicePrice, 0)) AS decimal(18, 4)) AS lowestPrice,
      CAST(AVG(NULLIF(d.InvoicePrice, 0)) AS decimal(18, 4)) AS averagePrice,
      -- The list price the pricing engine resolved, before any discount. This is the
      -- closest thing on an invoice line to "the price in a pricelist", which is what
      -- rule (b) actually asks about. InvoicePrice is what was charged after discounting,
      -- so comparing cost to it flags every one-off discount as a costing defect.
      CAST(MIN(NULLIF(d.PriceListPrice, 0)) AS decimal(18, 4)) AS listPrice,
      CAST(SUM(COALESCE(d.Quantity, 0)) AS decimal(18, 2)) AS quantity,
      MAX(a.ShippedTime) AS lastSold
    INTO #sold_items
    FROM dbo.Orders a
    INNER JOIN dbo.GenStatus gs ON gs.GenStatus = a.GenStatus
    INNER JOIN dbo.OrderTypes ot ON ot.OrderType = a.OrderType
    INNER JOIN dbo.Invoices c ON a.OrderID = c.OrderID
    INNER JOIN dbo.InvoiceLines d ON c.InvoiceID = d.InvoiceID
    WHERE a.ShippedTime >= DATEADD(day, -@lookbackDays, CAST(SYSDATETIME() AS date))
      AND gs.Shipped = 1
      AND COALESCE(ot.Credit, 0) = 0
      AND ot.OrderType IN (1, 3, 12)
      AND d.CategoryType IN (${COSTABLE_CATEGORIES})
      AND NULLIF(LTRIM(RTRIM(d.SKU)), '') IS NOT NULL
    GROUP BY LTRIM(RTRIM(d.SKU));

    -- Without this index the join below degrades from a seek to a 1.97M-row GROUP BY
    -- over vw.StockItems, which takes 12s and blows the driver's request timeout.
    CREATE CLUSTERED INDEX IX_sold_items_key ON #sold_items(itemKey);

    IF OBJECT_ID('tempdb..#items') IS NOT NULL DROP TABLE #items;

    SELECT
      s.*,
      ct.CategoryTypeName AS category,
      CAST(COALESCE(li.Cost, mi.Cost) AS decimal(18, 4)) AS masterCost,
      CASE WHEN st.StockItemID IS NULL THEN 1 ELSE 0 END AS unresolved,
      CASE WHEN fi.FrameItemID IS NOT NULL THEN 1 ELSE 0 END AS isFrame,
      CASE WHEN mi.MiscItemGroupID = 77 THEN 1 ELSE 0 END AS isProcessGroup
    INTO #items
    FROM #sold_items s
    LEFT JOIN dbo.CategoryTypes ct ON ct.CategoryType = s.categoryType
    -- A filtered join, not a GROUP BY over the whole view: 3.8s versus 12.4s.
    -- Measured safe as a plain join — of the SKUs sold in the window, 2,479 match and
    -- 2,479 are distinct, so this cannot fan out. OUTER APPLY TOP 1 would be more
    -- defensive but sorts per row and pushes the batch past the 15s request timeout.
    LEFT JOIN vw.StockItems v ON v.SKU = s.itemKey
    LEFT JOIN dbo.StockItems st ON st.StockItemID = v.StockItemID
    LEFT JOIN dbo.LensItem  li ON li.LensItemID  = st.LensItemID
    LEFT JOIN dbo.MiscItems mi ON mi.MiscItemID  = st.MiscItemID
    LEFT JOIN dbo.FrameItems fi ON fi.FrameItemID = st.FrameItemID;`;
}

/**
 * Rule (a): sold items whose current master cost is zero.
 * Frames are reported separately as "no cost source" — dbo.FrameItems has no cost column
 * at all, so a frame can never satisfy this rule and calling it "zero cost" would be a
 * lie about the data.
 */
function buildZeroCostQuery() {
  return `
    SELECT TOP (@rowLimit)
      itemKey, description, category, lines, invoices, revenue, lastSold,
      masterCost, unresolved, isFrame, isProcessGroup
    FROM #items
    WHERE COALESCE(masterCost, 0) = 0 AND revenue > 0
    ORDER BY revenue DESC;`;
}

/**
 * Rule (b): items whose cost is at or above the price actually charged.
 *
 * Basis is the price the pricing engine resolved onto the invoice line, not a pricelist
 * row. Lenses have no per-SKU pricelist entry — their price is computed from sphere/
 * cylinder grids — so the charged price is the only like-for-like comparator available
 * across all item kinds. Rows carry that basis explicitly.
 */
function buildCostExceedsPriceQuery() {
  return `
    SELECT TOP (@rowLimit)
      itemKey, description, category, lines, masterCost,
      COALESCE(listPrice, lowestPrice) AS comparedPrice,
      CASE WHEN listPrice IS NOT NULL THEN N'pricelist price on invoice'
           ELSE N'lowest price charged' END AS basis,
      lowestPrice, averagePrice, revenue, lastSold,
      CAST((COALESCE(listPrice, lowestPrice) - masterCost) * quantity AS decimal(18, 2)) AS marginAmount
    FROM #items
    WHERE masterCost > 0
      AND COALESCE(listPrice, lowestPrice) > 0
      AND masterCost >= COALESCE(listPrice, lowestPrice)
    ORDER BY revenue DESC;`;
}

/**
 * True counts, so a capped list is reported as "500 of N" rather than silently
 * pretending N == 500.
 */
function buildCheckCountsQuery() {
  return `
    SELECT
      SUM(CASE WHEN COALESCE(masterCost, 0) = 0 AND revenue > 0 THEN 1 ELSE 0 END) AS zeroCost,
      SUM(CASE WHEN masterCost > 0 AND COALESCE(listPrice, lowestPrice) > 0
                AND masterCost >= COALESCE(listPrice, lowestPrice) THEN 1 ELSE 0 END) AS costExceedsPrice,
      SUM(CASE WHEN zeroPriceLines > 0 THEN 1 ELSE 0 END) AS zeroPrice
    FROM #items;`;
}

/**
 * Rule (c): items invoiced at zero price.
 * InvoiceLineType = 1 filters out the placeholder lines ("Left: (None)") that make up a
 * large share of invoice lines and carry no item identity.
 */
function buildZeroPriceQuery() {
  return `
    SELECT TOP (@rowLimit)
      itemKey, description, category, masterCost, lastSold,
      zeroPriceLines AS lines, zeroPriceInvoices AS invoices,
      CAST(COALESCE(masterCost, 0) * zeroPriceQty AS decimal(18, 2)) AS costGivenAway
    FROM #items
    WHERE zeroPriceLines > 0
    ORDER BY costGivenAway DESC, zeroPriceLines DESC;`;
}

/** What the register cannot see, so the report never implies full coverage. */
function buildCoverageQuery() {
  return `
    SELECT
      COUNT(*) AS lines,
      SUM(CASE WHEN NULLIF(LTRIM(RTRIM(d.SKU)), '') IS NULL THEN 1 ELSE 0 END) AS blankSkuLines,
      COUNT(DISTINCT NULLIF(LTRIM(RTRIM(d.SKU)), '')) AS distinctItems,
      SUM(CASE WHEN d.CategoryType = 16 THEN 1 ELSE 0 END) AS packageLines
    FROM dbo.Orders a
    INNER JOIN dbo.GenStatus gs ON gs.GenStatus = a.GenStatus
    INNER JOIN dbo.OrderTypes ot ON ot.OrderType = a.OrderType
    INNER JOIN dbo.Invoices c ON a.OrderID = c.OrderID
    INNER JOIN dbo.InvoiceLines d ON c.InvoiceID = d.InvoiceID
    WHERE a.ShippedTime >= DATEADD(day, -@lookbackDays, CAST(SYSDATETIME() AS date))
      AND gs.Shipped = 1 AND COALESCE(ot.Credit, 0) = 0;`;
}

/**
 * One batch, so #items is built once and all three checks read from it. Temp tables are
 * scoped to the connection, so the checks cannot be split across requests — the pool
 * would hand them different connections.
 */
function buildFullBatch() {
  return [
    buildSoldItemsBatch(),
    buildZeroCostQuery(),
    buildCostExceedsPriceQuery(),
    buildZeroPriceQuery(),
    buildCoverageQuery(),
    buildCheckCountsQuery()
  ].join("\n\n");
}

async function getDataQuality() {
  const generatedAt = new Date().toISOString();
  const source = await checkSourceDatabase();

  if (source.state !== "online") {
    return { generatedAt, online: false, source, error: `Innovations (MSSQL) source is ${source.state}.` };
  }

  try {
    const data = await withTimeout(queryDataQuality(), QUERY_TIMEOUT_MS, "Data quality query");
    return { generatedAt, online: true, source, currency: "BBD", lookbackDays: LOOKBACK_DAYS, ...data };
  } catch (error) {
    return { generatedAt, online: false, source, error: error.message };
  }
}

async function queryDataQuality() {
  const pool = await getSourcePool();

  const result = await pool.request()
    .input("lookbackDays", sql.Int, LOOKBACK_DAYS)
    .input("rowLimit", sql.Int, ROW_LIMIT)
    .query(buildFullBatch());

  // SELECT ... INTO and CREATE INDEX emit no recordset, so the first SELECT is index 0.
  const [zeroCost, costExceeds, zeroPrice, coverage, counts] = result.recordsets;
  const trueCounts = counts[0] || {};

  // Exemptions live in the app database; if it is unreachable, report everything rather
  // than silently hiding findings.
  let exempt = new Set();
  let exemptionsAvailable = true;
  try {
    exempt = await loadActiveExemptions();
  } catch {
    exemptionsAvailable = false;
  }

  const isExempt = (check, key) => exempt.has(`${check}␟${String(key).trim().toUpperCase()}`);

  const zeroCostRows = zeroCost
    .filter((r) => !isExempt("zero-cost", r.itemKey))
    .map((r) => ({
      itemKey: trim(r.itemKey),
      description: trim(r.description),
      category: trim(r.category),
      lines: n(r.lines),
      invoices: n(r.invoices),
      revenue: n(r.revenue),
      lastSold: r.lastSold,
      // Frames have no cost column anywhere, so this is a missing source, not a zero.
      status: n(r.isFrame) ? "no-cost-source" : n(r.unresolved) ? "unresolved-item" : "zero-cost",
      inProcessGroup: Boolean(n(r.isProcessGroup))
    }));

  const costExceedsRows = costExceeds
    .filter((r) => !isExempt("cost-exceeds-price", r.itemKey))
    .map((r) => ({
      itemKey: trim(r.itemKey),
      description: trim(r.description),
      category: trim(r.category),
      lines: n(r.lines),
      masterCost: n(r.masterCost),
      comparedPrice: n(r.comparedPrice),
      lowestPrice: n(r.lowestPrice),
      averagePrice: n(r.averagePrice),
      revenue: n(r.revenue),
      marginAmount: n(r.marginAmount),
      lastSold: r.lastSold,
      basis: trim(r.basis)
    }));

  const zeroPriceRows = zeroPrice
    .filter((r) => !isExempt("zero-price", r.itemKey))
    .map((r) => ({
      itemKey: trim(r.itemKey),
      description: trim(r.description),
      category: trim(r.category),
      lines: n(r.lines),
      invoices: n(r.invoices),
      masterCost: n(r.masterCost),
      costGivenAway: n(r.costGivenAway),
      lastSold: r.lastSold
    }));

  const cov = coverage[0] || {};

  return {
    checks: [
      summarise("zero-cost", zeroCostRows, (r) => r.revenue, n(trueCounts.zeroCost)),
      summarise("cost-exceeds-price", costExceedsRows, (r) => r.revenue, n(trueCounts.costExceedsPrice)),
      summarise("zero-price", zeroPriceRows, (r) => r.costGivenAway, n(trueCounts.zeroPrice))
    ],
    rows: { "zero-cost": zeroCostRows, "cost-exceeds-price": costExceedsRows, "zero-price": zeroPriceRows },
    exemptions: { available: exemptionsAvailable, activeCount: exempt.size },
    coverage: {
      lines: n(cov.lines),
      blankSkuLines: n(cov.blankSkuLines),
      blankSkuPct: n(cov.lines) > 0 ? Math.round((n(cov.blankSkuLines) / n(cov.lines)) * 1000) / 10 : 0,
      distinctItems: n(cov.distinctItems),
      packageLines: n(cov.packageLines)
    }
  };
}

/**
 * `count` is the true number of offending items; `rows.length` is what was returned
 * after the row cap and exemption filtering. Reporting only the latter would understate
 * the problem while looking precise.
 */
function summarise(code, rows, valueOf, trueCount) {
  return {
    code,
    label: CHECKS[code].label,
    detail: CHECKS[code].detail,
    count: trueCount,
    shown: rows.length,
    truncated: trueCount > rows.length,
    value: Math.round(rows.reduce((s, r) => s + (valueOf(r) || 0), 0) * 100) / 100,
    valueIsPartial: trueCount > rows.length,
    severity: trueCount === 0 ? "ok" : code === "zero-cost" ? "critical" : "warning"
  };
}

function trim(v) { return v == null ? null : String(v).trim() || null; }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }

module.exports = {
  getDataQuality,
  buildZeroCostQuery,
  buildCostExceedsPriceQuery,
  buildZeroPriceQuery,
  buildCoverageQuery,
  LOOKBACK_DAYS,
  COSTABLE_CATEGORIES,
  DATA_QUALITY_CHECKS: Object.keys(CHECKS)
};
