const assert = require("node:assert/strict");
const test = require("node:test");
const jobFloor = require("../lib/job-floor");
const jobFloorSource = require("../lib/job-floor-source");

function makeDeps({ writes = "false", sourceFail = null } = {}) {
  const audits = [];
  const sourceCalls = [];
  return {
    audits,
    sourceCalls,
    source: {
      SourceStatusError: jobFloorSource.SourceStatusError,
      previewStatusUpdate: async (input) => { sourceCalls.push({ op: "preview", input }); if (sourceFail) throw sourceFail; return { orderId: 55, alreadyApplied: false }; },
      applyStatusUpdate: async (input) => { sourceCalls.push({ op: "apply", input }); if (sourceFail) throw sourceFail; return { orderId: 55, applied: true, verified: true }; },
      listAllowedStatuses: async (opts) => { sourceCalls.push({ op: "list", opts }); return [{ id: 27, name: "Focimeter 2 Final PASS", holdChecked: false, writable: true, reason: null }, { id: 193, name: "Unhold", holdChecked: true, writable: false, reason: "not supported from OptiLens yet" }]; },
    },
    getSetting: async (key) => (key === "job_floor.writes_enabled" ? writes : null),
    recordAuditEvent: async (event) => { audits.push(event); },
  };
}

test.beforeEach(() => {
  delete process.env.JOB_FLOOR_WRITES_ENABLED;
  delete process.env.JOB_FLOOR_SOURCE_USER_ACCOUNT_ID;
});

test("updateStatus defaults to a dry run: read-only preview, audited, no write", async () => {
  const deps = makeDeps({ writes: "true" });
  const result = await jobFloor.updateStatus({ orderId: 55, statusItemId: 7 }, { actorUserId: 3 }, deps);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.request, { orderId: 55, statusItemId: 7, expectedCurrentStatusId: undefined });
  assert.deepEqual(deps.sourceCalls.map((c) => c.op), ["preview"]);
  assert.deepEqual(deps.audits.map((a) => a.eventType), ["job_floor.update_status.dry_run"]);
});

test("a live write is refused (403) and audited while writes are disabled", async () => {
  const deps = makeDeps({ writes: "false" });
  await assert.rejects(
    jobFloor.updateStatus({ rxNumber: "1001", statusItemId: 2 }, { dryRun: false }, deps),
    (e) => e.statusCode === 403
  );
  assert.equal(deps.sourceCalls.length, 0);
  assert.deepEqual(deps.audits.map((a) => a.eventType), ["job_floor.update_status.refused"]);
});

test("a live write needs the source user account configured", async () => {
  const deps = makeDeps({ writes: "true" });
  await assert.rejects(
    jobFloor.updateStatus({ orderId: 5, statusItemId: 2 }, { dryRun: false }, deps),
    (e) => e.statusCode === 409 && /source_user_account_id/.test(e.message)
  );
  assert.equal(deps.sourceCalls.length, 0);
  assert.deepEqual(deps.audits.map((a) => a.eventType), ["job_floor.update_status.refused"]);
});

test("a live write goes through only when enabled and attributed, with attempt and success audited", async () => {
  process.env.JOB_FLOOR_SOURCE_USER_ACCOUNT_ID = "41";
  const deps = makeDeps({ writes: "true" });
  const result = await jobFloor.updateStatus({ orderId: 9, statusItemId: 2, expectedCurrentStatusId: 5 }, { dryRun: false, actorUserId: 1 }, deps);
  assert.equal(result.dryRun, false);
  assert.deepEqual(deps.sourceCalls, [{ op: "apply", input: { orderId: 9, statusItemId: 2, expectedCurrentStatusId: 5, userAccountId: 41, holdCheckedStatusIds: [] } }]);
  assert.deepEqual(deps.audits.map((a) => a.eventType), ["job_floor.update_status.attempted", "job_floor.update_status.succeeded"]);
});

test("source errors keep their code, are audited, and surface with the source status code", async () => {
  process.env.JOB_FLOOR_SOURCE_USER_ACCOUNT_ID = "41";
  const sourceFail = new jobFloorSource.SourceStatusError("Order 9 changed", "stale_order", 409);
  const deps = makeDeps({ writes: "true", sourceFail });
  await assert.rejects(
    jobFloor.updateStatus({ orderId: 9, statusItemId: 2 }, { dryRun: false }, deps),
    (e) => e.statusCode === 409 && e.code === "stale_order"
  );
  assert.deepEqual(deps.audits.map((a) => a.eventType), ["job_floor.update_status.attempted", "job_floor.update_status.failed"]);
  assert.equal(deps.audits[1].eventData.code, "stale_order");
});

test("a tray number is passed through to the source writer and audited as a tray", async () => {
  process.env.JOB_FLOOR_SOURCE_USER_ACCOUNT_ID = "41";
  const deps = makeDeps({ writes: "true" });
  const preview = await jobFloor.updateStatus({ trayId: " 766 ", statusItemId: 27 }, {}, deps);
  assert.deepEqual(preview.request, { trayId: "766", statusItemId: 27, expectedCurrentStatusId: undefined });
  await jobFloor.updateStatus({ trayId: "766", statusItemId: 27 }, { dryRun: false }, deps);
  assert.deepEqual(deps.sourceCalls.map((c) => [c.op, c.input.trayId]), [["preview", "766"], ["apply", "766"]]);
  assert.equal(deps.audits[0].entityType, "tray");
  assert.equal(deps.audits[0].entityId, "766");
});

