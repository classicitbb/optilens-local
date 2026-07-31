// Overview-tab summary — live Innovations MSSQL only.
//
// Deliberately narrower than lib/business-metrics.js: this powers tab 1 alone, so it
// must be cheap enough to auto-refresh. No app-database reads, no Actian/PSQL, no
// Access archive — see docs/BUSINESS_METRICS_OVERVIEW_PLAN.md.
//
// SALES BASIS. Every sales figure comes from FinARSalesJournal.SubTotal keyed on
// InvoiceTime. That is what the LMS's own CustomerBalances.SalesValueYTD roll-up is
// built from — they agree to 0.08% in aggregate and to the cent for most customers.
// Do not switch this to Invoices.Total or Orders.ShippedTime: that is tax-inclusive on
// a different date and lands ~25% high, which would make every comparator on the tab
// quote a different population than the value above it.

const sql = require("mssql");
const { getSourcePool, checkSourceDatabase } = require("../db");

const QUERY_TIMEOUT_MS = 15000;

const PERIODS = {
  mtd: { label: "Month to date", priorLabel: "same month last year" },
  qtd: { label: "Quarter to date", priorLabel: "same quarter last year" },
  ytd: { label: "Year to date", priorLabel: "same period last year" },
  r12: { label: "Rolling 12 months", priorLabel: "preceding 12 months" }
};

const ZERO_COST_LOOKBACK_DAYS = 7;
const WIP_STALE_DAYS = 7;
const TREND_MONTHS = 25;

function withTimeout(promise, ms, label) {
  return Promise.race([
    Promise.resolve().then(() => promise),
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { isTimeout: true })), ms)
    )
  ]);
}

/** Period boundaries, plus the matching prior-period window for comparators. */
function periodRange(period, now) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const endExclusive = new Date(y, m, now.getDate() + 1);

  switch (period) {
    case "mtd":
      return {
        start: new Date(y, m, 1),
        end: endExclusive,
        priorStart: new Date(y - 1, m, 1),
        priorEnd: new Date(y - 1, m, now.getDate() + 1)
      };
    case "qtd": {
      const q = Math.floor(m / 3) * 3;
      return {
        start: new Date(y, q, 1),
        end: endExclusive,
        priorStart: new Date(y - 1, q, 1),
        priorEnd: new Date(y - 1, m, now.getDate() + 1)
      };
    }
    case "r12": {
      const start = new Date(y, m - 11, 1);
      return {
        start,
        end: endExclusive,
        priorStart: new Date(y - 1, m - 11, 1),
        priorEnd: start
      };
    }
    case "ytd":
    default:
      return {
        start: new Date(y, 0, 1),
        end: endExclusive,
        priorStart: new Date(y - 1, 0, 1),
        priorEnd: new Date(y - 1, m, now.getDate() + 1)
      };
  }
}

async function getOverviewSummary({ period = "ytd" } = {}) {
  const periodKey = PERIODS[period] ? period : "ytd";
  const generatedAt = new Date().toISOString();

  // Only the Innovations source is checked — this tab reads nothing else, so the full
  // integration snapshot (app DB, Actian/PSQL, mirror, sync task) would be dead weight
  // on every auto-refresh.
  const source = await checkSourceDatabase();

  if (source.state !== "online") {
    return {
      generatedAt,
      currency: "BBD",
      period: periodKey,
      periodLabel: PERIODS[periodKey].label,
      online: false,
      source: { name: source.name, state: source.state, detail: source.detail },
      error: `Innovations (MSSQL) source is ${source.state}.`
    };
  }

  try {
    const data = await withTimeout(queryOverview(periodKey), QUERY_TIMEOUT_MS, "Overview summary query");
    return {
      generatedAt,
      currency: "BBD",
      period: periodKey,
      periodLabel: PERIODS[periodKey].label,
      online: true,
      source: { name: source.name, state: source.state, detail: source.detail },
      ...data
    };
  } catch (error) {
    return {
      generatedAt,
      currency: "BBD",
      period: periodKey,
      periodLabel: PERIODS[periodKey].label,
      online: false,
      source: { name: source.name, state: source.state, detail: source.detail },
      error: error.message
    };
  }
}

