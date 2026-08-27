const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("delivery checklist eligibility and packing slip access use shipment classification", () => {
  const client = read("public/delivery-export.js");
  assert.match(client, /function updateDeliveryChecklistAvailability/);
  assert.match(client, /Delivery checklist is not used for local shipments/);
  assert.match(client, /#packingSlipBtn/);
  assert.match(read("public/delivery-export.html"), /id="packingSlipBtn"/);
});

test("shared document preview supports sanitized save and browser print fallback", () => {
  const preview = read("public/document-preview.js");
  assert.match(preview, /function sanitizeFilename/);
  assert.match(preview, /frame\.contentWindow\?\.print\(\)/);
  assert.match(preview, /Opens your browser print dialog/);
  assert.match(read("public/delivery-export.html"), /document-preview\.js/);
});

test("packing slip maps shipment data and stock-only shipments to one attached-documents row", () => {
  const client = read("public/delivery-export.js");
  assert.match(client, /function renderPackingSlipHtml/);
  for (const label of ["Packing List", "Invoice #", "Received By", "Signature", "Dispatcher", "Thank you for choosing Classic Visions"]) assert.match(client, new RegExp(label));
  assert.match(client, /STOCK ORDER - SEE ATTACHED DOCUMENTS\./);
});

test("commercial invoice uses the shared preview, branded filename, and whole-stock replacement", () => {
  const client = read("public/delivery-export.js");
  const server = read("server.js");
  assert.match(client, /Classic Commercial Invoice -/);
  assert.match(client, /OptiLensDocumentPreview\?\.open/);
  assert.match(read("public/delivery-export.html"), /id="saveCoDraftBottomBtn"/);
  assert.match(client, /preview\.stockOrderOnly/);
  assert.match(server, /preview\.stockOrderOnly/);
});
