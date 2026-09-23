const assert = require("node:assert/strict");
const test = require("node:test");

const { formatField, num, toMinusCylinder, validateOrder } = require("../public/rx-capture-validation");

function order(overrides = {}) {
  return {
    patient: { name: "HUNTE, RUSSELL" },
    prescription: {
      od: { sphere: "-2.50", cylinder: "-1.00", axis: 90, add: null, prism: null, base: null },
      os: { sphere: "-2.25", cylinder: "-0.75", axis: 85, add: null, prism: null, base: null },
      ...overrides.prescription
    },
    pd: { od: 32, os: 32, ...overrides.pd },
    frame: { status: "TO_BE_TRACED", ...overrides.frame },
    lensRequest: { ...overrides.lensRequest }
  };
}

const paths = (items) => items.map((item) => item.path);

test("accepts an ordinary complete prescription", () => {
  const { errors, warnings } = validateOrder(order());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("parses plano wording and rejects text in numeric fields", () => {
  assert.equal(num("PL"), 0);
  assert.equal(num("-2,25"), -2.25);
  assert.equal(num("−1.50"), -1.5);
  assert.equal(num(""), null);
  assert.ok(Number.isNaN(num("abc")));
  const { errors } = validateOrder(order({ prescription: { od: { sphere: "abc" }, os: {} } }));
  assert.ok(paths(errors).includes("prescription.od.sphere"));
});

test("enforces producible sphere, cylinder and quarter-dioptre steps", () => {
  const { errors } = validateOrder(order({
    prescription: { od: { sphere: "-21.00", cylinder: "-9.00", axis: 10 }, os: { sphere: "+18.50", cylinder: "-1.10", axis: 10 } }
  }));
  assert.deepEqual(paths(errors).sort(), [
    "prescription.od.cylinder", "prescription.od.sphere", "prescription.os.cylinder", "prescription.os.sphere"
  ]);
  const step = validateOrder(order({ prescription: { od: { sphere: "-2.30", cylinder: null, axis: null }, os: { sphere: "-1.00" } } }));
  assert.ok(step.errors.some((item) => /0\.25 steps/.test(item.message)));
});

test("flags plus cylinder and offers the minus-cylinder transposition", () => {
  const eye = { sphere: "-3.00", cylinder: "+1.50", axis: 30 };
  assert.deepEqual(toMinusCylinder(eye), { sphere: "-1.50", cylinder: "-1.50", axis: 120 });
  assert.deepEqual(toMinusCylinder({ ...eye, axis: 120 }).axis, 30);
  const { errors, warnings } = validateOrder(order({ prescription: { od: eye, os: { sphere: "-2.25" } } }));
  assert.deepEqual(errors, []);
  const warning = warnings.find((item) => item.path === "prescription.od.cylinder");
  assert.equal(warning.fix.type, "minus-cylinder");
  assert.equal(warning.fix.values.cylinder, "-1.50");
});

test("checks axis range and its relationship to cylinder", () => {
  assert.ok(validateOrder(order({ prescription: { od: { sphere: "-1.00", cylinder: "-1.00", axis: 181 }, os: {} } }))
    .errors.some((item) => item.path === "prescription.od.axis"));
  const missing = validateOrder(order({ prescription: { od: { sphere: "-1.00", cylinder: "-1.00", axis: null }, os: {} } }));
  assert.deepEqual(missing.errors, []);
  assert.ok(paths(missing.warnings).includes("prescription.od.axis"));
  const orphan = validateOrder(order({ prescription: { od: { sphere: "-1.00", cylinder: null, axis: 45 }, os: {} } }));
  assert.ok(paths(orphan.warnings).includes("prescription.od.axis"));
});

test("validates ADD range and its fit with the chosen lens type", () => {
  assert.ok(validateOrder(order({ prescription: { od: { sphere: "-1.00", add: "+4.50" }, os: {} } })).errors.some((item) => item.path === "prescription.od.add"));
  assert.ok(validateOrder(order({ prescription: { od: { sphere: "-1.00", add: "-1.00" }, os: {} } })).errors.some((item) => item.path === "prescription.od.add"));
  const single = validateOrder(order({ prescription: { od: { sphere: "-1.00", add: "+2.00" }, os: {} }, lensRequest: { lensType: "Single Vision" } }));
  assert.ok(paths(single.warnings).includes("prescription.od.add"));
  const progressive = validateOrder(order({ lensRequest: { lensType: "Progressive" } }));
  assert.ok(paths(progressive.warnings).includes("prescription.od.add"));
  assert.ok(paths(progressive.warnings).includes("frame.segHeightOd"));
});

test("requires a base direction with prism", () => {
  const { errors, warnings } = validateOrder(order({ prescription: { od: { sphere: "-1.00", prism: "2.00", base: null }, os: { sphere: "-1.00", prism: "1.00", base: "BX" } } }));
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((item) => item.path === "prescription.od.base" && /base direction/.test(item.message)));
  assert.ok(warnings.some((item) => item.path === "prescription.os.base" && /not recognised/.test(item.message)));
  assert.ok(validateOrder(order({ prescription: { od: { sphere: "-1.00", prism: "-1" }, os: {} } })).errors.some((item) => item.path === "prescription.od.prism"));
});

test("checks monocular, binocular and near PD", () => {
  const wide = validateOrder(order({ pd: { od: 63, os: 32 } }));
  assert.ok(wide.errors.some((item) => item.path === "pd.od" && /binocular/.test(item.message)));
  assert.ok(validateOrder(order({ pd: { binocular: 90 } })).errors.some((item) => item.path === "pd.binocular"));
  assert.ok(validateOrder(order({ pd: { nearOd: 33 } })).errors.some((item) => item.path === "pd.nearOd"));
  assert.ok(validateOrder(order({ pd: { binocular: 64, od: 30, os: 30 } })).warnings.some((item) => item.path === "pd.binocular"));
});

test("holds progressives to a 14 mm fitting height", () => {
  const draft = order({ frame: { segHeightOd: "13.0", segHeightOs: "40" }, lensRequest: { lensType: "Progressive" } });
  const { errors } = validateOrder(draft);
  assert.deepEqual(paths(errors).sort(), ["frame.segHeightOd", "frame.segHeightOs"]);
  assert.deepEqual(validateOrder(order({ frame: { segHeightOd: "13.0" }, lensRequest: { lensType: "Single Vision" } })).errors, []);
});

test("applies the frame measurement limits used by the website", () => {
  const { errors } = validateOrder(order({ frame: { a: 80, b: 40, dbl: 18, ed: 85 } }));
  assert.deepEqual(paths(errors), ["frame.a"]);
  const small = validateOrder(order({ frame: { a: 52, b: 40, dbl: 18, ed: 50 } }));
  assert.deepEqual(paths(small.errors), ["frame.ed"]);
  assert.ok(validateOrder(order({ frame: { a: 0 } })).errors.some((item) => item.path === "frame.a"));
  const measured = validateOrder(order({ frame: { status: "MEASURED", a: 52 } }));
  assert.ok(measured.warnings.some((item) => item.path === "frame.b"));
});

test("warns when the frame needs a blank larger than 80 mm", () => {
  const { errors, warnings } = validateOrder(order({ pd: { od: 25, os: 25 }, frame: { a: 60, b: 50, dbl: 30, ed: 66 } }));
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((item) => /blank/.test(item.message)));
});

