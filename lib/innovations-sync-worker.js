/**
 * innovations-sync-worker.js — the always-on office sync (replaces the
 * "OptiLens Innovations Sync" and "OptiLens Innovations Sync Requests" scheduled tasks).
 *
 * Runs inside the OptiLens Local service, so the existing watchdog restarts it.
 * One job at a time, highest priority first:
 *   1. website "Sync now" requests      checked every 30 seconds
 *   2. hot tier                          every 2 minutes
 *   3. warm tier                         every 15 minutes
 *   4. nightly tier                      once a night (default 02:00 host time)
 * Hot/warm/nightly send only changed rows (innovations-sync-delta.js). The nightly
 * run on the weekly full day resends everything and re-baselines fingerprints.
 *
 * Enable with OPTILENS_SYNC_WORKER=on (the service also needs OPTILENS_SYNC_PASSPHRASE,
 * or OPTILENS_SYNC_USE_CREDENTIAL_VAULT=true, to read the CV API key unattended).
 */
const fs = require('node:fs');
const path = require('node:path');
const innovationsSync = require('./innovations-sync');
const pricingMirror = require('./innovations-pricing-mirror');
const syncLog = require('./innovations-sync-log');

const MINUTE = 60 * 1000;
const TICK_MS = 30 * 1000;
const STATE_FILE = process.env.OPTILENS_SYNC_WORKER_STATE_FILE
  || path.join(__dirname, '..', 'data', 'sync-worker-state.json');

// customers rides in the hot tier so a new account lands before its first
// balance/statement (the receiver resolves those against synced customers).
const TIERS = {
  hot: { everyMs: 2 * MINUTE, entities: ['customers', 'balances', 'order_activity', 'statements', 'statement_lines'] },
  warm: { everyMs: 15 * MINUTE, entities: ['banks', 'contacts', 'lens_aliases'] },
  nightly: { entities: ['store_lenses', 'store_lens_power_rows'], mirror: true },
};

function nightlyHour() {
  const hour = Number(process.env.OPTILENS_SYNC_NIGHTLY_HOUR ?? 2);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 2;
}
// 0 = Sunday. The nightly run on this day resends everything (self-heal).
function weeklyFullDay() {
  const day = Number(process.env.OPTILENS_SYNC_WEEKLY_FULL_DAY ?? 0);
  return Number.isInteger(day) && day >= 0 && day <= 6 ? day : 0;
}

