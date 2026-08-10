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
  const order = buildOrder(payload, config);
  const real = fieldsOf(UNCUT_SAMPLE);

  assert.equal(order.frame.source, real.frame_source, "frame_source must match the real UNCUT sample");
  assert.equal(order.frame.status, real.frame_status, "frame_status must match the real UNCUT sample");
  assert.equal(order.frame.tracing, real.frame_tracing, "frame_tracing must match the real UNCUT sample");
  assert.equal(order.frame.edge, real.frame_edge, "frame_edge must match the real UNCUT sample");
});

test("edged web order never claims TRACED without real trace geometry", () => {
  const payload = basePayload();
  payload.frame = { is_uncut: false, job_scope: "full_glaze", brand: "Test Frame", a_mm: 55, b_mm: 38, dbl_mm: 15 };
  const order = buildOrder(payload, config);

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
  const order = buildOrder(payload, config);
  assert.match(order.content, /\r\n/, "output must use CRLF line endings to match real exports");
  assert.match(order.content, /^file_version:/);
  assert.match(order.content, /start_order\r\n/);
  assert.match(order.content, /end_order\r\n?$/);
});

test("a submission with no resolved Innovations alias is rejected before it can reach the lab", () => {
  const payload = basePayload();
  delete payload.lenses[0].codes.material_code;
  assert.throws(() => buildOrder(payload, config), /No Innovations alias resolved/);
});

test("a submission with no ERP account number is rejected before it can reach the lab", () => {
  const payload = basePayload();
  payload.account = {};
  assert.throws(() => buildOrder(payload, config), /no account number/);
});
