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

const PERIODS_SQL = `
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
`;

const THROUGHPUT_SQL = `${PERIODS_SQL}
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
SELECT o.OrderID, o.JobID, o.CustomerAccount, o.CustomerTrayID, o.ReceivedTime, o.CurrentStatusDate,
  s.StatusItemName AS statusName,
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

// Job staging: open orders parked in a staging/waiting status, banded by days in that status.
const STAGING_STATUS_PATTERN = /^(staging|waiting)/i;
const STAGING_BANDS = [
  { key: "lt5", label: "< 5 Days", minDays: 0 },
  { key: "5", label: "5 Days", minDays: 5 },
  { key: "7", label: "7 Days", minDays: 7 },
  { key: "11", label: "11 Days", minDays: 11 },
  { key: "14", label: "14 Days", minDays: 14 },
  { key: "17", label: "17 Days", minDays: 17 },
  { key: "gt28", label: "> 28 Days", minDays: 28 }
];

function stagingBandIndex(order, now) {
  const days = Math.max(0, (now.getTime() - new Date(order.statusDate).getTime()) / 86400000);
  let index = 0;
  for (let i = 0; i < STAGING_BANDS.length; i += 1) if (days >= STAGING_BANDS[i].minDays) index = i;
  return index;
}

function buildStaging(orders, now = new Date()) {
  const staged = orders.filter((o) => o.statusName && STAGING_STATUS_PATTERN.test(o.statusName.trim())
    && !Number.isNaN(new Date(o.statusDate).getTime()));
  const columns = [...new Set(staged.map((o) => o.statusName.trim()))].sort();
  const cells = (list) => Object.fromEntries(columns.map((c) => [c, list.filter((o) => o.statusName.trim() === c).length]));
  return {
    columns,
    total: { label: "Total", cells: cells(staged) },
    bands: STAGING_BANDS.map((band, i) => ({
      key: band.key,
      label: band.label,
      cells: cells(staged.filter((o) => stagingBandIndex(o, now) === i))
    }))
  };
}

const ASSIGNMENT_TYPES = { user: [1, 2], customer: [3], cs: [4] };
const ASSIGNMENTS_SQL = `
SET NOCOUNT ON;
SELECT a.AssignedToType AS assignedToType, COUNT(DISTINCT a.OrderID) AS orders
FROM dbo.Assignments a JOIN dbo.Orders o ON o.OrderID = a.OrderID
WHERE a.IsClosed = 0 AND o.ShippedTime IS NULL
GROUP BY a.AssignedToType;
SELECT COUNT(DISTINCT a.OrderID) AS orders
FROM dbo.Assignments a JOIN dbo.Orders o ON o.OrderID = a.OrderID
WHERE a.IsClosed = 0 AND o.ShippedTime IS NULL;
`;

function shapeAssignments(result) {
  const byType = new Map(result.recordsets[0].map((r) => [Number(r.assignedToType), n0(r.orders)]));
  const sum = (types) => types.reduce((total, t) => total + (byType.get(t) || 0), 0);
  return {
    all: n0(result.recordsets[1][0] && result.recordsets[1][0].orders),
    user: sum(ASSIGNMENT_TYPES.user),
    cs: sum(ASSIGNMENT_TYPES.cs),
    customer: sum(ASSIGNMENT_TYPES.customer)
  };
}

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

function shapeWipOrder(r) {
  return {
    orderId: r.OrderID,
    jobId: r.JobID,
    customer: r.CustomerAccount,
    tray: r.CustomerTrayID,
    receivedTime: r.ReceivedTime,
    statusDate: r.CurrentStatusDate,
    statusName: r.statusName,
    outsourced: Boolean(r.outsourced)
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
    .map((r) => ({ seq: Number(r.seq), weekStart: new Date(r.startDate).toISOString().slice(0, 10), ...pick(r) }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  return { periods, weekly };
}

async function getProductionStatus({ pool, now = new Date() } = {}) {
  const source = pool || await getLiveSourcePool();
  const [throughputResult, wipResult, assignmentsResult] = await Promise.all([
    source.request().query(THROUGHPUT_SQL),
    source.request().query(WIP_SQL),
    source.request().query(ASSIGNMENTS_SQL)
  ]);

  const wipOrders = wipResult.recordset.map(shapeWipOrder);

  return {
    generatedAt: now.toISOString(),
    totals: summariseWip(wipOrders),
    throughput: shapeThroughput(throughputResult.recordset),
    aging: bucketAging(wipOrders, now),
    staging: buildStaging(wipOrders, now),
    assignments: shapeAssignments(assignmentsResult),
    notes: [
      "Figures come straight from the Innovations database; band edges and some totals are best-fit definitions and may differ slightly from the Innovations dashboard."
    ]
  };
}

// ── Drill-through: the orders behind any number on the page ─────────────────

const DRILL_ROW_LIMIT = 2000;
const PERIOD_METRICS = {
  received: {
    where: "o.ReceivedTime >= @a AND o.ReceivedTime < @b",
    extra: ""
  },
  shipped: {
    where: `o.ShippedTime >= @a AND o.ShippedTime < @b AND NOT EXISTS (
      SELECT 1 FROM dbo.OrderStatuses x JOIN dbo.StatusItems xs ON xs.StatusItemID = x.StatusItemID
      WHERE x.OrderID = o.OrderID AND xs.Cancellation = 1)`,
    extra: ""
  },
  // One row per cancelled order: its first cancellation event in the period.
  cancelled: {
    where: `ev.StatusDate >= @a AND ev.StatusDate < @b AND evs.Cancellation = 1
      AND ev.OrderStatusID = (SELECT MIN(y.OrderStatusID) FROM dbo.OrderStatuses y
        JOIN dbo.StatusItems ys ON ys.StatusItemID = y.StatusItemID
        WHERE y.OrderID = o.OrderID AND ys.Cancellation = 1 AND y.StatusDate >= @a AND y.StatusDate < @b)`,
    extra: "event"
  },
  remakes: {
    where: "ev.StatusDate >= @a AND ev.StatusDate < @b AND evs.StatusItemGroupID = 3 AND evs.Unship = 0",
    extra: "event"
  },
  breakages: { where: "ev.StatusDate >= @a AND ev.StatusDate < @b AND evs.StatusItemGroupID IN (2, 5)", extra: "event" }
};

function periodOrdersSql(metric) {
  const def = PERIOD_METRICS[metric];
  const event = def.extra === "event";
  // Remakes and cancellations are status events; received/shipped read the order itself.
  const orderFilter = metric === "breakages" || metric === "cancelled" ? "" : `AND o.OrderType IN ${ORDER_TYPES}`;
  return `${PERIODS_SQL}
