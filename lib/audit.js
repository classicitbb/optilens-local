const { getAppPool } = require("./db");

async function recordAuditEvent({
  moduleCode = null,
  actorUserId = null,
  eventType,
  entityType = null,
  entityId = null,
  eventData = null
}) {
  const pool = await getAppPool();

  await pool.request()
    .input("module_code", moduleCode)
    .input("actor_user_id", actorUserId)
    .input("event_type", eventType)
    .input("entity_type", entityType)
    .input("entity_id", entityId)
    .input("event_data", eventData === null || eventData === undefined ? null : JSON.stringify(eventData))
    .query(`
      INSERT INTO core.audit_events (
        module_code,
        actor_user_id,
        event_type,
        entity_type,
        entity_id,
        event_data
      )
      VALUES (
        @module_code,
        @actor_user_id,
        @event_type,
        @entity_type,
        @entity_id,
        @event_data
      );
    `);
}

module.exports = { recordAuditEvent };
