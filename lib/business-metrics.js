// Business metrics module — live MSSQL KPIs + local archive context.
const { getAppPool, getSourcePool, checkAppDatabase, checkSourceDatabase } = require("./db");
const { checkPsqlDatabase } = require("./psql-odbc");

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

// Hard ceilings so a hung DB/network can never block the HTTP response.
const HEALTH_TIMEOUT_MS = 9000;
const PSQL_TIMEOUT_MS = 12000;
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

async function safeHealth(promise, name, ms) {
  try {
    return await withTimeout(promise, ms, name);
  } catch (err) {
    return { name, state: err.isTimeout ? "timeout" : "error", detail: err.message };
  }
}

async function getBusinessMetrics() {
  const generatedAt = new Date().toISOString();

  const [appHealth, sourceHealth, psqlHealth] = await Promise.all([
    safeHealth(checkAppDatabase(), "Private app MSSQL", HEALTH_TIMEOUT_MS),
    safeHealth(checkSourceDatabase(), "Source MSSQL Innovations", HEALTH_TIMEOUT_MS),
    safeHealth(checkPsqlDatabase(), "PSQL Innovations", PSQL_TIMEOUT_MS)
  ]);

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
  `);

  const roll = result.recordsets[0][0] || {};
  const inv = result.recordsets[1][0] || {};
  const agingRows = result.recordsets[2] || [];
  const agingDef = result.recordsets[3][0] || {};
  const top = result.recordsets[4] || [];

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
    topCustomers: top.map((r) => ({
      name: r.name,
      accountNumber: r.accountNumber || null,
      salesYTD: num(r.salesYTD),
      balance: num(r.balance)
    })),
    caveats
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

module.exports = { getBusinessMetrics };
