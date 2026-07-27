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
