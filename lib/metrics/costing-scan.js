// Cost Check — scan an order or a lens and see its costing. Read-only against Innovations.
//
// A scan resolves to one of:
//   order  an OrderID, or a job / tray / customer-reference string on the order
//   lens   a lens OPC or user SKU (what is printed on the blank / box)
//   misc   a MiscItems SKU (coatings, cloths, edging and other add-ons)
//
// Nothing here writes. Corrections are prepared by lib/metrics/costing-fix.js and run through
// the audited privileged-data-access challenge, and "zero by design" decisions go to the
// app-owned exemption list (lib/metrics/item-exemptions.js).
//
// WHAT WAS MEASURED (2026-10-14, live Innovations), so nobody re-derives it:
//   - Invoice lines are PER EYE and CostPrice equals LensItem.Cost to the cent for stock lenses.
//   - A lens line's SKU is the lens OPC (LensItem.OPC_R/L/P) or UserSKU_R/L/P.
//   - vw.StockItems is NOT usable for lookup: a single SKU probe takes 45-50s. Go to
//     dbo.LensItem and dbo.MiscItems directly (0.4s and instant).
//   - PACKAGES (CategoryType 16): the package line carries the price and zero cost, and the
//     component lines (lens, edging, ...) inside it carry the cost. A package is therefore
//     costed through its components; a component with no cost is the defect, not the package.
//   - IMPORTED items are the OUTSOURCED orders: lenses not manufactured in-house, farmed out to a
//     lab (dbo.Farmouts, LabID <> 1 "No Lab Selected"). Their cost comes from that lab's supplier
//     cost list (PriceLists.PricelistGroup = 1), per eye, in the list's currency, and is
//     converted to base: cost = listPrice / Currencies.CurrentExchangeRate. Verified to the cent:
//     order 138711, Thai Optical Lab, 43.00 URX / 0.465 = 92.47 = the invoiced lens cost.
//   - The lens attributes of an Rx order live in dbo.RxJobs (open) / dbo.RxArchive (finished),
//     keyed SerialNum = OrderID, as RFFLens* (right) and LFFLens* (left) MG/MT/MF/LT/LO. Those are
//     the cost-grid tuple (MaterialGroupNum, MaterialNum, MFTypeNum, LensTypeNum, LensOptionNum).
//     LensItem.Option is NOT that option (it is a power code), so stock lenses cannot be keyed
//     into the cost lists; they are costed from LensItem.Cost.
//   - One SKU can legitimately sell in different roles (Lens vs Edging) at different economics,
//     so item history is grouped by CategoryType, never collapsed.

const sql = require("mssql");
const { getSourcePool, checkSourceDatabase } = require("../db");
const { loadActiveExemptions } = require("./item-exemptions");
const { coreTokens } = require("./cost-lists");

const QUERY_TIMEOUT_MS = 20000;
const HISTORY_DAYS = 365;
const MAX_CODES = 25;
const MAX_CODE_LENGTH = 64;
const MAX_SKUS_PER_ORDER = 40;
// Same floor the pricing engine guarantees (lib/pricing-engine.js DEFAULTS.floorMargin).
const LOW_MARGIN = 0.15;
const CENT = 0.005;

const PACKAGE_CATEGORY = 16;
const LENS_CATEGORY = 1;
// Same population the item cost register treats as costable, plus Misc (9) because add-ons such
// as cloths and cleaner are real cost. Zero-by-design triggers are handled through exemptions.
const COSTABLE_CATEGORIES = new Set([1, 4, 6, 7, 9, 10, 11, 13]);

/* ─────────── pure helpers (exported for tests) ─────────── */

function n(value) {
  const x = Number(value);
  return Number.isFinite(x) ? x : 0;
}
function r2(value) { return Math.round(n(value) * 100) / 100; }
function trim(value) { return value == null ? null : String(value).trim() || null; }

/**
 * Cleans one raw scan. Scanners may append control characters (CR/LF/TAB), and Code 39
 * readers sometimes include the `*` start/stop characters.
 */
function normaliseScan(raw) {
  const code = String(raw == null ? "" : raw)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/^\*+|\*+$/g, "")
    .trim();
  if (!code || code.length > MAX_CODE_LENGTH) return null;
  return code;
}

/** Accepts an array or a delimited string; returns unique cleaned codes, capped. */
function normaliseScans(input) {
  const list = Array.isArray(input) ? input : String(input == null ? "" : input).split(/[\r\n,;]+/);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const code = normaliseScan(item);
    if (!code) continue;
    const key = code.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(code);
    if (out.length >= MAX_CODES) break;
  }
  return out;
}

/**
 * The forms a code can take in the database. Scanners that strip leading zeros hand us a short
 * OPC, and OPCs are 10 digits; OrderID is an int, so only up to 9 digits is a safe order number.
 */
function codeForms(code) {
  const digits = /^\d+$/.test(code);
  return {
    code,
    orderId: digits && code.length <= 9 && Number(code) > 0 ? Number(code) : null,
    opc: digits && code.length < 10 ? code.padStart(10, "0") : code
  };
}

/** Margin of a price over a cost, or null when there is no price to be a margin of. */
function marginOf(price, cost) {
  if (!(price > 0)) return null;
  return (price - cost) / price;
}

const LIST_MATCH_TOLERANCE = 0.02;

/** A supplier list price in the list's currency, as base currency. Rate is foreign per 1 base. */
function listCostToBase(price, rate) {
  const p = n(price);
  const r = n(rate);
  if (!(p > 0) || !(r > 0)) return null;
  return r2(p / r);
}

