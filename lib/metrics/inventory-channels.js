// Channel splits for the Inventory tab: export vs local, outsourced vs in-house.
//
// Both are measured three ways — lens units, job count and revenue — because
// they answer different questions: units drive purchasing, jobs drive capacity,
// revenue drives whether the channel is worth serving.
//
// ── Export classification ────────────────────────────────────────────────────
// By shipping METHOD, layered, most reliable source first:
//   1. the method on the actual shipment  (covers 18,795 of 21,711 orders, 87%)
//   2. the customer's default method      (covers 21,708, 99.99%)
//   3. the customer's country             (Barbados = local, anything else = export)
// Anything still unresolved becomes a visible "unknown" bucket, never a guess.
//
// Two traps this deliberately avoids:
//   - Orders.ShipMethodID is NULL on every order in the window. It looks like
//     the obvious column and it is empty.
//   - ShippingCarrierID does NOT identify export. Method 5 ("0 Randall Hunte -
//     Delivery", code LOCAL) carries ShippingCarrierID 3 (DHL), so classifying
//     by carrier files the local van driver as an export courier. Match on the
//     method NAME/CODE instead.
//
// ── Outsourcing ──────────────────────────────────────────────────────────────
// Farmouts.LabID joins to Labs.num, NOT Labs.LabID — the wrong join returns
// customers (schools, opticians) as if they were labs.
//
// "No Lab Selected" (Labs.num = 1) is excluded: it is a placeholder, not an
// outsourcing decision, and counting it overstates outsourcing by ~5 points.
// "Customer Lens Edge" is kept but reported on its own line, since customer
// supplied edging is arguably not outsourcing at all — the caller can decide.

const sql = require("mssql");
const { getLiveSourcePool } = require("../db");

// Lens units come from invoiced lines, not RxArchive: NumRights/NumLefts are
// entirely zero in this database, and invoiced quantity is what "lenses sold"
// means commercially anyway.
const LENS_CATEGORY_TYPE = 1;

const NO_LAB_SELECTED = 1;

/**
 * Shared order-level spine. One row per shipped order in the window carrying
 * its channel, its lab, its lens units and its revenue, so both splits are
 * derived from exactly the same population and always reconcile to each other.
 */
function orderSpineSql() {
  return `
    WITH shipMethod AS (
      SELECT si.OrderID, MIN(sh.ShippingMethodID) AS shippingMethodId
      FROM dbo.ShipmentItems si
      INNER JOIN dbo.Shipments sh ON sh.ShipmentID = si.ShipmentID
      WHERE sh.ShippingMethodID IS NOT NULL
      GROUP BY si.OrderID
    ),
    custCountry AS (
      SELECT CustomerID, MIN(CountryID) AS CountryID
      FROM dbo.CustomerAddresses
      WHERE CountryID IS NOT NULL
      GROUP BY CustomerID
    ),
    lensUnits AS (
      SELECT i.OrderID, SUM(il.Quantity) AS units, COUNT(*) AS lines
      FROM dbo.Invoices i
      INNER JOIN dbo.InvoiceLines il ON il.InvoiceID = i.InvoiceID
      WHERE il.CategoryType = ${LENS_CATEGORY_TYPE}
      GROUP BY i.OrderID
    ),
    revenue AS (
      SELECT OrderID, SUM(SubTotal) AS revenue
      FROM dbo.FinARSalesJournal
      GROUP BY OrderID
    ),
    farmout AS (
      -- NULLIF drops the "No Lab Selected" placeholder BEFORE picking a lab, so
      -- an order that was genuinely farmed out and also carries a placeholder
      -- row still counts as outsourced. A plain MIN() collapsed those to the
      -- placeholder and under-counted outsourcing.
      SELECT f.OrderID,
             COALESCE(MIN(NULLIF(f.LabID, ${NO_LAB_SELECTED})), ${NO_LAB_SELECTED}) AS labNum
      FROM dbo.Farmouts f
      WHERE f.Active = 1
      GROUP BY f.OrderID
    ),
    spine AS (
      SELECT
        o.OrderID,
        o.CustomerID,
        cu.CustomerName,
        cu.AccountNumber,
        COALESCE(smShip.ShippingMethodName, smCust.ShippingMethodName) AS methodName,
        COALESCE(smShip.Code, smCust.Code) AS methodCode,
        CASE WHEN smShip.ShippingMethodID IS NOT NULL THEN 'shipment'
             WHEN smCust.ShippingMethodID IS NOT NULL THEN 'customer-default'
             WHEN cc.CountryID IS NOT NULL THEN 'country'
             ELSE 'none' END AS methodSource,
        co.CountryName,
        ISNULL(lu.units, 0) AS lensUnits,
        ISNULL(rv.revenue, 0) AS revenue,
        fo.labNum,
        lb.Name AS labName
      FROM dbo.Orders o
      LEFT JOIN dbo.Customers cu ON cu.CustomerID = o.CustomerID
      LEFT JOIN dbo.ShippingMethods smCust ON smCust.ShippingMethodID = cu.ShippingMethodID
      LEFT JOIN shipMethod sm ON sm.OrderID = o.OrderID
      LEFT JOIN dbo.ShippingMethods smShip ON smShip.ShippingMethodID = sm.shippingMethodId
      LEFT JOIN custCountry cc ON cc.CustomerID = o.CustomerID
      LEFT JOIN dbo.Countries co ON co.CountryID = cc.CountryID
      LEFT JOIN lensUnits lu ON lu.OrderID = o.OrderID
      LEFT JOIN revenue rv ON rv.OrderID = o.OrderID
      LEFT JOIN farmout fo ON fo.OrderID = o.OrderID
      LEFT JOIN dbo.Labs lb ON lb.num = fo.labNum
      WHERE o.ShippedTime >= DATEADD(month, -@windowMonths, GETDATE())
        AND o.ShippedTime IS NOT NULL
    ),
    classified AS (
      SELECT *,
        CASE
          WHEN methodName LIKE '%DHL%' OR methodName LIKE '%FedEx%' OR methodName LIKE '%Export%' THEN 'export'
          WHEN methodCode IS NOT NULL THEN 'local'
          WHEN CountryName IS NULL THEN 'unknown'
          WHEN CountryName = 'Barbados' THEN 'local'
          ELSE 'export'
        END AS channel,
        CASE
          WHEN labNum IS NULL OR labNum = ${NO_LAB_SELECTED} THEN 'in_house'
          ELSE 'outsourced'
        END AS fulfilment
      FROM spine
    )`;
}

