const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const RxBulk = require("../public/rx-capture-bulk");
const { createRxCaptureService, createTaskQueue, parseBatch, summarizeBatch } = require("../lib/rx-capture/service");

const ROOT = path.join(__dirname, "..");
const actor = { userId: "11111111-1111-4111-8111-111111111111", username: "employee", displayName: "Employee" };
const BATCH_ID = "22222222-2222-4222-8222-222222222222";
const customer = { id: 7, account: "5000150", name: "Value Optical Ltd" };

const file = (name, size = 1000, type = "application/pdf", lastModified = 1) => ({ name, size, type, lastModified });
const pdfDataUrl = (marker) => `data:application/pdf;base64,${Buffer.from(`%PDF-1.4 ${marker}`).toString("base64")}`;

test("bulk upload accepts PDFs and images, skips the rest and repeats, and caps the list at 100", () => {
  const first = RxBulk.acceptFiles([file("a.pdf"), file("b.png", 10, "image/png"), file("c.txt", 10, "text/plain"), file("big.pdf", 9 * 1024 * 1024), file("a.pdf")]);
  assert.deepEqual(first.accepted.map((item) => item.file.name), ["a.pdf", "b.png"]);
  assert.deepEqual(first.rejected.map((item) => item.name), ["c.txt", "big.pdf", "a.pdf"]);
  assert.match(first.rejected[2].reason, /Already in the list/);

  const many = Array.from({ length: 130 }, (_, index) => file(`rx-${index}.pdf`, 100 + index));
  const capped = RxBulk.acceptFiles(many);
  assert.equal(capped.accepted.length, 100);
  assert.equal(capped.rejected.length, 30);
  const more = RxBulk.acceptFiles([file("extra.pdf")], capped.accepted);
  assert.equal(more.accepted.length, 0);
  assert.match(more.rejected[0].reason, /100 files/);
});

test("bulk upload sends a few files at a time and one failure never stops the rest", async () => {
  const items = Array.from({ length: 10 }, (_, index) => ({ file: file(`rx-${index}.pdf`), status: "ready", message: "" }));
  let active = 0;
  let peak = 0;
  const upload = async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    if (item.file.name === "rx-3.pdf") throw Object.assign(new Error("Server busy."), { status: 503 });
    if (item.file.name === "rx-5.pdf") throw Object.assign(new Error("Already uploaded on 2026-10-15 12:00 UTC."), { status: 409 });
  };
  const counts = await RxBulk.uploadAll(items, upload);
  assert.ok(peak <= RxBulk.UPLOAD_CONCURRENCY && peak > 1, `peak ${peak}`);
  assert.deepEqual(counts, { ready: 0, uploading: 0, queued: 8, duplicate: 1, error: 1 });
  assert.equal(items[5].status, "duplicate");

  // A retry uploads only the failed file.
  const retried = [];
  await RxBulk.uploadAll(items, async (item) => { retried.push(item.file.name); });
  assert.deepEqual(retried, ["rx-3.pdf"]);
  assert.equal(items[3].status, "queued");
});

test("bulk progress is worded for a person watching the queue", () => {
  assert.equal(RxBulk.progressText(null), "Waiting for the first file…");
  const running = { total: 100, done: 37, queued: 60, processing: 3, ready: 35, needsAttention: 2, failed: 0, finished: false };
  assert.equal(RxBulk.progressText(running), "37 of 100 read · 3 reading now · 60 waiting · 35 ready to review · 2 need attention");
  assert.equal(RxBulk.percentDone(running), 37);
  const finished = { total: 100, done: 100, queued: 0, processing: 0, ready: 94, needsAttention: 4, failed: 2, finished: true };
  assert.equal(RxBulk.progressText(finished), "All 100 read · 94 ready to review · 4 need attention · 2 failed");
});

test("the server summarises a bulk upload by stage", () => {
  const summary = summarizeBatch({ NEW: 6, PROCESSING: 3, READY_FOR_REVIEW: 8, RELEASED: 1, NEEDS_INFO: 2, FAILED: 1 });
  assert.deepEqual(summary, { queued: 6, processing: 3, ready: 9, needsAttention: 2, failed: 1, total: 21, done: 12, finished: false });
  assert.equal(summarizeBatch({ READY_FOR_REVIEW: 2 }).finished, true);
  assert.equal(summarizeBatch({}).finished, false);
});

