const test = require('node:test');
const assert = require('node:assert/strict');

const { createApprovalJobs } = require('../lib/qbo-approval-jobs');

const settled = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(jobs, id, state = 'finished') {
  for (let i = 0; i < 50; i += 1) { if (jobs.get(id).state !== 'running') break; await settled(); }
  assert.equal(jobs.get(id).state, state);
  return jobs.get(id);
}

test('a batch re-checks then posts each invoice in order and reports every outcome', async () => {
  const calls = [];
  const jobs = createApprovalJobs({
    recheck: async ({ sourceInvoiceIds: [id] }) => { calls.push(`recheck ${id}`); return { results: [{ status: id === '2' ? 'skipped' : 'pending_approval', reason: 'Already reconciled.' }] }; },
    approve: async ({ sourceInvoiceId }) => { calls.push(`approve ${sourceInvoiceId}`); return { status: 'created', qboId: `q${sourceInvoiceId}` }; }
  });
  const started = jobs.start({ sourceInvoiceIds: ['1', '2', '3', '1'], actorUserId: 9 });
  assert.equal(started.total, 3);
  const done = await waitFor(jobs, started.id);
  assert.deepEqual(calls, ['recheck 1', 'approve 1', 'recheck 2', 'recheck 3', 'approve 3']);
  assert.deepEqual(done.items.map((item) => item.status), ['created', 'skipped', 'created']);
  assert.equal(done.items[1].message, 'Already reconciled.');
  assert.equal(done.finished, 3);
});

test('one failure does not stop the batch and marks the job finished with errors', async () => {
  const jobs = createApprovalJobs({
    recheck: async () => ({ results: [{ status: 'pending_approval' }] }),
    approve: async ({ sourceInvoiceId }) => { if (sourceInvoiceId === 'a') throw new Error('QuickBooks said no'); return { status: 'created', qboId: '1' }; }
  });
  const { id } = jobs.start({ sourceInvoiceIds: ['a', 'b'] });
  const done = await waitFor(jobs, id, 'finished_with_errors');
  assert.deepEqual(done.items.map((item) => item.status), ['failed', 'created']);
  assert.equal(done.items[0].message, 'QuickBooks said no');
});

test('only one batch runs at a time, and bad requests are refused', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const jobs = createApprovalJobs({ maxBatch: 2, recheck: async () => { await gate; return { results: [{ status: 'pending_approval' }] }; }, approve: async () => ({ status: 'created' }) });
  const { id } = jobs.start({ sourceInvoiceIds: ['1'] });
  assert.throws(() => jobs.start({ sourceInvoiceIds: ['2'] }), { statusCode: 409 });
  assert.equal(jobs.running().id, id);
  release();
  await waitFor(jobs, id);
  assert.equal(jobs.running(), null);
  assert.throws(() => jobs.start({ sourceInvoiceIds: [] }), { statusCode: 400 });
  assert.throws(() => jobs.start({ sourceInvoiceIds: ['1', '2', '3'] }), { statusCode: 400 });
  assert.throws(() => jobs.get('missing'), { statusCode: 404 });
});