test("direct status updates reject notes and e-mail rather than dropping them", async () => {
  const deps = makeDeps();
  await assert.rejects(jobFloor.updateStatus({ orderId: 1, statusItemId: 2, note: "hi" }, {}, deps), /Notes/);
  await assert.rejects(jobFloor.updateStatus({ orderId: 1, statusItemId: 2, email: true }, {}, deps), /Notes/);
  assert.equal(deps.sourceCalls.length, 0);
});

test("the module no longer exposes staging, job queues or InnovaAPI reads", () => {
  for (const name of ["stageJob", "listJobQueues", "listStagingActions", "getRxJob"]) assert.equal(jobFloor[name], undefined, name);
  const fs = require("node:fs");
  const path = require("node:path");
  const routes = fs.readFileSync(path.join(__dirname, "..", "lib/job-floor-routes.js"), "utf8");
  for (const gone of ["/stage", "/job-queues", "/staging-actions", "/rx-job"]) assert.equal(routes.includes(gone), false, gone);
});

test("env flag overrides the stored setting", async () => {
  process.env.JOB_FLOOR_WRITES_ENABLED = "false";
  assert.equal(await jobFloor.writesEnabled(makeDeps({ writes: "true" })), false);
  process.env.JOB_FLOOR_WRITES_ENABLED = "true";
  assert.equal(await jobFloor.writesEnabled(makeDeps({ writes: "false" })), true);
});

test("input validation rejects ambiguous or malformed identifiers", async () => {
  const deps = makeDeps();
  await assert.rejects(jobFloor.updateStatus({ orderId: 1, rxNumber: "x", statusItemId: 2 }, {}, deps), /exactly one/);
  await assert.rejects(jobFloor.updateStatus({ orderId: 1, trayId: "9", statusItemId: 2 }, {}, deps), /exactly one/);
  await assert.rejects(jobFloor.updateStatus({ statusItemId: 2 }, {}, deps), /exactly one/);
  await assert.rejects(jobFloor.updateStatus({ orderId: "abc", statusItemId: 2 }, {}, deps), /positive integer/);
  await assert.rejects(jobFloor.updateStatus({ orderId: 1, statusItemId: 0 }, {}, deps), /positive integer/);
  assert.equal(deps.audits.length, 0);
});

test("status items come from the source writer in the shape the page expects", async () => {
  assert.deepEqual(await jobFloor.listStatusItems({}, makeDeps()), [
    { ID: 27, name: "Focimeter 2 Final PASS", inactive: false, showInMobileApp: true, holdChecked: false, writable: true, reason: null },
    { ID: 193, name: "Unhold", inactive: false, showInMobileApp: true, holdChecked: true, writable: false, reason: "not supported from OptiLens yet" },
  ]);
});

test("job-floor page is wired into routes, permissions, edition and launcher", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const html = read("public/job-floor.html");
  assert.match(html, /href="\/styles\/system\.css"/);
  assert.match(html, /job-floor\.js/);
  assert.match(read("public/job-floor.js"), /\/api\/job-floor/);
  const server = read("server.js");
  assert.match(server, /"\/modules\/job-floor":\s+"job-floor\.html"/);
  assert.match(server, /"\/modules\/job-floor": \["automation\.read", "automation\.manage"\]/);
  assert.match(server, /handleJobFloorRoute\(/);
  const edition = read("lib/edition.js");
  assert.match(edition, /"\/modules\/job-floor"/);
  assert.match(edition, /"\/api\/job-floor"/);
  assert.match(read("public/shared.js"), /id: "job-floor"/);
  assert.match(read("public/app.js"), /id: "job-floor"/);
});

test("hold-checked statuses are off by default and enabled only through the setting or env", async () => {
  assert.deepEqual(await jobFloor.holdCheckedStatusIds(makeDeps()), []);
  const setting = makeDeps();
  setting.getSetting = async (key) => (key === "job_floor.hold_checked_status_ids" ? "79, 80,x,-1" : null);
  assert.deepEqual(await jobFloor.holdCheckedStatusIds(setting), [79, 80]);
  process.env.JOB_FLOOR_HOLD_CHECKED_STATUS_IDS = "80";
  try {
    assert.deepEqual(await jobFloor.holdCheckedStatusIds(setting), [80]);
  } finally {
    delete process.env.JOB_FLOOR_HOLD_CHECKED_STATUS_IDS;
  }
});

test("the enabled hold-checked ids reach the preview and the status list", async () => {
  const deps = makeDeps();
  deps.getSetting = async (key) => (key === "job_floor.hold_checked_status_ids" ? "79" : null);
  await jobFloor.updateStatus({ orderId: 5, statusItemId: 79 }, {}, deps);
  await jobFloor.listStatusItems({}, deps);
  assert.deepEqual(deps.sourceCalls.map((c) => [c.op, (c.input ?? c.opts).holdCheckedStatusIds]), [["preview", [79]], ["list", [79]]]);
});