/** "Right: ..." / "Left: ..." prefix on an Rx lens line; anything else is treated as right. */
function eyeOf(description) {
  return /^\s*left\b/i.test(String(description || "")) ? "left" : "right";
}

/**
 * Judges one invoice line. Pure: everything it needs is passed in, so the rules can be
 * asserted without a database.
 *
 * line:  { category, type, sku, quantity, cost, price, listPrice, description }
 * ctx:   { hasPackage, master: {kind, id, cost, ambiguous}|null, exempt: Set<string>,
 *          expected: { options: [{costBase, ...}], lab, tupleKnown }|null }
 *   expected is the outsourced-lens supplier cost for this line's eye, already converted to base.
 */
function analyseLine(line, ctx = {}) {
  const qty = n(line.quantity);
  const cost = n(line.cost);
  const price = n(line.price);
  const extCost = r2(cost * qty);
  const extPrice = r2(price * qty);
  const isPackage = line.category === PACKAGE_CATEGORY;
  const isCostable = COSTABLE_CATEGORIES.has(line.category);
  const isRealLine = line.type === 1;
  const sku = trim(line.sku);
  const exempt = Boolean(sku && ctx.exempt && ctx.exempt.has(`zero-cost␟${sku.toUpperCase()}`));
  const master = ctx.master || null;
  const issues = [];
  let suggestedCost = null;
  let costSource = master ? "item-master" : null;

  if (isRealLine && !isPackage && isCostable) {
    const expected = line.category === LENS_CATEGORY ? ctx.expected || null : null;
    const bestExpected = expected && expected.options.length ? expected.options[0] : null;
    if (bestExpected) suggestedCost = bestExpected.costBase;

    if (cost === 0 && !exempt) {
      // A priced line with no cost is the headline defect. A lens with neither cost nor price
      // inside a Package is a component with no cost: the package line itself is meant to be
      // zero-cost, so the cost has to be on the components.
      const insidePackage = ctx.hasPackage && line.category === LENS_CATEGORY && !sku && price === 0;
      const hint = bestExpected
        ? ` ${bestExpected.listName} lists ${bestExpected.price.toFixed(2)} (${bestExpected.currencyName || "list currency"}), which is ${bestExpected.costBase.toFixed(2)} at the current rate.`
        : "";
      if (insidePackage) {
        issues.push({
          code: "rx-lens-uncosted",
          severity: "critical",
          message: `Lens component of a package has no cost. The package is costed through its components.${hint}`
        });
      } else if (price > 0 || line.category === LENS_CATEGORY) {
        issues.push({ code: "no-cost", severity: "critical", message: `No cost on this line.${hint}` });
      }
    } else if (cost > 0 && expected) {
      if (bestExpected) {
        const agrees = expected.options.some((o) => Math.abs(o.costBase - cost) <= LIST_MATCH_TOLERANCE);
        if (agrees) {
          costSource = "supplier-list";
        } else {
          issues.push({
            code: "cost-differs-list",
            severity: "warning",
            message: `Line cost ${cost.toFixed(2)} does not match ${expected.lab || "the lab"}'s cost list: ${bestExpected.price.toFixed(2)} ${bestExpected.currencyName || ""} is ${bestExpected.costBase.toFixed(2)} at the current rate.`.replace(/\s+\./g, ".")
          });
        }
      } else if (expected.tupleKnown && expected.lab) {
        issues.push({
          code: "list-cell-missing",
          severity: "info",
          message: `${expected.lab}'s cost list has no price for this lens, so the line cost cannot be checked against a list.`
        });
      }
    }

    if (cost > 0 && price > 0 && cost >= price - CENT) {
      issues.push({
        code: "cost-ge-price",
        severity: "critical",
        message: `Cost ${cost.toFixed(2)} is at or above the price ${price.toFixed(2)}.`
      });
    } else if (cost > 0 && price > 0 && marginOf(price, cost) < LOW_MARGIN) {
      issues.push({
        code: "low-margin",
        severity: "warning",
        message: `Margin ${(marginOf(price, cost) * 100).toFixed(1)}% is under the ${LOW_MARGIN * 100}% floor.`
      });
    }

    if (price === 0 && cost > 0 && !ctx.hasPackage) {
      issues.push({ code: "zero-price", severity: "warning", message: "Costed but charged at zero." });
    }

    if (master && master.cost > 0 && cost > 0 && Math.abs(master.cost - cost) > CENT) {
      issues.push({
        code: "cost-differs-master",
        severity: "warning",
        message: `Line cost ${cost.toFixed(2)} differs from the item master cost ${master.cost.toFixed(2)}.`
      });
    }

    // Only lens and misc lines are keyed to a master by SKU. Edging, coatings and the like reuse
    // lens OPCs or process SKUs as labels, so a miss there says nothing.
    if (sku && !master && ctx.masterChecked && (line.category === LENS_CATEGORY || line.category === 9)) {
      issues.push({
        code: "unresolved-item",
        severity: "info",
        message: "SKU is not in the lens or misc item master, so there is no master cost to compare."
      });
    }
  }

  return {
    extCost,
    extPrice,
    margin: r2(extPrice - extCost),
    marginPct: marginOf(extPrice, extCost) == null ? null : Math.round(marginOf(extPrice, extCost) * 1000) / 10,
    isPackage,
    exempt,
    suggestedCost,
    costSource,
    issues
  };
}

