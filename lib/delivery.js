const { getAppPool } = require("./db");

async function listShipmentSessions() {
  const pool = await getAppPool();
  const result = await pool.request().query(`
    SELECT TOP (50)
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
    ORDER BY started_at DESC
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

function valueOrNull(value, maxLength) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

module.exports = {
  createShipmentSession,
  deleteTestShipmentSessions,
  getShipmentSession,
  listShipmentEvents,
  listShipmentSessions,
  updateShipmentStatus
};
