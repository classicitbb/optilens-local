const path = require("node:path");
const ExcelJS = require("exceljs");

const DEFAULT_STATUS_MAP = new Map([
  ["received at lab", "RECEIVED_AT_LAB"],
  ["in manufacturing", "IN_MANUFACTURING"],
  ["manufacturing complet", "MANUFACTURING_COMPLETE"],
  ["dispatched", "DISPATCHED"]
]);

function normalizeHeader(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeReference(value) {
  const original = String(value ?? "").trim();
  if (!original) return { original, normalized: "" };
  if (/^\d+\.0+$/.test(original)) return { original, normalized: original.replace(/\.0+$/, "") };
  return { original, normalized: original };
}

function parseDelimited(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (!quoted && ch === delimiter) { row.push(cell); cell = ""; }
    else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function locateHeaders(rows) {
  for (let index = 0; index < Math.min(rows.length, 20); index += 1) {
    const headers = rows[index].map(normalizeHeader);
    const order = headers.findIndex((value) => ["order code", "ordercode", "order_code", "rx no", "rx number"].includes(value));
    const status = headers.findIndex((value) => value === "status" || value === "supplier status");
    if (order >= 0) return { rowIndex: index, orderIndex: order, statusIndex: status };
  }
  throw new Error("Missing required order reference column.");
}

function normalizeRows(rows, sourceName) {
  const header = locateHeaders(rows);
  const seen = new Set();
  const items = [];
  const warnings = [];
  for (let i = header.rowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i] || [];
    if (!row.some((value) => String(value ?? "").trim())) continue;
    const reference = normalizeReference(row[header.orderIndex]);
    if (!reference.normalized) { warnings.push({ row: i + 1, code: "EMPTY_REFERENCE" }); continue; }
    if (seen.has(reference.normalized)) { warnings.push({ row: i + 1, code: "DUPLICATE_REFERENCE", reference: reference.normalized }); continue; }
    seen.add(reference.normalized);
    const supplierStatus = header.statusIndex >= 0 ? String(row[header.statusIndex] ?? "").trim() : "";
    items.push({
      supplierReference: reference.normalized,
      originalSupplierReference: reference.original,
      supplierStatus,
      normalizedStatus: DEFAULT_STATUS_MAP.get(supplierStatus.toLowerCase()) || null,
      sourceRow: i + 1,
      sourceName,
      warning: supplierStatus && !DEFAULT_STATUS_MAP.has(supplierStatus.toLowerCase()) ? "Unknown Supplier Status" : null
    });
  }
  return { items, warnings, headerRow: header.rowIndex + 1 };
}

async function parseXlsx(buffer, sourceName = "attachment.xlsx") {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheets = workbook.worksheets.filter((sheet) => sheet.state !== "hidden");
  let lastError;
  for (const sheet of worksheets) {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1).map((value) => value?.text ?? value ?? "")));
    try { return { ...normalizeRows(rows, sourceName), worksheet: sheet.name, parser: "TOGXlsxParser" }; }
    catch (error) { lastError = error; }
  }
  throw lastError || new Error("No visible worksheet could be parsed.");
}

function parseCsv(text, sourceName = "fixture.csv") {
  return { ...normalizeRows(parseDelimited(text), sourceName), parser: "SupplierCsvParser" };
}

async function parseSupplierFile({ buffer, filename, contentType }) {
  const extension = path.extname(filename || "").toLowerCase();
  if (extension === ".csv" || contentType === "text/csv") return parseCsv(Buffer.from(buffer).toString("utf8"), filename);
  if (extension === ".xlsx" || contentType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return parseXlsx(buffer, filename);
  throw new Error(`Unsupported supplier file type: ${extension || "unknown"}`);
}

module.exports = { DEFAULT_STATUS_MAP, locateHeaders, normalizeHeader, normalizeReference, parseCsv, parseXlsx, parseSupplierFile };
