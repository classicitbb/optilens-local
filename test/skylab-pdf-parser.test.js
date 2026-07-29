const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSkyLabText, parseSkyLabRow } = require("../lib/operations/skylab-pdf-parser");

test("SkyLab parser extracts Rx rows and ignores explicit Stock rows", () => {
  const result = parseSkyLabText(`All Shipped Jobs\nCharges by Account and Job\nSkyLab Optical Laboratory\nOrder No ChargesRx No Entry Date Shipped DatePatientInvoice Inv Type\n650044 - CLASSIC VISIONS\n614007 $0.00614007 07/24/2026 07/24/20263600636 Stock\n610880 $98.97135695 07/24/2026 07/15/2026BRYAN, STACIA3597524 Rx\n`);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].supplierReference, "135695");
  assert.equal(result.items[0].invType, "RX");
  assert.equal(result.ignoredRows[0].rxNumber, "614007");
});

test("SkyLab row parser preserves the source row and reports malformed rows", () => {
  const row = parseSkyLabRow("610880 $98.97135695 07/24/2026 07/15/2026BRYAN, STACIA3597524 Rx");
  assert.equal(row.rxNumber, "135695");
  assert.equal(row.patient, "BRYAN, STACIA");
  assert.equal(row.invoiceNumber, "3597524");
  assert.equal(row.invType, "RX");
  assert.equal(parseSkyLabRow("610880 not-a-row"), null);
});

test("SkyLab row parser accepts pdf-parse tab-separated rows with timestamps", () => {
  const row = parseSkyLabRow("610880\t$98.97\t135695\t07/24/26 12:05 PM\t07/15/26 4:37 PM\tBRYAN, STACIA\t3597524\tRx");
  assert.equal(row.rxNumber, "135695");
  assert.equal(row.entryDate, "07/24/26");
  assert.equal(row.shippedDate, "07/15/26");
  assert.equal(row.patient, "BRYAN, STACIA");
  assert.equal(row.invoiceNumber, "3597524");
});
