// Business metrics module — live MSSQL KPIs + local archive context.
const { getAppPool, getSourcePool } = require("./db");
const { getIntegrationHealthSnapshot } = require("./integration-health");

/**
 * Business metrics aggregation.
 *
 * Two data planes:
 *  1. Live MSSQL Innovations KPIs (sales YTD/MTD, WIP value, receivables,
 *     customer aging, stock turn, top 10 customers) — the headline figures.
 *  2. Locally available data (imported Access archive + app-owned delivery /
 *     pricing) for historical context.
 *
 * Every external call is wrapped in a timeout so the endpoint ALWAYS responds;
 * any slow/unreachable source is reported as `timeout`/`error` and the rest of
 * the dashboard still renders.
 */

const SOURCE_KPI_TIMEOUT_MS = 15000;
const APP_QUERY_TIMEOUT_MS = 12000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    Promise.resolve()
      .then(() => promise)
      .catch((err) => { throw err; }),
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { isTimeout: true })), ms)
    )
  ]);
}

async function getBusinessMetrics() {
  const generatedAt = new Date().toISOString();

  const snapshot = await getIntegrationHealthSnapshot();
  const appHealth = snapshot.appDatabase;
  const sourceHealth = snapshot.sourceDatabase;
  const psqlHealth = snapshot.psqlDatabase;

  const sources = { appDb: appHealth, sourceMssql: sourceHealth, sourcePsql: psqlHealth };
  const liveSourceOnline = sourceHealth.state === "online";

  // Live MSSQL KPIs and local archive data are independent — fetch in parallel,
  // each guarded so one failing never blocks the other.
  const [sourceKpisResult, localResult] = await Promise.all([
    liveSourceOnline
      ? withTimeout(getSourceKpis(), SOURCE_KPI_TIMEOUT_MS, "Live KPI query")
          .then((data) => ({ data, error: null }))
          .catch((err) => ({ data: null, error: err.message }))
      : Promise.resolve({ data: null, error: null }),
    appHealth.state === "online"
      ? withTimeout(getLocalMetrics(), APP_QUERY_TIMEOUT_MS, "Local metrics query")
          .then((data) => ({ data, error: null }))
          .catch((err) => ({ data: null, error: err.message }))
      : Promise.resolve({ data: null, error: appHealth.detail })
  ]);

  const local = localResult.data;

  return {
    generatedAt,
    currency: "BBD",
    appDbOnline: appHealth.state === "online",
    liveSourceOnline,
    sources,
    sourceKpis: sourceKpisResult.data,
    sourceKpisError: sourceKpisResult.error,
    overview: local ? local.overview : null,
    sales: local ? local.sales : null,
    deliveries: local ? local.deliveries : null,
    pricing: local ? local.pricing : null,
    localError: localResult.error,
    notes: localResult.error ? [`Local data unavailable: ${localResult.error}`] : []
  };
}

/**
 * Headline KPIs straight from the Innovations LMS management roll-ups in
 * CustomerBalances + the AR open-items aging buckets. These are the figures the
 * LMS itself reports, so they are authoritative and cheap (no heavy joins).
 */
