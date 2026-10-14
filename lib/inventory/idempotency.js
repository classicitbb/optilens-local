/**
 * Request idempotency for Inventory Intelligence mutations.
 *
 * A caller sends an `Idempotency-Key` header. The first request with a key runs;
 * a repeat with the same key (a double click, a network retry) gets the stored
 * result instead of running again. The key is also the correlation id on every
 * audit record the request writes, so a user action can be traced end to end.
 *
 * A failed request releases its key so it can be retried.
 */

const sql = require("mssql");
const store = require("./store");
const { runWithAuditContext } = require("./audit-service");
const { badRequest, conflict } = require("./errors");

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,120}$/;
const IN_PROGRESS_SECONDS = 120;

function validateKey(key) {
  if (key == null || key === "") return null;
  const text = String(key).trim();
  if (!KEY_PATTERN.test(text)) {
    throw badRequest("The Idempotency-Key header must be 8-120 characters (letters, digits, . _ : -).");
  }
  return text;
}

async function readKey(key) {
  if (store.isTestMode()) {
    const row = store.mem.idempotency.get(key);
    return row ? { ...row } : null;
  }
  const req = await store.request();
  const result = await req.input("key", sql.NVarChar(120), key).query(`
    SELECT idempotency_key AS idempotencyKey, operation, actor, state, response_json AS responseJson, created_at AS createdAt
    FROM inventory.idempotency_keys WHERE idempotency_key = @key;
  `);
  const row = result.recordset[0];
  return row ? { ...row, createdAt: store.toIso(row.createdAt) } : null;
}

async function claimKey(key, operation, actor) {
  const now = new Date();
  if (store.isTestMode()) {
    if (store.mem.idempotency.has(key)) return false;
    store.mem.idempotency.set(key, { idempotencyKey: key, operation, actor, state: "IN_PROGRESS", responseJson: null, createdAt: now.toISOString() });
    return true;
  }
  try {
    const req = await store.request();
    await req
      .input("key", sql.NVarChar(120), key)
      .input("operation", sql.NVarChar(120), store.clip(operation, 120))
      .input("actor", sql.NVarChar(120), store.clip(actor, 120))
      .input("created_at", sql.DateTime2, now)
      .query(`
        INSERT INTO inventory.idempotency_keys (idempotency_key, operation, actor, state, created_at)
        VALUES (@key, @operation, @actor, N'IN_PROGRESS', @created_at);
      `);
    return true;
  } catch (error) {
    if (error && (error.number === 2601 || error.number === 2627)) return false;
    throw error;
  }
}

async function finishKey(key, response) {
  const json = JSON.stringify(response === undefined ? null : response);
  if (store.isTestMode()) {
    const row = store.mem.idempotency.get(key);
    if (row) { row.state = "DONE"; row.responseJson = json; }
    return;
  }
  const req = await store.request();
  await req
    .input("key", sql.NVarChar(120), key)
    .input("response_json", sql.NVarChar(sql.MAX), json)
    .query(`UPDATE inventory.idempotency_keys SET state = N'DONE', response_json = @response_json WHERE idempotency_key = @key;`);
}

async function releaseKey(key) {
  if (store.isTestMode()) { store.mem.idempotency.delete(key); return; }
  const req = await store.request();
  await req.input("key", sql.NVarChar(120), key).query(`DELETE FROM inventory.idempotency_keys WHERE idempotency_key = @key AND state = N'IN_PROGRESS';`);
}

/**
 * Runs `fn` once per key. Without a key it simply runs (still inside an audit
 * context). Returns { result, replayed }.
 */
async function runIdempotent({ key, operation, actor, fn }) {
  const idempotencyKey = validateKey(key);
  if (!idempotencyKey) {
    return { result: await fn(), replayed: false };
  }

  const claimed = await claimKey(idempotencyKey, operation, actor);
  if (!claimed) {
    const existing = await readKey(idempotencyKey);
    if (existing && (existing.operation !== operation || existing.actor !== actor)) {
      throw conflict("That Idempotency-Key was already used for a different request.", "IDEMPOTENCY_KEY_REUSED");
    }
    if (existing && existing.state === "DONE") {
      return { result: store.parseJson(existing.responseJson), replayed: true };
    }
    const ageSeconds = existing ? (Date.now() - new Date(existing.createdAt).getTime()) / 1000 : 0;
    if (ageSeconds < IN_PROGRESS_SECONDS) {
      throw conflict("This request is already being processed.", "IN_PROGRESS");
    }
    // The previous attempt died without finishing; take the key over.
    await releaseKey(idempotencyKey);
    if (!(await claimKey(idempotencyKey, operation, actor))) {
      throw conflict("This request is already being processed.", "IN_PROGRESS");
    }
  }

  try {
    const result = await runWithAuditContext({ correlationId: idempotencyKey, actor }, fn);
    await finishKey(idempotencyKey, result);
    return { result, replayed: false };
  } catch (error) {
    await releaseKey(idempotencyKey).catch(() => {});
    throw error;
  }
}

function clearFallbackIdempotency() {
  store.mem.idempotency.clear();
}

module.exports = { validateKey, runIdempotent, clearFallbackIdempotency };
