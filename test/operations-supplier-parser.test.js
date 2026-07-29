const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const { idempotencyKey, sha256, validateFixture } = require("../lib/operations/service");
const { parseCsv, parseXlsx } = require("../lib/operations/supplier-parser");

test("supplier CSV parser locates headers, preserves source values, and warns on unknown status", () => {
  const result = parseCsv("Report date,2026-07-25\n\nOrder Code,Status\n00114,Received at lab\n00114,Received at lab\nABC-7,Vendor wording\n");
  assert.equal(result.headerRow, 3);
  assert.deepEqual(result.items.map((item) => item.supplierReference), ["00114", "ABC-7"]);
  assert.equal(result.items[0].originalSupplierReference, "00114");
  assert.equal(result.items[0].normalizedStatus, "RECEIVED_AT_LAB");
  assert.equal(result.items[1].warning, "Unknown Supplier Status");
  assert.equal(result.warnings.some((warning) => warning.code === "DUPLICATE_REFERENCE"), true);
});

test("supplier XLSX parser searches visible worksheets and preserves integer references", async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Cover").addRow(["title only"]);
  const sheet = workbook.addWorksheet("WIP");
  sheet.addRow(["Supplier WIP Report"]);
  sheet.addRow(["Order Code", "Status"]);
  sheet.addRow([1141, "In Manufacturing"]);
  sheet.addRow(["0007", "Manufacturing complet"]);
  const buffer = await workbook.xlsx.writeBuffer();
  const result = await parseXlsx(buffer, "changed-name.xlsx");
  assert.equal(result.worksheet, "WIP");
  assert.deepEqual(result.items.map((item) => item.supplierReference), ["1141", "0007"]);
  assert.equal(result.items[1].supplierStatus, "Manufacturing complet");
});

test("fixture validation and idempotency keys are deterministic", () => {
  const buffer = Buffer.from("ORDER CODE,STATUS\nA,Dispatched\n");
  validateFixture(buffer, "supplier.csv");
  assert.equal(sha256(buffer), sha256(Buffer.from(buffer)));
  assert.equal(idempotencyKey(["supplier-status-file", sha256(buffer)]), idempotencyKey(["supplier-status-file", sha256(buffer)]));
  assert.throws(() => validateFixture(Buffer.alloc(0), "supplier.csv"), /empty/);
  assert.throws(() => validateFixture(buffer, "supplier.exe"), /Only sanitized/);
});
