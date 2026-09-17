const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("current shipment list contains only synced Innovations shipments and suppresses empty source headers", () => {
  const source = read("lib/delivery.js");
  assert.match(source, /WHERE source_system = N'mssql-innovations'/);
  assert.match(source, /app_status = N'closed'[\s\S]*OR ISNULL\(source_item_count, 0\) > 0/);
  assert.match(source, /CASE[\s\S]*source_system = N'mssql-innovations'[\s\S]*source_item_count[\s\S]*AS item_count/);
  assert.match(source, /source_synced_at >= @sourceSyncStartedAt/);
});

test("shipment refresh limits mirrored rows to the source records synchronized by that refresh", () => {
  const source = read("server.js");
  assert.match(source, /const sourceSyncStartedAt = new Date\(Date\.now\(\) - 2000\);/);
  assert.match(source, /sourceSyncStartedAt: syncCompleted \? sourceSyncStartedAt : null/);
});

test("universal shipment search covers source shipment, customer, invoice, Rx and patient fields", () => {
  const source = read("lib/source-innovations.js");
  assert.match(source, /async function searchCurrentShipmentIds/);
  for (const field of ["s.ShipmentID", "c.AccountNumber", "c.CustomerName", "i.InvoiceID", "sj.RxNumber", "o.PatientID"]) {
    assert.match(source, new RegExp(field.replaceAll(".", "\\.")));
  }
});

test("shipment prep uses one universal current-search control rather than manual date and shipment filters", () => {
  const markup = read("public/delivery-export.html");
  assert.match(markup, /id="shipmentSearchInput"/);
  assert.doesNotMatch(markup, /id="shipmentIdInput"/);
  assert.doesNotMatch(markup, /id="fromDateInput"/);
  assert.doesNotMatch(markup, /id="toDateInput"/);
});

test("commercial invoice is dated by shipment closure, not the grouped invoice dates", () => {
  const source = read("lib/beswift-co.js");
  assert.match(source, /function shipmentClosedDate\(header, session\)[\s\S]*?header\?\.ShippedTime[\s\S]*?session\?\.closed_at/);
  assert.equal((source.match(/invoiceDate: shipmentClosedDate\(h, session\)/g) || []).length, 3);
  assert.doesNotMatch(source, /invoiceDates/);
});

test("unclassified item warnings open Item defaults at the flagged item", () => {
  const client = read("public/delivery-export.js");
  assert.match(client, /class="co-warning-link" data-classify-item=/);
  assert.match(client, /openDeliverySettings\("itemDefaults"\)/);
  assert.match(client, /data-setting-field="hsCode"\]'\)\?\.focus/);
  assert.match(client, /for \(const name of moduleState\.unclassifiedItems/);
});

test("shipment prep keeps dense square tables keyboard operable", () => {
  const markup = read("public/delivery-export.html");
  const client = read("public/delivery-export.js");
  const styles = read("public/styles/components.css");

  assert.match(markup, /class="shipment-search-label">Find a current shipment/);
  assert.match(markup, /<th scope="col">Order ID<\/th>/);
  assert.match(client, /<button type="button" class="shipment-list-row/);
  assert.doesNotMatch(client, /<article class="shipment-list-row/);
  assert.match(client, /\.focus\(\{ preventScroll: true \}\)/);
  assert.match(styles, /\.delivery-export-page \.shipment-prep-toolbar[\s\S]*?padding: 4px 8px;/);
  assert.match(styles, /\.shipment-search-field input[\s\S]*?border-radius: 0;/);
  assert.match(styles, /\.shipment-list-row:focus-visible/);
  assert.match(styles, /\.delivery-export-page \.shipment-detail-panel \.table-wrap[\s\S]*?border-radius: 0;/);
});
