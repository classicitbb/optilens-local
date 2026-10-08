// Production status — throughput, work-in-progress totals and work-order aging,
// read live from Innovations. Replicates the figures on the Innovations web
// "Production Throughput" / "Work Order Aging" dashboard.
//
// Definitions (each verified against the Innovations dashboard for Jul-Oct 2026):
//   Received   Orders.ReceivedTime in period, OrderType 1 (Rx) or 3 (stock-fulfilled).
//   Shipped    Orders.ShippedTime in period, same order types, minus any order that
//              carries a Cancellation status (cancelled jobs keep a ShippedTime).
//   Cancelled  Distinct orders that logged a Cancellation status in the period.
//   Breakages  Status rows from the Breakage (2) and Fulfillment Break (5) groups.
//   Remakes    Status rows from the Remake group (3), excluding Unship, on type 1/3 orders.
//   WIP        Open orders: type 1/3, not shipped, never cancelled.
//   Outsourced WIP with an active farm-out the lab has not yet received.
//   Assigned   Not reproduced yet — reported as null rather than guessed.
//
// Not yet reproduced exactly: monthly Remakes for completed months run higher than
// the Innovations dashboard (recent days/weeks match), and the aging bucket edges
// are a best fit. Both are flagged in the payload `notes`.

const { getLiveSourcePool } = require("../db");

const SOURCE_TIMEZONE = "SA Western Standard Time"; // UTC-4, no DST — matches the Innovations server
const ORDER_TYPES = "(1,3)";
const WEEKLY_POINTS = 14;
const OPEN_ORDER_LOOKBACK = "DATEADD(year, -1, SYSDATETIMEOFFSET())";

// Aging buckets: lower edge in elapsed days since ReceivedTime. Labels mirror the
// Innovations dashboard ("Current" is the youngest band).
const AGING_BUCKETS = [
  { key: "current", label: "Current", minDays: 0 },
  { key: "2d", label: "2 Days", minDays: 2 },
  { key: "4d", label: "4 Days", minDays: 4 },
  { key: "6d", label: "6 Days", minDays: 6 },
  { key: "10d", label: "10 Days", minDays: 10 },
  { key: "3w", label: "3 Weeks", minDays: 21 },
  { key: "1m", label: "1 Month", minDays: 30 }
];

const WAITING_STATUS_PATTERN = /^(waiting|frame to come|release frm hold|lenses on order)/i;

const THROUGHPUT_SQL = `
SET NOCOUNT ON;
DECLARE @now datetimeoffset = SYSDATETIMEOFFSET() AT TIME ZONE '${SOURCE_TIMEZONE}';
DECLARE @today datetimeoffset = TODATETIMEOFFSET(CONVERT(datetime2, CONVERT(date, @now)), '-04:00');
DECLARE @tomorrow datetimeoffset = DATEADD(day, 1, @today);
DECLARE @weekStart datetimeoffset = DATEADD(day, -(DATEDIFF(day, '19000101', CONVERT(date, @today)) % 7), @today);
DECLARE @monthStart datetimeoffset = DATEADD(day, 1 - DAY(CONVERT(date, @today)), @today);

DECLARE @p TABLE (kind varchar(8), seq int, label nvarchar(40), a datetimeoffset, b datetimeoffset);
INSERT @p VALUES
 ('row', 1, N'Today',       @today, @tomorrow),
 ('row', 2, N'Yesterday',   DATEADD(day, -1, @today), @today),
 ('row', 3, N'This Week',   @weekStart, @tomorrow),
 ('row', 4, N'Last 7 Days', DATEADD(day, -7, @today), @today),
 ('row', 5, N'Last Week',   DATEADD(day, -7, @weekStart), @weekStart),
 ('row', 6, N'This Month',  @monthStart, @tomorrow);
INSERT @p SELECT 'row', 6 + n, DATENAME(month, DATEADD(month, -n, @monthStart)),
  DATEADD(month, -n, @monthStart), DATEADD(month, -(n - 1), @monthStart)
  FROM (VALUES (1), (2), (3)) m(n);
INSERT @p SELECT 'week', n, CONVERT(nvarchar(10), CONVERT(date, DATEADD(day, -7 * n, @weekStart))),
  DATEADD(day, -7 * n, @weekStart), DATEADD(day, -7 * (n - 1), @weekStart)
  FROM (SELECT TOP (${WEEKLY_POINTS}) ROW_NUMBER() OVER (ORDER BY (SELECT 1)) - 1 AS n FROM sys.all_objects) w;

DECLARE @from datetimeoffset = (SELECT MIN(a) FROM @p);

SELECT OrderID, ReceivedTime, ShippedTime INTO #ord FROM dbo.Orders
 WHERE OrderType IN ${ORDER_TYPES} AND (ReceivedTime >= @from OR ShippedTime >= @from);

SELECT os.OrderID, os.StatusDate, s.StatusItemGroupID grp, s.Unship, s.Cancellation INTO #ev
 FROM dbo.OrderStatuses os JOIN dbo.StatusItems s ON s.StatusItemID = os.StatusItemID
 WHERE os.StatusDate >= @from
   AND (s.StatusItemGroupID IN (2, 3, 5) OR s.Cancellation = 1);

SELECT DISTINCT os.OrderID INTO #cx
 FROM dbo.OrderStatuses os JOIN dbo.StatusItems s ON s.StatusItemID = os.StatusItemID
 WHERE s.Cancellation = 1 AND os.OrderID IN (SELECT OrderID FROM #ord WHERE ShippedTime >= @from);

SELECT p.kind, p.seq, p.label, CONVERT(date, p.a) AS startDate,
 (SELECT COUNT(*) FROM #ord o WHERE o.ReceivedTime >= p.a AND o.ReceivedTime < p.b) AS received,
 (SELECT COUNT(*) FROM #ev e WHERE e.grp = 3 AND e.Unship = 0 AND e.StatusDate >= p.a AND e.StatusDate < p.b
    AND e.OrderID IN (SELECT OrderID FROM #ord)) AS remakes,
 (SELECT COUNT(*) FROM #ev e WHERE e.grp IN (2, 5) AND e.StatusDate >= p.a AND e.StatusDate < p.b) AS breakages,
 (SELECT COUNT(DISTINCT e.OrderID) FROM #ev e WHERE e.Cancellation = 1 AND e.StatusDate >= p.a AND e.StatusDate < p.b) AS cancelled,
 (SELECT COUNT(*) FROM #ord o WHERE o.ShippedTime >= p.a AND o.ShippedTime < p.b
    AND o.OrderID NOT IN (SELECT OrderID FROM #cx)) AS shipped
FROM @p p ORDER BY p.kind, p.seq;
`;

