const { getAppPool } = require("./db");
const sql = require("mssql");

async function listShipmentSessions(filters = {}) {
  const pool = await getAppPool();
  const range = normalizeDateRange(filters);
  const result = await pool.request()
    .input("fromDate", range.fromDate)
    .input("toDate", range.toDate)
    .input("sourceSyncStartedAt", filters.sourceSyncStartedAt || null)
    .query(`
    WITH session_counts AS (
      SELECT
        s.shipment_session_id,
        s.source_system,
        s.source_shipment_id,
        s.customer_account,
        s.dispatcher_id,
        s.app_status,
        s.source_shipped,
        s.started_at,
        s.closed_at,
        s.reopened_at,
        s.last_edited_at,
        s.notes,
        s.legacy_delivery_no,
        s.source_shipment_batch_id,
        s.tracking_number,
        s.shipping_method_id,
        s.shipping_method_name,
        s.source_result_message,
        s.source_item_count,
        s.source_synced_at,
        COUNT(i.shipment_session_item_id) AS item_count,
        MIN(CASE WHEN s.app_status = N'closed' THEN 1 ELSE 0 END) AS sort_group,
        MAX(COALESCE(s.closed_at, s.started_at)) AS sort_at
      FROM delivery.shipment_sessions s
      LEFT JOIN delivery.shipment_session_items i
        ON i.shipment_session_id = s.shipment_session_id
        AND i.removed_at IS NULL
      WHERE s.app_status <> N'closed'
         OR (
          s.closed_at >= TRY_CONVERT(date, @fromDate)
          AND s.closed_at < DATEADD(day, 1, TRY_CONVERT(date, @toDate))
        )
      GROUP BY
        s.shipment_session_id,
        s.source_system,
        s.source_shipment_id,
        s.customer_account,
        s.dispatcher_id,
        s.app_status,
        s.source_shipped,
        s.started_at,
        s.closed_at,
        s.reopened_at,
        s.last_edited_at,
        s.notes,
        s.legacy_delivery_no,
        s.source_shipment_batch_id,
        s.tracking_number,
        s.shipping_method_id,
        s.shipping_method_name,
        s.source_result_message,
        s.source_item_count,
        s.source_synced_at
    )
    SELECT TOP (200)
      shipment_session_id,
      source_system,
      source_shipment_id,
      customer_account,
      dispatcher_id,
      app_status,
      source_shipped,
      started_at,
      closed_at,
      reopened_at,
      last_edited_at,
      notes,
      legacy_delivery_no,
      source_shipment_batch_id,
      tracking_number,
      shipping_method_id,
      shipping_method_name,
      source_result_message,
      source_item_count,
      source_synced_at,
      CASE
        -- Mirrored shipments list their live Innovations line count. The app
        -- item table is only for optional scan/manual additions, so it is not
        -- an indication that a source shipment has no jobs.
        WHEN source_system = N'mssql-innovations' THEN ISNULL(source_item_count, 0)
        ELSE item_count
      END AS item_count
    FROM session_counts
    -- A source-mirrored shipment can remain locally after its source items
    -- have been reassigned or removed. Keep the local history intact, but do
    -- not offer an empty, still-open source snapshot as a shipment to prepare.
    WHERE (
      app_status = N'closed'
      OR source_system <> N'mssql-innovations'
      OR ISNULL(source_item_count, 0) > 0
    )
      -- When this request successfully refreshed Innovations, show only the
      -- source rows refreshed by it. Old mirrored rows remain in the app
      -- database for history, but cannot be presented as current shipments.
      AND (
        @sourceSyncStartedAt IS NULL
        OR source_system <> N'mssql-innovations'
        OR source_synced_at >= @sourceSyncStartedAt
      )
    ORDER BY sort_group, sort_at DESC
  `);

  return result.recordset;
}

async function createShipmentSession(payload, actorUserId = null) {
  const pool = await getAppPool();
  const data = normalizeSessionPayload(payload);

  const result = await pool.request()
    .input("source_system", data.sourceSystem)
    .input("source_shipment_id", data.sourceShipmentId)
    .input("customer_account", data.customerAccount)
    .input("dispatcher_id", data.dispatcherId)
    .input("source_shipped", data.sourceShipped)
    .input("notes", data.notes)
    .query(`
      INSERT INTO delivery.shipment_sessions (
        source_system,
        source_shipment_id,
        customer_account,
        dispatcher_id,
        source_shipped,
        notes
      )
      OUTPUT inserted.*
      VALUES (
        @source_system,
        @source_shipment_id,
        @customer_account,
        @dispatcher_id,
        @source_shipped,
        @notes
      )
    `);

  const session = result.recordset[0];
  await recordShipmentEvent(session.shipment_session_id, "created", {
    sourceSystem: data.sourceSystem,
    sourceShipmentId: data.sourceShipmentId,
    customerAccount: data.customerAccount
  }, actorUserId);

  return session;
}