function readState(file = STATE_FILE) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
}
function writeState(state, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

// The most recent nightly slot at or before `now` (host local time).
function lastNightlySlot(now, hour = nightlyHour()) {
  const slot = new Date(now);
  slot.setHours(hour, 0, 0, 0);
  if (slot > now) slot.setDate(slot.getDate() - 1);
  return slot;
}

/** Which tier is due next, or null. Pure, for tests. */
function dueTier(state, now = new Date()) {
  const last = state.lastSuccess || {};
  const lastAttempt = state.lastAttempt || {};
  const slot = lastNightlySlot(now);
  // A failed nightly run retries at most hourly until it succeeds for the slot.
  const nightlyDone = last.nightly && new Date(last.nightly) >= slot;
  const nightlyRetryWait = lastAttempt.nightly && now - new Date(lastAttempt.nightly) < 60 * MINUTE;
  for (const name of ['hot', 'warm']) {
    const ran = lastAttempt[name] ? new Date(lastAttempt[name]).getTime() : 0;
    if (now.getTime() - ran >= TIERS[name].everyMs) return { name };
  }
  if (!nightlyDone && !nightlyRetryWait) return { name: 'nightly', full: slot.getDay() === weeklyFullDay() };
  return null;
}

function createSyncWorker({ loadCredentials, sync = innovationsSync.sync, fetchNextRequest = innovationsSync.fetchNextRequest, completeRequest = innovationsSync.completeRequest, stateFile = STATE_FILE, log = syncLog.write } = {}) {
  let timer = null;
  let busy = false;
  let current = null;
  let lastError = null;
  let state = readState(stateFile);

  async function runSync(creds, opts) {
    const lock = innovationsSync.acquireSyncLock();
    if (!lock.acquired) return { ok: false, deferred: true, reason: 'A manual Innovations sync is running.' };
    try { return await sync(creds, { ...opts, commit: true, useLock: false }); } finally { lock.release(); }
  }

  async function serveRequest(creds) {
    const request = await fetchNextRequest(creds);
    if (!request) return false;
    current = { job: 'request', id: request.id, startedAt: new Date().toISOString() };
    log('worker.request.claimed', { requestId: request.id, entities: request.entities || [] });
    const requested = Array.isArray(request.entities) && request.entities.length ? request.entities : undefined;
    const entities = requested ? requested.filter((e) => !pricingMirror.isMirrorEntity(e)) : undefined;
    let result;
    try {
      if (requested && !entities.length) throw new Error('Pricing mirror entities run nightly; they cannot be requested from the website.');
      result = await runSync(creds, { entities, deltaMode: true });
      // Lost the lock to a manual CLI run: report it rather than leave the request claimed.
      if (result.deferred) result = { ok: false, error: result.reason };
    } catch (error) {
      result = { ok: false, error: String(error.message || error) };
    }
    await completeRequest(creds, request.id, Boolean(result.ok), result);
    log('worker.request.finished', { requestId: request.id, ok: Boolean(result.ok) });
    return true;
  }

  async function runTier(creds, tier) {
    const def = TIERS[tier.name];
    current = { job: tier.name, full: Boolean(tier.full), startedAt: new Date().toISOString() };
    state.lastAttempt = { ...(state.lastAttempt || {}), [tier.name]: current.startedAt };
    writeState(state, stateFile);
    // The weekly full night also resends the hot and warm tiers, so website drift heals.
    const entities = tier.full ? [...TIERS.hot.entities, ...TIERS.warm.entities, ...def.entities] : def.entities;
    const result = await runSync(creds, { entities, deltaMode: true, full: Boolean(tier.full) });
    if (result.deferred) { state.lastAttempt[tier.name] = null; writeState(state, stateFile); return; }
    let ok = Boolean(result.ok);
    if (def.mirror) {
      // The mirror is watermark-incremental on its own; the weekly run reads every row.
      const mirror = await runSync(creds, { entities: pricingMirror.MIRROR_ENTITY_NAMES, mirrorFull: Boolean(tier.full) });
      ok = ok && Boolean(mirror.ok);
    }
    if (ok) state.lastSuccess = { ...(state.lastSuccess || {}), [tier.name]: current.startedAt };
    writeState(state, stateFile);
    log('worker.tier.finished', { tier: tier.name, full: Boolean(tier.full), ok });
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const creds = loadCredentials();
      // Drain website requests first; then at most one scheduled tier per tick so
      // a request never waits longer than one tier run.
      while (await serveRequest(creds)) { /* keep serving */ }
      const tier = dueTier(state);
      if (tier) await runTier(creds, tier);
      lastError = null;
    } catch (error) {
      lastError = { at: new Date().toISOString(), message: String(error.message || error) };
      log('worker.error', { error: syncLog.trim(lastError.message) });
    } finally {
      current = null;
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      log('worker.started', { tiers: Object.fromEntries(Object.entries(TIERS).map(([k, v]) => [k, v.entities])), nightlyHour: nightlyHour(), weeklyFullDay: weeklyFullDay() });
      timer = setInterval(() => { tick(); }, TICK_MS);
      timer.unref?.();
      setTimeout(() => { tick(); }, 5000).unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    tick,
    status() {
      return { running: Boolean(timer), busy, current, lastError, lastAttempt: state.lastAttempt || {}, lastSuccess: state.lastSuccess || {}, tiers: TIERS, nightlyHour: nightlyHour(), weeklyFullDay: weeklyFullDay() };
    },
  };
}

module.exports = { createSyncWorker, dueTier, lastNightlySlot, TIERS, STATE_FILE };
