const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const rx = require("../lib/rx-generator");
const { normaliseOrderSettings } = require("../lib/rx-order-settings");

const sourceLens = rx.getCatalog().find((item) => item.mfType === "Single Vision");
assert.ok(sourceLens, "A source-validated single-vision alias is required for RX tests.");

const basePayload = {
  batchSize: 1,
  instructions: "test only",
  customer: { custNum: "5000150", custSeqNum: "1", shipName: "Enhance Vision Optical" },
  patient: { mode: "fixed", name: "BROOKS, HAZEL" },
  prescription: { mode: "plano", pdOd: 33, pdOs: 33 },
  frame: { mode: "uncut" },
  lens: { mode: "fixed", alias: sourceLens.alias },
  coating: { mode: "none" }
};

test("catalogue aliases preserve source-derived material, style, and option codes", () => {
  const sample = sourceLens;
  assert.deepEqual(
    { material: sample.materialCode, style: sample.styleCode, option: sample.colorCode },
    { material: sample.alias.slice(0, 3), style: sample.alias.slice(3, 8), option: sample.alias.slice(8, 13) }
  );
});

test("lens constraints limit both fixed and random alias selection", () => {
  const visionRxLens = rx.getCatalog().find((item) => item.category && item.colorDescription);
  const nonVisionRxLens = rx.getCatalog().find((item) =>
    item.alias !== visionRxLens.alias
    && (item.category !== visionRxLens.category || item.colorDescription !== visionRxLens.colorDescription)
  );
  assert.ok(visionRxLens, "Expected a source-validated constrained lens.");
  assert.ok(nonVisionRxLens, "Expected a source-validated lens outside the selected constraints.");
  const constrained = {
    catalog: visionRxLens.category,
    option: visionRxLens.colorDescription
  };
  assert.doesNotThrow(() => rx.preview({ ...basePayload, lens: { mode: "fixed", alias: visionRxLens.alias, ...constrained } }));
  assert.throws(() => rx.preview({ ...basePayload, lens: { mode: "fixed", alias: nonVisionRxLens.alias, ...constrained } }), /does not match the current lens supplier/);
  assert.doesNotThrow(() => rx.preview({ ...basePayload, lens: { mode: "random", ...constrained } }));

  const supplierLens = rx.getCatalog().find((item) => item.suppliers?.length);
  if (supplierLens) {
    const supplier = supplierLens.suppliers[0];
    assert.doesNotThrow(() => rx.preview({ ...basePayload, lens: { mode: "fixed", alias: supplierLens.alias, supplier } }));
  } else {
    assert.equal(rx.getCatalog().some((item) => item.suppliers?.length), false);
  }
});

test("preview is non-writing and retains the required RX line ordering", () => {
  const sequenceFile = path.join(__dirname, "..", "data", "rx", "sequence.json");
  const before = fs.readFileSync(sequenceFile, "utf8");
  const preview = rx.preview(basePayload);
  const after = fs.readFileSync(sequenceFile, "utf8");
  assert.equal(after, before);
  assert.match(preview.filename, /^\d{8}_BROOKS_HAZEL\.rx$/);
  assert.match(preview.content, /start_order\r\nagent_name:LL/);
  assert.match(preview.content, new RegExp(`lens_od_material_code:${sourceLens.materialCode}\\r\\nlens_od_material_desc:${sourceLens.materialDescription}`));
  assert.match(preview.content, /lens_sv_mf:s/);
  assert.match(preview.content, /rx_od_sphere:\+0\.00[\s\S]*end_order\r\n$/);
});

test("unapproved aliases and misc SKUs outside the Coatings group cannot enter an RX file", () => {
  assert.throws(() => rx.preview({ ...basePayload, lens: { mode: "fixed", alias: "0010100100001" } }), /valid 13-digit lens alias/);
  assert.throws(() => rx.preview({ ...basePayload, coating: { mode: "fixed", sku: "MOMOTEM" } }), /valid coating/);
});

test("source-approved coatings are serialized as live MiscItems", () => {
  const coating = rx.getCoatings().find((item) => item.sku === "STANDARDAR") || rx.getCoatings()[0];
  assert.ok(coating, "Expected at least one live coating.");
  const preview = rx.preview({ ...basePayload, coating: { mode: "fixed", sku: coating.sku } });
  assert.ok(preview.content.includes(`sku:${coating.sku}\r\nitem_source:MISC\r\nitem_description:${coating.description}`));
  assert.equal(preview.summary.coating, coating.description);
});

test("edged jobs use the source-approved EDGE TO FIT misc item", () => {
  const preview = rx.preview({ ...basePayload, frame: { mode: "edged" } });
  assert.match(preview.content, /sku:EDGE2FIT\r\nitem_source:MISC\r\nitem_description:EDGE TO FIT/);
});

test("unsafe output extensions are rejected before a file can be staged", () => {
  assert.throws(() => rx.preview({ ...basePayload, extension: "../unsafe" }), /Output extension/);
});

test("batch downloads use a valid ZIP envelope without an extra dependency", () => {
  const file = { filename: "example.rx", content: "start_order\r\nend_order\r\n" };
  const archive = rx.zip([file]);
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
});

test("saved order settings retain only validated order defaults", () => {
  const settings = normaliseOrderSettings({ batchSize: 10, randomSeed: "repeatable", instructions: "test only", custNum: "5000162", custSeqNum: "1", shipName: "Retail", labNum: "1177", remoteOperator: "1177-002", extension: ".RX" });
  assert.equal(settings.extension, ".rx");
  assert.equal(settings.batchSize, 10);
  assert.throws(() => normaliseOrderSettings({ ...settings, batchSize: 501 }), /Number of orders/);
  assert.throws(() => normaliseOrderSettings({ ...settings, extension: "rx" }), /Output extension/);
});
