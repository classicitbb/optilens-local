/**
 * zen-mirror-worker.js — schedules the Zen → innovations_mirror sync.
 *
 * Enabled when OPTILENS_MIRROR_SYNC_MINUTES > 0 (default 15) and the host has
 * the odbc module + Zen credentials. Safe to start unconditionally: it no-ops
 * with a clear status when the prerequisites are missing.
 */
const { getConfig } = require("./config");
const zen = require("./zen-source");
const { runMirrorSync, getMirrorSyncState } = require("./zen-mirror-sync");

let timer = null;
let retryTimer = null;
let activeRun = null;
let consecutiveFailures = 0;
let state = {
  enabled: false,
  intervalMinutes: 0,
  startedAt: null,
  lastRunAt: null,
  lastOk: null,
  lastError: null,
  nextRetryAt: null,
  consecutiveFailures: 0,
  detail: "Not started."
};

async function runOnce({ full = false } = {}) {
  state.lastRunAt = new Date().toISOString();
  try {
    const summary = await runMirrorSync({ full });
    if (summary.skipped) {
      state.detail = summary.reason;
      return summary;
    }
    state.lastOk = summary.ok;
    state.lastError = summary.ok ? null : summary.tables.filter((t) => t.error).map((t) => `${t.table}: ${t.error}`).join("; ");
    state.detail = summary.ok
      ? `Synced ${summary.tables.length} tables (${summary.tables.reduce((n, t) => n + (t.rows || 0), 0)} rows pulled).`
      : `Finished with errors: ${state.lastError}`;
    return summary;
  } catch (error) {
    state.lastOk = false;
    state.lastError = error.message;
    state.detail = `Sync failed: ${error.message}`;
    throw error;
  }
}

function runWithRecovery() {
  if (activeRun) return activeRun;

  activeRun = runOnce()
    .then((summary) => {
      if (!summary.skipped && !summary.ok) {
        throw new Error(summary.error || state.lastError || "Zen mirror sync did not complete successfully.");
      }
      consecutiveFailures = 0;
      state = { ...state, consecutiveFailures, nextRetryAt: null };
      return summary;
    })
    .catch((error) => {
      consecutiveFailures += 1;
      const retryDelayMs = Math.min(60000, 5000 * (2 ** Math.min(consecutiveFailures - 1, 4)));
      const retryAt = new Date(Date.now() + retryDelayMs).toISOString();
      state = { ...state, consecutiveFailures, nextRetryAt: retryAt };

      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        runWithRecovery().catch(() => {});
      }, retryDelayMs);
      retryTimer.unref();
      return { ok: false, error: error.message, retryAt };
    })
    .finally(() => {
      activeRun = null;
    });

  return activeRun;
}

function startManual({ full = false } = {}) {
  if (activeRun) {
    return { started: false, running: true, detail: "A mirror sync is already running.", worker: state };
  }
  activeRun = runOnce({ full })
    .finally(() => {
      activeRun = null;
    });
  activeRun.catch(() => {});
  return { started: true, running: true, full, worker: state };
}

function start() {
  const minutes = getConfig().sourceMirror.syncMinutes;

  if (!(minutes > 0)) {
    state = { ...state, enabled: false, intervalMinutes: 0, detail: "Disabled (OPTILENS_MIRROR_SYNC_MINUTES=0)." };
    return state;
  }
  if (!zen.isAvailable()) {
    state = { ...state, enabled: false, intervalMinutes: minutes, detail: "Zen source unavailable on this host (odbc module or credentials missing)." };
    return state;
  }
  if (timer) return state;

  state = { ...state, enabled: true, intervalMinutes: minutes, startedAt: new Date().toISOString(), detail: "Scheduled." };
  timer = setInterval(() => {
    runWithRecovery().catch(() => {});
  }, minutes * 60 * 1000);
  timer.unref();

  // Kick off an initial pass shortly after startup rather than waiting a full interval.
  setTimeout(() => {
    runWithRecovery().catch(() => {});
  }, 15 * 1000).unref();

  return state;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  consecutiveFailures = 0;
  state = { ...state, enabled: false, detail: "Stopped." };
  return state;
}

async function status() {
  let syncState = null;
  try {
    syncState = await getMirrorSyncState();
  } catch (error) {
    syncState = { error: error.message };
  }
  return { worker: state, sync: syncState };
}

module.exports = { runOnce, start, status, stop, startManual };