async function getSourceKpis() {
  const pool = await getSourcePool();
  const result = await pool.request().query(`
    -- 0: management roll-ups (per-customer, summed)
    SELECT
      COUNT(*) AS customers,
      ISNULL(SUM(SalesValueYTD), 0) AS salesYTD,
      ISNULL(SUM(SalesValuePTD), 0) AS salesMTD,
      ISNULL(SUM(CurrentWIPValue), 0) AS wipValue,
      ISNULL(SUM(CurrentBalance), 0) AS receivables,
      ISNULL(SUM(SalesCostYTD), 0) AS cogsYTD
    FROM dbo.CustomerBalances;

    -- 1: current inventory value from stock lots (partial coverage in mirror)
    SELECT ISNULL(SUM(CAST(OnHand AS float) * Cost), 0) AS inventoryValue,
           COUNT(*) AS lots
    FROM dbo.StockLots
    WHERE Active = 1;

    -- 2: AR aging buckets
    SELECT FinARAgingPeriodNum AS bucket,
           COUNT(*) AS items,
           ISNULL(SUM(AmountDue), 0) AS amountDue
    FROM dbo.FinAROpenItems
    GROUP BY FinARAgingPeriodNum;

    -- 3: aging bucket labels / day thresholds
    SELECT TOP (1)
      ActualDays1, ActualDays2, ActualDays3, ActualDays4,
      AgingDesc1, AgingDesc2, AgingDesc3, AgingDesc4
    FROM dbo.FinARAgingPeriods
    WHERE FinARAgingPeriodID = 1;

    -- 4: top 10 customers by YTD sales
    SELECT TOP (10)
      c.CustomerName AS name,
      c.AccountNumber AS accountNumber,
      ISNULL(b.SalesValueYTD, 0) AS salesYTD,
      ISNULL(b.CurrentBalance, 0) AS balance
    FROM dbo.CustomerBalances b
    INNER JOIN dbo.Customers c ON c.CustomerID = b.CustomerID
    ORDER BY b.SalesValueYTD DESC;

    IF OBJECT_ID('tempdb..#invoice_thresholds') IS NOT NULL
      DROP TABLE #invoice_thresholds;

    SELECT
      b.InvoiceID AS invoiceId,
      b.OrderID AS orderId,
      b.SubTotal AS subtotal,
      b.TaxAmount AS taxAmount,
      CAST(b.Total * COALESCE(d.OrderSign, 1) AS decimal(18, 2)) AS total,
      d.OrderTypeName AS invTypeName,
      a.CustomerOrdReference AS rxNum,
      a.CustomerAccount AS account,
      a.ReceivedTime AS rxDate,
      a.ShippedTime AS shipDate,
      a.PatientID AS patient,
      c.CustomerName AS customerName
    INTO #invoice_thresholds
    FROM dbo.Orders a
    INNER JOIN dbo.Invoices b ON a.OrderID = b.OrderID
    INNER JOIN dbo.Customers c ON c.CustomerID = a.CustomerID
    LEFT JOIN dbo.OrderTypes d ON a.OrderType = d.OrderType
    WHERE a.ShippedTime >= DATEADD(day, -7, CAST(SYSDATETIME() AS date))
      AND a.GenStatus = 6
      AND a.OrderType IN (1, 3, 4, 5, 8, 9, 10, 11, 12);

    -- 5: shipped-invoice threshold summary from the last 7 days
    SELECT
      COUNT(*) AS shippedInvoiceCount,
      SUM(CASE WHEN total < 199.00 THEN 1 ELSE 0 END) AS under199Count,
      ISNULL(SUM(CASE WHEN total < 199.00 THEN total ELSE 0 END), 0) AS under199Total,
      SUM(CASE WHEN total > 180.00 THEN 1 ELSE 0 END) AS over180Count,
      ISNULL(SUM(CASE WHEN total > 180.00 THEN total ELSE 0 END), 0) AS over180Total,
      SUM(CASE WHEN total > 180.00 AND total < 199.00 THEN 1 ELSE 0 END) AS overlapCount
    FROM #invoice_thresholds;

    -- 6: invoices matching Total < 199.00
    SELECT TOP (100)
      invoiceId, orderId, subtotal, taxAmount, total, invTypeName, rxNum,
      account, rxDate, shipDate, patient, customerName
    FROM #invoice_thresholds
    WHERE total < 199.00
    ORDER BY account, rxDate;

    -- 7: invoices matching Total > 180.00
    SELECT TOP (100)
      invoiceId, orderId, subtotal, taxAmount, total, invTypeName, rxNum,
      account, rxDate, shipDate, patient, customerName
    FROM #invoice_thresholds
    WHERE total > 180.00
    ORDER BY account, rxDate;

    IF OBJECT_ID('tempdb..#profitability_lines') IS NOT NULL
      DROP TABLE #profitability_lines;

    SELECT
      c.InvoiceID AS invoiceId,
      a.OrderID AS orderId,
      a.CustomerOrdReference AS rxNumber,
      origin.CustomerID AS customerId,
      origin.AccountNumber AS accountNumber,
      origin.CustomerName AS customerName,
      ot.OrderType AS orderType,
      ot.OrderTypeName AS orderTypeName,
      CAST(COALESCE(ot.Credit, 0) AS bit) AS isCredit,
      COALESCE(ot.OrderSign, CASE WHEN ot.Credit = 1 THEN -1 ELSE 1 END, 1) AS orderSign,
      d.Description AS description,
      d.SKU AS sku,
      a.ShippedTime AS shippedAt,
      d.CategoryType AS categoryType,
      COALESCE(CONVERT(nvarchar(120), d.CategoryType), N'Uncategorized') AS productGroup,
      CASE
        WHEN d.CategoryType IN (1, 16) THEN N'lens'
        WHEN d.CategoryType IN (4, 6, 7, 10, 11, 13) THEN N'addon'
        ELSE N'other'
      END AS lineKind,
      CAST(COALESCE(d.Quantity, 0) AS decimal(18, 4)) AS quantity,
      CAST(COALESCE(d.Quantity, 0) * COALESCE(ot.OrderSign, CASE WHEN ot.Credit = 1 THEN -1 ELSE 1 END, 1) AS decimal(18, 4)) AS signedQuantity,
      CAST(COALESCE(d.InvoicePrice, 0) AS decimal(18, 4)) AS unitPrice,
      CAST(CASE WHEN ot.Credit = 1 THEN -1 ELSE 1 END * COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0) AS decimal(18, 2)) AS lineRevenue,
      CAST(CASE
        WHEN COALESCE(ot.Credit, 0) = 0 AND ot.OrderType IN (1, 3, 12)
          THEN d.CostPrice
        ELSE NULL
      END AS decimal(18, 4)) AS unitCost,
      CAST(CASE
        WHEN COALESCE(ot.Credit, 0) = 0 AND ot.OrderType IN (1, 3, 12)
          THEN COALESCE(d.CostPrice, 0) * COALESCE(d.Quantity, 0)
        ELSE NULL
      END AS decimal(18, 2)) AS lineCost,
      CAST(CASE
        WHEN COALESCE(ot.Credit, 0) = 0 AND ot.OrderType IN (1, 3, 12)
          THEN (COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0)) - (COALESCE(d.CostPrice, 0) * COALESCE(d.Quantity, 0))
        ELSE NULL
      END AS decimal(18, 2)) AS marginAmount,
      CAST(CASE
        WHEN COALESCE(ot.Credit, 0) = 0
          AND ot.OrderType IN (1, 3, 12)
          AND COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0) > 0
          THEN (((COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0)) - (COALESCE(d.CostPrice, 0) * COALESCE(d.Quantity, 0)))
            / NULLIF(COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0), 0)) * 100
        ELSE NULL
      END AS decimal(18, 2)) AS marginPct,
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

    -- 8: profitability summary for shipped invoice lines from the last 30 days
    SELECT
      COUNT(DISTINCT invoiceId) AS invoiceCount,
      COUNT(*) AS lineCount,
      ISNULL(SUM(lineRevenue), 0) AS netRevenue,
      ISNULL(SUM(CASE WHEN lineCost IS NOT NULL THEN lineRevenue ELSE 0 END), 0) AS costedRevenue,
      ISNULL(SUM(lineCost), 0) AS totalCost,
      ISNULL(SUM(marginAmount), 0) AS marginAmount,
      CASE
        WHEN SUM(CASE WHEN lineCost IS NOT NULL THEN lineRevenue ELSE 0 END) > 0
          THEN (SUM(marginAmount) / NULLIF(SUM(CASE WHEN lineCost IS NOT NULL THEN lineRevenue ELSE 0 END), 0)) * 100
        ELSE NULL
      END AS marginPct,
      ISNULL(SUM(CASE WHEN isCredit = 1 THEN lineRevenue ELSE 0 END), 0) AS creditRevenue,
      SUM(CASE WHEN lineCost IS NOT NULL THEN 1 ELSE 0 END) AS costedLineCount,
      SUM(CASE WHEN isCredit = 0 AND orderType IN (1, 3, 12) AND unitCost IS NULL THEN 1 ELSE 0 END) AS missingCostLineCount
    FROM #profitability_lines;

    -- 9: profitability by customer
    SELECT TOP (20)
      accountNumber,
      customerName,
      COUNT(DISTINCT invoiceId) AS invoiceCount,
      COUNT(*) AS lineCount,
      ISNULL(SUM(lineRevenue), 0) AS netRevenue,
      ISNULL(SUM(CASE WHEN lineCost IS NOT NULL THEN lineRevenue ELSE 0 END), 0) AS costedRevenue,
      ISNULL(SUM(lineCost), 0) AS totalCost,
      ISNULL(SUM(marginAmount), 0) AS marginAmount,
      CASE
        WHEN SUM(CASE WHEN lineCost IS NOT NULL THEN lineRevenue ELSE 0 END) > 0
          THEN (SUM(marginAmount) / NULLIF(SUM(CASE WHEN lineCost IS NOT NULL THEN lineRevenue ELSE 0 END), 0)) * 100
        ELSE NULL
      END AS marginPct
    FROM #profitability_lines
    GROUP BY accountNumber, customerName
    ORDER BY marginAmount DESC, netRevenue DESC;

    -- 10: profitability by product category code
    SELECT TOP (20)
      productGroup,
      COUNT(*) AS lineCount,
      ISNULL(SUM(signedQuantity), 0) AS quantity,
      ISNULL(SUM(lineRevenue), 0) AS netRevenue,
      ISNULL(SUM(CASE WHEN lineCost IS NOT NULL THEN lineRevenue ELSE 0 END), 0) AS costedRevenue,
      ISNULL(SUM(lineCost), 0) AS totalCost,
      ISNULL(SUM(marginAmount), 0) AS marginAmount,
      CASE
        WHEN SUM(CASE WHEN lineCost IS NOT NULL THEN lineRevenue ELSE 0 END) > 0
          THEN (SUM(marginAmount) / NULLIF(SUM(CASE WHEN lineCost IS NOT NULL THEN lineRevenue ELSE 0 END), 0)) * 100
        ELSE NULL
      END AS marginPct
    FROM #profitability_lines
    GROUP BY productGroup
    ORDER BY marginAmount DESC, netRevenue DESC;

    -- 11: lowest-margin costed lines
    SELECT TOP (100)
      invoiceId, orderId, rxNumber, accountNumber, customerName, orderTypeName,
      description, sku, shippedAt, productGroup, quantity, unitPrice, unitCost,
      lineRevenue, lineCost, marginAmount, marginPct
    FROM #profitability_lines
    WHERE marginPct IS NOT NULL
    ORDER BY marginPct ASC, marginAmount ASC;

    -- 12: zero or missing cost exposure for lens and add-on invoice lines
    WITH zero_cost_lines AS (
      SELECT *
      FROM #profitability_lines
      WHERE isCredit = 0
        AND orderType IN (1, 3, 12)
        AND shippedAt >= DATEADD(day, -7, CAST(SYSDATETIME() AS date))
        AND lineRevenue > 0
        AND lineKind IN (N'lens', N'addon')
        AND COALESCE(unitCost, 0) = 0
    ),
    zero_cost_invoices AS (
      SELECT invoiceId, MAX(invoiceTotal) AS invoiceTotal
      FROM zero_cost_lines
      GROUP BY invoiceId
    )
    SELECT
      (SELECT COUNT(*) FROM zero_cost_invoices) AS invoiceCount,
      ISNULL((SELECT SUM(invoiceTotal) FROM zero_cost_invoices), 0) AS invoiceRevenue,
      COUNT(*) AS lineCount,
      ISNULL(SUM(lineRevenue), 0) AS lineRevenue,
      SUM(CASE WHEN lineKind = N'lens' THEN 1 ELSE 0 END) AS lensLineCount,
      ISNULL(SUM(CASE WHEN lineKind = N'lens' THEN signedQuantity ELSE 0 END), 0) AS lensQuantity,
      ISNULL(SUM(CASE WHEN lineKind = N'lens' THEN lineRevenue ELSE 0 END), 0) AS lensRevenue,
      SUM(CASE WHEN lineKind = N'addon' THEN 1 ELSE 0 END) AS addonLineCount,
      ISNULL(SUM(CASE WHEN lineKind = N'addon' THEN signedQuantity ELSE 0 END), 0) AS addonQuantity,
      ISNULL(SUM(CASE WHEN lineKind = N'addon' THEN lineRevenue ELSE 0 END), 0) AS addonRevenue,
      SUM(CASE WHEN unitCost IS NULL THEN 1 ELSE 0 END) AS missingCostLineCount
    FROM zero_cost_lines;

    -- 13: zero or missing cost line detail
    SELECT TOP (100)
      invoiceId, orderId, rxNumber, accountNumber, customerName, orderTypeName,
      description, sku, shippedAt, productGroup, lineKind, quantity, unitPrice,
      unitCost, lineRevenue, invoiceTotal
    FROM #profitability_lines
    WHERE isCredit = 0
      AND orderType IN (1, 3, 12)
      AND shippedAt >= DATEADD(day, -7, CAST(SYSDATETIME() AS date))
      AND lineRevenue > 0
      AND lineKind IN (N'lens', N'addon')
      AND COALESCE(unitCost, 0) = 0
    ORDER BY lineRevenue DESC, accountNumber, shippedAt DESC;
  `);

  const roll = result.recordsets[0][0] || {};
  const inv = result.recordsets[1][0] || {};
  const agingRows = result.recordsets[2] || [];
  const agingDef = result.recordsets[3][0] || {};
  const top = result.recordsets[4] || [];
  const invoiceSummary = result.recordsets[5][0] || {};
  const under199Invoices = result.recordsets[6] || [];
  const over180Invoices = result.recordsets[7] || [];
  const profitabilitySummary = result.recordsets[8]?.[0] || {};
  const profitabilityCustomers = result.recordsets[9] || [];
  const profitabilityProductGroups = result.recordsets[10] || [];
  const profitabilityLowMarginLines = result.recordsets[11] || [];
  const zeroCostSummary = result.recordsets[12]?.[0] || {};
  const zeroCostLines = result.recordsets[13] || [];

  const cogsYTD = num(roll.cogsYTD);
  const inventoryValue = num(inv.inventoryValue);
  // Stock turn = COGS (YTD) / current stock value. Inventory coverage in the
  // MSSQL mirror is partial, so this is indicative only (see caveats).
  const stockTurn = inventoryValue > 0 ? Number((cogsYTD / inventoryValue).toFixed(1)) : null;

  const bucketLabel = (n) => {
    switch (n) {
      case 0: return { label: "Current", detail: "not yet due" };
      case 1: return { label: agingDef.AgingDesc1 || "1–30 days", detail: `≤ ${num(agingDef.ActualDays1)} days` };
      case 2: return { label: agingDef.AgingDesc2 || "31–60 days", detail: `≤ ${num(agingDef.ActualDays2)} days` };
      case 3: return { label: agingDef.AgingDesc3 || "61–90 days", detail: `≤ ${num(agingDef.ActualDays3)} days` };
      case 4: return { label: agingDef.AgingDesc4 || "Over 120", detail: `> ${num(agingDef.ActualDays4)} days` };
      default: return { label: `Bucket ${n}`, detail: "" };
    }
  };

  const aging = [0, 1, 2, 3, 4].map((b) => {
    const row = agingRows.find((r) => num(r.bucket) === b);
    const meta = bucketLabel(b);
    return {
      bucket: b,
      label: meta.label,
      detail: meta.detail,
      amountDue: row ? num(row.amountDue) : 0,
      items: row ? num(row.items) : 0
    };
  });

  const caveats = [];
  caveats.push(`Stock turn uses YTD cost of sales ÷ current stock-lot value. Inventory coverage in the MSSQL mirror is partial (StockLotBalances empty, InvTransactions not mirrored), so treat stock turn as indicative; the authoritative inventory valuation lives in the Pervasive/Innovations source.`);

  return {
    asOf: new Date().toISOString(),
    customers: num(roll.customers),
    salesYTD: num(roll.salesYTD),
    salesMTD: num(roll.salesMTD),
    wipValue: num(roll.wipValue),
    receivables: num(roll.receivables),
    cogsYTD,
    inventoryValue,
    inventoryLots: num(inv.lots),
    stockTurn,
    stockTurnConfidence: "low",
    aging,
    agingTotal: aging.reduce((s, a) => s + a.amountDue, 0),
    invoiceThresholds: {
      lookbackDays: 7,
      shippedInvoiceCount: num(invoiceSummary.shippedInvoiceCount),
      under199: {
        threshold: 199,
        count: num(invoiceSummary.under199Count),
        total: num(invoiceSummary.under199Total),
        invoices: under199Invoices.map(invoiceThresholdPayload)
      },
      over180: {
        threshold: 180,
        count: num(invoiceSummary.over180Count),
        total: num(invoiceSummary.over180Total),
        invoices: over180Invoices.map(invoiceThresholdPayload)
      },
      overlapCount: num(invoiceSummary.overlapCount)
    },
    profitability: {
      lookbackDays: 30,
      invoiceCount: num(profitabilitySummary.invoiceCount),
      lineCount: num(profitabilitySummary.lineCount),
      netRevenue: num(profitabilitySummary.netRevenue),
      costedRevenue: num(profitabilitySummary.costedRevenue),
      totalCost: num(profitabilitySummary.totalCost),
      marginAmount: num(profitabilitySummary.marginAmount),
      marginPct: nullableNum(profitabilitySummary.marginPct),
      creditRevenue: num(profitabilitySummary.creditRevenue),
      costedLineCount: num(profitabilitySummary.costedLineCount),
      missingCostLineCount: num(profitabilitySummary.missingCostLineCount),
      zeroCost: {
        lookbackDays: 7,
        targetInvoiceCount: 0,
        invoiceCount: num(zeroCostSummary.invoiceCount),
        onTarget: num(zeroCostSummary.invoiceCount) === 0,
        invoiceRevenue: num(zeroCostSummary.invoiceRevenue),
        lineCount: num(zeroCostSummary.lineCount),
        lineRevenue: num(zeroCostSummary.lineRevenue),
        lensLineCount: num(zeroCostSummary.lensLineCount),
        lensQuantity: num(zeroCostSummary.lensQuantity),
        lensRevenue: num(zeroCostSummary.lensRevenue),
        addonLineCount: num(zeroCostSummary.addonLineCount),
        addonQuantity: num(zeroCostSummary.addonQuantity),
        addonRevenue: num(zeroCostSummary.addonRevenue),
        missingCostLineCount: num(zeroCostSummary.missingCostLineCount),
        exceptions: [
          "credit order types",
          "zero-dollar lines",
          "order types outside 1, 3, and 12",
          "categories outside lens and add-on billing paths"
        ],
        lines: zeroCostLines.map(zeroCostLinePayload)
      },
      byCustomer: profitabilityCustomers.map(profitabilityGroupPayload),
      byProductGroup: profitabilityProductGroups.map(profitabilityGroupPayload),
      lowMarginLines: profitabilityLowMarginLines.map(profitabilityLinePayload)
    },
    topCustomers: top.map((r) => ({
      name: r.name,
      accountNumber: r.accountNumber || null,
      salesYTD: num(r.salesYTD),
      balance: num(r.balance)
    })),
    caveats
  };
}

