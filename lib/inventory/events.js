/**
 * Durable, idempotent recalculation requests.
 *
 * Anything that should make the engine re-evaluate stock - new usage data, a
 * stock adjustment or count, an open-PO event, an approved settings change, or
 * the scheduled full scan - does so by inserting a row here. Nothing recalculates
 * inside the request that caused it, and nothing runs an unbounded purchasing
 * process in a web request: a worker (the in-process runner or
 * scripts/run-inventory-intelligence-scan.js) claims pending rows in bounded
 * batches.
 *
 * A request is idempotent on its dedupe key: replaying the same source event
 * (same event type, item and source reference) does not queue it twice.
 */

const { randomUUID, createHash } = require("node:crypto");
const sql = require("mssql");
const store = require("./store");
const { recordInventoryAudit } = require("./audit-service");
const { badRequest } = require("./errors");

const EVENT_TYPES = Object.freeze([
  "SCHEDULED_FULL",
  "MANUAL_FULL",
  "EVENT_USAGE",
  "EVENT_STOCK_ADJUSTMENT",
  "EVENT_PO",
  "EVENT_SETTINGS"
]);
const FULL_SCAN_TYPES = new Set(["SCHEDULED_FULL", "MANUAL_FULL"]);
const STALE_CLAIM_MINUTES = 30;

const REQUEST_COLUMNS = `
  request_id AS requestId,
  event_type AS eventType,
  item_id AS itemId,
  dedupe_key AS dedupeKey,
  payload_json AS payloadJson,
  status,
  requested_by AS requestedBy,
  requested_at AS requestedAt,
  claimed_at AS claimedAt,
  processed_at AS processedAt,
  scan_run_id AS scanRunId,
  attempts,
  last_error AS lastError`;

const OUTPUT_COLUMNS = `
  inserted.request_id AS requestId,
  inserted.event_type AS eventType,
  inserted.item_id AS itemId,
  inserted.dedupe_key AS dedupeKey,
  inserted.payload_json AS payloadJson,
  inserted.status AS status,
  inserted.requested_by AS requestedBy,
  inserted.requested_at AS requestedAt,
  inserted.claimed_at AS claimedAt,
  inserted.processed_at AS processedAt,
  inserted.scan_run_id AS scanRunId,
  inserted.attempts AS attempts,
  inserted.last_error AS lastError`;

function mapRequest(row) {
  if (!row) return null;
  return {
    ...row,
    requestedAt: store.toIso(row.requestedAt),
    claimedAt: store.toIso(row.claimedAt),
    processedAt: store.toIso(row.processedAt),
    payload: store.parseJson(row.payloadJson)
  };
}

function dedupeKeyFor({ eventType, itemId, sourceRef }) {
  if (sourceRef) return store.clip(`${eventType}:${itemId || "*"}:${sourceRef}`, 200);
  // No source reference: collapse repeats inside the same minute.
  const bucket = new Date().toISOString().slice(0, 16);
  return `${eventType}:${itemId || "*"}:${createHash("sha1").update(bucket).digest("hex").slice(0, 10)}`;
}

/**
 * Queues a recalculation. Returns { request, created }. A full-scan request is
 * reused while one is already pending or running.
 */
async function enqueueRecalculation({ eventType, itemId = null, sourceRef = null, payload = null, actor = "system", tx = null }) {
  if (!EVENT_TYPES.includes(eventType)) throw badRequest(`Unknown recalculation event ${eventType}.`);
  const isFull = FULL_SCAN_TYPES.has(eventType);
  if (!isFull && !itemId) throw badRequest("An item is required for an item-level recalculation event.");

  const now = new Date();
  const requestId = randomUUID();
  const dedupeKey = isFull ? `FULL:${requestId}` : dedupeKeyFor({ eventType, itemId, sourceRef });
  const request = {
    requestId,
    eventType,
    itemId: isFull ? null : itemId,
    dedupeKey,
    payloadJson: payload ? JSON.stringify(payload) : null,
    status: "PENDING",
    requestedBy: store.clip(actor, 120),
    requestedAt: now.toISOString(),
    claimedAt: null,
    processedAt: null,
    scanRunId: null,
    attempts: 0,
    lastError: null
  };

  if (store.isTestMode()) {
    for (const r of store.mem.requests.values()) {
      const fullInFlight = isFull && FULL_SCAN_TYPES.has(r.eventType) && ["PENDING", "RUNNING"].includes(r.status);
      if (fullInFlight || (!isFull && r.dedupeKey === dedupeKey)) return { request: mapRequest({ ...r }), created: false };
    }
    store.mem.requests.set(request.requestId, { ...request });
  } else {
    const probe = await store.request(tx);
    probe.input("dedupe_key", sql.NVarChar(200), dedupeKey);
    // A full scan is reused while one is in flight; an item event is reused when its source event was already queued.
    const matchSql = isFull
      ? "item_id IS NULL AND status IN (N'PENDING', N'RUNNING')"
      : "dedupe_key = @dedupe_key";
    const existing = await probe.query(`
      SELECT TOP 1 ${REQUEST_COLUMNS}
      FROM inventory.recalculation_requests
      WHERE ${matchSql}
      ORDER BY requested_at DESC;
    `);
    if (existing.recordset[0]) return { request: mapRequest(existing.recordset[0]), created: false };

    try {
      const req = await store.request(tx);
      await req
        .input("request_id", sql.UniqueIdentifier, request.requestId)
        .input("event_type", sql.NVarChar(40), eventType)
        .input("item_id", sql.NVarChar(100), request.itemId)
        .input("dedupe_key", sql.NVarChar(200), dedupeKey)
        .input("payload_json", sql.NVarChar(sql.MAX), request.payloadJson)
        .input("requested_by", sql.NVarChar(120), request.requestedBy)
        .input("requested_at", sql.DateTime2, now)
        .query(`
          INSERT INTO inventory.recalculation_requests (
            request_id, event_type, item_id, dedupe_key, payload_json, status, requested_by, requested_at
          ) VALUES (
            @request_id, @event_type, @item_id, @dedupe_key, @payload_json, N'PENDING', @requested_by, @requested_at
          );
        `);
    } catch (error) {
      if (error && (error.number === 2601 || error.number === 2627)) {
        return { request: { ...request, status: "PENDING" }, created: false };
      }
      throw error;
    }
  }

  await recordInventoryAudit({
    actor,
    action: "RECALCULATION_REQUESTED",
    entityType: "RecalculationRequest",
    entityId: request.requestId,
    afterState: { eventType, itemId: request.itemId, sourceRef },
    reason: isFull ? "Full scan queued" : `Recalculation queued for ${itemId}`,
    tx
  });
  return { request: mapRequest({ ...request }), created: true };
}