async function queryOverview(periodKey) {
  const pool = await getSourcePool();
  const now = new Date();
  const range = periodRange(periodKey, now);

  // Trend needs 12 extra months behind the window so each month can carry its own
  // prior-year value for the overlay.
  const trendStart = new Date(now.getFullYear(), now.getMonth() - (TREND_MONTHS - 1) - 12, 1);
  const rolling365Start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 365);

  const request = pool.request();
  request.input("pStart", sql.DateTime2, range.start);
  request.input("pEnd", sql.DateTime2, range.end);
  request.input("pPriorStart", sql.DateTime2, range.priorStart);
  request.input("pPriorEnd", sql.DateTime2, range.priorEnd);
  request.input("trendStart", sql.DateTime2, trendStart);
  request.input("r365Start", sql.DateTime2, rolling365Start);
  request.input("zeroCostDays", sql.Int, ZERO_COST_LOOKBACK_DAYS);
  request.input("wipStaleDays", sql.Int, WIP_STALE_DAYS);

  const result = await request.query(`
    -- 0: sales for the selected period and its prior-year counterpart
    SELECT
      ISNULL(SUM(CASE WHEN InvoiceTime >= @pStart AND InvoiceTime < @pEnd THEN SubTotal END), 0) AS periodSales,
      ISNULL(SUM(CASE WHEN InvoiceTime >= @pPriorStart AND InvoiceTime < @pPriorEnd THEN SubTotal END), 0) AS priorSales,
      ISNULL(SUM(CASE WHEN InvoiceTime >= @r365Start THEN SubTotal END), 0) AS sales365,
      COUNT(DISTINCT CASE WHEN InvoiceTime >= @pStart AND InvoiceTime < @pEnd THEN InvoiceID END) AS periodInvoices
    FROM dbo.FinARSalesJournal;

    -- 1: monthly series for the trend and its prior-year overlay
    SELECT FORMAT(InvoiceTime, 'yyyy-MM') AS ym,
           ISNULL(SUM(SubTotal), 0) AS net,
           COUNT(DISTINCT InvoiceID) AS invoices
    FROM dbo.FinARSalesJournal
    WHERE InvoiceTime >= @trendStart
    GROUP BY FORMAT(InvoiceTime, 'yyyy-MM')
    ORDER BY ym;

    -- 2: LMS roll-ups (authoritative receivables + WIP)
    SELECT
      COUNT(*) AS customers,
      ISNULL(SUM(CurrentBalance), 0) AS receivables,
      ISNULL(SUM(CurrentWIPValue), 0) AS wipValue,
      ISNULL(SUM(SalesValueYTD), 0) AS lmsSalesYTD,
      SUM(CASE WHEN CreditLimit > 0 THEN 1 ELSE 0 END) AS withCreditLimit
    FROM dbo.CustomerBalances;

    -- 3: open (unshipped) orders — makes the WIP figure actionable
    SELECT
      COUNT(*) AS openOrders,
      ISNULL(AVG(CAST(DATEDIFF(day, a.ReceivedTime, SYSDATETIME()) AS float)), 0) AS avgAgeDays,
      SUM(CASE WHEN DATEDIFF(day, a.ReceivedTime, SYSDATETIME()) > @wipStaleDays THEN 1 ELSE 0 END) AS staleOrders
    FROM dbo.Orders a
    INNER JOIN dbo.GenStatus g ON g.GenStatus = a.GenStatus
    WHERE g.Shipped = 0 AND g.Cancelled = 0
      AND a.ReceivedTime >= DATEADD(month, -6, SYSDATETIME());

    -- 4: AR aging buckets
    SELECT FinARAgingPeriodNum AS bucket,
           COUNT(*) AS items,
           ISNULL(SUM(AmountDue), 0) AS amountDue,
           MIN(InvoiceTime) AS oldestInvoice
    FROM dbo.FinAROpenItems
    GROUP BY FinARAgingPeriodNum;

    -- 5: aging bucket labels
    SELECT TOP (1)
      ActualDays1, ActualDays2, ActualDays3, ActualDays4,
      AgingDesc1, AgingDesc2, AgingDesc3, AgingDesc4
    FROM dbo.FinARAgingPeriods
    WHERE FinARAgingPeriodID = 1;

    -- 6: top customers by YTD sales
    SELECT TOP (10)
      b.CustomerID AS customerId,
      c.CustomerName AS name,
      c.AccountNumber AS accountNumber,
      ISNULL(b.SalesValueYTD, 0) AS salesYTD,
      ISNULL(b.CurrentBalance, 0) AS balance,
      ISNULL(b.CurrentWIPValue, 0) AS wip
    FROM dbo.CustomerBalances b
    INNER JOIN dbo.Customers c ON c.CustomerID = b.CustomerID
    ORDER BY b.SalesValueYTD DESC;

    -- 7: zero-cost exposure on lens / add-on lines (the KPI whose target is zero)
    WITH zero_cost AS (
      SELECT DISTINCT
        c.InvoiceID,
        CAST(c.Total * COALESCE(ot.OrderSign, 1) AS decimal(18, 2)) AS invoiceTotal
      FROM dbo.Orders a
      INNER JOIN dbo.GenStatus gs ON gs.GenStatus = a.GenStatus
      INNER JOIN dbo.OrderTypes ot ON ot.OrderType = a.OrderType
      INNER JOIN dbo.Invoices c ON a.OrderID = c.OrderID
      INNER JOIN dbo.InvoiceLines d ON c.InvoiceID = d.InvoiceID
      WHERE a.ShippedTime >= DATEADD(day, -@zeroCostDays, CAST(SYSDATETIME() AS date))
        AND gs.Shipped = 1
        AND COALESCE(ot.Credit, 0) = 0
        AND ot.OrderType IN (1, 3, 12)
        AND COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0) > 0
        -- 1=Lens plus the add-on categories. CategoryType 16 is Package, which is
        -- zero-cost by design (components are costed on their own lines) and must not
        -- be counted as a defect. See dbo.CategoryTypes.
        AND d.CategoryType IN (1, 4, 6, 7, 10, 11, 13)
        AND COALESCE(d.CostPrice, 0) = 0
    )
    SELECT COUNT(*) AS invoiceCount, ISNULL(SUM(invoiceTotal), 0) AS invoiceRevenue FROM zero_cost;

    -- 8: stock-lot coverage (why stock turn is withheld)
    -- Deliberately avoids StockLots.OnHandCalcTime: that column does not exist in the
    -- innovations_mirror schema, so referencing it fails to compile on the mirror
    -- profile and takes the whole Overview tab down with it. It is NULL on every row
    -- in live anyway, so it told us nothing.
    SELECT COUNT(*) AS lots,
           SUM(CASE WHEN OnHand > 0 THEN 1 ELSE 0 END) AS lotsWithStock
    FROM dbo.StockLots WHERE Active = 1;
  `);

  const sales = result.recordsets[0][0] || {};
  const monthRows = result.recordsets[1] || [];
  const roll = result.recordsets[2][0] || {};
  const wip = result.recordsets[3][0] || {};
  const agingRows = result.recordsets[4] || [];
  const agingDef = result.recordsets[5][0] || {};
  const topRows = result.recordsets[6] || [];
  const zeroCost = result.recordsets[7][0] || {};
  const stock = result.recordsets[8][0] || {};

  const aging = buildAging(agingRows, agingDef);
  const receivables = num(roll.receivables);
  const overdue = aging.filter((a) => a.bucket > 0).reduce((s, a) => s + a.amountDue, 0);
  const current = aging.filter((a) => a.bucket === 0).reduce((s, a) => s + a.amountDue, 0);
  const agingTotal = current + overdue;
  const sales365 = num(sales.sales365);

  return {
    headline: {
      sales: {
        value: num(sales.periodSales),
        prior: num(sales.priorSales),
        deltaPct: deltaPct(num(sales.periodSales), num(sales.priorSales)),
        priorLabel: PERIODS[periodKey].priorLabel,
        invoices: num(sales.periodInvoices),
        basis: "FinARSalesJournal.SubTotal (tax-exclusive)"
      },
      wip: {
        value: num(roll.wipValue),
        openOrders: num(wip.openOrders),
        avgAgeDays: round1(num(wip.avgAgeDays)),
        staleOrders: num(wip.staleOrders),
        staleAfterDays: WIP_STALE_DAYS
      },
      receivables: {
        value: receivables,
        customers: num(roll.customers),
        currentAmount: current,
        overdueAmount: overdue,
        currentPct: agingTotal > 0 ? round1((current / agingTotal) * 100) : null,
        dsoDays: sales365 > 0 ? Math.round(receivables / (sales365 / 365)) : null
      }
    },
    trend: buildTrend(monthRows, now),
    aging: { buckets: aging, total: agingTotal },
    topCustomers: topRows.map((r) => ({
      customerId: num(r.customerId),
      name: (r.name || "").trim(),
      accountNumber: r.accountNumber || null,
      salesYTD: num(r.salesYTD),
      balance: num(r.balance),
      wip: num(r.wip)
    })),
    exceptions: buildExceptions({ zeroCost, aging, wip }),
    dataQuality: buildDataQuality({ stock, roll })
  };
}