test("warns about opposing signs and mismatched lens wording", () => {
  const signs = validateOrder(order({ prescription: { od: { sphere: "+1.00" }, os: { sphere: "-1.00" } } }));
  assert.ok(signs.warnings.some((item) => /opposing signs/.test(item.message)));
  const mismatch = validateOrder(order({ lensRequest: { lensType: "Progressive", design: "Single Vision" } }));
  assert.ok(mismatch.warnings.some((item) => item.path === "lensRequest.lensType"));
});

test("formats fields without altering typed values", () => {
  assert.equal(formatField("prescription.od.sphere", "-2.5"), "-2.50");
  assert.equal(formatField("prescription.od.sphere", "1"), "+1.00");
  assert.equal(formatField("prescription.od.sphere", "-2.255"), "-2.255");
  assert.equal(formatField("prescription.od.add", "2"), "+2.00");
  assert.equal(formatField("prescription.od.prism", "1.5"), "1.50");
  assert.equal(formatField("prescription.od.base", "bi"), "BI");
  assert.equal(formatField("pd.od", "32"), "32.0");
  assert.equal(formatField("pd.od", "31.25"), "31.25");
  assert.equal(formatField("frame.a", "52"), "52.0");
  assert.equal(formatField("patient.name", "abc"), "abc");
});
