// Per-tab detail sections for Business Metrics tabs 2-6.
//
// Replaces the single 200 KB /api/business-metrics response for front-end use: each tab
// asks only for its own section, so opening Invoices no longer builds the 30-day
// profitability temp table and opening Pricing no longer touches the source at all.
//
// Sections and what they cost:
//   sales          source (customer roll-ups + aging) + app (archive revenue)
//   invoices       source only — 7-day #invoice_thresholds
//   profitability  source only — 30-day #profitability_lines (the expensive one)
//   deliveries     app only
//   pricing        app only
//
// /api/business-metrics (lib/business-metrics.js) is untouched and still returns
// everything at once, for anything already consuming it.

const { getAppPool, getSourcePool, checkSourceDatabase, checkAppDatabase } = require("../db");
const { getCostListConformance } = require("./cost-lists");
const { getInventorySection } = require("./inventory");

const SECTION_TIMEOUT_MS = 20000;

const SECTIONS = {
  sales: { needsSource: true, needsApp: true },
  invoices: { needsSource: true, needsApp: false },
  profitability: { needsSource: true, needsApp: false },
  deliveries: { needsSource: false, needsApp: true },
  pricing: { needsSource: false, needsApp: true },
  "cost-lists": { needsSource: true, needsApp: false },
  // Inventory bypasses the active source profile entirely: the stock tables
  // (LensItem, MiscItems, StockTransactions, POItems) live only in the vendor
  // Innovations MSSQL, never in the Zen-fed mirror, so it holds its own live
  // connection. It reads the app DB for thresholds and overrides but degrades
  // to documented defaults rather than failing, so needsApp stays false.
  inventory: { needsSource: false, needsApp: false }
};

function withTimeout(promise, ms, label) {
  return Promise.race([
    Promise.resolve().then(() => promise),
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { isTimeout: true })), ms)
    )
  ]);
}

async function getDetailSection(section) {
  const spec = SECTIONS[section];
  if (!spec) {
    const error = new Error(`Unknown section "${section}".`);
    error.statusCode = 404;
    throw error;
  }

  const generatedAt = new Date().toISOString();

  // Only check the databases this section actually reads.
  const [source, app] = await Promise.all([
    spec.needsSource ? checkSourceDatabase() : Promise.resolve(null),
    spec.needsApp ? checkAppDatabase() : Promise.resolve(null)
  ]);

  const sources = {};
  if (source) sources.sourceMssql = source;
  if (app) sources.appDb = app;

  const sourceOnline = !spec.needsSource || source.state === "online";
  const appOnline = !spec.needsApp || app.state === "online";

  const base = { section, generatedAt, currency: "BBD", sources, sourceOnline, appOnline };

  try {
    const data = await withTimeout(HANDLERS[section]({ sourceOnline, appOnline }), SECTION_TIMEOUT_MS, `${section} query`);
    return Object.assign(base, data);
  } catch (error) {
    return Object.assign(base, { error: error.message });
  }
}

const HANDLERS = {
  async sales({ sourceOnline, appOnline }) {
    const [live, archive] = await Promise.all([
      sourceOnline ? salesLive() : null,
      appOnline ? salesArchive() : null
    ]);
    return { live, archive };
  },

  async invoices({ sourceOnline }) {
    if (!sourceOnline) return { invoiceThresholds: null };
    return { invoiceThresholds: await invoiceThresholds() };
  },

  async profitability({ sourceOnline }) {
    if (!sourceOnline) return { profitability: null };
    return { profitability: await profitability() };
  },

  async deliveries({ appOnline }) {
    if (!appOnline) return { deliveries: null };
    return { deliveries: await deliveries() };
  },

  async pricing({ appOnline }) {
    if (!appOnline) return { pricing: null };
    return { pricing: await pricing() };
  },

  async "cost-lists"({ sourceOnline }) {
    if (!sourceOnline) return { costLists: null };
    const conformance = await getCostListConformance();
    // Rethrow so this section reports failure the same way every other tab does —
    // notably the "pricelist tables are not in the mirror" case.
    if (!conformance.online) {
      throw Object.assign(new Error(conformance.error), { statusCode: 503 });
    }
    return { costLists: conformance };
  },

  async inventory() {
    return { inventory: await getInventorySection() };
  }
};

