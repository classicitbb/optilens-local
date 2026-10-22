const assert = require("node:assert/strict");
const test = require("node:test");
const source = require("../lib/job-floor-source");

// In-memory stand-in for the source database: each named statement answers from `state`.
function makeDb(overrides = {}) {
  const state = {
    target: { id: 27, name: "Focimeter 2 Final PASS", allowed: 1 },
    user: { id: 41, active: 1 },
    orders: [{ orderId: 138998, jobId: "675", currentStatusId: 42, currentHistoryId: 774281, numberOfStatuses: 6, genStatusName: "In process" }],
    history: { id: 774281, statusItemId: 42, endDate: null, iteration: 2 },
    tray: { id: 91520, orderId: 138998, dateIn: new Date(), dateOut: null },
    realCount: 6,
    updateRows: 1,
    readBack: null,
    ...overrides,
  };
  const log = [];
  const flags = { committed: false, rolledBack: false, writerOpened: false };
  const exec = async (name, params = {}) => {
    log.push({ name, params });
    switch (name) {
      case "latestTrayTransaction": return { recordset: state.tray ? [state.tray] : [] };
      case "target": return { recordset: state.target ? [state.target] : [] };
      case "user": return { recordset: state.user ? [state.user] : [] };
      case "orderById": case "orderByIdForUpdate": case "orderByRx": case "orderByRxForUpdate": return { recordset: state.orders };
      case "latestHistory": case "latestHistoryForUpdate": return { recordset: state.history ? [state.history] : [] };
      case "realStatusCount": return { recordset: [{ n: state.realCount }] };
      case "now": return { recordset: [{ now: "2026-10-22T11:41:49.5200000-04:00" }] };
      case "insertHistory": return { recordset: [{ id: 774368 }], rowsAffected: 1 };
      case "closePrevious": return { recordset: [], rowsAffected: 1 };
      case "updateOrder": return { recordset: [], rowsAffected: state.updateRows };
      case "readBack": return {
        recordset: [state.readBack ?? {
          currentStatusId: 27, currentHistoryId: 774368, numberOfStatuses: 7,
          historyStatusItemId: 27, historyUserAccountId: 41, historyEndDate: null,
        }],
      };
      default: throw new Error(`unexpected statement ${name}`);
    }
  };
  const deps = {
    async openReader() { return { exec }; },
    async openWriter() {
      flags.writerOpened = true;
      return { exec, commit: async () => { flags.committed = true; }, rollback: async () => { flags.rolledBack = true; } };
    },
  };
  return { deps, log, flags, names: () => log.map((l) => l.name) };
}

const input = { orderId: 138998, statusItemId: 27, userAccountId: 41 };

test("apply writes the confirmed sequence in one transaction and verifies by read-back", async () => {
  const db = makeDb();
  const result = await source.applyStatusUpdate(input, db.deps);
  assert.equal(result.applied, true);
  assert.equal(result.verified, true);
  assert.deepEqual(db.names(), [
    "target", "user", "orderByIdForUpdate", "latestHistoryForUpdate", "realStatusCount",
    "now", "insertHistory", "closePrevious", "updateOrder", "readBack",
  ]);
  const byName = Object.fromEntries(db.log.map((l) => [l.name, l.params]));
  assert.deepEqual(byName.insertHistory, { orderId: 138998, statusItemId: 27, userAccountId: 41, iteration: 2, statusDate: "2026-10-22T11:41:49.5200000-04:00" });
  assert.deepEqual(byName.closePrevious, { id: 774281, endDate: "2026-10-22T11:41:49.5200000-04:00" });
  assert.deepEqual(byName.updateOrder, {
    orderId: 138998, historyId: 774368, statusItemId: 27, statusDate: "2026-10-22T11:41:49.5200000-04:00",
    numberOfStatuses: 7, userAccountId: 41, expectedStatusId: 42,
  });
  assert.equal(db.flags.committed, true);
  assert.equal(db.flags.rolledBack, false);
});