const SEVERITY_RANK = { ok: 0, info: 1, warning: 2, critical: 3 };

function worstSeverity(issues) {
  let worst = "ok";
  for (const issue of issues) {
    if ((SEVERITY_RANK[issue.severity] || 0) > SEVERITY_RANK[worst]) worst = issue.severity;
  }
  return worst;
}

/** Totals over analysed lines. Margin is provisional while any cost is known to be missing. */
function summariseLines(lines) {
  let revenue = 0;
  let cost = 0;
  let missing = 0;
  for (const line of lines) {
    revenue += line.extPrice;
    cost += line.extCost;
    if (line.issues.some((i) => i.code === "no-cost" || i.code === "rx-lens-uncosted")) missing += 1;
  }
  revenue = r2(revenue);
  cost = r2(cost);
  return {
    revenue,
    cost,
    margin: r2(revenue - cost),
    marginPct: marginOf(revenue, cost) == null ? null : Math.round(marginOf(revenue, cost) * 1000) / 10,
    linesMissingCost: missing,
    provisional: missing > 0
  };
}

/**
 * Which supplier cost lists plausibly belong to a lab. Names live in different vocabularies, so
 * this is a distinctive-word overlap (the same method the cost-list conformance report uses)
 * and is reported as a match, not as a fact.
 */
function matchCostLists(labName, lists) {
  const wanted = coreTokens(labName);
  if (!wanted.size) return [];
  return lists.filter((list) => {
    const have = coreTokens(list.priceListName);
    for (const token of wanted) if (have.has(token)) return true;
    return false;
  });
}

/* ─────────── SQL ─────────── */

// Lens SKU lookups cost about 0.2s per indexed column (1.5M rows), so they are tried in the order
// that usually hits first and stopped as soon as something matches: an order number needs none,
// the printed OPC is the common case, and the user SKUs are only consulted when the OPCs miss.
const LENS_OPC_COLUMNS = ["OPC_R", "OPC_L", "OPC_P"];
const LENS_USER_SKU_COLUMNS = ["UserSKU_R", "UserSKU_L", "UserSKU_P"];

function buildResolveOrderQuery() {
  return `
    SELECT TOP (5) o.OrderID
    FROM dbo.Orders o
    WHERE (@orderId IS NOT NULL AND o.OrderID = @orderId)
       OR o.JobID = @code OR o.JobIDLeft = @code OR o.JobIDRight = @code
       OR o.CustomerTrayID = @code OR o.CustomerOrdReference = @code;`;
}

function buildResolveMiscQuery() {
  return "SELECT TOP (5) mi.MiscItemID, mi.SKU FROM dbo.MiscItems mi WHERE mi.SKU = @code;";
}

function buildResolveLensQuery(columns) {
  const arms = columns.map((c) =>
    `SELECT li.LensItemID, li.Name FROM dbo.LensItem li WHERE li.${c} IN (@code, @opc)`);
  return `SELECT TOP (5) LensItemID, Name FROM (${arms.join(" UNION ")}) x ORDER BY LensItemID;`;
}

function buildResolveQuery() {
  return [buildResolveOrderQuery(), buildResolveMiscQuery(), buildResolveLensQuery(LENS_OPC_COLUMNS), buildResolveLensQuery(LENS_USER_SKU_COLUMNS)].join("\n");
}

function buildOrderQueries() {
  return `
    SELECT o.OrderID, o.OrderType, ot.OrderTypeName, ot.Credit, o.CustomerID, c.CustomerName,
           c.AccountNumber, o.PatientID, o.CustomerOrdReference, o.JobID, o.ReceivedTime,
           o.ShippedTime, gs.GenStatusName, gs.Shipped, gs.Cancelled, o.RemakeOfOrderID
    FROM dbo.Orders o
    LEFT JOIN dbo.OrderTypes ot ON ot.OrderType = o.OrderType
    LEFT JOIN dbo.GenStatus gs ON gs.GenStatus = o.GenStatus
    LEFT JOIN dbo.Customers c ON c.CustomerID = o.CustomerID
    WHERE o.OrderID = @orderId;

    SELECT InvoiceID, InvoiceType, Status, SubTotal, TaxAmount, Total, Discount, NoCharge,
           PricingErrors, InvoiceTime
    FROM dbo.Invoices WHERE OrderID = @orderId ORDER BY InvoiceID;

    SELECT l.InvoiceLineID, l.InvoiceID, l.LineNumber, l.InvoiceLineType, l.CategoryType,
           ct.CategoryTypeName, l.SKU, l.Description, l.Quantity, l.CostPrice, l.InvoicePrice,
           l.PriceListPrice, l.PriceListName, l.Suppressed
    FROM dbo.InvoiceLines l
    INNER JOIN dbo.Invoices i ON i.InvoiceID = l.InvoiceID
    LEFT JOIN dbo.CategoryTypes ct ON ct.CategoryType = l.CategoryType
    WHERE i.OrderID = @orderId
    ORDER BY i.InvoiceID, l.LineNumber;

    SELECT f.FarmoutID, f.LabID, la.Name AS labName, f.Active, f.TransmitDate, f.ReceivedDate,
           f.LeftLens, f.RightLens
    FROM dbo.Farmouts f
    LEFT JOIN dbo.Labs la ON la.num = f.LabID
    WHERE f.OrderID = @orderId
    ORDER BY f.FarmoutID;`;
}

/**
 * The Rx's lens attributes. RxJobs holds open jobs and RxArchive finished ones; both are keyed
 * SerialNum = OrderID. Highest iteration wins (a remake re-uses the order), open job first.
 */