/* ─────────── source-backed sections ─────────── */

async function salesLive() {
  const pool = await getSourcePool();
  const result = await pool.request().query(`
    SELECT TOP (10)
      b.CustomerID AS customerId, c.CustomerName AS name, c.AccountNumber AS accountNumber,
      ISNULL(b.SalesValueYTD, 0) AS salesYTD, ISNULL(b.CurrentBalance, 0) AS balance
    FROM dbo.CustomerBalances b
    INNER JOIN dbo.Customers c ON c.CustomerID = b.CustomerID
    ORDER BY b.SalesValueYTD DESC;

    SELECT FinARAgingPeriodNum AS bucket, COUNT(*) AS items, ISNULL(SUM(AmountDue), 0) AS amountDue
    FROM dbo.FinAROpenItems GROUP BY FinARAgingPeriodNum;

    SELECT TOP (1) ActualDays1, ActualDays2, ActualDays3, ActualDays4,
      AgingDesc1, AgingDesc2, AgingDesc3, AgingDesc4
    FROM dbo.FinARAgingPeriods WHERE FinARAgingPeriodID = 1;
  `);

  const agingRows = result.recordsets[1] || [];
  const def = result.recordsets[2][0] || {};
  const label = (b) => {
    switch (b) {
      case 0: return { label: "Current", detail: "not yet due" };
      case 1: return { label: def.AgingDesc1 || "1–30 days", detail: `≤ ${num(def.ActualDays1)} days` };
      case 2: return { label: def.AgingDesc2 || "31–60 days", detail: `≤ ${num(def.ActualDays2)} days` };
      case 3: return { label: def.AgingDesc3 || "61–90 days", detail: `≤ ${num(def.ActualDays3)} days` };
      case 4: return { label: def.AgingDesc4 || "Over 120", detail: `> ${num(def.ActualDays4)} days` };
      default: return { label: `Bucket ${b}`, detail: "" };
    }
  };

  const aging = [0, 1, 2, 3, 4].map((b) => {
    const row = agingRows.find((r) => num(r.bucket) === b);
    const meta = label(b);
    return {
      bucket: b, label: meta.label, detail: meta.detail,
      amountDue: row ? num(row.amountDue) : 0,
      items: row ? num(row.items) : 0
    };
  });

  return {
    topCustomers: (result.recordsets[0] || []).map((r) => ({
      customerId: num(r.customerId),
      name: (r.name || "").trim(),
      accountNumber: r.accountNumber || null,
      salesYTD: num(r.salesYTD),
      balance: num(r.balance)
    })),
    aging,
    agingTotal: aging.reduce((s, a) => s + a.amountDue, 0)
  };
}

