const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const delta = require('../lib/innovations-sync-delta');
const { createSyncWorker, dueTier, lastNightlySlot, TIERS } = require('../lib/innovations-sync-worker');

test('delta sends only new or changed rows and ignores sync timestamps', () => {
  const first = delta.filterChanged([{ id: 1, name: 'A', synced_at: 't1' }, { id: 2, name: 'B', synced_at: 't1' }], 'id', {});
  assert.equal(first.changed.length, 2);
  const second = delta.filterChanged([{ id: 1, name: 'A', synced_at: 't2' }, { id: 2, name: 'B2', synced_at: 't2' }, { id: 3, name: 'C' }], 'id', first.next);
  assert.deepEqual(second.changed.map((r) => r.id), [2, 3]);
  assert.equal(second.unchanged, 1);
  const full = delta.filterChanged([{ id: 1, name: 'A' }], 'id', first.next, { full: true });
  assert.equal(full.changed.length, 1);
});

test('delta fingerprints round-trip through the store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
  delta.save('customers', { 1: 'abc' }, dir);
  assert.deepEqual(delta.load('customers', dir), { 1: 'abc' });
  assert.deepEqual(delta.load('missing', dir), {});
});

test('scheduler: hot first, then warm, then nightly once per night', () => {
  const now = new Date(2026, 10, 12, 3, 0, 0); // Thu 03:00 local
  assert.equal(dueTier({}, now).name, 'hot');
  const recent = new Date(now.getTime() - 60 * 1000).toISOString();
  assert.equal(dueTier({ lastAttempt: { hot: recent } }, now).name, 'warm');
  const nightly = dueTier({ lastAttempt: { hot: recent, warm: recent } }, now);
  assert.equal(nightly.name, 'nightly');
  assert.equal(nightly.full, false);
  const doneTonight = new Date(2026, 10, 12, 2, 5).toISOString();
  assert.equal(dueTier({ lastAttempt: { hot: recent, warm: recent, nightly: doneTonight }, lastSuccess: { nightly: doneTonight } }, now), null);
});

test('scheduler: a failed nightly retries after an hour; Sunday night is a full run', () => {
  const now = new Date(2026, 10, 12, 3, 0, 0);
  const recent = new Date(now.getTime() - 60 * 1000).toISOString();
  const failed30mAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
  assert.equal(dueTier({ lastAttempt: { hot: recent, warm: recent, nightly: failed30mAgo } }, now), null);
  const failed2hAgo = new Date(now.getTime() - 120 * 60 * 1000).toISOString();
  assert.equal(dueTier({ lastAttempt: { hot: recent, warm: recent, nightly: failed2hAgo } }, now).name, 'nightly');
  const sunday = new Date(2026, 10, 15, 2, 30, 0);
  assert.equal(dueTier({ lastAttempt: { hot: sunday.toISOString(), warm: sunday.toISOString() } }, sunday).full, true);
  assert.equal(lastNightlySlot(new Date(2026, 10, 12, 1, 0)).getDate(), 11);
});

test('worker serves website requests before scheduled tiers, with delta on', async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-')), 'state.json');
  const calls = [];
  const requests = [{ id: 'r1', entities: ['customers'] }];
  const completed = [];
  const worker = createSyncWorker({
    stateFile,
    log: () => {},
    loadCredentials: () => ({ apiKey: 'k' }),
    fetchNextRequest: async () => requests.shift() || null,
    completeRequest: async (creds, id, ok) => { completed.push({ id, ok }); },
    sync: async (creds, opts) => { calls.push(opts); return { ok: true }; },
  });
  await worker.tick();
  assert.deepEqual(completed, [{ id: 'r1', ok: true }]);
  assert.deepEqual(calls[0].entities, ['customers']);
  assert.equal(calls[0].deltaMode, true);
  assert.deepEqual(calls[1].entities, TIERS.hot.entities);
  assert.equal(calls[1].commit, true);
  assert.ok(worker.status().lastSuccess.hot);
});

test('worker refuses pricing-mirror-only website requests and still completes them', async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-')), 'state.json');
  const completed = [];
  let served = false;
  const worker = createSyncWorker({
    stateFile, log: () => {}, loadCredentials: () => ({ apiKey: 'k' }),
    fetchNextRequest: async () => (served ? null : (served = true, { id: 'r2', entities: ['inn_labs'] })),
    completeRequest: async (creds, id, ok, result) => { completed.push({ id, ok, error: result.error }); },
    sync: async () => ({ ok: true }),
  });
  await worker.tick();
  assert.equal(completed[0].ok, false);
  assert.match(completed[0].error, /nightly/);
});