function profitabilityGroupPayload(row) {
  return {
    accountNumber: row.accountNumber || null,
    customerName: row.customerName || null,
    productGroup: row.productGroup || null,
    invoiceCount: num(row.invoiceCount),
    lineCount: num(row.lineCount),
    quantity: num(row.quantity),
    netRevenue: num(row.netRevenue),
    costedRevenue: num(row.costedRevenue),
    totalCost: num(row.totalCost),
    marginAmount: num(row.marginAmount),
    marginPct: nullableNum(row.marginPct)
  };
}

function profitabilityLinePayload(row) {
  return {
    invoiceId: row.invoiceId ?? null,
    orderId: row.orderId ?? null,
    rxNumber: row.rxNumber || null,
    accountNumber: row.accountNumber || null,
    customerName: row.customerName || null,
    orderTypeName: row.orderTypeName || null,
    description: row.description || null,
    sku: row.sku || null,
    shippedAt: row.shippedAt || null,
    productGroup: row.productGroup || null,
    quantity: num(row.quantity),
    unitPrice: num(row.unitPrice),
    unitCost: nullableNum(row.unitCost),
    lineRevenue: num(row.lineRevenue),
    lineCost: nullableNum(row.lineCost),
    marginAmount: nullableNum(row.marginAmount),
    marginPct: nullableNum(row.marginPct)
  };
}