async function invoiceThresholds() {
  const pool = await getSourcePool();
  const result = await pool.request().query(`
    IF OBJECT_ID('tempdb..#invoice_thresholds') IS NOT NULL DROP TABLE #invoice_thresholds;

    SELECT
      b.InvoiceID AS invoiceId, b.OrderID AS orderId, b.SubTotal AS subtotal,
      b.TaxAmount AS taxAmount,
      CAST(b.Total * COALESCE(d.OrderSign, 1) AS decimal(18, 2)) AS total,
      d.OrderTypeName AS invTypeName, a.CustomerOrdReference AS rxNum,
      a.CustomerAccount AS account, a.ReceivedTime AS rxDate, a.ShippedTime AS shipDate,
      a.PatientID AS patient, c.CustomerName AS customerName
    INTO #invoice_thresholds
    FROM dbo.Orders a
    INNER JOIN dbo.Invoices b ON a.OrderID = b.OrderID
    INNER JOIN dbo.Customers c ON c.CustomerID = a.CustomerID
    LEFT JOIN dbo.OrderTypes d ON a.OrderType = d.OrderType
    WHERE a.ShippedTime >= DATEADD(day, -7, CAST(SYSDATETIME() AS date))
      AND a.GenStatus = 6
      AND a.OrderType IN (1, 3, 4, 5, 8, 9, 10, 11, 12);

    SELECT
      COUNT(*) AS shippedInvoiceCount,
      SUM(CASE WHEN total < 199.00 THEN 1 ELSE 0 END) AS under199Count,
      ISNULL(SUM(CASE WHEN total < 199.00 THEN total ELSE 0 END), 0) AS under199Total,
      SUM(CASE WHEN total > 180.00 THEN 1 ELSE 0 END) AS over180Count,
      ISNULL(SUM(CASE WHEN total > 180.00 THEN total ELSE 0 END), 0) AS over180Total,
      SUM(CASE WHEN total > 180.00 AND total < 199.00 THEN 1 ELSE 0 END) AS overlapCount
    FROM #invoice_thresholds;
  `);

  // Counts and totals only — the invoice rows are served on demand by the
  // invoice-threshold drill, so this section costs ~1 KB instead of ~50 KB.
  // DROP TABLE and SELECT ... INTO emit no recordset, so the first SELECT is index 0.
  const summary = result.recordsets[0][0] || {};

  return {
    lookbackDays: 7,
    shippedInvoiceCount: num(summary.shippedInvoiceCount),
    under199: { threshold: 199, count: num(summary.under199Count), total: num(summary.under199Total) },
    over180: { threshold: 180, count: num(summary.over180Count), total: num(summary.over180Total) },
    overlapCount: num(summary.overlapCount)
  };
}