function buildAging(rows, def) {
  const meta = (n) => {
    switch (n) {
      case 0: return { label: "Current", detail: "not yet due" };
      case 1: return { label: def.AgingDesc1 || "1–30 days", detail: `≤ ${num(def.ActualDays1)} days` };
      case 2: return { label: def.AgingDesc2 || "31–60 days", detail: `≤ ${num(def.ActualDays2)} days` };
      case 3: return { label: def.AgingDesc3 || "61–90 days", detail: `≤ ${num(def.ActualDays3)} days` };
      case 4: return { label: def.AgingDesc4 || "Over 120", detail: `> ${num(def.ActualDays4)} days` };
      default: return { label: `Bucket ${n}`, detail: "" };
    }
  };

  return [0, 1, 2, 3, 4].map((b) => {
    const row = rows.find((r) => num(r.bucket) === b);
    const m = meta(b);
    return {
      bucket: b,
      label: m.label,
      detail: m.detail,
      amountDue: row ? num(row.amountDue) : 0,
      items: row ? num(row.items) : 0,
      oldestInvoice: row && row.oldestInvoice ? row.oldestInvoice : null
    };
  });
}

/** Current window plus each month's prior-year value, for the overlay. */
function buildTrend(rows, now) {
  const byMonth = new Map(rows.map((r) => [r.ym, { net: num(r.net), invoices: num(r.invoices) }]));
  const months = [];

  for (let i = TREND_MONTHS - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = monthKey(d);
    const priorKey = monthKey(new Date(d.getFullYear() - 1, d.getMonth(), 1));
    const cur = byMonth.get(key);
    const prev = byMonth.get(priorKey);
    months.push({
      month: key,
      value: cur ? cur.net : 0,
      invoices: cur ? cur.invoices : 0,
      priorValue: prev ? prev.net : null,
      partial: i === 0
    });
  }

  return { months, basis: "FinARSalesJournal.SubTotal (tax-exclusive)" };
}