test("an already-closed previous row is left alone; an order with no history starts at iteration 0", async () => {
  const closed = makeDb({ history: { id: 1, statusItemId: 42, endDate: new Date(), iteration: 1 } });
  await source.applyStatusUpdate(input, closed.deps);
  assert.equal(closed.names().includes("closePrevious"), false);

  const empty = makeDb({ history: null, realCount: 0, readBack: { currentStatusId: 27, currentHistoryId: 774368, numberOfStatuses: 1, historyStatusItemId: 27, historyUserAccountId: 41 } });
  await source.applyStatusUpdate(input, empty.deps);
  assert.equal(empty.log.find((l) => l.name === "insertHistory").params.iteration, 0);
  assert.equal(empty.names().includes("closePrevious"), false);
});

test("an order already at the target status is a verified no-op", async () => {
  const db = makeDb({
    orders: [{ orderId: 138998, jobId: "675", currentStatusId: 27, currentHistoryId: 9, numberOfStatuses: 6 }],
    history: { id: 9, statusItemId: 27, endDate: null, iteration: 2 },
  });
  const result = await source.applyStatusUpdate(input, db.deps);
  assert.equal(result.alreadyApplied, true);
  assert.equal(result.applied, false);
  assert.equal(db.names().some((n) => ["insertHistory", "closePrevious", "updateOrder"].includes(n)), false);
  assert.equal(db.flags.committed, true);
});

test("restricted statuses, unknown statuses and bad users are refused before any write", async () => {
  const restricted = makeDb({ target: { id: 193, name: "Unhold", allowed: 0 } });
  await assert.rejects(source.applyStatusUpdate({ ...input, statusItemId: 193 }, restricted.deps), (e) => e.code === "target_status_restricted");
  assert.equal(restricted.flags.rolledBack, true);
  assert.equal(restricted.flags.committed, false);

  await assert.rejects(source.applyStatusUpdate(input, makeDb({ target: null }).deps), (e) => e.code === "target_status_not_found" && e.statusCode === 404);
  await assert.rejects(source.applyStatusUpdate(input, makeDb({ user: { id: 41, active: 0 } }).deps), (e) => e.code === "source_user_invalid");
  await assert.rejects(source.applyStatusUpdate(input, makeDb({ user: null }).deps), (e) => e.code === "source_user_invalid");
});

test("a stale expected status, a missing order and an ambiguous RX number are refused", async () => {
  await assert.rejects(source.applyStatusUpdate({ ...input, expectedCurrentStatusId: 99 }, makeDb().deps), (e) => e.code === "stale_order");
  await assert.rejects(source.applyStatusUpdate(input, makeDb({ orders: [] }).deps), (e) => e.code === "order_not_active" && e.statusCode === 404);
  const two = makeDb({ orders: [{ orderId: 1 }, { orderId: 2 }] });
  await assert.rejects(source.applyStatusUpdate({ rxNumber: "675", statusItemId: 27, userAccountId: 41 }, two.deps), (e) => e.code === "order_ambiguous");
  assert.equal(two.names().includes("orderByRxForUpdate"), true);
});

test("a lost optimistic update or a failed read-back rolls the whole transaction back", async () => {
  const lost = makeDb({ updateRows: 0 });
  await assert.rejects(source.applyStatusUpdate(input, lost.deps), (e) => e.code === "stale_order");
  assert.equal(lost.flags.rolledBack, true);
  assert.equal(lost.flags.committed, false);

  const bad = makeDb({ readBack: { currentStatusId: 27, currentHistoryId: 774368, numberOfStatuses: 7, historyStatusItemId: 27, historyUserAccountId: 7 } });
  await assert.rejects(source.applyStatusUpdate(input, bad.deps), (e) => e.code === "verification_failed");
  assert.equal(bad.flags.rolledBack, true);
  assert.equal(bad.flags.committed, false);
});

test("a tray number resolves to its current order and the write is otherwise identical", async () => {
  const db = makeDb();
  const result = await source.applyStatusUpdate({ trayId: " 675 ", statusItemId: 27, userAccountId: 41 }, db.deps);
  assert.equal(result.applied, true);
  assert.equal(result.tray.id, "675");
  assert.deepEqual(db.names().slice(0, 4), ["target", "user", "latestTrayTransaction", "orderByIdForUpdate"]);
  assert.deepEqual(db.log.find((l) => l.name === "latestTrayTransaction").params, { trayId: "675" });
  assert.deepEqual(db.log.find((l) => l.name === "orderByIdForUpdate").params, { orderId: 138998 });
});

