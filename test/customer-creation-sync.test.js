'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { identity, syncDestination, review } = require('../lib/qbo-customer-creation-sync');

test('verified destination is reused without marking or creating', async () => {
  const existing = { id: 123 };
  const result = await syncDestination({
    reconcile: async () => existing, markAttempt: assert.fail, create: assert.fail
  });
  assert.deepEqual(result, { value: existing, outcome: 'linked' });
});

test('interrupted create is reconciled before another request', async () => {
  let record;
  let creates = 0;
  let attempted = false;
  const destination = {
    reconcile: async () => record,
    markAttempt: async () => { attempted = true; },
    create: async () => {
      assert.equal(attempted, true);
      creates++;
      record = { id: 123 };
      throw new Error('response lost');
    }
  };
  await assert.rejects(syncDestination(destination), /response lost/);
  const result = await syncDestination({ ...destination, uncertain: true });
  assert.deepEqual(result, { value: record, outcome: 'linked' });
  assert.equal(creates, 1);
});

test('uncertain Innovations outcome with no match requires review', async () => {
  await assert.rejects(syncDestination({
    reconcile: async () => null, markAttempt: assert.fail, create: assert.fail, uncertain: true
  }), { review: true });
});

test('ambiguous and incomplete identities cannot reach a destination create', async () => {
  assert.throws(() => identity(' ', 'Fixture'), { review: true });
  await assert.rejects(syncDestination({
    reconcile: async () => { throw review('Name-only candidate'); },
    markAttempt: assert.fail, create: assert.fail
  }), /Name-only candidate/);
});

test('idempotent QuickBooks retry still reconciles before replay', async () => {
  const callOrder = [];
  const result = await syncDestination({
    uncertain: true, idempotent: true,
    reconcile: async () => { callOrder.push('lookup'); return null; },
    markAttempt: async () => { callOrder.push('attempt'); },
    create: async () => { callOrder.push('create'); return { Id: '42' }; }
  });
  assert.deepEqual(callOrder, ['lookup', 'attempt', 'create']);
  assert.equal(result.outcome, 'created');
});

test('dry-run invoice never invokes customer resolution', async () => {
  const { syncOne } = require('../lib/qbo-invoice-sync');
  const prior = process.env.OPTILENS_CUSTOMER_SYNC_ENABLED;
  process.env.OPTILENS_CUSTOMER_SYNC_ENABLED = 'true';
  try {
    const request = {
      input() { return this; },
      async query(statement) {
        assert.doesNotMatch(statement, /local_customers|customer_jobs|customer_mappings/);
        return { recordset: [] };
      }
    };
    const outcome = await syncOne({ request: () => request }, { realmId: 'fixture' },
      { customersBySourceAccount: new Map(), items: new Map() },
      { sourceInvoiceId: '123', customerAccount: 'AC01' },
      { dryRun: true, resolveCustomer: assert.fail });
    assert.equal(outcome.status, 'exception');
  } finally {
    if (prior === undefined) delete process.env.OPTILENS_CUSTOMER_SYNC_ENABLED;
    else process.env.OPTILENS_CUSTOMER_SYNC_ENABLED = prior;
  }
});

test('repeated Innovations invoices reuse the resolved customer and proceed to invoice validation', async (t) => {
  const { syncOne } = require('../lib/qbo-invoice-sync');
  const prior = process.env.OPTILENS_CUSTOMER_SYNC_ENABLED;
  process.env.OPTILENS_CUSTOMER_SYNC_ENABLED = 'true';
  t.after(() => {
    if (prior === undefined) delete process.env.OPTILENS_CUSTOMER_SYNC_ENABLED;
    else process.env.OPTILENS_CUSTOMER_SYNC_ENABLED = prior;
  });
  const request = { input() { return this; }, async query() { return { recordset: [] }; } };
  const pool = { request: () => request };
  const mappings = { customersBySourceAccount: new Map(), items: new Map() };
  const invoice = { sourceInvoiceId: '1', sourceCustomerId: 2, customerAccount: 'AC01', itemName: 'fixture item' };
  const resolveCustomer = t.mock.fn(async () => ({ customer: { Id: 'qb1', DisplayName: 'Fixture' } }));
  const options = { dryRun: false, resolveCustomer };
  for (const sourceInvoiceId of ['1', '2']) {
    const outcome = await syncOne(pool, { realmId: 'fixture' }, mappings, { ...invoice, sourceInvoiceId }, options);
    assert.match(outcome.reason, /No exact QBO item mapping/);
  }
  assert.equal(resolveCustomer.mock.callCount(), 1);
  assert.equal(mappings.customersBySourceAccount.get('AC01').Id, 'qb1');
});
