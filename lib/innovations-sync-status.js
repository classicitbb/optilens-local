const { execFileSync } = require('node:child_process');
const syncLog = require('./innovations-sync-log');

const FULL_SYNC_TASK = 'OptiLens Innovations Sync';
const REQUEST_SYNC_TASK = 'OptiLens Innovations Sync Requests';

function queryTask(taskName) {
  if (process.platform !== 'win32') return null;
  try {
    const output = execFileSync('schtasks.exe', ['/Query', '/TN', taskName, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    if (!output) return null;
    const fields = parseCsvRow(output.split(/\r?\n/)[0]);
    return { name: taskName, nextRun: fields[1] || null, state: fields[2] || null };
  } catch {
    return null;
  }
}

function parseCsvRow(line) {
  const fields = [];
  const pattern = /("(?:[^"]|"")*"|[^,]*)(?:,|$)/g;
  let match;
  while ((match = pattern.exec(line)) && match[0]) {
    const value = match[1] || '';
    fields.push(value.startsWith('"') && value.endsWith('"')
      ? value.slice(1, -1).replace(/""/g, '"')
      : value);
    if (pattern.lastIndex >= line.length) break;
  }
  return fields;
}

function getInnovationsSyncStatus({ taskReader = queryTask, recentReader = syncLog.readRecent } = {}) {
  const task = taskReader(FULL_SYNC_TASK);
  const requestTask = taskReader(REQUEST_SYNC_TASK);
  const recent = recentReader(50);
  const finished = [...recent].reverse().find((event) => event.event === 'sync.finished');
  const lastRun = finished?.at || null;
  const lastRunOk = finished ? !!finished.ok : null;

  if (!task) {
    return {
      name: 'Innovations → Classic Visions sync',
      state: 'warning',
      detail: lastRun
        ? `Manual-only; last run ${lastRunOk ? 'succeeded' : 'failed'} at ${lastRun}. Scheduled task is not installed.`
        : 'Not scheduled — install the OptiLens Innovations Sync task for automatic cloud pushes.',
      task: null,
      requestTask,
      lastRun,
      lastRunOk,
    };
  }

  if (lastRunOk === false) {
    return {
      name: 'Innovations → Classic Visions sync',
      state: 'error',
      detail: `Scheduled task ${task.state || 'registered'}; last sync failed at ${lastRun || 'unknown time'}.`,
      task,
      requestTask,
      lastRun,
      lastRunOk,
    };
  }

  return {
    name: 'Innovations → Classic Visions sync',
    state: 'online',
    detail: lastRunOk === true
      ? `Scheduled task ${task.state || 'registered'}; last sync succeeded at ${lastRun}.`
      : `Scheduled task ${task.state || 'registered'}; no completed sync recorded yet.`,
    task,
    requestTask,
    lastRun,
    lastRunOk,
  };
}

module.exports = { FULL_SYNC_TASK, REQUEST_SYNC_TASK, getInnovationsSyncStatus, parseCsvRow };
