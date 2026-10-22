const assert = require("node:assert/strict");
const test = require("node:test");
const jobFloor = require("../lib/job-floor");

function makeDeps({ writes = "false", response = { data: { ok: true } }, fail = null } = {}) {
  const calls = [];
  const audits = [];
  return {
    calls,
    audits,
    api: {
      request: async (method, path, opts = {}) => {
        calls.push({ method, path, ...opts });
        if (fail) throw new Error(fail);
        return response;
      },
    },
    getSetting: async () => writes,
    recordAuditEvent: async (event) => { audits.push(event); },
  };
}

test.beforeEach(() => { delete process.env.JOB_FLOOR_WRITES_ENABLED; });

test("updateStatus defaults to a dry run: no API call, audited", async () => {
  const deps = makeDeps({ writes: "true" });
  const result = await jobFloor.updateStatus({ orderId: 55, statusItemId: 7, note: "hi" }, { actorUserId: 3 }, deps);
  assert.equal(result.dryRun, true);
  assert.equal(result.request.path, "/orders/55/status_item/7");
  assert.deepEqual(result.request.body, { orderUpdateNote: { note: "hi" } });
  assert.equal(deps.calls.length, 0);
  assert.deepEqual(deps.audits.map((a) => a.eventType), ["job_floor.update_status.dry_run"]);
});

test("a live write is refused (403) and audited while writes are disabled", async () => {
  const deps = makeDeps({ writes: "false" });
  await assert.rejects(
    jobFloor.updateStatus({ rxNumber: "1001", statusItemId: 2 }, { dryRun: false }, deps),
    (e) => e.statusCode === 403
  );
  assert.equal(deps.calls.length, 0);
  assert.deepEqual(deps.audits.map((a) => a.eventType), ["job_floor.update_status.refused"]);
});

test("a live write goes through only when enabled, with attempt and success audited", async () => {
  const deps = makeDeps({ writes: "true" });
  const result = await jobFloor.updateStatus({ trayId: "T 9", statusItemId: 2 }, { dryRun: false, actorUserId: 1 }, deps);
  assert.equal(result.dryRun, false);
  assert.deepEqual(deps.calls, [{ method: "PUT", path: "/trays/T%209/status_item/2", query: undefined, body: undefined }]);
  assert.deepEqual(deps.audits.map((a) => a.eventType), ["job_floor.update_status.attempted", "job_floor.update_status.succeeded"]);
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
  await assert.rejects(jobFloor.updateStatus({ orderId: 1, trayId: "x", statusItemId: 2 }, {}, deps), /exactly one/);
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
  assert.deepEqual(await jobFloor.listStatusItems({}, deps), [{ statusID: 1 }]);
  assert.deepEqual(await jobFloor.listJobQueues(deps), [{ id: 2 }]);
  assert.deepEqual(await jobFloor.listStagingActions(deps), [{ id: 3 }]);
  assert.deepEqual(await jobFloor.getRxJob({ orderId: 9 }, deps), { orderID: 9 });
  assert.deepEqual(deps.calls.map((c) => c.path), ["/status_items", "/job_queues", "/job_staging_actions", "/orders/9/rx_job"]);
  assert.equal(deps.calls[0].query.active, true);
  await assert.rejects(jobFloor.getRxJob({}, deps), /exactly one/);
});
