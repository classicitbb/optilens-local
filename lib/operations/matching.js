const sql = require("mssql");
const { getSourcePool } = require("../db");
const { connectZen, isAvailable: isZenAvailable } = require("../zen-source");

const MATCH_FIELDS = Object.freeze({
  customer_order_reference: "CAST(o.CustomerOrdReference AS nvarchar(120))",
  customer_tray_id: "CAST(o.CustomerTrayID AS nvarchar(120))",
  job_id: "CAST(o.JobID AS nvarchar(120))",
  order_id: "CONVERT(nvarchar(120), o.OrderID)"
});

const ZEN_MATCH_FIELDS = Object.freeze({
  customer_order_reference: "o.CustomerOrdReference",
  customer_tray_id: "o.CustomerTrayID",
  job_id: "o.JobID",
  order_id: "o.OrderID"
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
      o.CustomerID AS customer_id,
      c.CustomerName AS customer_name,
      CAST(o.CustomerTrayID AS nvarchar(120)) AS tray_number,
      CAST(o.CustomerOrdReference AS nvarchar(120)) AS order_reference,
      o.CurrentStatusID AS current_status_id,
      si.StatusItemName AS current_status_description,
      o.PatientID AS patient_id,
      o.CustomerAccount AS customer_account,
      COALESCE(o.CustomerTime, o.ReceivedTime) AS received_at,
      CAST(CASE WHEN g.Active = 1 AND o.JobID IS NOT NULL AND o.JobID <> N'' AND o.OrderType IN (1, 3) THEN 1 ELSE 0 END AS bit) AS is_active
    FROM dbo.Orders o
    LEFT JOIN dbo.Customers c ON c.CustomerID = o.CustomerID
    LEFT JOIN dbo.GenStatus g ON g.GenStatus = o.GenStatus
    LEFT JOIN dbo.StatusItems si ON si.StatusItemID = o.CurrentStatusID
    WHERE ${expression} IN (${placeholders});
  `;
}

function buildZenBatchMatchQuery(references, matchingField) {
  const expression = ZEN_MATCH_FIELDS[matchingField];
  if (!expression) throw new Error(`Unsupported supplier matching field: ${matchingField}`);
  const placeholders = references.map(() => "?").join(", ");
  return `
    SELECT
      ${expression} AS supplier_reference,
      o.OrderID AS internal_order_id,
      o.CustomerID AS customer_id,
      c.CustomerName AS customer_name,
      o.CustomerTrayID AS tray_number,
      o.CustomerOrdReference AS order_reference,
      o.CurrentStatusID AS current_status_id,
      si.StatusItemName AS current_status_description,
      o.PatientID AS patient_id,
      o.CustomerAccount AS customer_account,
      COALESCE(o.CustomerTime, o.ReceivedTime) AS received_at,
      CASE WHEN g.Active = 1 AND o.JobID IS NOT NULL AND o.JobID <> '' AND o.OrderType IN (1, 3) THEN 1 ELSE 0 END AS is_active
    FROM Orders o
    LEFT OUTER JOIN Customers c ON c.CustomerID = o.CustomerID
    LEFT OUTER JOIN GenStatus g ON g.GenStatus = o.GenStatus
    LEFT OUTER JOIN StatusItems si ON si.StatusItemID = o.CurrentStatusID
    WHERE ${expression} IN (${placeholders});
  `;
}

function zenRowToMatchRow(row) {
  const value = (name) => row[name] ?? row[String(name).toUpperCase()] ?? row[String(name).toLowerCase()];
  return {
    supplier_reference: value("supplier_reference"),
    internal_order_id: value("internal_order_id"),
    customer_id: value("customer_id"),
    customer_name: value("customer_name"),
    tray_number: value("tray_number"),
    order_reference: value("order_reference"),
    current_status_id: value("current_status_id"),
    current_status_description: value("current_status_description"),
    patient_id: value("patient_id"),
    customer_account: value("customer_account"),
    received_at: value("received_at"),
    is_active: Number(value("is_active")) === 1
  };
}

async function matchSupplierReferencesFromZen(normalized, matchingField) {
  let connection;
  try {
    connection = await connectZen();
    const rows = await connection.query(buildZenBatchMatchQuery(normalized, matchingField), normalized);
    return classifyMatches(normalized, rows.map(zenRowToMatchRow));
  } finally {
    await connection?.close().catch(() => {});
  }
}

async function matchSupplierReferences(references, { matchingField = "customer_order_reference" } = {}) {
  const normalized = [...new Set((references || []).map(normalizeReference).filter(Boolean))];
  if (!normalized.length) return [];
  if (normalized.length > 500) throw new Error("Supplier batch cannot contain more than 500 references.");
  try {
    const pool = await getSourcePool();
    const request = pool.request();
    normalized.forEach((reference, index) => request.input(`reference_${index}`, sql.NVarChar(120), reference));
    const result = await request.query(buildBatchMatchQuery(normalized, matchingField));
    return classifyMatches(normalized, result.recordset);
  } catch (mssqlError) {
    if (!isZenAvailable()) throw mssqlError;
    try {
      return await matchSupplierReferencesFromZen(normalized, matchingField);
    } catch (zenError) {
      throw new AggregateError([mssqlError, zenError], `Supplier matching failed through MSSQL and Actian Zen: ${mssqlError.message}; Zen fallback: ${zenError.message}`);
    }
  }
}

module.exports = { MATCH_FIELDS, ZEN_MATCH_FIELDS, buildBatchMatchQuery, buildZenBatchMatchQuery, classifyMatches, matchSupplierReferences, normalizeReference, zenRowToMatchRow };
