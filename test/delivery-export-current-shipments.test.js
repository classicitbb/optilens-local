const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("current shipment list suppresses empty Innovations mirror sessions without deleting history", () => {
  const source = read("lib/delivery.js");
  assert.match(source, /WHERE app_status = N'closed'[\s\S]*source_system <> N'mssql-innovations'[\s\S]*OR item_count > 0/);
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
