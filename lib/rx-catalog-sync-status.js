const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TASK_NAME = 'OptiLens RX Alias Catalog Sync';
const LOG_FILE = path.join(__dirname, '..', 'data', 'logs', 'rx-catalog-sync.jsonl');
const TASK_MARKER_FILE = path.join(__dirname, '..', 'data', 'logs', 'rx-catalog-sync-task.json');
const DEFAULT_INTERVAL_MINUTES = Number(process.env.OPTILENS_RX_SYNC_INTERVAL_MINUTES || 1440);

function queryTask(taskName = TASK_NAME) {
  if (process.platform !== 'win32') return null;
  try {
    const output = execFileSync('schtasks.exe', ['/Query', '/TN', taskName, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    if (!output) return null;
    const fields = output.split(/\r?\n/)[0].match(/("(?:[^"]|"")*"|[^,]*)/g) || [];
    const clean = fields.filter(Boolean).map((field) => field.startsWith('"') ? field.slice(1, -1).replace(/""/g, '"') : field);
    return { name: taskName, nextRun: clean[1] || null, state: clean[2] || null };
  } catch { return null; }
}

function readRecent() {
  try { return fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean).slice(-50).map((line) => JSON.parse(line)); } catch { return []; }
}

function readTaskMarker() {
  try { return JSON.parse(fs.readFileSync(TASK_MARKER_FILE, 'utf8')); } catch { return null; }
}

function getRxCatalogSyncStatus({ taskReader = queryTask, recentReader = readRecent, now = new Date(), intervalMinutes = DEFAULT_INTERVAL_MINUTES } = {}) {
  const task = taskReader() || readTaskMarker();
  const recent = recentReader();
  const lastRun = [...recent].reverse().find((event) => event.event === 'sync.finished' || event.event === 'sync.failed') || null;
  const lastRunAt = lastRun?.at || null;
  const age = lastRunAt ? Math.max(0, Math.round((now.getTime() - new Date(lastRunAt).getTime()) / 60000)) : null;
  const expected = Number(intervalMinutes) > 0 ? Number(intervalMinutes) : DEFAULT_INTERVAL_MINUTES;
  const ok = lastRun?.event === 'sync.finished' && !!lastRun.ok;
  if (!task) return { name: 'RX alias catalog sync', state: 'warning', detail: 'Not scheduled — install the OptiLens RX Alias Catalog Sync task.', task: null, lastRun: lastRunAt, lastRunOk: ok, lastRunAgeMinutes: age };
  if (lastRun?.event === 'sync.failed' || (lastRun && !ok)) return { name: 'RX alias catalog sync', state: 'error', detail: `Scheduled task ${task.state || 'registered'}; last sync failed at ${lastRunAt || 'unknown time'}.`, task, lastRun: lastRunAt, lastRunOk: false, lastRunAgeMinutes: age };
  if (age != null && age > expected * 2) return { name: 'RX alias catalog sync', state: 'warning', detail: `Scheduled task ${task.state || 'registered'}; last successful sync is stale (${age} minutes old, expected every ${expected} minutes).`, task, lastRun: lastRunAt, lastRunOk: true, lastRunAgeMinutes: age };
  return { name: 'RX alias catalog sync', state: 'online', detail: lastRunAt ? `Scheduled task ${task.state || 'registered'}; last sync succeeded at ${lastRunAt}.` : `Scheduled task ${task.state || 'registered'}; no completed sync recorded yet.`, task, lastRun: lastRunAt, lastRunOk: lastRun ? ok : null, lastRunAgeMinutes: age };
}

module.exports = { TASK_NAME, LOG_FILE, TASK_MARKER_FILE, getRxCatalogSyncStatus };