async function updateShipmentStatus(id, status, actorUserId = null) {
  const pool = await getAppPool();
  const statusSql = status === "closed"
    ? "app_status = N'closed', closed_at = SYSUTCDATETIME(), last_edited_at = SYSUTCDATETIME()"
    : "app_status = N'prep', reopened_at = SYSUTCDATETIME(), last_edited_at = SYSUTCDATETIME()";

  const result = await pool.request()
    .input("id", id)
    .query(`
      UPDATE delivery.shipment_sessions
      SET ${statusSql}
      OUTPUT inserted.*
      WHERE shipment_session_id = @id
    `);

  if (!result.recordset.length) {
    const error = new Error("Shipment session not found.");
    error.statusCode = 404;
    throw error;
  }

  await recordShipmentEvent(id, status === "closed" ? "closed" : "reopened", {
    appStatus: status
  }, actorUserId);

  return result.recordset[0];
}

async function closeShipmentSessionsBatch(sessionIds, dispatcherId, actorUserId = null) {
  const ids = normalizeSessionIds(sessionIds);
  if (!ids.length) {
    const error = new Error("Select at least one open domestic shipment to close.");
    error.statusCode = 400;
    throw error;
  }

  const closed = [];
  for (const id of ids) {
    if (dispatcherId) {
      await setShipmentDispatcher(id, dispatcherId);
    }
    closed.push(await updateShipmentStatus(id, "closed", actorUserId));
  }
  return closed;
}

async function setShipmentDispatcher(id, dispatcherId) {
  const pool = await getAppPool();
  await pool.request()
    .input("id", id)
    .input("dispatcher_id", valueOrNull(dispatcherId, 120))
    .query(`
      UPDATE delivery.shipment_sessions
      SET dispatcher_id = @dispatcher_id,
          last_edited_at = SYSUTCDATETIME()
      WHERE shipment_session_id = @id
    `);
}

async function recordShipmentEvent(sessionId, eventType, eventData, actorUserId = null) {
  const pool = await getAppPool();
  await pool.request()
    .input("shipment_session_id", sessionId)
    .input("event_type", eventType)
    .input("actor_user_id", actorUserId)
    .input("event_data", JSON.stringify(eventData || {}))
    .query(`
      INSERT INTO delivery.shipment_events (
        shipment_session_id,
        event_type,
        actor_user_id,
        event_data
      )
      VALUES (
        @shipment_session_id,
        @event_type,
        @actor_user_id,
        @event_data
      )
    `);
}

async function listShipmentSessionItems(sessionId) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("shipment_session_id", sessionId)
    .query(`
      SELECT
        shipment_session_item_id AS shipmentSessionItemId,
        shipment_session_id AS shipmentSessionId,
        source_system AS sourceSystem,
        source_shipment_item_id AS shipmentItemId,
        source_order_id AS orderId,
        invoice_number AS invoiceNumber,
        patient_name AS patientName,
        price,
        item_state AS itemState,
        added_method AS addedMethod,
        created_at AS createdAt
      FROM delivery.shipment_session_items
      WHERE shipment_session_id = @shipment_session_id
        AND removed_at IS NULL
      ORDER BY created_at, shipment_session_item_id
    `);

  return result.recordset;
}