function buildRxTupleQuery() {
  const cols = `Iteration,
      RFFLensMG AS rMG, RFFLensMT AS rMT, RFFLensMF AS rMF, RFFLensLT AS rLT, RFFLensLO AS rLO,
      LFFLensMG AS lMG, LFFLensMT AS lMT, LFFLensMF AS lMF, LFFLensLT AS lLT, LFFLensLO AS lLO`;
  return `
    SELECT TOP (1) * FROM (
      SELECT 1 AS src, ${cols} FROM dbo.RxJobs WHERE SerialNum = @orderId
      UNION ALL
      SELECT 2 AS src, ${cols} FROM dbo.RxArchive WHERE SerialNum = @orderId
    ) x ORDER BY Iteration DESC, src;`;
}

/** Every active supplier cost list that prices this grid tuple, with its currency and rate. */
function buildListCostQuery() {
  return `
    SELECT pl.PriceListID AS priceListId, pl.PriceListName AS priceListName,
           cu.CurrencyName AS currencyName, cu.CurrentExchangeRate AS rate,
           MAX(i.Price) AS price
    FROM dbo.PriceRxPOSItems i
    INNER JOIN dbo.PriceRxPOSSheets s ON s.PriceRxPOSSheetID = i.PriceRxPOSSheetID
    INNER JOIN dbo.PriceLists pl ON pl.PriceListID = s.PriceListID
      AND pl.PricelistGroup = 1 AND pl.IsActive = 1
    LEFT JOIN dbo.Currencies cu ON cu.CurrencyID = pl.CurrencyID
    WHERE i.MaterialGroupNum = @g AND i.MaterialNum = @m AND i.MFTypeNum = @f
      AND i.LensTypeNum = @t AND i.LensOptionNum = @o AND i.Price > 0
    GROUP BY pl.PriceListID, pl.PriceListName, cu.CurrencyName, cu.CurrentExchangeRate;`;
}

/** Placeholders @s0..@sN for an IN list / VALUES list, plus the inputs to bind. */
function skuParams(skus) {
  return {
    names: skus.map((_, i) => `@s${i}`),
    bind(request) {
      skus.forEach((sku, i) => request.input(`s${i}`, sql.NVarChar(120), sku));
      return request;
    }
  };
}

/**
 * Master cost by SKU for lenses. One UNION ALL arm per SKU column rather than an OR join, so
 * each arm can seek its own index.
 */
function buildLensMasterQuery(count, columns = [...LENS_OPC_COLUMNS, ...LENS_USER_SKU_COLUMNS]) {
  const values = Array.from({ length: count }, (_, i) => `(@s${i})`).join(",");
  const arms = columns.map(
    (column) => `
      SELECT v.sku, li.LensItemID, li.Name, li.Cost, li.Price1, li.ReorderCost
      FROM (VALUES ${values}) v(sku)
      INNER JOIN dbo.LensItem li ON li.${column} = v.sku`
  );
  return arms.join("\n      UNION ALL");
}

function buildMiscMasterQuery(count) {
  const names = Array.from({ length: count }, (_, i) => `@s${i}`).join(",");
  return `
    SELECT mi.SKU AS sku, mi.MiscItemID, mi.Desc1 AS name, mi.Cost, mi.Price
    FROM dbo.MiscItems mi WHERE mi.SKU IN (${names});`;
}

function buildCostListCoverageQuery() {
  return `
    SELECT pl.PriceListID AS priceListId, pl.PriceListName AS priceListName, pl.IsActive AS isActive,
           SUM(CASE WHEN i.Price > 0 THEN 1 ELSE 0 END) AS pricedCells,
           MAX(i.LastUpdated) AS lastUpdated
    FROM dbo.PriceLists pl
    LEFT JOIN dbo.PriceRxPOSSheets s ON s.PriceListID = pl.PriceListID
    LEFT JOIN dbo.PriceRxPOSItems i ON i.PriceRxPOSSheetID = s.PriceRxPOSSheetID
    WHERE pl.PricelistGroup = 1
    GROUP BY pl.PriceListID, pl.PriceListName, pl.IsActive;`;
}

