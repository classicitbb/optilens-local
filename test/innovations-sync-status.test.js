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
