const assert = require("node:assert/strict");
const test = require("node:test");
const jobFloor = require("../lib/job-floor");
const jobFloorSource = require("../lib/job-floor-source");

function makeDeps({ writes = "false", response = { data: { ok: true } }, fail = null, sourceFail = null } = {}) {
  const calls = [];
  const audits = [];
  const sourceCalls = [];
  return {
    calls,
    audits,
    sourceCalls,
    source: {
      SourceStatusError: jobFloorSource.SourceStatusError,
      previewStatusUpdate: async (input) => { sourceCalls.push({ op: "preview", input }); if (sourceFail) throw sourceFail; return { orderId: 55, alreadyApplied: false }; },
      applyStatusUpdate: async (input) => { sourceCalls.push({ op: "apply", input }); if (sourceFail) throw sourceFail; return { orderId: 55, applied: true, verified: true }; },
      listAllowedStatuses: async () => [{ id: 27, name: "Focimeter 2 Final PASS" }],
    },
    api: {
      request: async (method, path, opts = {}) => {
        calls.push({ method, path, ...opts });
        if (fail) throw new Error(fail);
        return response;
      },
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
  assert.equal(deps.calls.length, 0);
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
  assert.deepEqual(deps.sourceCalls, [{ op: "apply", input: { orderId: 9, statusItemId: 2, expectedCurrentStatusId: 5, userAccountId: 41 } }]);
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

test("direct status updates reject tray lookups, notes and e-mail rather than dropping them", async () => {
  const deps = makeDeps();
  await assert.rejects(jobFloor.updateStatus({ trayId: "T1", statusItemId: 2 }, {}, deps), /Tray lookup/);
  await assert.rejects(jobFloor.updateStatus({ orderId: 1, statusItemId: 2, note: "hi" }, {}, deps), /Notes/);
  await assert.rejects(jobFloor.updateStatus({ orderId: 1, statusItemId: 2, email: true }, {}, deps), /Notes/);
  assert.equal(deps.sourceCalls.length, 0);
});

test("env flag overrides the stored setting", async () => {
  process.env.JOB_FLOOR_WRITES_ENABLED = "false";
  assert.equal(await jobFloor.writesEnabled(makeDeps({ writes: "true" })), false);
  process.env.JOB_FLOOR_WRITES_ENABLED = "true";
  assert.equal(await jobFloor.writesEnabled(makeDeps({ writes: "false" })), true);
});

test("a failing API call is audited and rethrown", async () => {
  const deps = makeDeps({ writes: "true", fail: "boom" });
  await assert.rejects(jobFloor.stageJob({ trayId: "A1", actionId: 1 }, { dryRun: false }, deps), /boom/);
  assert.deepEqual(deps.audits.map((a) => a.eventType), ["job_floor.stage_job.attempted", "job_floor.stage_job.failed"]);
});

test("input validation rejects ambiguous or malformed identifiers", async () => {
  const deps = makeDeps();
  await assert.rejects(jobFloor.updateStatus({ orderId: 1, rxNumber: "x", statusItemId: 2 }, {}, deps), /exactly one/);
  await assert.rejects(jobFloor.updateStatus({ statusItemId: 2 }, {}, deps), /exactly one/);
  await assert.rejects(jobFloor.updateStatus({ orderId: "abc", statusItemId: 2 }, {}, deps), /positive integer/);
  await assert.rejects(jobFloor.updateStatus({ orderId: 1, statusItemId: 0 }, {}, deps), /positive integer/);
  await assert.rejects(jobFloor.stageJob({ actionId: 1 }, {}, deps), /Identify the job/);
  assert.equal(deps.audits.length, 0);
});

test("stageJob maps fields to the job_staging query names", async () => {
  const deps = makeDeps();
  const r = await jobFloor.stageJob({ trayId: "A1", actionId: "4", stagingAreaId: 2, checkInsOnly: true }, {}, deps);
  assert.deepEqual(r.request.query, {
    tray_id: "A1", order_id: undefined, rx_number: undefined, po_number: undefined, invoice_id: undefined,
    action_id: 4, sku: undefined, container_name: undefined, check_ins_only: 1, staging_area_id: 2,
  });
});

test("reads unwrap the data envelope and use the right endpoints", async () => {
  const deps = makeDeps({ response: { data: { statusItem: [{ statusID: 1 }], jobQueue: [{ id: 2 }], jobStagingActions: [{ id: 3 }], rxJob: { orderID: 9 } } } });
  assert.deepEqual(await jobFloor.listStatusItems({}, deps), [{ ID: 27, name: "Focimeter 2 Final PASS", inactive: false, showInMobileApp: true }]);
  assert.deepEqual(await jobFloor.listJobQueues(deps), [{ id: 2 }]);
  assert.deepEqual(await jobFloor.listStagingActions(deps), [{ id: 3 }]);
  assert.deepEqual(await jobFloor.getRxJob({ orderId: 9 }, deps), { orderID: 9 });
  assert.deepEqual(deps.calls.map((c) => c.path), ["/job_queues", "/job_staging_actions", "/orders/9/rx_job"]);
  await assert.rejects(jobFloor.getRxJob({}, deps), /exactly one/);
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