function buildItemHistoryQueries(count) {
  const names = Array.from({ length: count }, (_, i) => `@s${i}`).join(",");
  return `
    SELECT l.CategoryType AS category, ct.CategoryTypeName AS categoryName,
           COUNT(*) AS lines, SUM(l.Quantity) AS quantity,
           AVG(NULLIF(l.InvoicePrice, 0)) AS avgPrice, MIN(NULLIF(l.InvoicePrice, 0)) AS minPrice,
           MAX(l.InvoicePrice) AS maxPrice, AVG(NULLIF(l.CostPrice, 0)) AS avgCost,
           MIN(l.CostPrice) AS minCost, MAX(l.CostPrice) AS maxCost,
           SUM(CASE WHEN COALESCE(l.CostPrice, 0) = 0 THEN 1 ELSE 0 END) AS zeroCostLines,
           MAX(i.InvoiceTime) AS lastSold
    FROM dbo.InvoiceLines l
    INNER JOIN dbo.Invoices i ON i.InvoiceID = l.InvoiceID
    LEFT JOIN dbo.CategoryTypes ct ON ct.CategoryType = l.CategoryType
    WHERE l.SKU IN (${names}) AND l.InvoiceLineType = 1
      AND i.InvoiceTime >= DATEADD(day, -@days, SYSDATETIME())
    GROUP BY l.CategoryType, ct.CategoryTypeName
    ORDER BY lines DESC;

    -- The most recent lines whose cost disagrees with the master: these are the ones to look at.
    SELECT TOP (10) l.InvoiceLineID AS lineId, i.OrderID AS orderId, l.CategoryType AS category,
           l.Quantity AS quantity, l.CostPrice AS cost, l.InvoicePrice AS price, i.InvoiceTime AS invoiced
    FROM dbo.InvoiceLines l
    INNER JOIN dbo.Invoices i ON i.InvoiceID = l.InvoiceID
    WHERE l.SKU IN (${names}) AND l.InvoiceLineType = 1 AND l.CategoryType = @category
      AND i.InvoiceTime >= DATEADD(day, -@days, SYSDATETIME())
      AND ABS(COALESCE(l.CostPrice, 0) - @masterCost) > ${CENT}
    ORDER BY i.InvoiceTime DESC;

    SELECT TOP (6) la.Name AS labName, COUNT(DISTINCT f.OrderID) AS orders
    FROM dbo.InvoiceLines l
    INNER JOIN dbo.Invoices i ON i.InvoiceID = l.InvoiceID
    INNER JOIN dbo.Farmouts f ON f.OrderID = i.OrderID AND f.Active = 1
    INNER JOIN dbo.Labs la ON la.num = f.LabID AND la.num <> 1
    WHERE l.SKU IN (${names}) AND i.InvoiceTime >= DATEADD(day, -@days, SYSDATETIME())
    GROUP BY la.Name ORDER BY orders DESC;`;
}

/* ─────────── data access ─────────── */

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve().then(() => promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { isTimeout: true })), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

async function resolveCode(pool, code) {
  const forms = codeForms(code);
  const ask = (text) => pool.request()
    .input("code", sql.NVarChar(120), forms.code)
    .input("opc", sql.NVarChar(120), forms.opc)
    .input("orderId", sql.Int, forms.orderId)
    .query(text).then((r) => r.recordset);

  // An order number outranks an item code: the two cannot collide for a well-formed 10-digit OPC.
  const orders = await ask(buildResolveOrderQuery());
  if (orders.length) return orders.map((o) => ({ kind: "order", id: o.OrderID, label: `Order ${o.OrderID}` }));

  const matches = (await ask(buildResolveMiscQuery())).map((m) => ({ kind: "misc", id: m.MiscItemID, label: trim(m.SKU) }));
  let lenses = await ask(buildResolveLensQuery(LENS_OPC_COLUMNS));
  if (!lenses.length) lenses = await ask(buildResolveLensQuery(LENS_USER_SKU_COLUMNS));
  // Lenses first: a lens is the more specific meaning of a code that is both.
  return lenses.map((l) => ({ kind: "lens", id: l.LensItemID, label: trim(l.Name) || `Lens ${l.LensItemID}` })).concat(matches);
}

/**
 * Master cost per SKU, keyed by upper-case SKU. Lens SKUs are only looked up in the 1.5M-row lens
 * master for lens lines; everything else goes to the 700-row misc master.
 */
async function loadMasters(pool, lensSkus, otherSkus) {
  const masters = new Map();
  if (lensSkus.length) await loadLensMasters(pool, lensSkus, masters);
  const misc = otherSkus.filter((s) => !masters.has(s.toUpperCase()));
  if (misc.length) await loadMiscMasters(pool, misc, masters);
  return masters;
}

async function loadLensMasters(pool, skus, masters) {
  // OPC first; the user SKUs are only worth the extra lookups for SKUs the OPCs did not find.
  for (const columns of [LENS_OPC_COLUMNS, LENS_USER_SKU_COLUMNS]) {
    const todo = skus.filter((s) => !masters.has(s.toUpperCase()));
    if (!todo.length) return;
    const result = await skuParams(todo).bind(pool.request()).query(buildLensMasterQuery(todo.length, columns));
    addLensMasters(result.recordset, masters);
  }
}

function addLensMasters(rows, masters) {
  for (const row of rows) {
    const key = String(row.sku).trim().toUpperCase();
    const existing = masters.get(key);
    if (existing) {
      if (!existing.ids.includes(row.LensItemID)) existing.ids.push(row.LensItemID);
      if (Math.abs(existing.cost - n(row.Cost)) > CENT) existing.ambiguous = true;
      continue;
    }
    masters.set(key, {
      kind: "lens", id: row.LensItemID, ids: [row.LensItemID], name: trim(row.Name),
      cost: n(row.Cost), price: n(row.Price1), ambiguous: false
    });
  }
}

async function loadMiscMasters(pool, skus, masters) {
  const result = await skuParams(skus).bind(pool.request()).query(buildMiscMasterQuery(skus.length));
  for (const row of result.recordset) {
    const key = String(row.sku).trim().toUpperCase();
    if (masters.has(key)) continue;
    masters.set(key, {
      kind: "misc", id: row.MiscItemID, ids: [row.MiscItemID], name: trim(row.name),
      cost: n(row.Cost), price: n(row.Price), ambiguous: false
    });
  }
}

async function loadCostLists(pool) {
  try {
    const result = await pool.request().query(buildCostListCoverageQuery());
    return result.recordset.map((r) => ({
      priceListId: r.priceListId,
      priceListName: trim(r.priceListName),
      isActive: Boolean(r.isActive),
      pricedCells: n(r.pricedCells),
      lastUpdated: r.lastUpdated || null
    }));
  } catch {
    return [];
  }
}