function zeroCostLinePayload(row) {
  return {
    invoiceId: row.invoiceId ?? null,
    orderId: row.orderId ?? null,
    rxNumber: row.rxNumber || null,
    accountNumber: row.accountNumber || null,
    customerName: row.customerName || null,
    orderTypeName: row.orderTypeName || null,
    description: row.description || null,
    sku: row.sku || null,
    shippedAt: row.shippedAt || null,
    productGroup: row.productGroup || null,
    lineKind: row.lineKind || null,
    quantity: num(row.quantity),
    unitPrice: num(row.unitPrice),
    unitCost: nullableNum(row.unitCost),
    lineRevenue: num(row.lineRevenue),
    invoiceTotal: num(row.invoiceTotal)
  };
}

function invoiceThresholdPayload(row) {
  return {
    invoiceId: row.invoiceId ?? null,
    orderId: row.orderId ?? null,
    subtotal: num(row.subtotal),
    taxAmount: num(row.taxAmount),
    total: num(row.total),
    invTypeName: row.invTypeName || null,
    rxNum: row.rxNum || null,
    account: row.account || null,
    rxDate: row.rxDate || null,
    shipDate: row.shipDate || null,
    patient: row.patient || null,
    customerName: row.customerName || null
  };
}

/** Locally available data: imported Access archive + app-owned delivery/pricing. */
async function getLocalMetrics() {
  const pool = await getAppPool();
  const result = await pool.request().query(`
    SELECT
      (SELECT COUNT(*) FROM archive.access_deliveries) AS deliveriesTotal,
      (SELECT COUNT(*) FROM archive.access_deliveries WHERE YEAR(delivery_date) = YEAR(GETDATE())) AS deliveriesThisYear,
      (SELECT COUNT(*) FROM archive.access_delivery_items) AS deliveryItemsTotal,
      (SELECT ISNULL(SUM(total), 0) FROM archive.access_delivery_items) AS archivedRevenueTotal,
      (SELECT COUNT(*) FROM archive.access_commercial_invoices) AS commercialInvoicesTotal,
      (SELECT COUNT(*) FROM delivery.shipment_sessions WHERE app_status = N'prep') AS openExportSessions,
      (SELECT COUNT(*) FROM delivery.shipment_sessions) AS shipmentSessionsTotal,
      (SELECT COUNT(*) FROM pricing.price_rules WHERE is_active = 1) AS activePricingRules,
      (SELECT MIN(CAST(delivery_date AS date)) FROM archive.access_deliveries) AS archiveMinDate,
      (SELECT MAX(CAST(delivery_date AS date)) FROM archive.access_deliveries) AS archiveMaxDate;

    SELECT TOP (1)
      history_months AS historyMonths, cutoff_date AS cutoffDate,
      completed_at AS completedAt, status AS status, source_path AS sourcePath
    FROM archive.access_import_batches ORDER BY started_at DESC;

    SELECT
      FORMAT(d.delivery_date, 'yyyy-MM') AS ym,
      COUNT(DISTINCT d.legacy_delivery_no) AS deliveries,
      COUNT(i.legacy_item_id) AS items,
      ISNULL(SUM(i.total), 0) AS revenue
    FROM archive.access_deliveries d
    LEFT JOIN archive.access_delivery_items i ON i.legacy_delivery_no = d.legacy_delivery_no
    WHERE d.delivery_date IS NOT NULL
    GROUP BY FORMAT(d.delivery_date, 'yyyy-MM')
    ORDER BY ym;

    SELECT TOP (10)
      i.customer_id AS customerId, SUM(ISNULL(i.total, 0)) AS revenue, COUNT(*) AS items,
      ca.branchName, ca.accountNumber
    FROM archive.access_delivery_items i
    OUTER APPLY (
      SELECT TOP (1) CAST(b.branch_name AS nvarchar(200)) AS branchName, b.account_number AS accountNumber
      FROM archive.access_customer_branches b WHERE b.customer_id = i.customer_id ORDER BY b.legacy_branch_id
    ) ca
    WHERE i.customer_id IS NOT NULL
    GROUP BY i.customer_id, ca.branchName, ca.accountNumber
    ORDER BY revenue DESC;

    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN app_status = N'prep' THEN 1 ELSE 0 END) AS openPrep,
      SUM(CASE WHEN app_status = N'closed' THEN 1 ELSE 0 END) AS closed,
      SUM(CASE WHEN reopened_at IS NOT NULL THEN 1 ELSE 0 END) AS reopened
    FROM delivery.shipment_sessions;

    SELECT
      (SELECT COUNT(*) FROM archive.access_couriers) AS couriersTotal,
      (SELECT COUNT(*) FROM archive.access_couriers WHERE overseas_courier = 1) AS overseasCouriers,
      (SELECT ISNULL(SUM(freight_cost), 0) FROM archive.access_commercial_invoices) AS freightCostTotal,
      (SELECT ISNULL(SUM(packing_cost), 0) FROM archive.access_commercial_invoices) AS packingCostTotal,
      (SELECT ISNULL(SUM(insurance_cost), 0) FROM archive.access_commercial_invoices) AS insuranceCostTotal,
      (SELECT ISNULL(SUM(other_cost), 0) FROM archive.access_commercial_invoices) AS otherCostTotal;

    SELECT
      (SELECT COUNT(*) FROM pricing.price_rules) AS rulesTotal,
      (SELECT COUNT(*) FROM pricing.price_rules WHERE is_active = 1) AS rulesActive,
      (SELECT COUNT(*) FROM pricing.price_calculations) AS calculationsTotal,
      (SELECT ISNULL(AVG(calculated_price - input_price), 0) FROM pricing.price_calculations) AS avgAdjustment,
      (SELECT MAX(created_at) FROM pricing.price_calculations) AS lastCalculationAt;
  `);

  const core = result.recordsets[0][0] || {};
  const batch = result.recordsets[1][0] || null;
  const byMonth = result.recordsets[2] || [];
  const topCustomers = result.recordsets[3] || [];
  const sessions = result.recordsets[4][0] || {};
  const logistics = result.recordsets[5][0] || {};
  const pricing = result.recordsets[6][0] || {};

  const deliveriesTotal = num(core.deliveriesTotal);
  const deliveryItemsTotal = num(core.deliveryItemsTotal);
  const avgItemsPerDelivery = deliveriesTotal > 0 ? Number((deliveryItemsTotal / deliveriesTotal).toFixed(1)) : 0;

  return {
    overview: {
      deliveriesTotal,
      deliveriesThisYear: num(core.deliveriesThisYear),
      deliveryItemsTotal,
      archivedRevenueTotal: num(core.archivedRevenueTotal),
      commercialInvoicesTotal: num(core.commercialInvoicesTotal),
      openExportSessions: num(core.openExportSessions),
      shipmentSessionsTotal: num(core.shipmentSessionsTotal),
      activePricingRules: num(core.activePricingRules),
      archiveWindow: {
        min: core.archiveMinDate || null,
        max: core.archiveMaxDate || null,
        historyMonths: batch ? num(batch.historyMonths) : null,
        cutoffDate: batch ? batch.cutoffDate : null,
        completedAt: batch ? batch.completedAt : null,
        status: batch ? batch.status : null
      }
    },
    sales: {
      archivedRevenueTotal: num(core.archivedRevenueTotal),
      revenueByMonth: byMonth.map((r) => ({ month: r.ym, revenue: num(r.revenue), deliveries: num(r.deliveries), items: num(r.items) })),
      topCustomers: topCustomers.map((r) => ({
        customerId: num(r.customerId),
        name: r.branchName || r.accountNumber || `Customer ${r.customerId}`,
        accountNumber: r.accountNumber || null,
        revenue: num(r.revenue),
        items: num(r.items)
      }))
    },
    deliveries: {
      appOwned: { total: num(sessions.total), openPrep: num(sessions.openPrep), closed: num(sessions.closed), reopened: num(sessions.reopened) },
      archive: {
        deliveriesTotal,
        deliveriesThisYear: num(core.deliveriesThisYear),
        avgItemsPerDelivery,
        couriersTotal: num(logistics.couriersTotal),
        overseasCouriers: num(logistics.overseasCouriers),
        commercialInvoicesTotal: num(core.commercialInvoicesTotal),
        freightCostTotal: num(logistics.freightCostTotal),
        packingCostTotal: num(logistics.packingCostTotal),
        insuranceCostTotal: num(logistics.insuranceCostTotal),
        otherCostTotal: num(logistics.otherCostTotal)
      },
      byMonth: byMonth.map((r) => ({ month: r.ym, deliveries: num(r.deliveries), items: num(r.items) }))
    },
    pricing: {
      rulesTotal: num(pricing.rulesTotal),
      rulesActive: num(pricing.rulesActive),
      calculationsTotal: num(pricing.calculationsTotal),
      avgAdjustment: num(pricing.avgAdjustment),
      lastCalculationAt: pricing.lastCalculationAt || null
    }
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

module.exports = { getBusinessMetrics };