async function profitability() {
  const pool = await getSourcePool();
  const result = await pool.request().query(`
    IF OBJECT_ID('tempdb..#profitability_lines') IS NOT NULL DROP TABLE #profitability_lines;

    SELECT
      c.InvoiceID AS invoiceId, a.OrderID AS orderId,
      a.CustomerOrdReference AS rxNumber, origin.AccountNumber AS accountNumber,
      origin.CustomerName AS customerName, ot.OrderType AS orderType,
      ot.OrderTypeName AS orderTypeName, CAST(COALESCE(ot.Credit, 0) AS bit) AS isCredit,
      d.Description AS description, d.SKU AS sku, a.ShippedTime AS shippedAt,
      COALESCE(CONVERT(nvarchar(120), d.CategoryType), N'Uncategorized') AS productGroup,
      -- 1=Lens. CategoryType 16 is Package, which is zero-cost by design (its
      -- components are costed on their own lines), so it must fall through to 'other'
      -- and stay out of the zero-cost KPI below. See dbo.CategoryTypes.
      CASE
        WHEN d.CategoryType = 1 THEN N'lens'
        WHEN d.CategoryType IN (4, 6, 7, 10, 11, 13) THEN N'addon'
        ELSE N'other'
      END AS lineKind,
      CAST(COALESCE(d.Quantity, 0) AS decimal(18, 4)) AS quantity,
      CAST(COALESCE(d.Quantity, 0) * COALESCE(ot.OrderSign, CASE WHEN ot.Credit = 1 THEN -1 ELSE 1 END, 1) AS decimal(18, 4)) AS signedQuantity,
      CAST(COALESCE(d.InvoicePrice, 0) AS decimal(18, 4)) AS unitPrice,
      CAST(CASE WHEN ot.Credit = 1 THEN -1 ELSE 1 END * COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0) AS decimal(18, 2)) AS lineRevenue,
      CAST(CASE WHEN COALESCE(ot.Credit, 0) = 0 AND ot.OrderType IN (1, 3, 12) THEN d.CostPrice ELSE NULL END AS decimal(18, 4)) AS unitCost,
      CAST(CASE WHEN COALESCE(ot.Credit, 0) = 0 AND ot.OrderType IN (1, 3, 12)
        THEN COALESCE(d.CostPrice, 0) * COALESCE(d.Quantity, 0) ELSE NULL END AS decimal(18, 2)) AS lineCost,
      CAST(CASE WHEN COALESCE(ot.Credit, 0) = 0 AND ot.OrderType IN (1, 3, 12)
        THEN (COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0)) - (COALESCE(d.CostPrice, 0) * COALESCE(d.Quantity, 0))
        ELSE NULL END AS decimal(18, 2)) AS marginAmount,
      CAST(CASE WHEN COALESCE(ot.Credit, 0) = 0 AND ot.OrderType IN (1, 3, 12)
        AND COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0) > 0
        THEN (((COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0)) - (COALESCE(d.CostPrice, 0) * COALESCE(d.Quantity, 0)))
          / NULLIF(COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0), 0)) * 100
        ELSE NULL END AS decimal(18, 2)) AS marginPct,
      CAST(COALESCE(c.Total, 0) * COALESCE(ot.OrderSign, CASE WHEN ot.Credit = 1 THEN -1 ELSE 1 END, 1) AS decimal(18, 2)) AS invoiceTotal
    INTO #profitability_lines
    FROM dbo.Orders a
    INNER JOIN dbo.GenStatus gs ON gs.GenStatus = a.GenStatus
    INNER JOIN dbo.OrderTypes ot ON ot.OrderType = a.OrderType
    INNER JOIN dbo.Invoices c ON a.OrderID = c.OrderID
    INNER JOIN dbo.InvoiceLines d ON c.InvoiceID = d.InvoiceID
    INNER JOIN dbo.Customers origin ON origin.CustomerID = COALESCE(a.BillToID, c.CustomerID, a.CustomerID)
    WHERE a.ShippedTime >= DATEADD(day, -30, CAST(SYSDATETIME() AS date))
      AND gs.Shipped = 1
      AND (ot.Credit = 1 OR ot.OrderType IN (1, 3, 10, 12));

    SELECT
      COUNT(DISTINCT invoiceId) AS invoiceCount, COUNT(*) AS lineCount,
      ISNULL(SUM(lineRevenue), 0) AS netRevenue,
      ISNULL(SUM(CASE WHEN lineCost IS NOT NULL THEN lineRevenue ELSE 0 END), 0) AS costedRevenue,
      ISNULL(SUM(lineCost), 0) AS totalCost, ISNULL(SUM(marginAmount), 0) AS marginAmount,
      CASE WHEN SUM(CASE WHEN lineCost IS NOT NULL THEN lineRevenue ELSE 0 END) > 0
        THEN (SUM(marginAmount) / NULLIF(SUM(CASE WHEN lineCost IS NOT NULL THEN lineRevenue ELSE 0 END), 0)) * 100
        ELSE NULL END AS marginPct,
      ISNULL(SUM(CASE WHEN isCredit = 1 THEN lineRevenue ELSE 0 END), 0) AS creditRevenue,
      SUM(CASE WHEN lineCost IS NOT NULL THEN 1 ELSE 0 END) AS costedLineCount,
      SUM(CASE WHEN isCredit = 0 AND orderType IN (1, 3, 12) AND unitCost IS NULL THEN 1 ELSE 0 END) AS missingCostLineCount
    FROM #profitability_lines;

    SELECT TOP (50) accountNumber, customerName,
      COUNT(DISTINCT invoiceId) AS invoiceCount, COUNT(*) AS lineCount,
      ISNULL(SUM(lineRevenue), 0) AS netRevenue,
      ISNULL(SUM(lineCost), 0) AS totalCost, ISNULL(SUM(marginAmount), 0) AS marginAmount,
      CASE WHEN SUM(CASE WHEN lineCost IS NOT NULL THEN lineRevenue ELSE 0 END) > 0
        THEN (SUM(marginAmount) / NULLIF(SUM(CASE WHEN lineCost IS NOT NULL THEN lineRevenue ELSE 0 END), 0)) * 100
        ELSE NULL END AS marginPct
    FROM #profitability_lines GROUP BY accountNumber, customerName
    ORDER BY marginAmount DESC, netRevenue DESC;

    SELECT TOP (50) productGroup, COUNT(*) AS lineCount,
      ISNULL(SUM(signedQuantity), 0) AS quantity, ISNULL(SUM(lineRevenue), 0) AS netRevenue,
      ISNULL(SUM(lineCost), 0) AS totalCost, ISNULL(SUM(marginAmount), 0) AS marginAmount,
      CASE WHEN SUM(CASE WHEN lineCost IS NOT NULL THEN lineRevenue ELSE 0 END) > 0
        THEN (SUM(marginAmount) / NULLIF(SUM(CASE WHEN lineCost IS NOT NULL THEN lineRevenue ELSE 0 END), 0)) * 100
        ELSE NULL END AS marginPct
    FROM #profitability_lines GROUP BY productGroup
    ORDER BY marginAmount DESC, netRevenue DESC;

    WITH zero_cost_lines AS (
      SELECT * FROM #profitability_lines
      WHERE isCredit = 0 AND orderType IN (1, 3, 12)
        AND shippedAt >= DATEADD(day, -7, CAST(SYSDATETIME() AS date))
        AND lineRevenue > 0 AND lineKind IN (N'lens', N'addon')
        AND COALESCE(unitCost, 0) = 0
    ),
    zero_cost_invoices AS (
      SELECT invoiceId, MAX(invoiceTotal) AS invoiceTotal FROM zero_cost_lines GROUP BY invoiceId
    )
    SELECT
      (SELECT COUNT(*) FROM zero_cost_invoices) AS invoiceCount,
      ISNULL((SELECT SUM(invoiceTotal) FROM zero_cost_invoices), 0) AS invoiceRevenue,
      COUNT(*) AS lineCount, ISNULL(SUM(lineRevenue), 0) AS lineRevenue,
      SUM(CASE WHEN lineKind = N'lens' THEN 1 ELSE 0 END) AS lensLineCount,
      ISNULL(SUM(CASE WHEN lineKind = N'lens' THEN signedQuantity ELSE 0 END), 0) AS lensQuantity,
      ISNULL(SUM(CASE WHEN lineKind = N'lens' THEN lineRevenue ELSE 0 END), 0) AS lensRevenue,
      SUM(CASE WHEN lineKind = N'addon' THEN 1 ELSE 0 END) AS addonLineCount,
      ISNULL(SUM(CASE WHEN lineKind = N'addon' THEN signedQuantity ELSE 0 END), 0) AS addonQuantity,
      ISNULL(SUM(CASE WHEN lineKind = N'addon' THEN lineRevenue ELSE 0 END), 0) AS addonRevenue,
      SUM(CASE WHEN unitCost IS NULL THEN 1 ELSE 0 END) AS missingCostLineCount
    FROM zero_cost_lines;
  `);

  // Aggregates only. The line-level detail (lowest-margin lines, zero-cost lines) is
  // served on demand by the low-margin-lines and zero-cost-lines drills, so this
  // section costs ~6 KB rather than ~180 KB.
  // DROP TABLE and SELECT ... INTO emit no recordset, so the first SELECT is index 0.
  const summary = result.recordsets[0][0] || {};
  const zero = result.recordsets[3][0] || {};

  const group = (r) => ({
    accountNumber: r.accountNumber || null,
    customerName: (r.customerName || "").trim() || null,
    productGroup: r.productGroup || null,
    invoiceCount: num(r.invoiceCount), lineCount: num(r.lineCount), quantity: num(r.quantity),
    netRevenue: num(r.netRevenue), totalCost: num(r.totalCost),
    marginAmount: num(r.marginAmount), marginPct: nullableNum(r.marginPct)
  });

  return {
    lookbackDays: 30,
    invoiceCount: num(summary.invoiceCount), lineCount: num(summary.lineCount),
    netRevenue: num(summary.netRevenue), costedRevenue: num(summary.costedRevenue),
    totalCost: num(summary.totalCost), marginAmount: num(summary.marginAmount),
    marginPct: nullableNum(summary.marginPct), creditRevenue: num(summary.creditRevenue),
    costedLineCount: num(summary.costedLineCount), missingCostLineCount: num(summary.missingCostLineCount),
    zeroCost: {
      lookbackDays: 7, targetInvoiceCount: 0,
      invoiceCount: num(zero.invoiceCount), onTarget: num(zero.invoiceCount) === 0,
      invoiceRevenue: num(zero.invoiceRevenue), lineCount: num(zero.lineCount),
      lineRevenue: num(zero.lineRevenue),
      lensLineCount: num(zero.lensLineCount), lensQuantity: num(zero.lensQuantity), lensRevenue: num(zero.lensRevenue),
      addonLineCount: num(zero.addonLineCount), addonQuantity: num(zero.addonQuantity), addonRevenue: num(zero.addonRevenue),
      missingCostLineCount: num(zero.missingCostLineCount),
      exceptions: [
        "credit order types", "zero-dollar lines",
        "order types outside 1, 3, and 12",
        "categories outside lens and add-on billing paths"
      ]
    },
    byCustomer: (result.recordsets[1] || []).map(group),
    byProductGroup: (result.recordsets[2] || []).map(group)
  };
}