function describeLab(labName, lists) {
  const matched = matchCostLists(labName, lists);
  const usable = matched.filter((l) => l.isActive && l.pricedCells > 0);
  return {
    labName: trim(labName),
    costLists: matched.map((l) => ({
      priceListId: l.priceListId, name: l.priceListName, active: l.isActive,
      pricedCells: l.pricedCells, lastUpdated: l.lastUpdated
    })),
    hasUsableCostList: usable.length > 0
  };
}

/**
 * What the farmed-out lab's cost lists say this order's lenses should cost, per eye, in base
 * currency. Only meaningful for outsourced Rx orders (a lab was chosen and the Rx is on file);
 * returns null otherwise so stock and in-house orders are judged on the item master alone.
 */
async function loadSupplierExpectations(pool, orderId, suppliers) {
  const labs = suppliers.filter((s) => s.labId !== 1 && s.labName);
  if (!labs.length) return null;

  const tupleRow = (await pool.request().input("orderId", sql.Int, orderId).query(buildRxTupleQuery())).recordset[0];
  if (!tupleRow) return null;

  const labListIds = new Set(labs.flatMap((s) => s.costLists.filter((l) => l.active).map((l) => l.priceListId)));
  const labName = labs[0].labName;
  const pricedCells = new Map(labs.flatMap((s) => s.costLists.map((l) => [l.priceListId, l.pricedCells])));

  async function forEye(prefix) {
    const tuple = ["MG", "MT", "MF", "LT", "LO"].map((k) => n(tupleRow[`${prefix}${k}`]));
    if (tuple.every((v) => v === 0)) return { tuple: null, tupleKnown: false, options: [], others: [] };
    const found = (await pool.request()
      .input("g", sql.Int, tuple[0]).input("m", sql.Int, tuple[1]).input("f", sql.Int, tuple[2])
      .input("t", sql.Int, tuple[3]).input("o", sql.Int, tuple[4])
      .query(buildListCostQuery())).recordset.map((r) => ({
      listId: r.priceListId,
      listName: trim(r.priceListName),
      currencyName: trim(r.currencyName),
      rate: n(r.rate),
      price: r2(r.price),
      costBase: listCostToBase(r.price, r.rate)
    })).filter((r) => r.costBase != null);
    return {
      tuple,
      tupleKnown: true,
      lab: labName,
      // Lists belonging to the lab that did the work are what the cost should agree with.
      options: found.filter((r) => labListIds.has(r.listId)).sort((a, b) => (pricedCells.get(b.listId) || 0) - (pricedCells.get(a.listId) || 0)),
      others: found.filter((r) => !labListIds.has(r.listId)).sort((a, b) => a.costBase - b.costBase)
    };
  }

  const right = await forEye("r");
  const left = tupleRow.lMG === tupleRow.rMG && tupleRow.lMT === tupleRow.rMT && tupleRow.lMF === tupleRow.rMF
    && tupleRow.lLT === tupleRow.rLT && tupleRow.lLO === tupleRow.rLO
    ? right
    : await forEye("l");
  return { right, left, lab: labName };
}

async function loadExemptions() {
  try {
    return { set: await loadActiveExemptions(), available: true };
  } catch {
    return { set: new Set(), available: false };
  }
}