function buildExceptions({ zeroCost, aging, wip }) {
  const out = [];

  const zcCount = num(zeroCost.invoiceCount);
  if (zcCount > 0) {
    out.push({
      id: "zero-cost",
      severity: "critical",
      count: zcCount,
      value: num(zeroCost.invoiceRevenue),
      label: "zero-cost invoices",
      detail: `target 0 · last ${ZERO_COST_LOOKBACK_DAYS} days`,
      drill: "zero-cost-lines"
    });
  }

  const overdueBuckets = aging.filter((a) => a.bucket > 0 && a.amountDue > 0);
  const worst = overdueBuckets[overdueBuckets.length - 1];
  if (worst) {
    out.push({
      id: "ar-overdue",
      severity: "warning",
      count: worst.items,
      value: worst.amountDue,
      label: `AR ${worst.label.toLowerCase()}`,
      detail: worst.oldestInvoice ? `oldest ${new Date(worst.oldestInvoice).toISOString().slice(0, 10)}` : worst.detail,
      drill: `aging-bucket:${worst.bucket}`
    });
  }

  const stale = num(wip.staleOrders);
  if (stale > 0) {
    out.push({
      id: "wip-stale",
      severity: "warning",
      count: stale,
      value: null,
      label: `WIP over ${WIP_STALE_DAYS} days`,
      detail: `of ${num(wip.openOrders)} open orders`,
      drill: "wip-stale"
    });
  }

  return out;
}

function buildDataQuality({ stock, roll }) {
  const out = [];
  const lots = num(stock.lots);
  const withStock = num(stock.lotsWithStock);

  if (lots > 0 && withStock < lots) {
    out.push({
      id: "stock-uncosted",
      text: `Stock turn withheld — only ${fmtInt(withStock)} of ${fmtInt(lots)} active stock lots carry an on-hand quantity, so the inventory valuation is not a usable denominator.`
    });
  }

  const customers = num(roll.customers);
  const withLimit = num(roll.withCreditLimit);
  if (customers > 0 && withLimit < customers) {
    out.push({
      id: "credit-limits",
      text: `${fmtInt(customers - withLimit)} of ${fmtInt(customers)} customers have no credit limit set, so limit breaches cannot be monitored.`
    });
  }

  return out;
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function deltaPct(current, prior) {
  if (!prior) return null;
  return round1(((current / prior) - 1) * 100);
}

function round1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function fmtInt(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

module.exports = { getOverviewSummary, periodRange, PERIODS, ZERO_COST_LOOKBACK_DAYS, WIP_STALE_DAYS };
