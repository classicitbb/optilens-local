const assert = require("node:assert/strict");
const test = require("node:test");

const RxVoice = require("../public/rx-capture-voice");
const { applyCaptureRules, normalizeOpticalOrder } = require("../lib/rx-capture/normalized-order");

const order = (values) => normalizeOpticalOrder(values);
const eye = (sphere, cylinder, axis) => ({ sphere, cylinder, axis });

test("a zero cylinder with no axis is left blank when a sphere is read", () => {
  for (const zero of ["0.00", "+0.00", "-0.00", "0", "SPH", "DS", "plano"]) {
    const result = applyCaptureRules(order({ prescription: { od: eye("-2.00", zero, null), os: eye("+1.25", zero, null) } }));
    assert.equal(result.prescription.od.cylinder, null, zero);
    assert.equal(result.prescription.os.cylinder, null, zero);
    assert.equal(result.prescription.od.axis, null);
  }
});

test("a real cylinder, or a zero cylinder that has an axis, is kept", () => {
  const result = applyCaptureRules(order({ prescription: { od: eye("-2.00", "-0.50", 180), os: eye("-1.00", "0.00", 90) } }));
  assert.equal(result.prescription.od.cylinder, "-0.50");
  assert.equal(result.prescription.od.axis, 180);
  assert.equal(result.prescription.os.cylinder, "0.00");
  assert.equal(result.prescription.os.axis, 90);
});

test("a zero cylinder is only dropped when the sphere was detected", () => {
  const result = applyCaptureRules(order({ prescription: { od: eye(null, "0.00", null), os: eye("-1.00", "0.00", null) } }));
  assert.equal(result.prescription.od.cylinder, "0.00");
  assert.equal(result.prescription.os.cylinder, null);
});

test("dropping a zero cylinder clears its uncertain and missing marks", () => {
  const flags = { "prescription.od.cylinder": { reason: "No plus or minus was spoken", evidence: "0" } };
  const result = applyCaptureRules(order({
    prescription: { od: eye("-2.00", "0", null) },
    uncertainFields: ["prescription.od.cylinder", "prescription.od.sphere"],
    missingFields: ["prescription.od.axis"]
  }), flags);
  assert.deepEqual(result.uncertainFields, ["prescription.od.sphere"]);
  assert.deepEqual(result.missingFields, []);
  assert.deepEqual(flags, {});
});

test("a binocular PD over 42 is split to one PD per eye", () => {
  const result = applyCaptureRules(order({ pd: { binocular: 64 } }));
  assert.equal(result.pd.od, "32.0");
  assert.equal(result.pd.os, "32.0");
  assert.equal(result.pd.binocular, null);
  const odd = applyCaptureRules(order({ pd: { binocular: 63 } }));
  assert.equal(odd.pd.od, "31.5");
  assert.equal(odd.pd.os, "31.5");
});

test("two binocular PDs are each split per eye", () => {
  const result = applyCaptureRules(order({ pd: { binocular: 64, nearBinocular: 61 } }));
  assert.deepEqual([result.pd.od, result.pd.os, result.pd.nearOd, result.pd.nearOs], ["32.0", "32.0", "30.5", "30.5"]);
  assert.equal(result.pd.binocular, null);
  assert.equal(result.pd.nearBinocular, null);
});

test("a single PD over 42 sitting in one eye field is treated as binocular", () => {
  const result = applyCaptureRules(order({ pd: { od: 66 } }));
  assert.equal(result.pd.od, "33.0");
  assert.equal(result.pd.os, "33.0");
  const near = applyCaptureRules(order({ pd: { od: 32, os: 32, nearOs: 60 } }));
  assert.deepEqual([near.pd.nearOd, near.pd.nearOs], ["30.0", "30.0"]);
});

test("monocular PDs and PDs of 42 or less are left alone", () => {
  const mono = applyCaptureRules(order({ pd: { od: 31, os: 33.5 } }));
  assert.deepEqual([mono.pd.od, mono.pd.os, mono.pd.binocular], ["31", "33.5", null]);
  const small = applyCaptureRules(order({ pd: { binocular: 42 } }));
  assert.equal(small.pd.binocular, "42");
  assert.equal(small.pd.od, null);
});

test("a binocular PD does not overwrite an eye PD that was given", () => {
  const both = applyCaptureRules(order({ pd: { binocular: 64, od: 31, os: 33 } }));
  assert.deepEqual([both.pd.binocular, both.pd.od, both.pd.os], ["64", "31", "33"]);
  const one = applyCaptureRules(order({ pd: { binocular: 64, od: 31 } }));
  assert.deepEqual([one.pd.od, one.pd.os], ["31", "32.0"]);
});

test("doubt about a binocular PD carries to the eyes it was split into", () => {
  const flags = { "pd.binocular": { reason: "Two different values were spoken", evidence: "PD 63 / PD 64" } };
  const result = applyCaptureRules(order({ pd: { binocular: 63 }, uncertainFields: ["pd.binocular"] }), flags);
  assert.deepEqual(result.uncertainFields.sort(), ["pd.od", "pd.os"]);
  assert.deepEqual(Object.keys(flags).sort(), ["pd.od", "pd.os"]);
});

test("HT is split like the word height, so a bare HT value is not left unassigned", () => {
  const pieces = RxVoice.splitTranscript("Right eye -2.00 sphere. Add 2.00, PD 32 HT 18");
  const measure = pieces.find((piece) => piece.key === "measure");
  assert.ok(measure && /HT 18/.test(measure.text));
  const keys = (text) => RxVoice.splitTranscript(text).map((piece) => piece.key);
  assert.deepEqual(keys("Right eye -2.00 sphere HT 18. Left eye -1.00 sphere HT 17"), keys("Right eye -2.00 sphere height 18. Left eye -1.00 sphere height 17"));
  assert.deepEqual(keys("Right eye HT 18 -2.00 sphere"), ["right"]);
});