async function getOrderCosting(pool, orderId, shared) {
  const result = await pool.request().input("orderId", sql.Int, orderId).query(buildOrderQueries());
  const [headers, invoices, lines, farmouts] = result.recordsets;
  const header = headers[0];
  if (!header) return null;

  // Outsourced (imported) lenses are costed from the lab's supplier cost list, so find the lab and
  // what its list says before judging the lens lines.
  const suppliers = farmouts
    .filter((f) => f.Active)
    .map((f) => ({
      farmoutId: f.FarmoutID, labId: f.LabID, transmitted: f.TransmitDate || null, received: f.ReceivedDate || null,
      ...describeLab(f.labName, shared.costLists)
    }));
  let expectations = null;
  try {
    expectations = await loadSupplierExpectations(pool, orderId, suppliers);
  } catch {
    /* the list check is additive: without it the order is still judged on its own lines */
  }

  const costable = lines.filter((l) => COSTABLE_CATEGORIES.has(l.CategoryType) && trim(l.SKU));
  const uniqueSkus = (rows) => [...new Set(rows.map((l) => trim(l.SKU)))].slice(0, MAX_SKUS_PER_ORDER);
  const masters = await loadMasters(
    pool,
    uniqueSkus(costable.filter((l) => l.CategoryType === LENS_CATEGORY)),
    uniqueSkus(costable.filter((l) => l.CategoryType !== LENS_CATEGORY))
  );
  const hasPackage = lines.some((l) => l.CategoryType === PACKAGE_CATEGORY && l.InvoiceLineType === 1);

  const analysed = lines.map((l) => {
    const sku = trim(l.SKU);
    const master = sku ? masters.get(sku.toUpperCase()) || null : null;
    const verdict = analyseLine(
      {
        category: l.CategoryType, type: l.InvoiceLineType, sku, quantity: l.Quantity,
        cost: l.CostPrice, price: l.InvoicePrice, listPrice: l.PriceListPrice, description: l.Description
      },
      {
        hasPackage, master, exempt: shared.exempt, masterChecked: Boolean(sku),
        expected: expectations ? expectations[eyeOf(l.Description)] : null
      }
    );
    return {
      lineId: l.InvoiceLineID,
      invoiceId: l.InvoiceID,
      lineNumber: l.LineNumber,
      type: l.InvoiceLineType,
      category: l.CategoryType,
      categoryName: trim(l.CategoryTypeName),
      sku,
      description: trim(l.Description),
      quantity: n(l.Quantity),
      cost: r2(l.CostPrice),
      price: r2(l.InvoicePrice),
      listPrice: r2(l.PriceListPrice),
      priceListName: trim(l.PriceListName),
      master: master ? { kind: master.kind, id: master.id, ids: master.ids, cost: master.cost, name: master.name, ambiguous: master.ambiguous } : null,
      ...verdict
    };
  });

  const orderIssues = [];
  const invoiceRows = invoices.map((i) => ({
    invoiceId: i.InvoiceID, invoiceType: i.InvoiceType, status: i.Status,
    subTotal: r2(i.SubTotal), total: r2(i.Total), discount: r2(i.Discount),
    noCharge: Boolean(i.NoCharge), pricingErrors: n(i.PricingErrors), invoiced: i.InvoiceTime || null
  }));
  if (!invoiceRows.length) {
    orderIssues.push({ code: "no-invoice", severity: "warning", message: "This order has no invoice yet, so there is no cost or price to check." });
  }
  for (const inv of invoiceRows) {
    if (inv.pricingErrors > 0) {
      orderIssues.push({ code: "pricing-errors", severity: "warning", message: `Invoice ${inv.invoiceId} was flagged with ${inv.pricingErrors} pricing error(s) by Innovations.` });
    }
  }

  const isRx = header.OrderType === 1 || header.OrderType === 10;
  for (const s of suppliers) {
    if (s.labId === 1 && isRx) {
      orderIssues.push({ code: "no-lab", severity: "warning", message: "No lab selected yet, so the supplier cost cannot be determined." });
    } else if (s.labId !== 1 && !s.hasUsableCostList) {
      orderIssues.push({ code: "lab-no-cost-list", severity: "warning", message: `${s.labName || "This lab"} has no supplier cost list with prices, so lens cost cannot come from a list.` });
    }
  }

  const issues = [...orderIssues, ...analysed.flatMap((l) => l.issues)];
  const totals = summariseLines(analysed.filter((l) => l.type === 1));

  return {
    kind: "order",
    id: header.OrderID,
    title: `Order ${header.OrderID}`,
    order: {
      orderId: header.OrderID,
      type: trim(header.OrderTypeName),
      isCredit: Boolean(header.Credit),
      customer: trim(header.CustomerName),
      account: trim(header.AccountNumber),
      patient: trim(header.PatientID),
      reference: trim(header.CustomerOrdReference),
      jobId: trim(header.JobID),
      status: trim(header.GenStatusName),
      shipped: Boolean(header.Shipped),
      cancelled: Boolean(header.Cancelled),
      received: header.ReceivedTime || null,
      shippedTime: header.ShippedTime || null,
      remakeOf: header.RemakeOfOrderID || null,
      hasPackage
    },
    invoices: invoiceRows,
    lines: analysed,
    suppliers,
    // What the lab's cost list says the lenses should cost, per eye, converted to base currency.
    supplierCost: expectations,
    orderIssues,
    totals,
    severity: worstSeverity(issues),
    issueCount: issues.filter((i) => i.severity !== "info").length
  };
}