async function addShipmentSessionItem(sessionId, item, actorUserId = null) {
  const invoiceNumber = valueOrNull(item.invoiceNumber, 120);
  if (!invoiceNumber) {
    const error = new Error("Scan an invoice number before adding a row.");
    error.statusCode = 400;
    throw error;
  }

  const pool = await getAppPool();
  const duplicate = await pool.request()
    .input("shipment_session_id", sessionId)
    .input("invoice_number", invoiceNumber)
    .query(`
      SELECT TOP (1) shipment_session_item_id
      FROM delivery.shipment_session_items
      WHERE shipment_session_id = @shipment_session_id
        AND invoice_number = @invoice_number
        AND removed_at IS NULL
    `);

  if (duplicate.recordset.length) {
    const error = new Error(`Invoice ${invoiceNumber} is already on this shipment.`);
    error.statusCode = 409;
    throw error;
  }

  const result = await pool.request()
    .input("shipment_session_id", sessionId)
    .input("source_system", valueOrNull(item.sourceSystem, 80) || "mssql")
    .input("source_shipment_item_id", valueOrNull(item.shipmentItemId, 120))
    .input("source_order_id", valueOrNull(item.orderId, 120))
    .input("invoice_number", invoiceNumber)
    .input("patient_name", valueOrNull(item.patientName, 300))
    .input("price", sql.Decimal(18, 2), normalizePrice(item.price))
    .query(`
      INSERT INTO delivery.shipment_session_items (
        shipment_session_id,
        source_system,
        source_shipment_item_id,
        source_order_id,
        invoice_number,
        patient_name,
        price,
        added_method
      )
      OUTPUT
        inserted.shipment_session_item_id AS shipmentSessionItemId,
        inserted.shipment_session_id AS shipmentSessionId,
        inserted.source_system AS sourceSystem,
        inserted.source_shipment_item_id AS shipmentItemId,
        inserted.source_order_id AS orderId,
        inserted.invoice_number AS invoiceNumber,
        inserted.patient_name AS patientName,
        inserted.price,
        inserted.item_state AS itemState,
        inserted.added_method AS addedMethod,
        inserted.created_at AS createdAt
      VALUES (
        @shipment_session_id,
        @source_system,
        @source_shipment_item_id,
        @source_order_id,
        @invoice_number,
        @patient_name,
        @price,
        N'scan'
      )
    `);

  await recordShipmentEvent(sessionId, "item.added", {
    invoiceNumber,
    orderId: item.orderId || null
  }, actorUserId);

  return result.recordset[0];
}

async function getShipmentSession(id) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("id", id)
    .query(`
      SELECT
        shipment_session_id,
        source_system,
        source_shipment_id,
        customer_account,
        dispatcher_id,
        app_status,
        source_shipped,
        started_at,
        closed_at,
        reopened_at,
        last_edited_at,
        notes,
        legacy_delivery_no
      FROM delivery.shipment_sessions
      WHERE shipment_session_id = @id
    `);

  if (!result.recordset.length) {
    const error = new Error("Shipment session not found.");
    error.statusCode = 404;
    throw error;
  }

  return result.recordset[0];
}

async function listShipmentEvents(sessionId) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("shipment_session_id", sessionId)
    .query(`
      SELECT TOP (100)
        shipment_event_id,
        shipment_session_id,
        event_type,
        event_data,
        created_at
      FROM delivery.shipment_events
      WHERE shipment_session_id = @shipment_session_id
      ORDER BY created_at DESC, shipment_event_id DESC
    `);

  return result.recordset;
}

async function deleteTestShipmentSessions() {
  const pool = await getAppPool();
  const result = await pool.request().batch(`
    DELETE e
    FROM delivery.shipment_events e
    INNER JOIN delivery.shipment_sessions s
      ON s.shipment_session_id = e.shipment_session_id
    WHERE s.source_shipment_id LIKE N'TEST-%'
       OR s.customer_account LIKE N'TEST-%';

    DELETE FROM delivery.shipment_sessions
    WHERE source_shipment_id LIKE N'TEST-%'
       OR customer_account LIKE N'TEST-%';

    SELECT @@ROWCOUNT AS deleted_sessions;
  `);

  return result.recordset?.[0] || { deleted_sessions: 0 };
}

function normalizeSessionPayload(payload) {
  return {
    sourceSystem: String(payload.sourceSystem || "mssql").slice(0, 80),
    sourceShipmentId: valueOrNull(payload.sourceShipmentId, 120),
    customerAccount: valueOrNull(payload.customerAccount, 120),
    dispatcherId: valueOrNull(payload.dispatcherId, 120),
    sourceShipped: payload.sourceShipped === true || payload.sourceShipped === 1 ? true : false,
    notes: valueOrNull(payload.notes, 4000)
  };
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

function normalizeSessionIds(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
}

function normalizePrice(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function valueOrNull(value, maxLength) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

module.exports = {
  addShipmentSessionItem,
  closeShipmentSessionsBatch,
  createShipmentSession,
  deleteTestShipmentSessions,
  getShipmentSession,
  listShipmentSessionItems,
  listShipmentEvents,
  listShipmentSessions,
  updateShipmentStatus
};
