const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const { commercialInvoiceHsCode, isEdgedCommercialInvoiceOrder } = require("../lib/beswift-co");

test("commercial invoice keeps the requested operational defaults and source fallbacks", () => {
  const source = read("lib/beswift-co.js");
  assert.match(source, /s\.Reference AS ShipmentReference/);
  assert.match(source, /o\.BillToReference/);
  assert.match(source, /freightCost: 62/);
  assert.match(source, /customerOrderNoDefault = contactName/);
  assert.match(source, /declarationOverride = text\(headerOverrides\.declaration\) \|\| declarationDefault/);
});

test("commercial invoice uses one editable gross-weight control and consolidates stock orders", () => {
  const markup = read("public/delivery-export.html");
  const client = read("public/delivery-export.js");
  const source = read("lib/beswift-co.js");
  assert.match(markup, /id="coGrossWeight"/);
  assert.match(markup, /id="coGrossWeightUnit"/);
  assert.doesNotMatch(markup, /id="coActualGrossKg"/);
  assert.match(client, /actualGrossKg: readGrossWeightKg\(\)/);
  assert.match(source, /A stock\/fulfillment order is one commercial-invoice commodity/);
  assert.match(source, /hsCodes: new Set/);
  assert.match(client, /coAutoPreparedSessionIds/);
});

test("edged invoice work is classified as finished spectacles", () => {
  const source = read("lib/beswift-co.js");
  const lens = { category: "lens", name: "1.67 SV Clear" };
  const defaults = { hsCode: "90015000" };
  const catalog = { hsCode: "90015000" };

  assert.match(source, /ISNULL\(prl\.IsEdged, 0\) AS IsPriceListEdged/);
  assert.equal(isEdgedCommercialInvoiceOrder([{ IsPriceListEdged: true }]), true);
  assert.equal(isEdgedCommercialInvoiceOrder([{ SKU: "EDGINVTRIG", Description: "Processes - Edged Invoice Trigger" }]), true);
  assert.equal(isEdgedCommercialInvoiceOrder([{ SKU: "", Description: "Left: AR coating" }]), false);
  assert.equal(commercialInvoiceHsCode({ ...lens, edged: true }, catalog, defaults), "90049000");
  assert.equal(commercialInvoiceHsCode({ ...lens, edged: false }, catalog, defaults), "90015000");
});
