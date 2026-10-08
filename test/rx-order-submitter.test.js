const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const rxGenerator = require("../lib/rx-generator");
const { buildOrder } = require("../lib/rx-order-submitter");

// Regression fixtures: real LabLink -> Innovations .rx exports (uploaded by
// Russell 2026-08-09; see docs/rx-format-field-map.md). These pin down the
// enum values buildOrder() must reproduce for CV web orders.
const SAMPLES_DIR = path.join(__dirname, "..", "templates", "rx-samples");
const UNCUT_SAMPLE = fs.readFileSync(path.join(SAMPLES_DIR, "sample-sv-distance-uncut.rx"), "utf8");
const ENCLOSED_SAMPLE = fs.readFileSync(path.join(SAMPLES_DIR, "sample-progressive-enclosed-traced.rx"), "utf8");

function fieldsOf(text) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1);
  }
  return fields;
}

const config = rxGenerator.loadConfig();

const basePayload = () => ({
  quote: { quote_number: "Q-TEST-1", notes_customer: "", customer_name: "Test Customer" },
  account: { account_number: "5000150", name: "Test Customer" },
  frame: {},
  lenses: [{
    item_name: "Test Lens",
    codes: {
      mf_type: "Single Vision",
      color_code: "0", color_description: "Clear",
      material_code: "0", material_description: "1.50 Plastic",
      style_code: "1", style_description: "Single Vision",
    },
    rx: { od_sph: "0", od_cyl: "0", od_axis: "0", os_sph: "0", os_cyl: "0", os_axis: "0", pd: 66 },
  }],
  addons: [],
});

test("uncut web order matches the real UNCUT enum pattern (no fabricated trace claim)", () => {
  const payload = basePayload();
  payload.frame = { is_uncut: true };
  const order = buildOrder(payload, config, { reserveIdentifiers: false });
  const real = fieldsOf(UNCUT_SAMPLE);

  assert.equal(order.frame.source, real.frame_source, "frame_source must match the real UNCUT sample");
  assert.equal(order.frame.status, real.frame_status, "frame_status must match the real UNCUT sample");
  assert.equal(order.frame.tracing, real.frame_tracing, "frame_tracing must match the real UNCUT sample");
  assert.equal(order.frame.edge, real.frame_edge, "frame_edge must match the real UNCUT sample");
});

test("edged web order never claims TRACED without real trace geometry", () => {
  const payload = basePayload();
  payload.frame = { is_uncut: false, job_scope: "full_glaze", brand: "Test Frame", a_mm: 55, b_mm: 38, dbl_mm: 15 };
  const order = buildOrder(payload, config, { reserveIdentifiers: false });

  // We have no tracer hardware behind the web form, so we must never send
  // "TRACED" / "TRACE - UNCUT" -- that would misrepresent the job to Innova.
  assert.notEqual(order.frame.tracing, "TRACED");
  assert.notEqual(order.frame.source, "TRACE - UNCUT");
  // And must never send the old, unverified "FRAME TRACE" value either.
  assert.notEqual(order.frame.source, "FRAME TRACE");
  assert.notEqual(order.frame.tracing, "FRAME TRACE");
  assert.equal(order.frame.status, "ENCLOSED");
  assert.equal(order.frame.edge, "EDGED");

  // Sanity: the enclosed+traced real sample at least confirms ENCLOSED/EDGED
  // are valid values for this job shape, even though its tracing differs.
  const real = fieldsOf(ENCLOSED_SAMPLE);
  assert.equal(order.frame.status, real.frame_status);
  assert.equal(order.frame.edge, real.frame_edge);
});

test("rendered order text uses colon-delimited fields and CRLF, like real Innova exports", () => {
  const payload = basePayload();
  payload.frame = { is_uncut: true };
  const order = buildOrder(payload, config, { reserveIdentifiers: false });
  assert.match(order.content, /\r\n/, "output must use CRLF line endings to match real exports");
  assert.match(order.content, /^file_version:/);
  assert.match(order.content, /start_order\r\n/);
  assert.match(order.content, /end_order\r\n?$/);
});

