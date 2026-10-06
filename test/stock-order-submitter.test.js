const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPayload } = require('../lib/stock-order-submitter');

const config = { defaults: { labNum: '1177', custNum: '5000150', custSeqNum: '1', shipName: 'Classic Visions' } };
const items = [{ sku: '0095006615', source: 'flens', description: 'CR-39 SV CLEAR 70.0 0.0/-4.75/Either', quantity: 2 }];

test('an ERP account number is used as the customer number', () => {
  const payload = buildPayload({ payload: { account: { account_number: '5000092', name: 'Star Pupils' }, items } }, config);
  assert.equal(payload.customer.custNum, '5000092');
  assert.equal(payload.customer.shipName, 'Star Pupils');
  assert.equal(payload.items[0].source, 'FLENS');
});

test('a buyer with no ERP account rides on the default customer number', () => {
  const payload = buildPayload({ payload: { account: { name: 'Web Buyer' }, items } }, config);
  assert.equal(payload.customer.custNum, '5000150');
});

test('no ERP account and no default customer number is refused', () => {
  assert.throws(
    () => buildPayload({ payload: { account: {}, items } }, { defaults: { ...config.defaults, custNum: '' } }),
    /no account number/,
  );
});
