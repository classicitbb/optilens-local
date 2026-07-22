const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dispatch, normalizeRequest, positiveInteger, dateOnly, OPERATIONS, statementPayload, statementLinePayload, orderPayload, CUSTOMER_ORDER_STATUS_QUERY,
} = require('../lib/live-data-gateway');

test('gateway exposes only approved reads', () => {
  assert.deepEqual(OPERATIONS, ['innovations.customer_account', 'innovations.customer_statement', 'innovations.customer_orders', 'optilens.customer_deliveries']);
});

test('order payload exposes only the portal order-list fields', () => {
  assert.deepEqual(orderPayload({
    order_id: 9,
    invoice_id: 53,
    account_number: 'RETAIL',
    order_type_name: 'Rx',
    received_at: '2026-07-11T10:00:00Z',
    promise_date: '2026-07-15T16:00:00Z',
    status_name: 'In progress',
    rx_number: 'RX-99',
    patient: 'PATIENT ONE',
  }), {
    rx_number: 'RX-99',
    patient: 'PATIENT ONE',
    received_at: '2026-07-11T10:00:00Z',
    promise_date: '2026-07-15T16:00:00Z',
    status_name: 'In progress',
  });
});

test('order query is limited to active WIP and valid shipments made today', () => {
  assert.match(CUSTOMER_ORDER_STATUS_QUERY, /INNER JOIN dbo\.GenStatus/);
  assert.match(CUSTOMER_ORDER_STATUS_QUERY, /b\.Active = 1/);
  assert.match(CUSTOMER_ORDER_STATUS_QUERY, /a\.OrderType IN \(1, 3\)/);
  assert.match(CUSTOMER_ORDER_STATUS_QUERY, /a\.PromisedTime AS promise_date/);
  assert.match(CUSTOMER_ORDER_STATUS_QUERY, /b\.PromisedTime AS promise_date/);
  assert.match(CUSTOMER_ORDER_STATUS_QUERY, /a\.ShipDate = CAST\(SYSDATETIME\(\) AS date\)/);
  assert.match(CUSTOMER_ORDER_STATUS_QUERY, /Terminating = 1/);
  assert.doesNotMatch(CUSTOMER_ORDER_STATUS_QUERY, /dbo\.Now\(\)/);
});

test('order status requires the mapped LMS account', async () => {
  await assert.rejects(
    dispatch({ operation: 'innovations.customer_orders', target: { innovations_customer_id: 42 } }),
    (error) => error.code === 'account_number_missing',
  );
});

test('posted statement totals and line presentation retain all portal fields', () => {
  const statement = statementPayload({ id: 4250, discount: '12.50', allowance: '7.50', opening_balance: '680.04' });
  assert.equal(statement.discounts_allowance, 20);
  assert.equal(statement.opening_balance, '680.04');

  assert.deepEqual(statementLinePayload({
    id: 1, statement_id: 4250, order_type_name: 'Rx', post_date: '2026-06-30', invoice_id: 53054,
    order_id: 98196, patient: 'HUNTE DIANE', payment_method: 'Credit Card', reference: '322056', amount: '750.00',
  }), {
    id: 1, statement_id: 4250, order_type_name: 'Rx', post_date: '2026-06-30', invoice_id: 53054,
    order_id: 98196, patient: 'HUNTE DIANE', payment_method: 'Credit Card', reference: '322056', amount: 750,
  });
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
