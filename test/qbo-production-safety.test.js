const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyExistingTransactions, isProduction, productionApplyEnabled, transactionSnapshotHash } = require('../lib/qbo-invoice-sync');

const invoice = { sourceInvoiceId: 12345 };
const exact = { Id: '77', DocNumber: '12345', PrivateNote: 'OptiLens source Innovations invoice 12345', SyncToken: '0' };

test('production QBO reconciliation only accepts one exact source marker match', () => {
  assert.equal(classifyExistingTransactions(invoice, []).kind, 'none');
  assert.equal(classifyExistingTransactions(invoice, [{ resource: 'Invoice', transaction: exact }]).kind, 'exact');
  assert.equal(classifyExistingTransactions(invoice, [{ resource: 'Invoice', transaction: { ...exact, PrivateNote: 'manual invoice' } }]).kind, 'ambiguous');
  assert.equal(classifyExistingTransactions(invoice, [{ resource: 'Invoice', transaction: exact }, { resource: 'CreditMemo', transaction: { ...exact, Id: '78' } }]).kind, 'ambiguous');
});

test('production detection and apply flag fail closed', () => {
  assert.equal(isProduction({ environment: 'production' }), true);
  assert.equal(isProduction({ environment: 'sandbox' }), false);
  const previous = process.env.OPTILENS_QBO_PRODUCTION_APPLY_ENABLED;
  delete process.env.OPTILENS_QBO_PRODUCTION_APPLY_ENABLED;
  assert.equal(productionApplyEnabled(), false);
  process.env.OPTILENS_QBO_PRODUCTION_APPLY_ENABLED = 'true';
  assert.equal(productionApplyEnabled(), true);
  if (previous === undefined) delete process.env.OPTILENS_QBO_PRODUCTION_APPLY_ENABLED;
  else process.env.OPTILENS_QBO_PRODUCTION_APPLY_ENABLED = previous;
});

test('QBO snapshots have a stable hash and detect a transaction change', () => {
  assert.equal(transactionSnapshotHash(exact), transactionSnapshotHash({ ...exact }));
  assert.notEqual(transactionSnapshotHash(exact), transactionSnapshotHash({ ...exact, PrivateNote: 'manually changed' }));
});