/* ─────────── app-database sections ─────────── */

async function salesArchive() {
  const pool = await getAppPool();
  const result = await pool.request().query(`
    SELECT ISNULL(SUM(total), 0) AS archivedRevenueTotal FROM archive.access_delivery_items;

    SELECT FORMAT(d.delivery_date, 'yyyy-MM') AS ym,
      COUNT(DISTINCT d.legacy_delivery_no) AS deliveries,
      COUNT(i.legacy_item_id) AS items, ISNULL(SUM(i.total), 0) AS revenue
    FROM archive.access_deliveries d
    LEFT JOIN archive.access_delivery_items i ON i.legacy_delivery_no = d.legacy_delivery_no
    WHERE d.delivery_date IS NOT NULL
    GROUP BY FORMAT(d.delivery_date, 'yyyy-MM') ORDER BY ym;

    SELECT TOP (25) i.customer_id AS customerId, SUM(ISNULL(i.total, 0)) AS revenue,
      COUNT(*) AS items, ca.branchName, ca.accountNumber
    FROM archive.access_delivery_items i
    OUTER APPLY (
      SELECT TOP (1) CAST(b.branch_name AS nvarchar(200)) AS branchName, b.account_number AS accountNumber
      FROM archive.access_customer_branches b WHERE b.customer_id = i.customer_id ORDER BY b.legacy_branch_id
    ) ca
    WHERE i.customer_id IS NOT NULL
    GROUP BY i.customer_id, ca.branchName, ca.accountNumber ORDER BY revenue DESC;
  `);

  return {
    archivedRevenueTotal: num((result.recordsets[0][0] || {}).archivedRevenueTotal),
    revenueByMonth: (result.recordsets[1] || []).map((r) => ({
      month: r.ym, revenue: num(r.revenue), deliveries: num(r.deliveries), items: num(r.items)
    })),
    topCustomers: (result.recordsets[2] || []).map((r) => ({
      customerId: num(r.customerId),
      name: r.branchName || r.accountNumber || `Customer ${r.customerId}`,
      accountNumber: r.accountNumber || null,
      revenue: num(r.revenue), items: num(r.items)
    }))
  };
}

