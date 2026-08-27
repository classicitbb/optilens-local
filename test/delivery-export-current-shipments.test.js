const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("current shipment list uses the synced Innovations item count to suppress only empty source shipments", () => {
  const source = read("lib/delivery.js");
  assert.match(source, /WHERE \([\s\S]*app_status = N'closed'[\s\S]*source_system <> N'mssql-innovations'[\s\S]*OR ISNULL\(source_item_count, 0\) > 0/);
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
