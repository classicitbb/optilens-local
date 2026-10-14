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

async function searchPurchaseOrders({ mode, value }) {
  if (mode === "po") {
    const id = poNumber(value);
    const rows = await sourceQuery(HEADER_SELECT + ` WHERE h.POHeaderID = @poNumber` + HEADER_GROUP, (r) => r.input("poNumber", sql.Int, id));
    return { mode, query: String(id), orders: rows, truncated: false };
  }
  if (mode !== "barcode") throw badRequest("Choose PO number or lens barcode.");
  const code = barcode(value);
  // Match the scanned side of a lens, rather than the other eye's stock item.
  const query = `WITH matched AS (
    SELECT DISTINCT TOP (51) i.POHeaderID
    FROM dbo.POItems i
    JOIN dbo.StockItems si ON si.StockItemID = i.StockItemID
    JOIN dbo.LensItem li ON li.LensItemID = si.LensItemID
    WHERE (si.ChiralCode = 10 AND (li.OPC_L = @code OR li.UserSKU_L = @code))
       OR (si.ChiralCode = 20 AND (li.OPC_R = @code OR li.UserSKU_R = @code))
       OR (si.ChiralCode = 30 AND (li.OPC_P = @code OR li.UserSKU_P = @code))
    ORDER BY i.POHeaderID DESC
  ) ` + HEADER_SELECT + ` JOIN matched m ON m.POHeaderID = h.POHeaderID` + HEADER_GROUP + ` ORDER BY h.POHeaderID DESC`;
  const rows = await sourceQuery(query, (r) => r.input("code", sql.NVarChar(80), code));
  return { mode, query: code, orders: rows.slice(0, 50), truncated: rows.length > 50 };
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