async function deliveries() {
  const pool = await getAppPool();
  const result = await pool.request().query(`
    SELECT
      (SELECT COUNT(*) FROM archive.access_deliveries) AS deliveriesTotal,
      (SELECT COUNT(*) FROM archive.access_deliveries WHERE YEAR(delivery_date) = YEAR(GETDATE())) AS deliveriesThisYear,
      (SELECT COUNT(*) FROM archive.access_delivery_items) AS deliveryItemsTotal,
      (SELECT COUNT(*) FROM archive.access_commercial_invoices) AS commercialInvoicesTotal,
      (SELECT COUNT(*) FROM archive.access_couriers) AS couriersTotal,
      (SELECT COUNT(*) FROM archive.access_couriers WHERE overseas_courier = 1) AS overseasCouriers,
      (SELECT ISNULL(SUM(freight_cost), 0) FROM archive.access_commercial_invoices) AS freightCostTotal,
      (SELECT ISNULL(SUM(packing_cost), 0) FROM archive.access_commercial_invoices) AS packingCostTotal,
      (SELECT ISNULL(SUM(insurance_cost), 0) FROM archive.access_commercial_invoices) AS insuranceCostTotal,
      (SELECT ISNULL(SUM(other_cost), 0) FROM archive.access_commercial_invoices) AS otherCostTotal;

    SELECT COUNT(*) AS total,
      SUM(CASE WHEN app_status = N'prep' THEN 1 ELSE 0 END) AS openPrep,
      SUM(CASE WHEN app_status = N'closed' THEN 1 ELSE 0 END) AS closed,
      SUM(CASE WHEN reopened_at IS NOT NULL THEN 1 ELSE 0 END) AS reopened
    FROM delivery.shipment_sessions;

    SELECT FORMAT(delivery_date, 'yyyy-MM') AS ym,
      COUNT(DISTINCT legacy_delivery_no) AS deliveries
    FROM archive.access_deliveries WHERE delivery_date IS NOT NULL
    GROUP BY FORMAT(delivery_date, 'yyyy-MM') ORDER BY ym;
  `);

  const core = result.recordsets[0][0] || {};
  const sessions = result.recordsets[1][0] || {};
  const total = num(core.deliveriesTotal);
  const items = num(core.deliveryItemsTotal);

  return {
    appOwned: {
      total: num(sessions.total), openPrep: num(sessions.openPrep),
      closed: num(sessions.closed), reopened: num(sessions.reopened)
    },
    archive: {
      deliveriesTotal: total, deliveriesThisYear: num(core.deliveriesThisYear),
      avgItemsPerDelivery: total > 0 ? Number((items / total).toFixed(1)) : 0,
      couriersTotal: num(core.couriersTotal), overseasCouriers: num(core.overseasCouriers),
      commercialInvoicesTotal: num(core.commercialInvoicesTotal),
      freightCostTotal: num(core.freightCostTotal), packingCostTotal: num(core.packingCostTotal),
      insuranceCostTotal: num(core.insuranceCostTotal), otherCostTotal: num(core.otherCostTotal)
    },
    byMonth: (result.recordsets[2] || []).map((r) => ({ month: r.ym, deliveries: num(r.deliveries) }))
  };
}

async function pricing() {
  const pool = await getAppPool();
  const result = await pool.request().query(`
    SELECT
      (SELECT COUNT(*) FROM pricing.price_rules) AS rulesTotal,
      (SELECT COUNT(*) FROM pricing.price_rules WHERE is_active = 1) AS rulesActive,
      (SELECT COUNT(*) FROM pricing.price_calculations) AS calculationsTotal,
      (SELECT ISNULL(AVG(calculated_price - input_price), 0) FROM pricing.price_calculations) AS avgAdjustment,
      (SELECT MAX(created_at) FROM pricing.price_calculations) AS lastCalculationAt;
  `);
  const p = result.recordset[0] || {};
  return {
    rulesTotal: num(p.rulesTotal), rulesActive: num(p.rulesActive),
    calculationsTotal: num(p.calculationsTotal), avgAdjustment: num(p.avgAdjustment),
    lastCalculationAt: p.lastCalculationAt || null
  };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nullableNum(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

module.exports = { getDetailSection, DETAIL_SECTIONS: Object.keys(SECTIONS) };
