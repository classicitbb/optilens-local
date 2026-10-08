const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  AGING_BUCKETS, bucketAging, summariseWip, shapeThroughput, getProductionStatus
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
        return /#ord/.test(sql)
          ? { recordset: [{ kind: "row", seq: 1, label: "Today", received: 3, shipped: 2 }] }
          : { recordset: [{ OrderID: 1, ReceivedTime: daysAgo(1), statusName: "Waiting on Frame", outsourced: 0 }] };
      }
    })
  };

  const status = await getProductionStatus({ pool, now: NOW });

  assert.strictEqual(calls.length, 2);
  assert.strictEqual(status.generatedAt, NOW.toISOString());
  assert.strictEqual(status.totals.waiting, 1);
  assert.strictEqual(status.throughput.periods[0].received, 3);
  assert.strictEqual(status.aging.total, 1);
});

test("the page, script and stylesheet exist and are wired to the API", () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  assert.match(read("public/production-status.html"), /production-status\.js/);
  assert.match(read("public/production-status.html"), /href="\/styles\/system\.css"/);
  assert.match(read("public/production-status.js"), /\/api\/production-status/);
  assert.match(read("server.js"), /"\/api\/production-status"/);
  assert.match(read("server.js"), /"\/modules\/production-status":\s+"production-status\.html"/);
  assert.match(read("public/shared.js"), /id: "production-status"/);
});
