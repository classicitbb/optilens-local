const { execFileSync } = require('node:child_process');
const syncLog = require('./innovations-sync-log');

const FULL_SYNC_TASK = 'OptiLens Innovations Sync';
const REQUEST_SYNC_TASK = 'OptiLens Innovations Sync Requests';
const DEFAULT_INTERVAL_MINUTES = Number(process.env.OPTILENS_SYNC_INTERVAL_MINUTES ?? 60);

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

function syncAgeMinutes(lastRun, now = new Date()) {
  if (!lastRun) return null;
  const at = new Date(lastRun);
  if (Number.isNaN(at.getTime())) return null;
  return Math.max(0, Math.round((now.getTime() - at.getTime()) / 60000));
}

function appendRequestTaskDetail(detail, requestTask) {
  if (requestTask) return detail;
  return `${detail} Request poller task is not installed; CV Web "Sync now" requests will stay pending.`;
}

function getWorkerSyncStatus(worker, now) {
  const lastRun = worker.lastSuccess?.hot || null;
  const lastRunAgeMinutes = syncAgeMinutes(lastRun, now);
  const failedTier = ['hot', 'warm', 'nightly'].find((tier) => {
    const attempt = worker.lastAttempt?.[tier];
    return attempt && attempt > (worker.lastSuccess?.[tier] || '') && worker.current?.job !== tier;
  });
  const intervalMinutes = (worker.tiers?.hot?.everyMs || 120000) / 60000;
  const detail = ['In-service sync worker is running.'];
  let state = 'online';
  if (worker.lastError) {
    state = 'error';
    detail.push('The worker reported an error. See sync logs.');
  } else if (failedTier) {
    state = 'error';
    detail.push(`The last ${failedTier} tier run did not succeed.`);
  } else if (lastRunAgeMinutes === null || lastRunAgeMinutes > intervalMinutes * 2) {
    state = 'warning';
    detail.push(lastRunAgeMinutes === null
      ? 'Waiting for the first successful hot sync.'
      : `Hot sync is delayed (${lastRunAgeMinutes} minutes since success).`);
  }
  if (lastRun) detail.push(`Last hot sync succeeded at ${lastRun}.`);
  if (worker.current?.job) detail.push(`Currently running: ${worker.current.job}.`);
  return {
    name: 'Innovations → Classic Visions sync',
    state,
    detail: detail.join(' '),
    mode: 'worker',
    lastRun,
    lastRunAgeMinutes,
    lastRunOk: lastRun ? failedTier !== 'hot' : null,
  };
}

function getInnovationsSyncStatus({
  workerStatus,
  taskReader = queryTask,
  recentReader = syncLog.readRecent,
  now = new Date(),
  intervalMinutes = DEFAULT_INTERVAL_MINUTES,
} = {}) {
  if (workerStatus?.running) return getWorkerSyncStatus(workerStatus, now);

  const task = taskReader(FULL_SYNC_TASK);
  const requestTask = taskReader(REQUEST_SYNC_TASK);
  const recent = recentReader(50);
  const finished = [...recent].reverse().find((event) => event.event === 'sync.finished');
  const lastRun = finished?.at || null;
  const lastRunOk = finished ? !!finished.ok : null;
  const lastRunAgeMinutes = syncAgeMinutes(lastRun, now);
  const expectedInterval = Number(intervalMinutes) > 0 ? Number(intervalMinutes) : DEFAULT_INTERVAL_MINUTES;
  const warningMinutes = expectedInterval * 2;
  const errorMinutes = expectedInterval * 4;

  if (!task) {
    return {
      name: 'Innovations → Classic Visions sync',
      state: 'warning',
      detail: appendRequestTaskDetail(lastRun
        ? `Manual-only; last run ${lastRunOk ? 'succeeded' : 'failed'} at ${lastRun}. Scheduled task is not installed.`
        : 'Not scheduled — install the OptiLens Innovations Sync task for automatic cloud pushes.', requestTask),
      task: null,
      requestTask,
      lastRun,
      lastRunAgeMinutes,
      lastRunOk,
    };
  }

  if (lastRunOk === false) {
    return {
      name: 'Innovations → Classic Visions sync',
      state: 'error',
      detail: appendRequestTaskDetail(`Scheduled task ${task.state || 'registered'}; last sync failed at ${lastRun || 'unknown time'}.`, requestTask),
      task,
      requestTask,
      lastRun,
      lastRunAgeMinutes,
      lastRunOk,
    };
  }

  if (lastRunOk === true && lastRunAgeMinutes != null && lastRunAgeMinutes > errorMinutes) {
    return {
      name: 'Innovations → Classic Visions sync',
      state: 'error',
      detail: appendRequestTaskDetail(`Scheduled task ${task.state || 'registered'}; last successful sync is stale (${lastRunAgeMinutes} minutes old, expected every ${expectedInterval} minutes).`, requestTask),
      task,
      requestTask,
      lastRun,
      lastRunAgeMinutes,
      lastRunOk,
    };
  }

  if (lastRunOk === true && lastRunAgeMinutes != null && lastRunAgeMinutes > warningMinutes) {
    return {
      name: 'Innovations → Classic Visions sync',
      state: 'warning',
      detail: appendRequestTaskDetail(`Scheduled task ${task.state || 'registered'}; last successful sync is delayed (${lastRunAgeMinutes} minutes old, expected every ${expectedInterval} minutes).`, requestTask),
      task,
      requestTask,
      lastRun,
      lastRunAgeMinutes,
      lastRunOk,
    };
  }

  return {
    name: 'Innovations → Classic Visions sync',
    state: 'online',
    detail: appendRequestTaskDetail(lastRunOk === true
      ? `Scheduled task ${task.state || 'registered'}; last sync succeeded at ${lastRun}.`
      : `Scheduled task ${task.state || 'registered'}; no completed sync recorded yet.`, requestTask),
    task,
    requestTask,
    lastRun,
    lastRunAgeMinutes,
    lastRunOk,
  };
}

module.exports = { FULL_SYNC_TASK, REQUEST_SYNC_TASK, getInnovationsSyncStatus, parseCsvRow, syncAgeMinutes, appendRequestTaskDetail };