test("a confirmed standard-shape selection produces a real trace block and TRACED enum values", () => {
  const payload = basePayload();
  payload.frame = { is_uncut: true, a_mm: 52, b_mm: 38, dbl_mm: 17 };
  payload.shape = {
    source: "standard", standardId: "rect", job: "1506", confirmed: true, mirroredFrom: null,
    nativeBox: { a: 55, b: 40, dbl: 18, ed: 61 },
    computed: { ed: 60.5, edAxis: 15, circ: 160 },
    radii: { R: [25, 25.5, 26, 26.5, 27], L: [24, 24.5, 25, 25.5, 26] },
  };
  const order = buildOrder(payload, config, { reserveIdentifiers: false });
  assert.equal(order.frame.tracing, "TRACED");
  assert.equal(order.frame.source, "TRACE - UNCUT");
  assert.match(order.content, /x_standard_shape_trace:true/);
  assert.match(order.content, /trace_start\r\n[\s\S]*trace_end\r\n/);
  assert.match(order.content, /TRCFMT=1;5;E;R;F/);
});

test("an unconfirmed shape selection is dropped -- sent as NO TRACE, not fabricated", () => {
  const payload = basePayload();
  payload.frame = { is_uncut: true };
  payload.shape = {
    source: "standard", standardId: "rect", job: "1506", confirmed: false, mirroredFrom: null,
    nativeBox: { a: 55, b: 40, dbl: 18, ed: 61 },
    computed: { ed: 60.5, edAxis: 15, circ: 160 },
    radii: { R: [25, 26, 27], L: [24, 25, 26] },
  };
  const order = buildOrder(payload, config, { reserveIdentifiers: false });
  assert.equal(order.frame.tracing, "NO TRACE");
  assert.equal(order.frame.source, "NO TRACE - UNCUT");
  assert.match(order.content, /x_standard_shape_trace:false/);
  assert.doesNotMatch(order.content, /trace_start/);
  assert.match(order.instructions, /not confirmed by the dispenser/);
});

test("a submission with no resolved Innovations alias is rejected before it can reach the lab", () => {
  const payload = basePayload();
  delete payload.lenses[0].codes.material_code;
  assert.throws(() => buildOrder(payload, config, { reserveIdentifiers: false }), /No Innovations alias resolved/);
});

test("a submission with no ERP account number is rejected before it can reach the lab", () => {
  const payload = basePayload();
  payload.account = {};
  assert.throws(() => buildOrder(payload, config, { reserveIdentifiers: false }), /no account number/);
});

const { buildDropFile } = require("../lib/rx-order-submitter");

const claimed = (over = {}) => ({
  payload: { account: { account_number: "5000150" } },
  canonical_order: { orderId: "4821", patientName: "Test, Patient" },
  hashref_body: "start_order\r\nlab_num:{{lab_num}}\r\ncust_num:{{cust_num}}\r\nend_order",
  ...over,
});

test("drop file fills lab and customer, and is named from the database order number", () => {
  const drop = buildDropFile(claimed(), { defaults: { labNum: "1177" }, output: { extension: ".rx" } });
  assert.match(drop.content, /lab_num:1177\r\ncust_num:5000150\r\n/);
  assert.equal(drop.filename, "4821_TEST_PATIENT.rx");
});

test("drop file refuses an order the website could not render", () => {
  assert.throws(
    () => buildDropFile(claimed({ canonical_order: null, hashref_body: undefined, canonical_error: "A confirmed lens alias is required" }), { defaults: { labNum: "1177" }, output: { extension: ".rx" } }),
    /confirmed lens alias/,
  );
});

test("drop file refuses a missing account number", () => {
  assert.throws(
    () => buildDropFile(claimed({ payload: { account: {} } }), { defaults: { labNum: "1177" }, output: { extension: ".rx" } }),
    /account number/,
  );
});

const stockGenerator = require('../lib/stock-order-generator');
const syncLog = require('../lib/innovations-sync-log');
const fixtureConfig = {
  defaults: { labNum: '1177' }, output: { extension: '.rx' }, stockOrder: {},
  folders: { incoming: 'fixture-incoming', stockStaging: 'fixture-staging', stockArchive: 'fixture-archive' },
};

