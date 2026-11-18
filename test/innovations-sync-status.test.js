const test = require('node:test');
const assert = require('node:assert/strict');
const { getInnovationsSyncStatus, parseCsvRow } = require('../lib/innovations-sync-status');

test('sync status reports when automatic Innovations to Classic Visions scheduling is missing', () => {
  assert.deepEqual(parseCsvRow('"Task","7/27/2026 1:00:00 PM","Ready"'), [
    'Task', '7/27/2026 1:00:00 PM', 'Ready',
  ]);

  const status = getInnovationsSyncStatus({
    taskReader: () => null,
    recentReader: () => [],
  });

  assert.equal(status.name, 'Innovations → Classic Visions sync');
  assert.equal(status.state, 'warning');
  assert.match(status.detail, /Not scheduled/);
});

test('sync status surfaces the latest failed run when the task is registered', () => {
  const status = getInnovationsSyncStatus({
    taskReader: (name) => name === 'OptiLens Innovations Sync' ? { state: 'Ready' } : null,
    recentReader: () => [{ event: 'sync.finished', at: '2026-07-27T16:00:00.000Z', ok: false }],
  });

  assert.equal(status.state, 'error');
  assert.match(status.detail, /last sync failed/);
  assert.match(status.detail, /Sync now/);
});

test('sync status does not warn about Sync now when the request poller is registered', () => {
  const status = getInnovationsSyncStatus({
    taskReader: (name) => name === 'OptiLens Innovations Sync'
      ? { state: 'Ready' }
      : { state: 'Ready' },
    recentReader: () => [{ event: 'sync.finished', at: '2026-07-27T16:00:00.000Z', ok: true }],
    now: new Date('2026-07-27T16:10:00.000Z'),
  });

  assert.equal(status.state, 'online');
  assert.doesNotMatch(status.detail, /Sync now/);
  assert.equal(status.requestTask.state, 'Ready');
});

test('sync status warns and errors when the latest successful run is stale', () => {
  const taskReader = (name) => name === 'OptiLens Innovations Sync' ? { state: 'Ready' } : null;
  const recentReader = () => [{ event: 'sync.finished', at: '2026-07-27T12:00:00.000Z', ok: true }];

  const warning = getInnovationsSyncStatus({
    taskReader,
    recentReader,
    now: new Date('2026-07-27T14:30:00.000Z'),
    intervalMinutes: 60,
  });
  assert.equal(warning.state, 'warning');
  assert.equal(warning.lastRunAgeMinutes, 150);
  assert.match(warning.detail, /delayed/);

  const error = getInnovationsSyncStatus({
    taskReader,
    recentReader,
    now: new Date('2026-07-27T16:30:00.000Z'),
    intervalMinutes: 60,
  });
  assert.equal(error.state, 'error');
  assert.equal(error.lastRunAgeMinutes, 270);
  assert.match(error.detail, /stale/);
});

test('live Innovations worker supersedes the retired Windows tasks', () => {
  const now = new Date('2026-07-27T16:00:00.000Z');
  const lastHot = '2026-07-27T15:58:00.000Z';
  const status = getInnovationsSyncStatus({
    now,
    workerStatus: { running: true, lastSuccess: { hot: lastHot } },
    taskReader: () => assert.fail('Worker installations do not use Windows tasks'),
  });
  assert.equal(status.state, 'online');
  assert.equal(status.mode, 'worker');
  assert.equal(status.lastRun, lastHot);
  assert.doesNotMatch(status.detail, /task is not installed/);
});

test('worker failures and delayed hot syncs are visible', () => {
  const now = new Date('2026-07-27T16:00:00.000Z');
  const lastSuccess = { hot: '2026-07-27T15:40:00.000Z' };
  const check = (fields) => getInnovationsSyncStatus({
    now, workerStatus: { running: true, lastSuccess, ...fields },
  });
  assert.equal(check({}).state, 'warning');
  assert.equal(check({ lastAttempt: { warm: '2026-07-27T15:59:00.000Z' } }).state, 'error');
  const failure = check({ lastError: { message: 'internal error detail' } });
  assert.equal(failure.state, 'error');
  assert.doesNotMatch(failure.detail, /internal error detail/);
});
