/** Read-only inspection of purchase orders already stored in Innovations. */
const sql = require("mssql");
const db = require("../db");
const { assertReadOnlySql } = require("./source-adapter");
const { badRequest, unavailable } = require("./errors");

function poNumber(value) {
  const text = String(value || "").trim();
  if (!/^\d{1,10}$/.test(text) || Number(text) > 2147483647) throw badRequest("Enter a valid Innovations PO number.");
  return Number(text);
}

function barcode(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 80 || /[\x00-\x1f]/.test(text)) throw badRequest("Enter a lens barcode or SKU (up to 80 characters).");
  return text;
}

async function sourceQuery(query, bind) {
  assertReadOnlySql(query);
  try {
    const pool = await db.getLiveSourcePool();
    const request = pool.request();
    bind(request);
    return (await request.query(query)).recordset;
  } catch (error) {
    const wrapped = unavailable("Innovations purchase orders are temporarily unavailable.", "SOURCE_UNAVAILABLE");
    wrapped.cause = error;
    throw wrapped;
  }
}

const HEADER_SELECT = `
  SELECT h.POHeaderID AS poNumber, h.POStatus AS statusCode,
    ps.POStatusName AS status, v.VendorName AS vendor,
    h.CreateDate AS createdAt, h.CommitDate AS committedAt,
    h.CloseDate AS closedAt, h.PromiseDate AS promisedAt,
    COUNT(i.POItemID) AS lineCount,
    COALESCE(SUM(CAST(i.QtyInitial AS bigint)), 0) AS orderedUnits,
    COALESCE(SUM(CAST(COALESCE(i.QtyReceived, 0) AS bigint)), 0) AS receivedUnits
  FROM dbo.POHeaders h
  LEFT JOIN dbo.POStatus ps ON ps.ItemStatus = h.POStatus
  LEFT JOIN dbo.Vendors v ON v.VendorID = h.VendorID
  LEFT JOIN dbo.POItems i ON i.POHeaderID = h.POHeaderID
`;

const HEADER_GROUP = ` GROUP BY h.POHeaderID, h.POStatus, ps.POStatusName, v.VendorName,
  h.CreateDate, h.CommitDate, h.CloseDate, h.PromiseDate`;

const STATUS_CODES = Object.freeze({ SAVED: 20, ON_ORDER: 30, BACK_ORDER: 40, ALL: null });
const SORT_COLUMNS = Object.freeze({
  number: "h.POHeaderID", vendor: "v.VendorName", status: "ps.POStatusName",
  created: "h.CreateDate", committed: "h.CommitDate", lines: "lineCount",
  ordered: "orderedUnits", received: "receivedUnits"
});

async function searchPurchaseOrders({ mode = "po", value = "", status = "SAVED", sortBy = "created", sortDir = "DESC" }) {
  if (mode !== "po" && mode !== "barcode") throw badRequest("Choose PO number or lens barcode.");
  if (!Object.hasOwn(STATUS_CODES, status)) throw badRequest("Choose a valid PO status filter.");
  if (!Object.hasOwn(SORT_COLUMNS, sortBy) || !["ASC", "DESC"].includes(sortDir)) throw badRequest("Choose a valid PO sort.");
  const queryText = String(value || "").trim();
  const exactNumber = mode === "po" && queryText ? poNumber(queryText) : null;
  const code = mode === "barcode" && queryText ? barcode(queryText) : null;
  const where = [];
  if (status !== "ALL") where.push("h.POStatus = @statusCode");
  if (exactNumber !== null) where.push("h.POHeaderID = @poNumber");
  const bind = (request) => {
    if (status !== "ALL") request.input("statusCode", sql.Int, STATUS_CODES[status]);
    if (exactNumber !== null) request.input("poNumber", sql.Int, exactNumber);
    if (code) request.input("code", sql.NVarChar(80), code);
  };
  // Match the scanned side of a lens, rather than the other eye's stock item.
  const matched = code ? `WITH matched AS (
    SELECT DISTINCT i.POHeaderID
    FROM dbo.POItems i
    JOIN dbo.StockItems si ON si.StockItemID = i.StockItemID
    JOIN dbo.LensItem li ON li.LensItemID = si.LensItemID
    WHERE (si.ChiralCode = 10 AND (li.OPC_L = @code OR li.UserSKU_L = @code))
       OR (si.ChiralCode = 20 AND (li.OPC_R = @code OR li.UserSKU_R = @code))
       OR (si.ChiralCode = 30 AND (li.OPC_P = @code OR li.UserSKU_P = @code))
  ) ` : "";
  const limitedSelect = HEADER_SELECT.replace("SELECT h.POHeaderID", "SELECT TOP (51) h.POHeaderID");
  const query = matched + limitedSelect + (code ? " JOIN matched m ON m.POHeaderID = h.POHeaderID" : "") +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") + HEADER_GROUP +
    ` ORDER BY ${SORT_COLUMNS[sortBy]} ${sortDir}, h.POHeaderID DESC`;
  const rows = await sourceQuery(query, bind);
  return { mode, query: queryText, status, sortBy, sortDir, orders: rows.slice(0, 50), truncated: rows.length > 50 };
}

async function getPurchaseOrder(value) {
  const id = poNumber(value);
  const headers = await sourceQuery(HEADER_SELECT + ` WHERE h.POHeaderID = @poNumber` + HEADER_GROUP, (r) => r.input("poNumber", sql.Int, id));
  if (!headers.length) return null;
  const lines = await sourceQuery(`SELECT i.POItemID AS lineId, i.LineNumber AS lineNumber,
    i.StockItemID AS stockItemId, i.QtyInitial AS orderedQuantity,
    COALESCE(i.QtyReceived, 0) AS receivedQuantity,
    i.UnitCostInitial AS unitCost, i.Notes AS notes,
    li.Name AS lensName, li.Abbrev AS lensAbbrev,
    CASE si.ChiralCode WHEN 10 THEN 'Left' WHEN 20 THEN 'Right' WHEN 30 THEN 'Pair' ELSE NULL END AS lensSide,
    CASE si.ChiralCode WHEN 10 THEN COALESCE(NULLIF(li.OPC_L, ''), li.UserSKU_L)
      WHEN 20 THEN COALESCE(NULLIF(li.OPC_R, ''), li.UserSKU_R)
      WHEN 30 THEN COALESCE(NULLIF(li.OPC_P, ''), li.UserSKU_P) ELSE NULL END AS sku
    FROM dbo.POItems i
    LEFT JOIN dbo.StockItems si ON si.StockItemID = i.StockItemID
    LEFT JOIN dbo.LensItem li ON li.LensItemID = si.LensItemID
    WHERE i.POHeaderID = @poNumber ORDER BY i.LineNumber, i.POItemID`, (r) => r.input("poNumber", sql.Int, id));
  return { order: headers[0], lines };
}

module.exports = { searchPurchaseOrders, getPurchaseOrder, poNumber, barcode };