test("the processing queue never runs more tasks than its limit and keeps order", async () => {
  const queue = createTaskQueue(3);
  let active = 0;
  let peak = 0;
  const started = [];
  await new Promise((resolve) => {
    let finished = 0;
    for (let index = 0; index < 12; index += 1) {
      queue.push(async () => {
        started.push(index);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((done) => setTimeout(done, 3));
        active -= 1;
        finished += 1;
        if (finished === 12) resolve();
      });
    }
  });
  assert.equal(peak, 3);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("a failing task does not stall the queue", async () => {
  const queue = createTaskQueue(1);
  const done = [];
  queue.push(async () => { throw new Error("boom"); });
  await new Promise((resolve) => queue.push(async () => { done.push("second"); resolve(); }));
  assert.deepEqual(done, ["second"]);
});

test("a bulk upload reference must be a UUID and file names lose their folder path", () => {
  assert.equal(parseBatch(undefined), null);
  assert.deepEqual(parseBatch({ id: BATCH_ID.toUpperCase(), fileName: "C:/scans/Order1.pdf" }), { id: BATCH_ID, fileName: "Order1.pdf" });
  assert.equal(parseBatch({ id: BATCH_ID, fileName: "a" + String.fromCharCode(92) + "b" + String.fromCharCode(92) + "Order2.pdf" }).fileName, "Order2.pdf");
  assert.throws(() => parseBatch({ id: "not-a-uuid" }), { statusCode: 400 });
});

function fakeOrderPool({ duplicate = null } = {}) {
  const rows = new Map();
  const state = { rows, inserts: [], events: [], updates: [] };
  state.pool = {
    request() {
      const params = {};
      const request = {
        input(name, _type, value) { params[name] = value; return request; },
        async query(text) {
          if (/INSERT INTO rx_capture\.orders/.test(text)) {
            state.inserts.push({ ...params });
            rows.set(params.capture_order_id, { ...params, created_by_user_id: params.created_by_user_id, last_updated_at: params.created_at });
            return { recordset: [], rowsAffected: [1] };
          }
          if (/FROM rx_capture\.orders\s+WHERE source_sha256/.test(text)) return { recordset: duplicate ? [duplicate] : [] };
          if (/order_events/.test(text)) { state.events.push({ ...params }); return { recordset: [], rowsAffected: [1] }; }
          if (/^\s*UPDATE rx_capture\.orders/.test(text)) {
            state.updates.push({ text, ...params });
            const row = rows.get(params.capture_order_id);
            if (row && /SET status = N'PROCESSING'/.test(text)) {
              if (row.status !== "NEW") return { recordset: [], rowsAffected: [0] };
              row.status = "PROCESSING";
            }
            if (row && params.status && /SET status = @status/.test(text)) row.status = params.status;
            return { recordset: [], rowsAffected: [1] };
          }
          return { recordset: [...rows.values()].filter((row) => row.capture_order_id === params.capture_order_id) };
        }
      };
      return request;
    }
  };
  return state;
}

function cleanUp(state) {
  for (const insert of state.inserts) {
    for (const filePath of JSON.parse(insert.source_image_paths_json || "[]")) fs.rmSync(filePath, { force: true });
  }
}

test("a bulk file is stored as a queued order and handed to the bounded queue, not processed at once", async () => {
  const fake = fakeOrderPool();
  const queued = [];
  const immediate = [];
  const service = createRxCaptureService({
    getAppPool: async () => fake.pool,
    scheduleBatch: (task) => queued.push(task),
    schedule: (task) => immediate.push(task)
  });
  try {
    const order = await service.createOrder({ images: [{ dataUrl: pdfDataUrl("one") }], customer, batch: { id: BATCH_ID, fileName: "Order1.pdf" } }, actor);
    assert.equal(order.status, "NEW");
    assert.equal(order.batchId, BATCH_ID);
    assert.equal(order.fileName, "Order1.pdf");
    assert.equal(fake.inserts[0].batch_id, BATCH_ID);
    assert.match(fake.inserts[0].source_sha256, /^[0-9a-f]{64}$/);
    assert.equal(queued.length, 1);
    assert.equal(immediate.length, 0);

    // An ordinary single capture keeps its immediate path and PROCESSING status.
    const single = await service.createOrder({ images: [{ dataUrl: pdfDataUrl("two") }], customer }, actor);
    assert.equal(single.status, "PROCESSING");
    assert.equal(immediate.length, 1);
    assert.equal(queued.length, 1);
  } finally {
    cleanUp(fake);
  }
});

test("the same file uploaded twice is refused with a clear message and stores nothing", async () => {
  const fake = fakeOrderPool({ duplicate: { capture_order_id: "x", source_file_name: "Order1.pdf", created_at: new Date("2026-10-15T12:30:00Z") } });
  const service = createRxCaptureService({ getAppPool: async () => fake.pool, scheduleBatch: () => { throw new Error("must not queue"); } });
  await assert.rejects(
    service.createOrder({ images: [{ dataUrl: pdfDataUrl("one") }], customer, batch: { id: BATCH_ID, fileName: "Order1.pdf" } }, actor),
    { statusCode: 409, message: /Already uploaded on 2026-10-15 12:30 UTC as Order1\.pdf/ }
  );
  assert.equal(fake.inserts.length, 0);
});

test("a bulk upload carries exactly one file per order", async () => {
  const fake = fakeOrderPool();
  const service = createRxCaptureService({ getAppPool: async () => fake.pool, scheduleBatch: () => {} });
  await assert.rejects(
    service.createOrder({ images: [{ dataUrl: pdfDataUrl("a") }, { dataUrl: pdfDataUrl("b") }], customer, batch: { id: BATCH_ID } }, actor),
    { statusCode: 400, message: /one file per order/ }
  );
});

test("a queued order is claimed once, read, and left ready for review; a discarded one is skipped", async () => {
  const fake = fakeOrderPool();
  let extractions = 0;
  const service = createRxCaptureService({
    getAppPool: async () => fake.pool,
    scheduleBatch: () => {},
    getCatalog: () => [],
    extractPrescriptionFromImages: async () => { extractions += 1; return {}; },
    retryDelaysMs: []
  });
  try {
    const order = await service.createOrder({ images: [{ dataUrl: pdfDataUrl("three") }], customer, batch: { id: BATCH_ID, fileName: "Order3.pdf" } }, actor);
    const row = fake.rows.get(order.id);
    assert.equal(row.status, "NEW");
    await service.processOrder(order.id, actor);
    assert.equal(extractions, 1);

    // Claim fails for an order that is no longer waiting, so nothing is read twice.
    const second = await service.createOrder({ images: [{ dataUrl: pdfDataUrl("four") }], customer, batch: { id: BATCH_ID, fileName: "Order4.pdf" } }, actor);
    fake.rows.get(second.id).status = "CANCELLED";
    const before = extractions;
    await service.recoverProcessingOrders().catch(() => {});
    assert.equal(extractions, before);
  } finally {
    cleanUp(fake);
  }
});

test("bulk extraction retries a busy extractor but a single capture reports the failure straight away", async () => {
  async function run(batch) {
    const fake = fakeOrderPool();
    let calls = 0;
    const slept = [];
    const service = createRxCaptureService({
      getAppPool: async () => fake.pool,
      scheduleBatch: () => {},
      schedule: () => {},
      getCatalog: () => [],
      retryDelaysMs: [1, 2],
      sleep: async (ms) => { slept.push(ms); },
      extractPrescriptionFromImages: async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error("busy"), { statusCode: 502 });
        return {};
      }
    });
    try {
      const order = await service.createOrder({ images: [{ dataUrl: pdfDataUrl(batch ? "b" : "s") }], customer, ...(batch ? { batch: { id: BATCH_ID, fileName: "x.pdf" } } : {}) }, actor);
      await service.processOrder(order.id, actor);
      return { calls, slept, status: fake.rows.get(order.id).status, failures: fake.updates.filter((update) => /FAILED/.test(update.text)).length };
    } finally {
      cleanUp(fake);
    }
  }
  const bulk = await run(true);
  assert.equal(bulk.calls, 3);
  assert.deepEqual(bulk.slept, [1, 2]);
  assert.equal(bulk.failures, 0);
  const single = await run(false);
  assert.equal(single.calls, 1);
  assert.equal(single.failures, 1);
});