/**
 * Claims up to `limit` pending requests for processing (bounded batch). Requests
 * left RUNNING by a crashed worker are reclaimed after STALE_CLAIM_MINUTES.
 */
async function claimRequests({ limit = 200 } = {}) {
  const take = Math.max(1, Math.min(500, Number(limit) || 200));
  const now = new Date();

  if (store.isTestMode()) {
    const claimed = [];
    const cutoff = now.getTime() - STALE_CLAIM_MINUTES * 60000;
    const candidates = Array.from(store.mem.requests.values())
      .filter((r) => r.status === "PENDING" || (r.status === "RUNNING" && new Date(r.claimedAt).getTime() < cutoff))
      .sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)))
      .slice(0, take);
    for (const r of candidates) {
      r.status = "RUNNING";
      r.claimedAt = now.toISOString();
      r.attempts += 1;
      claimed.push(mapRequest({ ...r }));
    }
    return claimed;
  }

  const req = await store.request();
  const result = await req
    .input("take", sql.Int, take)
    .input("claimed_at", sql.DateTime2, now)
    .input("stale_minutes", sql.Int, STALE_CLAIM_MINUTES)
    .query(`
      WITH next AS (
        SELECT TOP (@take) *
        FROM inventory.recalculation_requests WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE status = N'PENDING'
           OR (status = N'RUNNING' AND claimed_at < DATEADD(minute, -@stale_minutes, SYSUTCDATETIME()))
        ORDER BY requested_at
      )
      UPDATE next
      SET status = N'RUNNING', claimed_at = @claimed_at, attempts = attempts + 1
      OUTPUT ${OUTPUT_COLUMNS};
    `);
  return result.recordset.map(mapRequest);
}

async function finishRequests(requestIds, { status = "PROCESSED", scanRunId = null, error = null } = {}) {
  if (!requestIds.length) return;
  const now = new Date();
  if (store.isTestMode()) {
    for (const id of requestIds) {
      const r = store.mem.requests.get(id);
      if (r) { r.status = status; r.processedAt = now.toISOString(); r.scanRunId = scanRunId; r.lastError = store.clip(error, 500); }
    }
    return;
  }
  for (const id of requestIds) {
    const req = await store.request();
    await req
      .input("request_id", sql.UniqueIdentifier, id)
      .input("status", sql.NVarChar(20), status)
      .input("processed_at", sql.DateTime2, now)
      .input("scan_run_id", sql.UniqueIdentifier, scanRunId)
      .input("last_error", sql.NVarChar(500), store.clip(error, 500))
      .query(`
        UPDATE inventory.recalculation_requests
        SET status = @status, processed_at = @processed_at, scan_run_id = @scan_run_id, last_error = @last_error
        WHERE request_id = @request_id;
      `);
  }
}

async function listRequests({ status = null, limit = 50 } = {}) {
  const take = Math.max(1, Math.min(200, Number(limit) || 50));
  if (store.isTestMode()) {
    let list = Array.from(store.mem.requests.values());
    if (status) list = list.filter((r) => r.status === status);
    list.sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
    return list.slice(0, take).map((r) => mapRequest({ ...r }));
  }
  const req = await store.request();
  req.input("take", sql.Int, take);
  let where = "1 = 1";
  if (status) { req.input("status", sql.NVarChar(20), status); where += " AND status = @status"; }
  const result = await req.query(`
    SELECT TOP (@take) ${REQUEST_COLUMNS}
    FROM inventory.recalculation_requests
    WHERE ${where}
    ORDER BY requested_at DESC;
  `);
  return result.recordset.map(mapRequest);
}

function clearFallbackRequests() {
  store.mem.requests.clear();
}

module.exports = {
  EVENT_TYPES,
  FULL_SCAN_TYPES,
  enqueueRecalculation,
  claimRequests,
  finishRequests,
  listRequests,
  clearFallbackRequests
};
