// Review decisions for the Order quality tab — the only app-owned state for that tab.
// Findings are live read-only queries against Innovations; this records what a person
// decided about one. It never writes to Innovations.
//
// Backing table: metrics.order_quality_decisions (database/060-order-quality-review.sql).

const sql = require("mssql");
const { getAppPool } = require("../db");
const { recordAuditEvent } = require("../audit");

const DECISIONS = ["accepted", "fixed", "dismissed"];
const CHECK_CODES = ["lens-swap", "lens-unresolved", "addon-by-hand", "order-errors"];

function assertDecision(body) {
  const key = String(body?.findingKey || "").trim();
  if (!key) throw Object.assign(new Error("A finding key is required."), { statusCode: 400 });
  if (key.length > 300) throw Object.assign(new Error("Finding key is too long."), { statusCode: 400 });
  const decision = String(body?.decision || "").trim();
  if (!DECISIONS.includes(decision)) {
    throw Object.assign(new Error(`Decision must be one of: ${DECISIONS.join(", ")}.`), { statusCode: 400 });
  }
  const checkCode = String(body?.checkCode || "").trim();
  if (!CHECK_CODES.includes(checkCode)) {
    throw Object.assign(new Error(`Unknown check "${checkCode}".`), { statusCode: 400 });
  }
  const reason = String(body?.reason || "").trim();
  if (!reason) {
    throw Object.assign(new Error("A reason is required so the decision can be understood later."), { statusCode: 400 });
  }
  return { key, decision, checkCode, reason: reason.slice(0, 500) };
}

/** Latest decision per finding key, as a Map. Returns an empty Map if the table is unreachable. */
async function loadDecisions() {
  try {
    const pool = await getAppPool();
    const result = await pool.request().query(`
      SELECT finding_key, decision, reason, created_at, created_by
      FROM (
        SELECT finding_key, decision, reason, created_at, created_by,
               ROW_NUMBER() OVER (PARTITION BY finding_key ORDER BY created_at DESC) AS rn
        FROM metrics.order_quality_decisions
      ) d WHERE rn = 1;
    `);
    const map = new Map();
    for (const row of result.recordset) {
      map.set(row.finding_key, {
        decision: row.decision, reason: row.reason, decidedAt: row.created_at, decidedBy: row.created_by
      });
    }
    return { available: true, map };
  } catch (error) {
    return { available: false, map: new Map(), error: error.message };
  }
}

async function recordDecision(body, { actorUserId, actorName }) {
  const { key, decision, checkCode, reason } = assertDecision(body);
  const context = body.context && typeof body.context === "object" ? body.context : null;
  const pool = await getAppPool();
  await pool.request()
    .input("key", sql.NVarChar(300), key)
    .input("check", sql.NVarChar(40), checkCode)
    .input("decision", sql.NVarChar(20), decision)
    .input("reason", sql.NVarChar(500), reason)
    .input("context", sql.NVarChar(sql.MAX), context ? JSON.stringify(context).slice(0, 4000) : null)
    .input("actor", sql.UniqueIdentifier, actorUserId || null)
    .input("actorName", sql.NVarChar(100), actorName ? String(actorName).slice(0, 100) : null)
    .query(`
      INSERT INTO metrics.order_quality_decisions
        (finding_key, check_code, decision, reason, context_json, created_by_user_id, created_by)
      VALUES (@key, @check, @decision, @reason, @context, @actor, @actorName);
    `);
  await recordAuditEvent({
    moduleCode: "business-metrics",
    actorUserId: actorUserId || null,
    eventType: `order_quality.${decision}`,
    entityType: "metrics.order_quality_decision",
    entityId: key,
    eventData: { checkCode, reason }
  }).catch(() => { /* auditing must never block the operator's action */ });
  return { ok: true, decision };
}

module.exports = { loadDecisions, recordDecision, assertDecision, DECISIONS, CHECK_CODES };