test("the new columns are added by a registered migration", () => {
  const migrations = fs.readFileSync(path.join(ROOT, "lib", "migrations.js"), "utf8");
  assert.match(migrations, /054-rx-capture-bulk-upload\.sql/);
  const sql = fs.readFileSync(path.join(ROOT, "database", "054-rx-capture-bulk-upload.sql"), "utf8");
  for (const column of ["batch_id", "source_file_name", "source_sha256"]) assert.match(sql, new RegExp(`COL_LENGTH\\(N'rx_capture\\.orders', N'${column}'\\)`));
});

test("the page accepts dropped files on Recent orders and on the New prescription area", () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "rx-capture.html"), "utf8");
  const client = fs.readFileSync(path.join(ROOT, "public", "rx-capture.js"), "utf8");
  assert.match(html, /<script src="\/rx-capture-bulk\.js" defer><\/script>/);
  assert.match(html, /data-mode="bulk"/);
  assert.match(html, /id="bulkDropZone"/);
  assert.match(html, /id="batchBanner"/);
  // Recent orders panel is a drop target.
  assert.match(client, /document\.querySelector\("\.orders-panel"\)/);
  assert.match(client, /openBulk\(event\.dataTransfer\.files\)/);
  // Several files dropped on the New prescription area become a bulk upload.
  assert.match(client, /if \(dropped\.length > 1\) return openBulk\(dropped\)/);
  // One order per file, tagged with the batch.
  assert.match(client, /batch: \{ id: batchId, fileName: item\.file\.name \}/);
});

test("the batch routes are authenticated and the list can be filtered to one upload", () => {
  const routes = fs.readFileSync(path.join(ROOT, "lib", "rx-capture", "routes.js"), "utf8");
  assert.ok(routes.includes("batches"), "the batch progress route is registered");
  assert.match(routes, /requirePermission\(req, "rx-capture\.read"\)[\s\S]{0,120}batchSummary/);
  assert.match(routes, /batchId: url\.searchParams\.get\("batch"\)/);
});
