const test = require("node:test");
const assert = require("node:assert/strict");
const { buildBatchMatchQuery, classifyMatches } = require("../lib/operations/matching");

test("batch matcher classifies missing, inactive, matched, and duplicate active references", () => {
  const result = classifyMatches(["A", "B", "C", "D"], [
    { supplier_reference: "A", internal_order_id: 1, is_active: true },
    { supplier_reference: "B", internal_order_id: 2, is_active: false },
    { supplier_reference: "C", internal_order_id: 3, is_active: true },
    { supplier_reference: "C", internal_order_id: 4, is_active: true }
  ]);
  assert.deepEqual(result.map((item) => item.matchResult), ["Matched", "Inactive Order", "Duplicate Active Match", "Not Found"]);
});

test("batch matcher query is parameterized and uses the configured reference field", () => {
  const query = buildBatchMatchQuery(["001", "002"], "customer_order_reference");
  assert.match(query, /CustomerOrdReference/);
  assert.match(query, /@reference_0/);
  assert.match(query, /@reference_1/);
  assert.doesNotMatch(query, /001|002/);
  assert.throws(() => buildBatchMatchQuery(["001"], "unknown"), /Unsupported supplier matching field/);
});

test("batch matcher supports TOG JobID references", () => {
  const query = buildBatchMatchQuery(["836"], "job_id");
  assert.match(query, /o\.JobID/);
  assert.match(query, /@reference_0/);
});

test("batch matcher supports SkyLab OrderID references", () => {
  const query = buildBatchMatchQuery(["836"], "order_id");
  assert.match(query, /o\.OrderID/);
  assert.match(query, /CONVERT\(nvarchar\(120\), o\.OrderID\)/);
  assert.match(query, /@reference_0/);
});

test("batch matcher returns order context for the reconciliation table", () => {
  const query = buildBatchMatchQuery(["836"], "order_id");
  assert.match(query, /o\.PatientID AS patient_id/);
  assert.match(query, /o\.CustomerID AS customer_id/);
  assert.match(query, /c\.CustomerName AS customer_name/);
  assert.match(query, /LEFT JOIN dbo\.Customers c ON c\.CustomerID = o\.CustomerID/);
  assert.match(query, /o\.CustomerAccount AS customer_account/);
  assert.match(query, /COALESCE\(o\.CustomerTime, o\.ReceivedTime\) AS received_at/);
});
