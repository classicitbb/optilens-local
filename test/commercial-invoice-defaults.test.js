const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("commercial invoice keeps the requested operational defaults and source fallbacks", () => {
  const source = read("lib/beswift-co.js");
  assert.match(source, /s\.Reference AS ShipmentReference/);
  assert.match(source, /o\.BillToReference/);
  assert.match(source, /freightCost: 62/);
  assert.match(source, /customerOrderNoDefault = contactName/);
  assert.match(source, /declarationOverride = text\(headerOverrides\.declaration\) \|\| declarationDefault/);
});

test("commercial invoice uses one editable gross-weight control and labels stock orders", () => {
  const markup = read("public/delivery-export.html");
  const client = read("public/delivery-export.js");
  const source = read("lib/beswift-co.js");
  assert.match(markup, /id="coGrossWeight"/);
  assert.match(markup, /id="coGrossWeightUnit"/);
  assert.doesNotMatch(markup, /id="coActualGrossKg"/);
  assert.match(client, /actualGrossKg: readGrossWeightKg\(\)/);
  assert.match(source, /Stock order - \$\{commercialDescription\}/);
  assert.match(client, /coAutoPreparedSessionIds/);
});
