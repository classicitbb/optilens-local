const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  AGING_BUCKETS, bucketAging, summariseWip, shapeThroughput, getProductionStatus, getProductionOrders
} = require("../lib/metrics/production-status");

const NOW = new Date("2026-10-08T12:00:00-04:00");
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();

test("aging buckets place orders by elapsed days and report the cumulative 'older' column", () => {
  const orders = [0.2, 1.9, 2, 5.9, 6, 12, 25, 31, 90].map((d) => ({ receivedTime: daysAgo(d) }));
  const aging = bucketAging(orders, NOW);

  assert.strictEqual(aging.total, 9);
  assert.deepStrictEqual(aging.buckets.map((b) => b.key), AGING_BUCKETS.map((b) => b.key));
  assert.deepStrictEqual(aging.buckets.map((b) => b.count), [2, 1, 1, 1, 1, 1, 2]);
  assert.deepStrictEqual(aging.buckets.map((b) => b.olderThan), [9, 7, 6, 5, 4, 3, 2]);
  assert.ok(Math.abs(aging.buckets.reduce((sum, b) => sum + b.share, 0) - 1) < 1e-9);
});

test("aging ignores unparseable dates and handles an empty list", () => {
  assert.strictEqual(bucketAging([{ receivedTime: "not a date" }], NOW).total, 0);
  const empty = bucketAging([], NOW);
  assert.strictEqual(empty.total, 0);
  assert.ok(empty.buckets.every((b) => b.share === 0));
});

test("WIP totals separate outsourced and waiting work and leave Assigned unreported", () => {
  const totals = summariseWip([
    { statusName: "Waiting on Frame", outsourced: false },
    { statusName: "Label for Tray 1", outsourced: false },
    { statusName: "Transmitted", outsourced: true },
    { statusName: "Waiting for Lens", outsourced: true },
    { statusName: null, outsourced: false }
  ]);

  assert.deepStrictEqual(totals,
    { waiting: 1, inProgress: 2, outsourced: 2, totalWip: 5, assigned: null });
});

test("throughput rows keep period order and weekly points sort oldest to newest", () => {
  const shaped = shapeThroughput([
    { kind: "week", seq: 0, label: "2026-10-05", startDate: "2026-10-05", received: 5, shipped: 4 },
    { kind: "week", seq: 1, label: "2026-09-28", startDate: "2026-09-28", received: 264, remakes: 4 },
    { kind: "row", seq: 1, label: "Today" },
    { kind: "row", seq: 2, label: "Yesterday", received: 44, shipped: 45, remakes: 3, breakages: 3 }
  ]);

  assert.deepStrictEqual(shaped.periods.map((p) => p.label), ["Today", "Yesterday"]);
  assert.strictEqual(shaped.periods[0].received, 0, "missing counts become zero");
  assert.strictEqual(shaped.periods[1].shipped, 45);
  assert.deepStrictEqual(shaped.weekly.map((w) => w.weekStart), ["2026-09-28", "2026-10-05"]);
});

test("getProductionStatus assembles the payload from the two source queries", async () => {
  const calls = [];
  const pool = {
    request: () => ({
      query: async (sql) => {
        calls.push(sql);
        if (/dbo\.Assignments/.test(sql)) return { recordsets: [[{ assignedToType: 4, orders: 1 }], [{ orders: 3 }]] };
        return /#ord/.test(sql)
          ? { recordset: [{ kind: "row", seq: 1, label: "Today", received: 3, shipped: 2 }] }
          : {
            recordset: [{
              OrderID: 1, JobID: "J1", ReceivedTime: daysAgo(1), CurrentStatusDate: daysAgo(6),
              statusName: "Waiting on Frame", outsourced: 0
            }]
          };
      }
    })
  };

  const status = await getProductionStatus({ pool, now: NOW });

  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(status.assignments, { all: 3, user: 0, cs: 1, customer: 0 });
  assert.deepStrictEqual(status.staging.columns, ["Waiting on Frame"]);
  assert.strictEqual(status.staging.total.cells["Waiting on Frame"], 1);
  assert.strictEqual(status.staging.bands.find((b) => b.key === "5").cells["Waiting on Frame"], 1);
  assert.strictEqual(status.generatedAt, NOW.toISOString());
  assert.strictEqual(status.totals.waiting, 1);
  assert.strictEqual(status.throughput.periods[0].received, 3);
  assert.strictEqual(status.aging.total, 1);
});

function fakePool(recordset) {
  return { request: () => ({ input() {}, query: async () => ({ recordset, recordsets: [recordset] }) }) };
}

test("drill-through returns the orders behind a WIP segment and an aging band", async () => {
  const pool = fakePool([
    { OrderID: 1, JobID: "A", ReceivedTime: daysAgo(1), statusName: "Label for Tray 1", outsourced: 0 },
    { OrderID: 2, JobID: "B", ReceivedTime: daysAgo(12), statusName: "Transmitted", outsourced: 1 },
    { OrderID: 3, JobID: "C", ReceivedTime: daysAgo(40), statusName: "Remote Rx", outsourced: 0 }
  ]);

  const outsourced = await getProductionOrders({ metric: "wip", segment: "outsourced" }, { pool, now: NOW });
  assert.deepStrictEqual(outsourced.orders.map((o) => o.jobId), ["B"]);

  const band = await getProductionOrders({ metric: "aging", bucket: "10d" }, { pool, now: NOW });
  assert.deepStrictEqual(band.orders.map((o) => o.jobId), ["B"]);

  const older = await getProductionOrders({ metric: "aging", bucket: "10d", older: "1" }, { pool, now: NOW });
  assert.deepStrictEqual(older.orders.map((o) => o.jobId), ["C", "B"], "oldest first");
  assert.strictEqual(older.count, 2);
});

test("drill-through rejects unknown metrics and malformed periods with a 400", async () => {
  const pool = fakePool([]);
  for (const params of [{ metric: "nope" }, { metric: "received", seq: "x" }, { metric: "wip", segment: "x" },
    { metric: "aging", bucket: "x" }, { metric: "assignments", type: "x" }]) {
    await assert.rejects(getProductionOrders(params, { pool, now: NOW }), (error) => error.statusCode === 400);
  }
});

test("period drill-through binds the period as parameters rather than interpolating input", async () => {
  const inputs = {};
  const pool = { request: () => ({ input: (k, v) => { inputs[k] = v; }, query: async () => ({ recordset: [] }) }) };
  await getProductionOrders({ metric: "shipped", kind: "row", seq: "2", label: "x'; DROP TABLE Orders;--" }, { pool, now: NOW });
  assert.deepStrictEqual(inputs, { kind: "row", seq: 2 });
});

test("the page, script and stylesheet exist and are wired to the API", () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  assert.match(read("public/production-status.html"), /production-status\.js/);
  assert.match(read("public/production-status.html"), /href="\/styles\/system\.css"/);
  assert.match(read("public/production-status.js"), /\/api\/production-status/);
  assert.match(read("server.js"), /"\/api\/production-status"/);
  assert.match(read("server.js"), /"\/api\/production-status\/orders"/);
  assert.match(read("server.js"), /"\/modules\/production-status":\s+"production-status\.html"/);
  assert.match(read("public/shared.js"), /id: "production-status"/);
});