async function getChannelSplits(windowMonths) {
  const pool = await getLiveSourcePool();
  const request = pool.request().input("windowMonths", sql.Int, windowMonths);

  const result = await request.query(`
    ${orderSpineSql()}
    SELECT channel, COUNT(*) AS jobs, SUM(lensUnits) AS lensUnits,
           CAST(SUM(revenue) AS decimal(18,2)) AS revenue
    FROM classified GROUP BY channel;

    ${orderSpineSql()}
    SELECT fulfilment, COUNT(*) AS jobs, SUM(lensUnits) AS lensUnits,
           CAST(SUM(revenue) AS decimal(18,2)) AS revenue
    FROM classified GROUP BY fulfilment;

    ${orderSpineSql()}
    SELECT ISNULL(labName, '(unknown lab)') AS labName, labNum,
           COUNT(*) AS jobs, SUM(lensUnits) AS lensUnits,
           CAST(SUM(revenue) AS decimal(18,2)) AS revenue
    FROM classified
    WHERE fulfilment = 'outsourced'
    GROUP BY labName, labNum
    ORDER BY jobs DESC;

    ${orderSpineSql()}
    SELECT ISNULL(CountryName, '(country not set)') AS countryName, channel,
           COUNT(DISTINCT CustomerID) AS customers, COUNT(*) AS jobs,
           SUM(lensUnits) AS lensUnits, CAST(SUM(revenue) AS decimal(18,2)) AS revenue
    FROM classified
    GROUP BY CountryName, channel
    ORDER BY jobs DESC;

    ${orderSpineSql()}
    SELECT methodSource, COUNT(*) AS jobs FROM classified GROUP BY methodSource;
  `);

  const [channels, fulfilment, byLab, byCountry, bySource] = result.recordsets;

  const pick = (rows, key, value) => rows.find((r) => r[key] === value)
    || { jobs: 0, lensUnits: 0, revenue: 0 };

  const total = (rows) => rows.reduce((acc, r) => ({
    jobs: acc.jobs + num(r.jobs),
    lensUnits: acc.lensUnits + num(r.lensUnits),
    revenue: acc.revenue + num(r.revenue)
  }), { jobs: 0, lensUnits: 0, revenue: 0 });

  const channelTotals = total(channels);
  const fulfilTotals = total(fulfilment);

  // "Customer Lens Edge" is customer-supplied edging. It is reported on its own
  // line rather than folded into outsourcing, because whether it counts is a
  // business judgement, not a data question.
  const customerEdge = byLab.find((r) => /customer lens edge/i.test(r.labName || ""));

  return {
    export: {
      total: channelTotals,
      rows: ["export", "local", "unknown"].map((c) => {
        const row = pick(channels, "channel", c);
        return {
          channel: c,
          label: c === "export" ? "Export" : c === "local" ? "Local" : "Unclassified",
          jobs: num(row.jobs),
          lensUnits: num(row.lensUnits),
          revenue: num(row.revenue),
          jobShare: share(num(row.jobs), channelTotals.jobs),
          unitShare: share(num(row.lensUnits), channelTotals.lensUnits),
          revenueShare: share(num(row.revenue), channelTotals.revenue)
        };
      }),
      byCountry: byCountry.map((r) => ({
        countryName: r.countryName,
        channel: r.channel,
        customers: num(r.customers),
        jobs: num(r.jobs),
        lensUnits: num(r.lensUnits),
        revenue: num(r.revenue)
      })),
      classifierCoverage: bySource.map((r) => ({ source: r.methodSource, jobs: num(r.jobs) }))
    },

    fulfilment: {
      total: fulfilTotals,
      rows: ["outsourced", "in_house"].map((f) => {
        const row = pick(fulfilment, "fulfilment", f);
        return {
          fulfilment: f,
          label: f === "outsourced" ? "Outsourced" : "In-house",
          jobs: num(row.jobs),
          lensUnits: num(row.lensUnits),
          revenue: num(row.revenue),
          jobShare: share(num(row.jobs), fulfilTotals.jobs),
          unitShare: share(num(row.lensUnits), fulfilTotals.lensUnits),
          revenueShare: share(num(row.revenue), fulfilTotals.revenue)
        };
      }),
      byLab: byLab.map((r) => ({
        labName: r.labName,
        labNum: r.labNum,
        jobs: num(r.jobs),
        lensUnits: num(r.lensUnits),
        revenue: num(r.revenue),
        jobShare: share(num(r.jobs), fulfilTotals.jobs)
      })),
      customerSuppliedEdging: customerEdge
        ? {
            labName: customerEdge.labName,
            jobs: num(customerEdge.jobs),
            note: "Customer-supplied edging. Counted as outsourced above; exclude it and outsourcing falls by this many jobs."
          }
        : null
    }
  };
}

function num(v) { return v == null ? 0 : Number(v); }

function share(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

module.exports = { getChannelSplits };
