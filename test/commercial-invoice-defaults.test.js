const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const {
  applyCommercialInvoiceLineOverride,
  buildAutomationJobPayload,
  commercialInvoiceHsCode,
  isEdgedCommercialInvoiceOrder
} = require("../lib/beswift-co");

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

test("commercial invoice amount is calculated and edging wins over a stale HS override", () => {
  const edged = applyCommercialInvoiceLineOverride({
    category: "lens",
    edged: true,
    commercialDescription: "Progressive lens",
    hsCode: "90015000",
    countryOfOrigin: "Barbados",
    unitPrice: 50,
    quantity: 2,
    amount: 100
  }, {
    specificationText: "Progressive lens + edging",
    hsCodeText: "90015000",
    unitPriceText: "61.25",
    quantityText: "3",
    amountText: "9999"
  });

  assert.equal(edged.commercialDescription, "Progressive lens + edging");
  assert.equal(edged.hsCode, "90049000");
  assert.equal(edged.unitCost, 61.25);
  assert.equal(edged.amount, 183.75);
  assert.equal(edged.value, 183.75);

  const uncut = applyCommercialInvoiceLineOverride({
    category: "lens",
    edged: false,
    hsCode: "90015000",
    unitPrice: 10,
    quantity: 1,
    amount: 10
  }, { hsCodeText: "90014000", unitPriceText: "12", quantityText: "2" });
  assert.equal(uncut.hsCode, "90014000");
  assert.equal(uncut.amount, 24);
});

test("saved certificate items are the data queued to the extension", () => {
  const source = read("lib/beswift-co.js");
  const snapshot = buildAutomationJobPayload({
    coApplicationId: "co-1",
    shipmentSessionId: "shipment-1",
    portalEnvironment: "production"
  }, {
    items: [{ certificateEligible: true, commercialDescription: "Edited lens", unitCost: 61.25, value: 183.75 }]
  }, []);

  assert.equal(snapshot.payload.items[0].commercialDescription, "Edited lens");
  assert.equal(snapshot.payload.items[0].unitCost, 61.25);
  assert.match(source, /const rebuilt = await rebuildEditableDraft\(application\)/);
  assert.match(source, /const \{ editable, warnings \} = await rebuildEditableDraft\(current, draftInput\)/);
});

test("delivery export shows calculated amounts and ordered workflow actions", () => {
  const markup = read("public/delivery-export.html");
  const client = read("public/delivery-export.js");
  const components = read("public/styles/components.css");
  const system = read("public/styles/system.css");

  assert.match(markup, /1 - Prepare Draft[\s\S]*2 - Save Draft[\s\S]*Print \/ PDF[\s\S]*3 - Queue Fill Job/);
  assert.match(client, /aria-label="Amount \(calculated\)" readonly tabindex="-1"/);
  assert.match(client, /item\.edged \? " readonly tabindex/);
  assert.match(components, /\.co-job-row \{[\s\S]*border-bottom: 1px solid var\(--line\);[\s\S]*border-radius: 0;/);
  assert.match(system, /workflow-tabs button:not\(\.workflow-tab-refresh\):not\(\.workflow-tab-settings\)/);
});
