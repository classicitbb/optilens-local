const sql = require("mssql");
const { getSourcePool } = require("../db");

const MATCH_FIELDS = Object.freeze({
  customer_order_reference: "CAST(o.CustomerOrdReference AS nvarchar(120))",
  customer_tray_id: "CAST(o.CustomerTrayID AS nvarchar(120))",
  order_id: "CONVERT(nvarchar(120), o.OrderID)"
});

function normalizeReference(value) { return String(value ?? "").trim(); }

function classifyMatches(references, rows) {
  const byReference = new Map();
  for (const row of rows) {
    const key = normalizeReference(row.supplier_reference);
    const values = byReference.get(key) || [];
    values.push(row);
    byReference.set(key, values);
  }
  return references.map((rawReference) => {
    const supplierReference = normalizeReference(rawReference);
    const candidates = byReference.get(supplierReference) || [];
    const active = candidates.filter((candidate) => candidate.is_active);
    if (!candidates.length) return { supplierReference, matchResult: "Not Found", matches: [] };
    if (!active.length) return { supplierReference, matchResult: "Inactive Order", matches: candidates };
    if (active.length > 1) return { supplierReference, matchResult: "Duplicate Active Match", matches: active };
    return { supplierReference, matchResult: "Matched", matches: active };
  });
}

function buildBatchMatchQuery(references, matchingField) {
  const expression = MATCH_FIELDS[matchingField];
  if (!expression) throw new Error(`Unsupported supplier matching field: ${matchingField}`);
  const placeholders = references.map((_, index) => `@reference_${index}`).join(", ");
  return `
    SELECT
      ${expression} AS supplier_reference,
      o.OrderID AS internal_order_id,
      CAST(o.CustomerTrayID AS nvarchar(120)) AS tray_number,
      CAST(o.CustomerOrdReference AS nvarchar(120)) AS order_reference,
      o.CurrentStatusID AS current_status_id,
      si.StatusItemName AS current_status_description,
      o.PatientID AS patient,
      o.CustomerAccount AS customer_account,
      o.ReceivedTime AS order_date,
      CAST(CASE WHEN g.Active = 1 AND o.JobID IS NOT NULL AND o.JobID <> N'' AND o.OrderType IN (1, 3) THEN 1 ELSE 0 END AS bit) AS is_active
    FROM dbo.Orders o
    LEFT JOIN dbo.GenStatus g ON g.GenStatus = o.GenStatus
    LEFT JOIN dbo.StatusItems si ON si.StatusItemID = o.CurrentStatusID
    WHERE ${expression} IN (${placeholders});
  `;
}

async function matchSupplierReferences(references, { matchingField = "customer_order_reference" } = {}) {
  const normalized = [...new Set((references || []).map(normalizeReference).filter(Boolean))];
  if (!normalized.length) return [];
  if (normalized.length > 500) throw new Error("Supplier batch cannot contain more than 500 references.");
  const pool = await getSourcePool();
  const request = pool.request();
  normalized.forEach((reference, index) => request.input(`reference_${index}`, sql.NVarChar(120), reference));
  const result = await request.query(buildBatchMatchQuery(normalized, matchingField));
  return classifyMatches(normalized, result.recordset);
}

module.exports = { MATCH_FIELDS, buildBatchMatchQuery, classifyMatches, matchSupplierReferences, normalizeReference };
