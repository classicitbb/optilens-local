/**
 * shipment-sync.js — mirrors Innovations dbo.Shipments into the local
 * delivery.shipment_sessions table so the Shipments screen in the Delivery
 * and Export Workbench actually reflects what's in Innovations (open +
 * shipped/closed with tracking no., batch id, message, item count), instead
 * of only showing sessions the app happened to create locally.
 *
 * Source of truth for open/closed is Innovations' own Shipped bit — this is
 * a read + upsert (never deletes a local session, never writes back to
 * Innovations). Safe to call on every /api/delivery/shipments GET; the
 * upsert key is (source_system, source_shipment_id), enforced by the
 * filtered unique index added in database/013-shipment-sync-columns.sql.
 */
const { getAppPool, getSourcePool } = require("./db");

const SOURCE_SYSTEM = "mssql-innovations";
const MAX_ROWS = 500;

async function syncShipmentSessions(filters = {}) {
  const range = normalizeDateRange(filters);
  const rows = await fetchSourceShipments(range);
  const pool = await getAppPool();

  let inserted = 0;
  let updated = 0;
  const errors = [];

  for (const row of rows) {
    try {
      const outcome = await upsertSession(pool, row);
      if (outcome === "inserted") inserted += 1;
      else if (outcome === "updated") updated += 1;
    } catch (error) {
      errors.push({ sourceShipmentId: row.ShipmentID, message: error.message });
    }
  }

  return { pulled: rows.length, inserted, updated, errors };
}

async function fetchSourceShipments(range) {
  const pool = await getSourcePool();
  const result = await pool.request()
    .input("fromDate", range.fromDate)
    .input("toDate", range.toDate)
    .query(`
      SELECT TOP (${MAX_ROWS})
        s.ShipmentID,
        s.ShipmentBatchID,
        s.ShippingMethodID,
        sm.ShippingMethodName,
        c.AccountNumber AS CustomerAccount,
        s.Shipped,
        s.ShippedTime,
        s.TrackingNumber,
        s.ResultMessage,
        s.RecordCreated,
        s.LastUpdated,
        (SELECT COUNT(*) FROM dbo.ShipmentItems si WHERE si.ShipmentID = s.ShipmentID) AS ItemCount
      FROM dbo.Shipments s
      LEFT JOIN dbo.ShippingMethods sm ON sm.ShippingMethodID = s.ShippingMethodID
      LEFT JOIN dbo.Customers c ON c.CustomerID = s.ShipToID
      WHERE s.RecordDeleted = 0
        AND (
          s.Shipped = 0
          OR (
            s.ShippedTime >= TRY_CONVERT(datetimeoffset, @fromDate)
            AND s.ShippedTime < DATEADD(day, 1, TRY_CONVERT(datetimeoffset, @toDate))
          )
        )
      ORDER BY s.ShipmentID DESC
    `);
  return result.recordset;
}

async function upsertSession(pool, row) {
  const isClosed = Boolean(row.Shipped);
  const request = pool.request()
    .input("source_system", SOURCE_SYSTEM)
    .input("source_shipment_id", String(row.ShipmentID))
    .input("customer_account", valueOrNull(row.CustomerAccount, 120))
    .input("source_shipped", isClosed)
    .input("app_status", isClosed ? "closed" : "prep")
    .input("closed_at", isClosed ? row.ShippedTime : null)
    .input("source_shipment_batch_id", row.ShipmentBatchID ?? null)
    .input("tracking_number", valueOrNull(row.TrackingNumber, 200))
    .input("shipping_method_id", row.ShippingMethodID ?? null)
    .input("shipping_method_name", valueOrNull(row.ShippingMethodName, 200))
    .input("source_result_message", valueOrNull(row.ResultMessage, 500))
    .input("source_item_count", row.ItemCount ?? 0);

  const result = await request.query(`
    MERGE delivery.shipment_sessions AS target
    USING (SELECT @source_system AS source_system, @source_shipment_id AS source_shipment_id) AS src
      ON target.source_system = src.source_system AND target.source_shipment_id = src.source_shipment_id
    WHEN MATCHED THEN UPDATE SET
      customer_account = COALESCE(target.customer_account, @customer_account),
      source_shipped = @source_shipped,
      app_status = CASE WHEN @app_status = N'closed' THEN N'closed' ELSE target.app_status END,
      closed_at = COALESCE(target.closed_at, @closed_at),
      source_shipment_batch_id = @source_shipment_batch_id,
      tracking_number = @tracking_number,
      shipping_method_id = @shipping_method_id,
      shipping_method_name = @shipping_method_name,
      source_result_message = @source_result_message,
      source_item_count = @source_item_count,
      source_synced_at = SYSUTCDATETIME(),
      last_edited_at = SYSUTCDATETIME()
    WHEN NOT MATCHED THEN INSERT (
      source_system, source_shipment_id, customer_account, dispatcher_id,
      app_status, source_shipped, closed_at, source_shipment_batch_id,
      tracking_number, shipping_method_id, shipping_method_name,
      source_result_message, source_item_count, source_synced_at
    ) VALUES (
      @source_system, @source_shipment_id, @customer_account, NULL,
      @app_status, @source_shipped, @closed_at, @source_shipment_batch_id,
      @tracking_number, @shipping_method_id, @shipping_method_name,
      @source_result_message, @source_item_count, SYSUTCDATETIME()
    )
    OUTPUT $action AS action;
  `);

  return result.recordset[0]?.action === "INSERT" ? "inserted" : "updated";
}

function normalizeDateRange(filters) {
  const today = new Date();
  const fallbackTo = today.toISOString().slice(0, 10);
  const fallbackFromDate = new Date(today);
  fallbackFromDate.setDate(fallbackFromDate.getDate() - 7);
  const fallbackFrom = fallbackFromDate.toISOString().slice(0, 10);

  return {
    fromDate: isDateString(filters.fromDate) ? filters.fromDate : fallbackFrom,
    toDate: isDateString(filters.toDate) ? filters.toDate : fallbackTo
  };
}

function isDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function valueOrNull(value, maxLength) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

module.exports = { syncShipmentSessions };
