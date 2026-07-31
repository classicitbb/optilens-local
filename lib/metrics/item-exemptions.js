// Operator-curated exemptions for the item cost defect register.
//
// The register itself is a live query against Innovations — fix an item's cost there and
// it disappears on the next refresh. This is the only app-owned state: the record of
// which items are zero-cost ON PURPOSE (workflow triggers such as EDGINVTRIG), which the
// source cannot tell us.
//
// Backing table: pricing.item_cost_exemptions (database/030-item-cost-exemptions.sql).

const sql = require("mssql");
const { getAppPool } = require("../db");
const { recordAuditEvent } = require("../audit");

const CHECK_CODES = ["zero-cost", "cost-exceeds-price", "zero-price"];
const MAX_KEY_LENGTH = 120;

/** SKUs arrive from invoice lines with stray whitespace and inconsistent case. */
function normaliseItemKey(value) {
  const key = String(value == null ? "" : value).trim().toUpperCase();
  if (!key) {
    throw Object.assign(new Error("An item key (SKU) is required."), { statusCode: 400 });
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw Object.assign(new Error(`Item key is longer than ${MAX_KEY_LENGTH} characters.`), { statusCode: 400 });
  }
  return key;
}

function assertCheckCode(value) {
  const code = String(value || "zero-cost").trim();
  if (!CHECK_CODES.includes(code)) {
    throw Object.assign(
      new Error(`Unknown check "${code}". Expected one of: ${CHECK_CODES.join(", ")}.`),
      { statusCode: 400 }
    );
  }
  return code;
}

/** Active exemptions as a Set of "checkCode␟item_key", for filtering the register. */
async function loadActiveExemptions() {
  const pool = await getAppPool();
  const result = await pool.request().query(`
    SELECT item_key, check_code
    FROM pricing.item_cost_exemptions
    WHERE exemption_state = N'ACTIVE';
  `);
  return new Set(result.recordset.map((r) => `${r.check_code}␟${String(r.item_key).trim().toUpperCase()}`));
}

async function listExemptions() {
  const pool = await getAppPool();
  const result = await pool.request().query(`
    SELECT exemption_id, item_key, item_description, check_code, exemption_state,
           reason, source, exempted_by, exempted_at, created_at, updated_at
    FROM pricing.item_cost_exemptions
    ORDER BY exemption_state, item_key;
  `);
  return result.recordset.map(toPayload);
}

/**
 * Exempt an item from a check, or revoke that exemption. Upserts so an operator can
 * revoke and re-exempt without hitting the unique constraint.
 */
async function setExemption({ itemKey, checkCode, description, reason, revoke = false }, actorUserId) {
  const key = normaliseItemKey(itemKey);
  const code = assertCheckCode(checkCode);
  const state = revoke ? "REVOKED" : "ACTIVE";

  if (!revoke && !String(reason || "").trim()) {
    throw Object.assign(
      new Error("A reason is required when exempting an item, so the decision can be understood later."),
      { statusCode: 400 }
    );
  }

  const pool = await getAppPool();
  const result = await pool.request()
    .input("itemKey", sql.NVarChar(MAX_KEY_LENGTH), key)
    .input("checkCode", sql.NVarChar(40), code)
    .input("description", sql.NVarChar(400), description ? String(description).slice(0, 400) : null)
    .input("reason", sql.NVarChar(sql.MAX), reason ? String(reason) : null)
    .input("state", sql.NVarChar(40), state)
    .input("actor", sql.UniqueIdentifier, actorUserId || null)
    .query(`
      MERGE pricing.item_cost_exemptions AS target
      USING (SELECT @itemKey AS item_key, @checkCode AS check_code) AS src
        ON target.item_key = src.item_key AND target.check_code = src.check_code
      WHEN MATCHED THEN UPDATE SET
        exemption_state = @state,
        reason = COALESCE(@reason, target.reason),
        item_description = COALESCE(@description, target.item_description),
        exempted_by = @actor,
        exempted_at = SYSUTCDATETIME(),
        updated_at = SYSUTCDATETIME(),
        updated_by_user_id = @actor
      WHEN NOT MATCHED THEN
        INSERT (item_key, item_description, check_code, exemption_state, reason, source,
                exempted_by, exempted_at, updated_by_user_id)
        VALUES (@itemKey, @description, @checkCode, @state, @reason, N'OPERATOR',
                @actor, SYSUTCDATETIME(), @actor)
      OUTPUT inserted.exemption_id, inserted.item_key, inserted.item_description,
             inserted.check_code, inserted.exemption_state, inserted.reason, inserted.source,
             inserted.exempted_by, inserted.exempted_at, inserted.created_at, inserted.updated_at;
    `);

  const row = result.recordset[0];

  await recordAuditEvent({
    moduleCode: "business-metrics",
    actorUserId,
    eventType: revoke ? "item_cost_exemption.revoked" : "item_cost_exemption.granted",
    entityType: "pricing.item_cost_exemption",
    entityId: row.exemption_id,
    eventData: { itemKey: key, checkCode: code, reason: reason || null }
  }).catch(() => { /* auditing must never block the operator's action */ });

  return toPayload(row);
}

function toPayload(row) {
  return {
    exemptionId: row.exemption_id,
    itemKey: String(row.item_key || "").trim(),
    itemDescription: row.item_description || null,
    checkCode: row.check_code,
    state: row.exemption_state,
    reason: row.reason || null,
    source: row.source,
    exemptedBy: row.exempted_by || null,
    exemptedAt: row.exempted_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

module.exports = {
  loadActiveExemptions,
  listExemptions,
  setExemption,
  normaliseItemKey,
  assertCheckCode,
  CHECK_CODES
};
