const { getAppPool, checkAppDatabase, checkSourceDatabase } = require("./db");
const { checkPsqlDatabase } = require("./psql-odbc");

/**
 * Business metrics aggregation.
 *
 * Pulls everything that is available *locally* in the private app database
 * (optilens_local): the imported Access archive plus app-owned delivery and
 * pricing data. Live MSSQL / PSQL Innovations source connections are reported
 * via `sources` and degrade gracefully — the live-only views light up once
 * those credentials are configured in the vault.
 */
async function getBusinessMetrics() {
  const generatedAt = new Date().toISOString();

  const [appHealth, sourceHealth, psqlHealth] = await Promise.all([
    checkAppDatabase(),
    checkSourceDatabase(),
    checkPsqlDatabase()
  ]);

  const sources = {
    appDb: appHealth,
    sourceMssql: sourceHealth,
    sourcePsql: psqlHealth
  };
  const liveSourceOnline = sourceHealth.state === "online";

  // Without the private app DB there is nothing local to show.
  if (appHealth.state !== "online") {
    return {
      generatedAt,
      appDbOnline: false,
      liveSourceOnline,
      sources,
      overview: null,
      sales: null,
      deliveries: null,
      pricing: null,
      notes: [`Private app database is not available: ${appHealth.detail}`]
    };
  }

  const pool = await getAppPool();
  const result = await pool.request().query(`
    -- 0: overview core counts
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

    -- 1: latest import batch
    SELECT TOP (1)
      history_months AS historyMonths,
      cutoff_date AS cutoffDate,
      completed_at AS completedAt,
      status AS status,
      source_path AS sourcePath
    FROM archive.access_import_batches
    ORDER BY started_at DESC;

    -- 2: archive revenue / deliveries by month
    SELECT
      FORMAT(d.delivery_date, 'yyyy-MM') AS ym,
      COUNT(DISTINCT d.legacy_delivery_no) AS deliveries,
      COUNT(i.legacy_item_id) AS items,
      ISNULL(SUM(i.total), 0) AS revenue
    FROM archive.access_deliveries d
    LEFT JOIN archive.access_delivery_items i
      ON i.legacy_delivery_no = d.legacy_delivery_no
    WHERE d.delivery_date IS NOT NULL
    GROUP BY FORMAT(d.delivery_date, 'yyyy-MM')
    ORDER BY ym;

    -- 3: top customers by archived revenue
    SELECT TOP (10)
      i.customer_id AS customerId,
      SUM(ISNULL(i.total, 0)) AS revenue,
      COUNT(*) AS items,
      ca.branchName,
      ca.accountNumber
    FROM archive.access_delivery_items i
    OUTER APPLY (
      SELECT TOP (1)
        CAST(b.branch_name AS nvarchar(200)) AS branchName,
        b.account_number AS accountNumber
      FROM archive.access_customer_branches b
      WHERE b.customer_id = i.customer_id
      ORDER BY b.legacy_branch_id
    ) ca
    WHERE i.customer_id IS NOT NULL
    GROUP BY i.customer_id, ca.branchName, ca.accountNumber
    ORDER BY revenue DESC;

    -- 4: app-owned delivery sessions breakdown
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN app_status = N'prep' THEN 1 ELSE 0 END) AS openPrep,
      SUM(CASE WHEN app_status = N'closed' THEN 1 ELSE 0 END) AS closed,
      SUM(CASE WHEN reopened_at IS NOT NULL THEN 1 ELSE 0 END) AS reopened
    FROM delivery.shipment_sessions;

    -- 5: couriers + commercial invoice cost totals
    SELECT
      (SELECT COUNT(*) FROM archive.access_couriers) AS couriersTotal,
      (SELECT COUNT(*) FROM archive.access_couriers WHERE overseas_courier = 1) AS overseasCouriers,
      (SELECT ISNULL(SUM(freight_cost), 0) FROM archive.access_commercial_invoices) AS freightCostTotal,
      (SELECT ISNULL(SUM(packing_cost), 0) FROM archive.access_commercial_invoices) AS packingCostTotal,
      (SELECT ISNULL(SUM(insurance_cost), 0) FROM archive.access_commercial_invoices) AS insuranceCostTotal,
      (SELECT ISNULL(SUM(other_cost), 0) FROM archive.access_commercial_invoices) AS otherCostTotal;

    -- 6: pricing
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
  const avgItemsPerDelivery = deliveriesTotal > 0
    ? Number((deliveryItemsTotal / deliveriesTotal).toFixed(1))
    : 0;

  const liveNote = liveSourceOnline
    ? null
    : `Live product- and period-level revenue requires the MSSQL Innovations source (currently ${sourceHealth.state}). Figures below are from the imported Access archive.`;

  return {
    generatedAt,
    appDbOnline: true,
    liveSourceOnline,
    currency: "BBD",
    sources,
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
      revenueByMonth: byMonth.map((r) => ({
        month: r.ym,
        revenue: num(r.revenue),
        deliveries: num(r.deliveries),
        items: num(r.items)
      })),
      topCustomers: topCustomers.map((r) => ({
        customerId: num(r.customerId),
        name: r.branchName || r.accountNumber || `Customer ${r.customerId}`,
        accountNumber: r.accountNumber || null,
        revenue: num(r.revenue),
        items: num(r.items)
      })),
      liveNote
    },
    deliveries: {
      appOwned: {
        total: num(sessions.total),
        openPrep: num(sessions.openPrep),
        closed: num(sessions.closed),
        reopened: num(sessions.reopened)
      },
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
      byMonth: byMonth.map((r) => ({
        month: r.ym,
        deliveries: num(r.deliveries),
        items: num(r.items)
      }))
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
