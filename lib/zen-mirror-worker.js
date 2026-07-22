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
let state = {
  enabled: false,
  intervalMinutes: 0,
  startedAt: null,
  lastRunAt: null,
  lastOk: null,
  lastError: null,
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
    runOnce().catch(() => {});
  }, minutes * 60 * 1000);
  timer.unref();

  // Kick off an initial pass shortly after startup rather than waiting a full interval.
  setTimeout(() => {
    runOnce().catch(() => {});
  }, 15 * 1000).unref();

  return state;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
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

module.exports = { runOnce, start, status, stop };
