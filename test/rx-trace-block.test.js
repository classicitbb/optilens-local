const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { renderTraceBlock } = require("../lib/rx-generator");

// Regression check: renderTraceBlock() must reproduce the shape of a real
// LabLink trace_start/trace_end block (see docs/rx-format-field-map.md for
// why HBOX/VBOX/.ED come from the outline's own native box, not whatever
// A/B the order header carries).
const SAMPLE_PATH = path.join(__dirname, "..", "templates", "rx-samples", "sample-progressive-enclosed-traced.rx");
const SAMPLE = fs.readFileSync(SAMPLE_PATH, "utf8");

function extractTraceBlock(text) {
  const match = text.match(/trace_start\r?\n([\s\S]*?)trace_end/);
  if (!match) throw new Error("Fixture has no trace_start/trace_end block.");
  return match[1];
}

function extractRadiiMm(traceBody) {
  const values = [];
  for (const line of traceBody.split(/\r?\n/)) {
    if (line.startsWith("R=")) {
      for (const v of line.slice(2).split(";")) values.push(parseInt(v, 10) / 100);
    }
  }
  return values;
}

function headerField(traceBody, key) {
  const line = traceBody.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  if (!line) return null;
  return line.slice(key.length + 1).split(";").map((v) => parseFloat(v.trim()));
}

const realTraceBody = extractTraceBlock(SAMPLE);
const realRadiiMm = extractRadiiMm(realTraceBody);

// Reconstruct the "shape" payload rx-order-engine.js would have sent for
// this exact real order: a right-eye-only trace (mirrored second eye, as
// evidenced by the real file omitting a second TRCFMT block), native box
// pulled straight from the file's own HBOX/VBOX/DBL/.ED.
const fixtureShape = {
  job: "0021",
  mirroredFrom: "right",
  nativeBox: { a: headerField(realTraceBody, "HBOX")[0], b: headerField(realTraceBody, "VBOX")[0], dbl: headerField(realTraceBody, "DBL")[0], ed: headerField(realTraceBody, ".ED")[0] },
  computed: { ed: headerField(realTraceBody, ".ED")[0], edAxis: headerField(realTraceBody, ".AX")[0], circ: headerField(realTraceBody, "CIRC")[0] },
  radii: { R: realRadiiMm, L: [] },
};

test("renderTraceBlock reproduces the real sample's R= radii exactly (hundredths of mm)", () => {
  const rendered = renderTraceBlock(fixtureShape);
  const renderedRadii = extractRadiiMm(rendered.replace(/\r\n/g, "\n"));
  assert.deepEqual(renderedRadii, realRadiiMm, "radii round-trip must be lossless to the hundredth of a mm");
});

test("renderTraceBlock's header fields are numerically equivalent to the real sample", () => {
  const rendered = renderTraceBlock(fixtureShape).replace(/\r\n/g, "\n");
  assert.deepEqual(headerField(rendered, "HBOX"), headerField(realTraceBody, "HBOX"));
  assert.deepEqual(headerField(rendered, "VBOX"), headerField(realTraceBody, "VBOX"));
  assert.deepEqual(headerField(rendered, ".ED"), headerField(realTraceBody, ".ED"));
  assert.deepEqual(headerField(rendered, "CIRC"), headerField(realTraceBody, "CIRC"));
  assert.deepEqual(headerField(rendered, ".AX"), headerField(realTraceBody, ".AX"));
  assert.equal(headerField(rendered, "DBL")[0], headerField(realTraceBody, "DBL")[0]);
});

test("renderTraceBlock omits the second TRCFMT block when the eye was mirrored, matching the real sample", () => {
  const rendered = renderTraceBlock(fixtureShape);
  const trcfmtCount = (rendered.match(/TRCFMT=/g) || []).length;
  const realTrcfmtCount = (realTraceBody.match(/TRCFMT=/g) || []).length;
  assert.equal(trcfmtCount, realTrcfmtCount, "mirrored real sample sends exactly one TRCFMT block");
  assert.equal(trcfmtCount, 1);
});

test("renderTraceBlock returns '' (no trace) when radii are absent", () => {
  assert.equal(renderTraceBlock(null), "");
  assert.equal(renderTraceBlock({ radii: { R: [] } }), "");
  assert.equal(renderTraceBlock({}), "");
});

test("renderTraceBlock sends both TRCFMT blocks for a genuinely distinct second eye", () => {
  const shape = {
    job: "test",
    mirroredFrom: null,
    nativeBox: { a: 52, b: 40, dbl: 18, ed: 60 },
    computed: { ed: 60, edAxis: 30, circ: 150 },
    radii: { R: [25, 26, 27], L: [28, 29, 30] },
  };
  const rendered = renderTraceBlock(shape);
  assert.equal((rendered.match(/TRCFMT=/g) || []).length, 2);
  assert.match(rendered, /TRCFMT=1;3;E;R;F/);
  assert.match(rendered, /TRCFMT=1;3;E;L;F/);
});