DECLARE @a datetimeoffset, @b datetimeoffset;
SELECT @a = a, @b = b FROM @p WHERE kind = @kind AND seq = @seq;
SELECT TOP (${DRILL_ROW_LIMIT + 1}) o.OrderID, o.JobID, o.CustomerAccount, o.CustomerTrayID,
  o.ReceivedTime, o.ShippedTime, cs.StatusItemName AS statusName,
  ${event ? "ev.StatusDate AS eventDate, evs.StatusItemName AS eventName" : "NULL AS eventDate, NULL AS eventName"}
FROM dbo.Orders o
${event ? "JOIN dbo.OrderStatuses ev ON ev.OrderID = o.OrderID JOIN dbo.StatusItems evs ON evs.StatusItemID = ev.StatusItemID" : ""}
LEFT JOIN dbo.StatusItems cs ON cs.StatusItemID = o.CurrentStatusID
WHERE ${def.where} ${orderFilter}
ORDER BY ${event ? "ev.StatusDate" : metric === "shipped" ? "o.ShippedTime" : "o.ReceivedTime"} DESC;`;
}

const WIP_SEGMENTS = {
  total: () => true,
  waiting: (o) => !o.outsourced && WAITING_STATUS_PATTERN.test(o.statusName || ""),
  outsourced: (o) => o.outsourced,
  inProgress: (o) => !o.outsourced && !WAITING_STATUS_PATTERN.test(o.statusName || "")
};

function ageBucketIndex(order, now, buckets = AGING_BUCKETS) {
  const ageDays = Math.max(0, (now.getTime() - new Date(order.receivedTime).getTime()) / 86400000);
  let index = 0;
  for (let i = 0; i < buckets.length; i += 1) if (ageDays >= buckets[i].minDays) index = i;
  return index;
}

function orderRow(r) {
  return {
    orderId: r.orderId ?? r.OrderID,
    jobId: r.jobId ?? r.JobID,
    customer: r.customer ?? r.CustomerAccount,
    tray: r.tray ?? r.CustomerTrayID,
    receivedTime: r.receivedTime ?? r.ReceivedTime,
    shippedTime: r.ShippedTime ?? null,
    status: r.statusName,
    eventDate: r.eventDate ?? r.statusDate ?? null,
    eventName: r.eventName ?? null
  };
}

function clientError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/**
 * Orders behind one figure. `params`: { metric, kind, seq } for period figures,
 * { metric: "wip", segment } for the Totals tiles, { metric: "aging", bucket, older }
 * for aging bands (older=1 → that band and everything older).
 */
async function getProductionOrders(params, { pool, now = new Date() } = {}) {
  const metric = String(params.metric || "");
  const source = pool || await getLiveSourcePool();
  let rows;
  let title;

  if (PERIOD_METRICS[metric]) {
    const kind = params.kind === "week" ? "week" : "row";
    const seq = Number.parseInt(params.seq, 10);
    if (!Number.isInteger(seq) || seq < 0 || seq > 99) throw clientError("Invalid period.");
    const request = source.request();
    request.input("kind", kind);
    request.input("seq", seq);
    rows = (await request.query(periodOrdersSql(metric))).recordset.map(orderRow);
    title = `${metric[0].toUpperCase()}${metric.slice(1)} — ${params.label || (kind === "week" ? "week" : "period")}`;
  } else if (metric === "assignments") {
    const type = String(params.type || "");
    const types = ASSIGNMENT_TYPES[type];
    if (type !== "all" && !types) throw clientError("Unknown assignment type.");
    const request = source.request();
    const typeFilter = type === "all" ? "" : `AND a.AssignedToType IN (${types.join(",")})`;
    const result = await request.query(`SELECT TOP (${DRILL_ROW_LIMIT + 1}) o.OrderID, o.JobID, o.CustomerAccount,
      o.CustomerTrayID, o.ReceivedTime, o.ShippedTime, cs.StatusItemName AS statusName,
      a.DateAssigned AS eventDate, a.Description AS eventName
      FROM dbo.Assignments a JOIN dbo.Orders o ON o.OrderID = a.OrderID
      LEFT JOIN dbo.StatusItems cs ON cs.StatusItemID = o.CurrentStatusID
      WHERE a.IsClosed = 0 AND o.ShippedTime IS NULL ${typeFilter} ORDER BY a.DateAssigned DESC`);
    rows = result.recordset.map(orderRow);
    title = `Assigned orders — ${type}`;
  } else if (metric === "staging") {
    const orders = (await source.request().query(WIP_SQL)).recordset.map(shapeWipOrder);
    const bandIndex = STAGING_BANDS.findIndex((b) => b.key === params.band);
    if (params.band && params.band !== "total" && bandIndex < 0) throw clientError("Unknown staging band.");
    rows = orders
      .filter((o) => o.statusName && STAGING_STATUS_PATTERN.test(o.statusName.trim()))
      .filter((o) => !params.status || o.statusName.trim() === params.status)
      .filter((o) => bandIndex < 0 || stagingBandIndex(o, now) === bandIndex)
      .sort((a, b) => new Date(a.statusDate) - new Date(b.statusDate))
      .map(orderRow);
    title = `Job staging — ${params.status || "all"}${bandIndex >= 0 ? ` (${STAGING_BANDS[bandIndex].label})` : ""}`;
  } else if (metric === "wip" || metric === "aging") {
    const orders = (await source.request().query(WIP_SQL)).recordset.map(shapeWipOrder);
    if (metric === "wip") {
      const segment = WIP_SEGMENTS[params.segment];
      if (!segment) throw clientError("Unknown WIP segment.");
      rows = orders.filter(segment).map(orderRow);
      title = `Work in progress — ${params.segment}`;
    } else {
      const index = AGING_BUCKETS.findIndex((b) => b.key === params.bucket);
      if (index < 0) throw clientError("Unknown aging band.");
      const older = String(params.older) === "1";
      rows = orders
        .filter((o) => (older ? ageBucketIndex(o, now) >= index : ageBucketIndex(o, now) === index))
        .sort((a, b) => new Date(a.receivedTime) - new Date(b.receivedTime))
        .map(orderRow);
      title = `Work order aging — ${AGING_BUCKETS[index].label}${older ? " and older" : ""}`;
    }
  } else {
    throw clientError("Unknown metric.");
  }

  const truncated = rows.length > DRILL_ROW_LIMIT;
  return { title, count: truncated ? DRILL_ROW_LIMIT : rows.length, truncated, orders: rows.slice(0, DRILL_ROW_LIMIT) };
}

module.exports = {
  getProductionOrders,
  buildStaging,
  shapeAssignments,
  STAGING_BANDS,
  AGING_BUCKETS,
  bucketAging,
  summariseWip,
  shapeThroughput,
  getProductionStatus
};
