const test = require("node:test");
const assert = require("node:assert/strict");
const { createSupplierMailboxPoller, nextLocalRun, parsePollTime } = require("../lib/operations/mailbox-poller");

test("poll time accepts a valid 24-hour time", () => {
  assert.deepEqual(parsePollTime("08:10"), { hour: 8, minute: 10 });
  assert.deepEqual(parsePollTime("23:59"), { hour: 23, minute: 59 });
  assert.throws(() => parsePollTime("8:10"), /HH:mm/);
  assert.throws(() => parsePollTime("24:00"), /valid 24-hour/);
});

test("next mailbox poll is today before 08:10 and tomorrow after it", () => {
  const before = new Date(2026, 6, 29, 8, 9, 59);
  const after = new Date(2026, 6, 29, 8, 10, 0);
  assert.equal(nextLocalRun(before, "08:10").getTime(), new Date(2026, 6, 29, 8, 10, 0).getTime());
  assert.equal(nextLocalRun(after, "08:10").getTime(), new Date(2026, 6, 30, 8, 10, 0).getTime());
});

test("poller schedules the daily run and prevents overlapping runs", async () => {
  const now = new Date(2026, 6, 29, 8, 0, 0);
  const timers = [];
  const logs = [];
  let resolveSync;
  let syncCalls = 0;
  const syncMailbox = () => {
    syncCalls += 1;
    return new Promise((resolve) => { resolveSync = resolve; });
  };
  const poller = createSupplierMailboxPoller({
    syncMailbox,
    now: () => now,
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => { timer.cancelled = true; },
    logger: { log: (line) => logs.push(line), error: (line) => logs.push(line) }
  });

  const started = poller.start();
  assert.equal(started.nextRunAt, new Date(2026, 6, 29, 8, 10, 0).toISOString());
  assert.equal(timers[0].delay, 10 * 60 * 1000);

  const scheduledRun = timers[0].callback();
  await Promise.resolve();
  assert.equal(syncCalls, 1);
  const overlappingRun = poller.runNow();
  assert.equal(syncCalls, 1);
  resolveSync({ state: "connected", scanned: 2, captured: 2 });
  assert.deepEqual(await scheduledRun, { state: "connected", scanned: 2, captured: 2 });
  assert.deepEqual(await overlappingRun, { state: "connected", scanned: 2, captured: 2 });
  assert.match(logs[1], /Supplier mailbox poll completed/);
  assert.equal(timers.length, 2);
});
