const assert = require("node:assert/strict");
const test = require("node:test");
const { buildRxCaptureOrder } = require("../lib/rx-capture/order-builder");

const lens = {
  alias: "1234567890123", mfType: "Single Vision",
  colorCode: "CLR", colorDescription: "Clear",
  materialCode: "MR", materialDescription: "MR Material",
  styleCode: "SV", styleDescription: "Single Vision"
};

function generator() {
  return {
    loadConfig: () => ({ defaults: { labNum: "1177", custSeqNum: "1", remoteOperator: "EMP" }, output: { extension: ".rx" } }),
    getCatalog: () => [lens],
    getCoatings: () => [{ sku: "COAT", source: "MISC", description: "Coating", kind: "coating" }],
    getAddons: () => [{ sku: "EDGE", source: "MISC", description: "EDGE TO FIT" }],
    LENS_BEHAVIOUR: { "Single Vision": { lensSvMf: "s", rxType: "S", requiresAdd: false, requiresSegHeight: false } },
    filenameFor: (orderId, patient, extension) => `${orderId}_${patient.replace(/[^A-Z]/g, "_")}${extension}`,
    renderRxText: (order) => `id:${order.identifiers.orderId}\npatient:${order.patient.name}\nlens:${order.lens.alias}\n`,
    nextIdentifiers: () => ({ orderId: "80000001", gkOrder: "60000001", guid: "a".repeat(40) })
  };
}

function normalizedOrder() {
  return {
    patient: { name: "DOE, JANE" },
    prescription: {
      od: { sphere: "-1.00", cylinder: "-0.50", axis: 90 },
      os: { sphere: "-1.25", cylinder: "0", axis: null }
    },
    pd: { binocular: "64" },
    frame: { a: "54", b: "36", dbl: "18" },
    lensRequest: { lensType: "Single Vision" },
    uncertainFields: [], missingFields: []
  };
}

function resolution() {
  return { customerNumber: "5000150", shipName: "Classic Visions", lensAlias: lens.alias, frameMode: "uncut", coatingSku: "COAT" };
}

test("builds a deterministic reviewed RX order only from exact source selections", () => {
  const result = buildRxCaptureOrder(normalizedOrder(), resolution(), { generator: generator(), reserveIdentifiers: false });
  assert.equal(result.order.patient.name, "DOE, JANE");
  assert.equal(result.order.lens.alias, lens.alias);
  assert.equal(result.order.prescription.od.near, "32.0");
  assert.equal(result.order.prescription.os.axis, "0");
  assert.equal(result.order.frame.source, "NO TRACE - UNCUT");
  assert.equal(result.order.items[0].sku, "COAT");
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.order.content, /lens:1234567890123/);
});

test("keeps unresolved captured values blank while still requiring an exact lens", () => {
  const incomplete = normalizedOrder();
  incomplete.uncertainFields = ["prescription.od.sphere"];
  incomplete.prescription.od.sphere = null;
  incomplete.prescription.os.axis = null;
  incomplete.pd.binocular = null;
  incomplete.frame = {};
  const result = buildRxCaptureOrder(incomplete, resolution(), { generator: generator(), reserveIdentifiers: false });
  assert.equal(result.issues.hasIssues, true);
  assert.equal(result.order.prescription.od.sphere, "");
  assert.equal(result.order.prescription.os.axis, "0");
  assert.equal(result.order.prescription.od.near, "");
  assert.equal(result.order.frame.a, "");
  assert.throws(() => buildRxCaptureOrder(normalizedOrder(), { ...resolution(), lensAlias: "9999999999999" }, { generator: generator() }), /exact source-validated lens alias/);
});

test("adds only the configured exact edging item for an edged capture", () => {
  const captured = normalizedOrder();
  captured.frame.model = "FRAME 54";
  const result = buildRxCaptureOrder(captured, { ...resolution(), frameMode: "edged", frameMounting: "1" }, { generator: generator(), reserveIdentifiers: false });
  assert.equal(result.order.frame.status, "ENCLOSED");
  assert.equal(result.order.items.at(-1).description, "EDGE TO FIT");
});

test("an edged capture with no detected frame model sends the follow-up placeholder", () => {
  const captured = normalizedOrder();
  captured.frame.model = null;
  captured.frame.color = null;
  const result = buildRxCaptureOrder(captured, { ...resolution(), frameMode: "edged", frameMounting: "2" }, { generator: generator(), reserveIdentifiers: false });
  assert.equal(result.order.frame.model, "FRAME TO FOLLOW");
  assert.equal(result.order.frame.color, "1");
  assert.equal(result.order.frame.mounting, "2");
});

test("an edged capture with blank measurements sends the default box and plastic mounting", () => {
  const captured = normalizedOrder();
  captured.frame = { a: null, b: "", dbl: undefined };
  const result = buildRxCaptureOrder(captured, { ...resolution(), frameMode: "edged" }, { generator: generator(), reserveIdentifiers: false });
  assert.equal(result.order.frame.a, "55.0");
  assert.equal(result.order.frame.b, "45.0");
  assert.equal(result.order.frame.dbl, "18.0");
  assert.equal(result.order.frame.mounting, "2");
});

test("distance PDs are sent over the binocular note, which only fills a blank eye", () => {
  const captured = normalizedOrder();
  captured.pd = { binocular: "64", od: "31", os: "33.5" };
  const both = buildRxCaptureOrder(captured, resolution(), { generator: generator(), reserveIdentifiers: false });
  assert.equal(both.order.prescription.od.far, "31.0");
  assert.equal(both.order.prescription.os.far, "33.5");
  captured.pd = { binocular: "64", od: "31", os: null };
  const one = buildRxCaptureOrder(captured, resolution(), { generator: generator(), reserveIdentifiers: false });
  assert.equal(one.order.prescription.os.far, "32.0");
});