async function getItemCosting(pool, match, shared) {
  const table = match.kind === "lens"
    ? `SELECT LensItemID AS id, Name AS name, Cost AS cost, Price1 AS price, ReorderCost AS reorderCost,
              OPC_R, OPC_L, OPC_P, UserSKU_R, UserSKU_L, UserSKU_P
       FROM dbo.LensItem WHERE LensItemID = @id;`
    : `SELECT MiscItemID AS id, Desc1 AS name, Cost AS cost, Price AS price, ReorderCost AS reorderCost, SKU AS OPC_R
       FROM dbo.MiscItems WHERE MiscItemID = @id;`;
  const item = (await pool.request().input("id", sql.Int, match.id).query(table)).recordset[0];
  if (!item) return null;

  const skus = [...new Set(
    [item.OPC_R, item.OPC_L, item.OPC_P, item.UserSKU_R, item.UserSKU_L, item.UserSKU_P].map(trim).filter(Boolean)
  )];
  const masterCost = n(item.cost);
  const category = match.kind === "lens" ? LENS_CATEGORY : 9;

  let history = [];
  let stale = [];
  let labs = [];
  if (skus.length) {
    const params = skuParams(skus);
    const request = params.bind(pool.request())
      .input("days", sql.Int, HISTORY_DAYS)
      .input("category", sql.Int, category)
      .input("masterCost", sql.Decimal(18, 4), masterCost);
    const result = await request.query(buildItemHistoryQueries(skus.length));
    history = result.recordsets[0].map((h) => ({
      category: h.category, categoryName: trim(h.categoryName), lines: n(h.lines), quantity: r2(h.quantity),
      avgPrice: r2(h.avgPrice), minPrice: r2(h.minPrice), maxPrice: r2(h.maxPrice),
      avgCost: r2(h.avgCost), minCost: r2(h.minCost), maxCost: r2(h.maxCost),
      zeroCostLines: n(h.zeroCostLines), lastSold: h.lastSold || null
    }));
    stale = result.recordsets[1].map((s) => ({
      lineId: s.lineId, orderId: s.orderId, quantity: n(s.quantity), cost: r2(s.cost), price: r2(s.price), invoiced: s.invoiced || null
    }));
    labs = result.recordsets[2].map((l) => ({ ...describeLab(l.labName, shared.costLists), orders: n(l.orders) }));
  }

  const role = history.find((h) => h.category === category) || null;
  const listPrice = r2(item.price);
  const issues = [];
  const sold = role ? role.lines : 0;
  const exempt = skus.some((s) => shared.exempt.has(`zero-cost␟${s.toUpperCase()}`));

  if (masterCost === 0 && !exempt) {
    issues.push({
      code: "master-no-cost",
      severity: sold > 0 ? "critical" : "warning",
      message: sold > 0
        ? `Item master has no cost and it sold ${sold} time(s) in the last ${HISTORY_DAYS} days.`
        : "Item master has no cost."
    });
  }
  if (masterCost > 0 && role && role.avgPrice > 0 && masterCost >= role.avgPrice - CENT) {
    issues.push({ code: "cost-ge-price", severity: "critical", message: `Master cost ${masterCost.toFixed(2)} is at or above the average price charged ${role.avgPrice.toFixed(2)}.` });
  } else if (masterCost > 0 && role && role.avgPrice > 0 && marginOf(role.avgPrice, masterCost) < LOW_MARGIN) {
    issues.push({ code: "low-margin", severity: "warning", message: `Margin at the average price is ${(marginOf(role.avgPrice, masterCost) * 100).toFixed(1)}%, under the ${LOW_MARGIN * 100}% floor.` });
  }
  if (role && role.zeroCostLines > 0 && !exempt) {
    issues.push({ code: "sold-without-cost", severity: "warning", message: `${role.zeroCostLines} of ${role.lines} recent invoice line(s) carried no cost.` });
  }
  if (stale.length) {
    issues.push({ code: "cost-differs-master", severity: "warning", message: `Recent invoice lines were costed differently from the master ${masterCost.toFixed(2)}.` });
  }
  if (!labs.length && sold > 0 && match.kind === "lens") {
    issues.push({ code: "no-lab-history", severity: "info", message: "No lab was recorded against recent orders for this lens." });
  }
  for (const lab of labs) {
    if (!lab.hasUsableCostList) {
      issues.push({ code: "lab-no-cost-list", severity: "info", message: `${lab.labName} has no supplier cost list with prices.` });
    }
  }

  return {
    kind: match.kind,
    id: item.id,
    title: trim(item.name) || `Item ${item.id}`,
    item: {
      id: item.id, name: trim(item.name), skus,
      masterCost, listPrice, reorderCost: r2(item.reorderCost),
      marginAtList: marginOf(listPrice, masterCost) == null ? null : Math.round(marginOf(listPrice, masterCost) * 1000) / 10,
      marginAtAverage: role && marginOf(role.avgPrice, masterCost) != null ? Math.round(marginOf(role.avgPrice, masterCost) * 1000) / 10 : null,
      exempt
    },
    history,
    staleLines: stale,
    labs,
    issues,
    severity: worstSeverity(issues),
    issueCount: issues.filter((i) => i.severity !== "info").length
  };
}

async function scanCosting(input) {
  const generatedAt = new Date().toISOString();
  const codes = normaliseScans(input);
  if (!codes.length) {
    throw Object.assign(new Error("Scan at least one order number or lens code."), { statusCode: 400 });
  }
  const source = await checkSourceDatabase();
  if (source.state !== "online") {
    return { generatedAt, online: false, source, error: `Innovations (MSSQL) source is ${source.state}.`, results: [] };
  }

  try {
    return await withTimeout(runScan(codes, generatedAt, source), QUERY_TIMEOUT_MS * 2, "Cost check");
  } catch (error) {
    return { generatedAt, online: false, source, error: error.message, results: [] };
  }
}

async function runScan(codes, generatedAt, source) {
  const pool = await getSourcePool();
  const [exemptions, costLists] = await Promise.all([loadExemptions(), loadCostLists(pool)]);
  const shared = { exempt: exemptions.set, costLists };

  const results = [];
  for (const code of codes) {
    try {
      const matches = await resolveCode(pool, code);
      if (!matches.length) {
        results.push({ code, status: "not-found", matches: [] });
        continue;
      }
      const chosen = matches[0];
      const detail = chosen.kind === "order"
        ? await getOrderCosting(pool, chosen.id, shared)
        : await getItemCosting(pool, chosen, shared);
      results.push(detail
        ? { code, status: "found", matches, ...detail }
        : { code, status: "not-found", matches });
    } catch (error) {
      results.push({ code, status: "error", error: error.message, matches: [] });
    }
  }

  return {
    generatedAt,
    online: true,
    source,
    currency: "BBD",
    exemptionsAvailable: exemptions.available,
    lowMarginFloor: LOW_MARGIN,
    results
  };
}

module.exports = {
  scanCosting,
  normaliseScan,
  normaliseScans,
  codeForms,
  analyseLine,
  listCostToBase,
  eyeOf,
  buildRxTupleQuery,
  buildListCostQuery,
  summariseLines,
  matchCostLists,
  marginOf,
  buildResolveQuery,
  buildResolveLensQuery,
  buildResolveOrderQuery,
  LENS_OPC_COLUMNS,
  LENS_USER_SKU_COLUMNS,
  buildOrderQueries,
  buildLensMasterQuery,
  buildMiscMasterQuery,
  buildItemHistoryQueries,
  LOW_MARGIN,
  COSTABLE_CATEGORIES
};
