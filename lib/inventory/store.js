/**
 * Persistence plumbing shared by the Inventory Intelligence services.
 *
 * Two backends exist, selected explicitly and never by failure:
 *   - production: the private app database (`inventory.*` tables);
 *   - test mode:  an in-memory model used only by automated tests.
 *
 * A database error is never swallowed into the in-memory model. If the app
 * database cannot be reached the operation fails with a safe "unavailable"
 * error, so a recommendation, approval or audit record can never appear to
 * succeed while existing only in process memory.
 */

const db = require("../db");
const { unavailable } = require("./errors");

let testMode = false;

function setTestMode(enabled) {
  testMode = Boolean(enabled);
}

function isTestMode() {
  return testMode;
}

function freshMemory() {
  return {
    settings: [],
    recommendations: new Map(),
    tasks: new Map(),
    taskHistory: [],
    audit: [],
    scans: new Map(),
    confidence: [],
    counts: [],
    requests: new Map(),
    idempotency: new Map(),
    sequence: 0
  };
}

const mem = freshMemory();

function resetMemory() {
  const fresh = freshMemory();
  for (const key of Object.keys(fresh)) mem[key] = fresh[key];
}

function nextSequence() {
  mem.sequence += 1;
  return mem.sequence;
}

async function getPool() {
  try {
    return await db.getAppPool();
  } catch (error) {
    const wrapped = unavailable();
    wrapped.cause = error;
    throw wrapped;
  }
}

/** A request bound to the open transaction, or to the pool when there is none. */
async function request(tx) {
  if (tx) return tx.request();
  const pool = await getPool();
  return pool.request();
}

/**
 * Runs fn inside one database transaction (or, in test mode, an in-memory
 * unit of work that is rolled back if fn throws).
 */
async function withTransaction(fn) {
  if (testMode) {
    const snapshot = structuredClone(mem);
    try {
      return await fn(null);
    } catch (error) {
      for (const key of Object.keys(snapshot)) mem[key] = snapshot[key];
      throw error;
    }
  }

  const pool = await getPool();
  const tx = pool.transaction();
  await tx.begin();
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (error) {
    try { await tx.rollback(); } catch { /* the original error is the one that matters */ }
    throw error;
  }
}

/** Truncates a value to a column length so a long note cannot fail an audit insert. */
function clip(value, length) {
  if (value == null) return null;
  const text = String(value);
  return text.length > length ? text.slice(0, length) : text;
}

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseJson(text, fallback = null) {
  if (text == null || text === "") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

module.exports = {
  mem,
  setTestMode,
  isTestMode,
  resetMemory,
  nextSequence,
  getPool,
  request,
  withTransaction,
  clip,
  toIso,
  parseJson
};