const WIP_SQL = `
SET NOCOUNT ON;
SELECT o.OrderID, o.ReceivedTime, s.StatusItemName AS statusName,
  CASE WHEN EXISTS (SELECT 1 FROM dbo.Farmouts f
        WHERE f.OrderID = o.OrderID AND f.Active = 1 AND f.ReceivedDate IS NULL) THEN 1 ELSE 0 END AS outsourced
FROM dbo.Orders o
LEFT JOIN dbo.StatusItems s ON s.StatusItemID = o.CurrentStatusID
WHERE o.ShippedTime IS NULL AND o.OrderType IN ${ORDER_TYPES}
  AND o.ReceivedTime >= ${OPEN_ORDER_LOOKBACK}
  AND NOT EXISTS (SELECT 1 FROM dbo.OrderStatuses os JOIN dbo.StatusItems c ON c.StatusItemID = os.StatusItemID
                  WHERE os.OrderID = o.OrderID AND c.Cancellation = 1);
`;

const n0 = (v) => (v == null ? 0 : Number(v));

/** Bucket open orders by elapsed days since receipt. `orders` need only `receivedTime`. */
function bucketAging(orders, now = new Date(), buckets = AGING_BUCKETS) {
  const counts = buckets.map(() => 0);
  for (const order of orders) {
    const received = new Date(order.receivedTime).getTime();
    if (Number.isNaN(received)) continue;
    const ageDays = Math.max(0, (now.getTime() - received) / 86400000);
    let index = 0;
    for (let i = 0; i < buckets.length; i += 1) {
      if (ageDays >= buckets[i].minDays) index = i;
    }
    counts[index] += 1;
  }

  const total = counts.reduce((sum, c) => sum + c, 0);
  let olderThan = total;
  return {
    total,
    buckets: buckets.map((bucket, i) => {
      const row = {
        key: bucket.key,
        label: bucket.label,
        minDays: bucket.minDays,
        count: counts[i],
        share: total ? counts[i] / total : 0,
        // Orders at least this old (the Innovations ">" column).
        olderThan
      };
      olderThan -= counts[i];
      return row;
    })
  };
}

function summariseWip(orders) {
  let waiting = 0;
  let outsourced = 0;
  for (const order of orders) {
    if (order.outsourced) outsourced += 1;
    else if (WAITING_STATUS_PATTERN.test(order.statusName || "")) waiting += 1;
  }
  const totalWip = orders.length;
  return { waiting, inProgress: totalWip - waiting - outsourced, outsourced, totalWip, assigned: null };
}

function shapeThroughput(rows) {
  const pick = (r) => ({
    received: n0(r.received),
    remakes: n0(r.remakes),
    breakages: n0(r.breakages),
    cancelled: n0(r.cancelled),
    shipped: n0(r.shipped)
  });
  const periods = rows.filter((r) => r.kind === "row")
    .map((r) => ({ key: String(r.seq), label: r.label, ...pick(r) }));
  const weekly = rows.filter((r) => r.kind === "week")
    .map((r) => ({ weekStart: new Date(r.startDate).toISOString().slice(0, 10), ...pick(r) }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  return { periods, weekly };
}

async function getProductionStatus({ pool, now = new Date() } = {}) {
  const source = pool || await getLiveSourcePool();
  const [throughputResult, wipResult] = await Promise.all([
    source.request().query(THROUGHPUT_SQL),
    source.request().query(WIP_SQL)
  ]);

  const wipOrders = wipResult.recordset.map((r) => ({
    orderId: r.OrderID,
    receivedTime: r.ReceivedTime,
    statusName: r.statusName,
    outsourced: Boolean(r.outsourced)
  }));

  return {
    generatedAt: now.toISOString(),
    totals: summariseWip(wipOrders),
    throughput: shapeThroughput(throughputResult.recordset),
    aging: bucketAging(wipOrders, now),
    notes: [
      "Monthly remake counts for completed months currently read higher than the Innovations dashboard.",
      "Aging bucket edges and the Waiting/Assigned totals are best-fit definitions pending calibration."
    ]
  };
}

module.exports = {
  AGING_BUCKETS,
  bucketAging,
  summariseWip,
  shapeThroughput,
  getProductionStatus
};