for (const [side, code, other] of [['od', '1', 'os'], ['os', '2', 'od']]) {
  test(`drop file preserves ${side}-only Hashref bytes and .rx filename`, () => {
    // Cloud-rendered input contract; codes 1/2 still require live intake proof.
    const body = [
      'file_version:2.5', 'start_order', 'lab_num:{{lab_num}}', 'cust_num:{{cust_num}}',
      'order_num:4821', `rx_eye:${code}`, `x_${side}_lens_alias:FIXTURE`,
      `rx_${side}_sphere:0.00`, `rx_${side}_cylinder:-1.25`, `rx_${side}_axis:90`,
      `rx_${side}_far:31.50`, `rx_${side}_prism:1.00`, `rx_${side}_prism_dir:OUT`,
      `rx_${side}_seg_height:18.00`, 'end_order', '',
    ].join('\r\n');
    const drop = buildDropFile(claimed({ hashref_body: body }), fixtureConfig);
    assert.equal(drop.filename, '4821_TEST_PATIENT.rx');
    assert.equal(drop.content, body.replace('{{lab_num}}', '1177').replace('{{cust_num}}', '5000150'));
    assert.equal(fieldsOf(drop.content).rx_eye, code);
    assert.doesNotMatch(drop.content, new RegExp(`(?:rx_${other}_|x_${other}_lens_)`));
    assert.doesNotMatch(drop.content, /(?<!\r)\n/);
  });
}

for (const [label, present, outcome] of [
  ['consumed without receipt (current acceptance rule)', [], 'accepted'],
  ['renamed .bad', ['bad'], 'rejected'],
  ['.bad takes precedence over an incoming file', ['bad', 'incoming'], 'rejected'],
  ['still incoming at timeout', ['incoming'], 'pending'],
]) {
  test(`watcher verdict: ${label}`, async (t) => {
    const dropped = path.resolve(__dirname, '..', fixtureConfig.folders.incoming, '4821_TEST_PATIENT.rx');
    t.mock.method(fs, 'readFileSync', () => JSON.stringify(fixtureConfig));
    t.mock.method(fs, 'existsSync', (file) =>
      (file === dropped && present.includes('incoming')) ||
      (file === `${dropped}.bad` && present.includes('bad')));
    assert.equal(await stockGenerator.checkReleaseOutcome('4821_TEST_PATIENT.rx', { timeoutMs: 0 }), outcome);
  });
}

for (const outcome of ['accepted', 'rejected', 'pending']) {
  test(`RX worker reports ${outcome} after writing exact .rx fixture`, async (t) => {
    const sub = { ...claimed(), id: 'fixture-submission', attempts: 1 };
    const completions = [];
    const writes = [];
    t.mock.method(rxGenerator, 'loadConfig', () => fixtureConfig);
    t.mock.method(fs, 'existsSync', () => false);
    t.mock.method(rxGenerator, 'atomicWrite', (file, content) => writes.push({ file, content }));
    t.mock.method(stockGenerator, 'checkReleaseOutcome', async (filename) => {
      assert.equal(filename, '4821_TEST_PATIENT.rx');
      return outcome;
    });
    t.mock.method(syncLog, 'write', () => {});
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (String(url).endsWith('/_rx_submissions/next')) {
        return { ok: true, json: async () => ({ submission: sub }) };
      }
      assert.ok(String(url).endsWith('/_rx_submissions/complete'));
      completions.push(JSON.parse(options.body));
      return { ok: true };
    });
    const result = await require('../lib/rx-order-submitter').runOnce(
      { baseUrl: 'https://fixture.invalid', apiKey: 'fixture-only' }, { max: 1 });
    const ok = outcome !== 'rejected';
    assert.deepEqual(writes, [{
      file: path.resolve(__dirname, '..', fixtureConfig.folders.incoming, '4821_TEST_PATIENT.rx'),
      content: buildDropFile(sub, fixtureConfig).content,
    }]);
    assert.deepEqual(result.processed, [{ id: sub.id, ok, outcome, transport: 'file_drop', filename: '4821_TEST_PATIENT.rx' }]);
    assert.deepEqual(completions, [{
      id: sub.id, ok, transport: 'file_drop', attempts: 1,
      result_message: `Dropped 4821_TEST_PATIENT.rx; Innovations intake: ${outcome}.`,
      ...(ok ? {} : { error: 'Innova rejected 4821_TEST_PATIENT.rx (renamed .bad in the Incoming folder).' }),
    }]);
  });
}