test("an unknown, empty or unlinked tray is refused before any write", async () => {
  const run = (tray) => source.applyStatusUpdate({ trayId: "675", statusItemId: 27, userAccountId: 41 }, makeDb({ tray }).deps);
  await assert.rejects(run(null), (e) => e.code === "tray_not_found" && e.statusCode === 404);
  await assert.rejects(run({ id: 1, orderId: 138998, dateIn: new Date(), dateOut: new Date() }), (e) => e.code === "tray_empty");
  await assert.rejects(run({ id: 1, orderId: 0, dateIn: new Date(), dateOut: null }), (e) => e.code === "tray_empty");
  await assert.rejects(source.applyStatusUpdate({ trayId: "x".repeat(41), statusItemId: 27, userAccountId: 41 }, makeDb().deps), (e) => e.code === "invalid_input");
  await assert.rejects(source.applyStatusUpdate({ trayId: "675", orderId: 5, statusItemId: 27, userAccountId: 41 }, makeDb().deps), (e) => e.code === "invalid_input");
});

test("live writes require a source user, and require exactly one order identifier", async () => {
  const db = makeDb();
  await assert.rejects(source.applyStatusUpdate({ orderId: 1, statusItemId: 27 }, db.deps), (e) => e.code === "source_user_missing");
  assert.equal(db.flags.writerOpened, false);
  await assert.rejects(source.applyStatusUpdate({ ...input, rxNumber: "1" }, makeDb().deps), (e) => e.code === "invalid_input");
  await assert.rejects(source.applyStatusUpdate({ statusItemId: 27, userAccountId: 41 }, makeDb().deps), (e) => e.code === "invalid_input");
  await assert.rejects(source.applyStatusUpdate({ ...input, statusItemId: 0 }, makeDb().deps), (e) => e.code === "invalid_input");
});

test("preview is read-only: reader only, no row locks, no writes", async () => {
  const db = makeDb();
  const plan = await source.previewStatusUpdate({ orderId: 138998, statusItemId: 27 }, db.deps);
  assert.equal(db.flags.writerOpened, false);
  assert.deepEqual(db.names(), ["target", "orderById", "latestHistory", "realStatusCount"]);
  assert.equal(plan.closesHistoryId, 774281);
  assert.equal(plan.numberOfStatusesAfter, 7);
  assert.equal(plan.iteration, 2);
  assert.equal(plan.alreadyApplied, false);
});

test("the writer must be a separate, credentialed login", () => {
  const cfg = (write, readUser = "reader") => ({ sourceMssql: { user: readUser }, privilegedDataAccess: { sources: { "source-mssql": { write } } } });
  assert.throws(() => source.requireWriterProfile(cfg(null)), (e) => e.code === "writer_credentials_missing");
  assert.throws(() => source.requireWriterProfile(cfg({ user: "w" })), (e) => e.code === "writer_credentials_missing");
  assert.throws(() => source.requireWriterProfile(cfg({ user: "Reader", password: "x" })), (e) => e.code === "writer_not_separate");
  assert.equal(source.requireWriterProfile(cfg({ user: "writer", password: "x" })).user, "writer");
});

test("statements only write OrderStatuses and Orders, and never touch locks, counters or the -5 marker", () => {
  const writes = Object.entries(source.STATEMENTS).filter(([, s]) => /^\s*(INSERT|UPDATE|DELETE|MERGE)/i.test(s.text));
  assert.deepEqual(writes.map(([n]) => n).sort(), ["closePrevious", "insertHistory", "updateOrder"]);
  assert.match(source.STATEMENTS.insertHistory.text, /INSERT INTO dbo\.OrderStatuses/);
  assert.match(source.STATEMENTS.closePrevious.text, /UPDATE dbo\.OrderStatuses/);
  assert.match(source.STATEMENTS.updateOrder.text, /UPDATE dbo\.Orders/);
  for (const [, s] of writes) assert.doesNotMatch(s.text, /Locks|TransactionIDs|Transactions|QueuedChanges|DELETE/i);
  // the allow-list guards every status with side effects this module does not replicate
  for (const guard of ["Originating = 0", "Terminating = 0", "Cancellation = 0", "Unship = 0", "CheckHoldConditions = 0", "StockFlags = 0", "ReceiveFarmout = 0", "Inactive = 0", "ShowInMobileApp = 1"]) {
    assert.ok(source.ALLOWED_STATUS_PREDICATE.includes(guard), guard);
  }
});
