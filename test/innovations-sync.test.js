const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { normalizeEntitySelection, reconcileLensAliasRecords, acquireSyncLock } = require('../lib/innovations-sync');

// A pid that is guaranteed not to be running: spawn a trivial process and
// let it exit before using its (now-free) pid.
function deadPid() {
  const result = spawnSync(process.execPath, ['-e', '0']);
  return result.pid;
}

test('default Innovations cloud sync excludes catalog entities that require explicit rollout', () => {
  assert.deepEqual(normalizeEntitySelection(), [
    'banks',
    'customers',
    'contacts',
    'balances',
    'order_activity',
    'statements',
    'statement_lines',
    'lens_aliases',
  ]);
});

test('explicit Innovations cloud sync selection can still request catalog entities', () => {
  assert.deepEqual(normalizeEntitySelection(['store_lens_power_rows', 'supplies']), [
    'supplies',
    'store_lens_power_rows',
  ]);
});

test('lens alias reconciliation deactivates only aliases removed from the source snapshot', () => {
  const active = [
    { alias: '0010100100001', is_active: true },
    { alias: '0010100100003', is_active: true },
  ];
  const result = reconcileLensAliasRecords(active, new Set(['0010100100001', '0010100100002']));

  assert.deepEqual(result.records.map((record) => ({ alias: record.alias, is_active: record.is_active })), [
    { alias: '0010100100001', is_active: true },
    { alias: '0010100100003', is_active: true },
    { alias: '0010100100002', is_active: false },
  ]);
  assert.deepEqual(result.deletedRecords.map((record) => Object.keys(record).sort()), [
    ['alias', 'is_active', 'synced_at'],
  ]);
  assert.equal(result.deletedRecords[0].alias, '0010100100002');
  assert.equal(result.deletedRecords[0].is_active, false);
  assert.ok(Number.isFinite(Date.parse(result.deletedRecords[0].synced_at)));
  assert.deepEqual([...result.currentAliases], ['0010100100001', '0010100100003']);
});

test('acquireSyncLock reclaims a lock left by a process that is no longer running', () => {
  const lockFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-')), 'innovations-cloud-sync.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid(), at: new Date().toISOString() }));

  // Fresh (well under any staleMs), but the holder pid is dead: must reclaim now, not wait out staleMs.
  const lock = acquireSyncLock({ lockFile, staleMs: 3 * 60 * 60 * 1000 });
  assert.equal(lock.acquired, true);
  lock.release();
  assert.equal(fs.existsSync(lockFile), false);
});

test('acquireSyncLock still defers to a fresh lock held by a live process', () => {
  const lockFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-')), 'innovations-cloud-sync.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));

  const lock = acquireSyncLock({ lockFile, staleMs: 3 * 60 * 60 * 1000 });
  assert.equal(lock.acquired, false);
  assert.equal(lock.holderPid, process.pid);
});
