const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const rx = require("../lib/rx-generator");

const basePayload = {
  batchSize: 1,
  instructions: "test only",
  customer: { custNum: "5000150", custSeqNum: "1", shipName: "Enhance Vision Optical" },
  patient: { mode: "fixed", name: "BROOKS, HAZEL" },
  prescription: { mode: "plano", pdOd: 33, pdOs: 33 },
  frame: { mode: "uncut" },
  lens: { mode: "fixed", alias: "0010100100001" },
  coating: { mode: "fixed", sku: "STANDARDAR" }
};

test("catalogue aliases preserve the approved material, style, and option row", () => {
  const sample = rx.getCatalog().find((item) => item.alias === "0070126700116");
  assert.deepEqual(
    { material: sample.materialCode, style: sample.styleCode, option: sample.colorCode },
    { material: "007", style: "01267", option: "00116" }
  );
});

test("preview is non-writing and retains the required RX line ordering", () => {
  const sequenceFile = path.join(__dirname, "..", "data", "rx", "sequence.json");
  const before = fs.readFileSync(sequenceFile, "utf8");
  const preview = rx.preview(basePayload);
  const after = fs.readFileSync(sequenceFile, "utf8");
  assert.equal(after, before);
  assert.match(preview.filename, /^\d{8}_BROOKS_HAZEL\.rx$/);
  assert.match(preview.content, /start_order\r\nagent_name:LL/);
  assert.match(preview.content, /lens_od_material_code:001\r\nlens_od_material_desc:1\.50 Index/);
  assert.match(preview.content, /item_start\r\nsku:STANDARDAR[\s\S]*item_end\r\nlens_sv_mf:s/);
  assert.match(preview.content, /rx_od_sphere:\+0\.00[\s\S]*end_order\r\n$/);
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
