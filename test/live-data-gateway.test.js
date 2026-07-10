const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRequest, positiveInteger, dateOnly, OPERATIONS } = require('../lib/live-data-gateway');

test('gateway exposes only approved reads', () => {
  assert.deepEqual(OPERATIONS, ['innovations.customer_account', 'innovations.customer_statement', 'optilens.customer_deliveries']);
});

test('customer mapping is mandatory and normalized', () => {
  const request = normalizeRequest({ operation: 'innovations.customer_account', target: { innovations_customer_id: '42', account_number: ' CV-42 ' } });
  assert.equal(request.target.innovationsCustomerId, 42);
  assert.equal(request.target.accountNumber, 'CV-42');
  assert.throws(() => normalizeRequest({ operation: 'innovations.customer_account', target: {} }), /no customer mapping/i);
});

test('identifiers and dates reject malformed input', () => {
  assert.equal(positiveInteger('7'), 7);
  assert.equal(positiveInteger('../1'), null);
  assert.equal(dateOnly('2026-07-10'), '2026-07-10');
  assert.equal(dateOnly('2026-07-10; DROP TABLE x'), null);
});

