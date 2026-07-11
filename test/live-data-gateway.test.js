const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dispatch, normalizeRequest, positiveInteger, dateOnly, OPERATIONS, statementPayload, statementLinePayload,
} = require('../lib/live-data-gateway');

test('gateway exposes only approved reads', () => {
  assert.deepEqual(OPERATIONS, ['innovations.customer_account', 'innovations.customer_statement', 'innovations.customer_rx_order_status', 'optilens.customer_deliveries']);
});

test('Rx order status uses the configured bearer token and returns only Rx rows', async () => {
  const originalFetch = global.fetch;
  let requestUrl = '';
  let authorization = '';
  global.fetch = async (url, options) => {
    requestUrl = String(url);
    authorization = options.headers.Authorization;
    return new Response(JSON.stringify({
      data: {
        orderSummary: [
          { orderTypeName: 'Credit', orderID: 12, startDate: '2026-07-11T09:00:00Z' },
          { orderTypeName: 'Rx', orderID: 8, startDate: '2026-07-10T09:00:00Z', statusName: 'Remote Rx' },
          { orderTypeName: 'RX', orderID: 9, startDate: '2026-07-11T10:00:00Z', statusName: 'In progress' },
        ],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const data = await dispatch(
      { operation: 'innovations.customer_rx_order_status', target: { account_number: 'RETAIL' } },
      { innovaApi: { baseUrl: 'https://localhost/api/v2', bearerToken: 'test-token' } },
    );
    assert.match(requestUrl, /\/order_summary\?account_number=RETAIL$/);
    assert.equal(authorization, 'Bearer test-token');
    assert.deepEqual(data.orders.map((row) => row.order_id), [9, 8]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Rx order status requires the mapped LMS account and configured bearer token', async () => {
  await assert.rejects(
    dispatch({ operation: 'innovations.customer_rx_order_status', target: { innovations_customer_id: 42 } }),
    (error) => error.code === 'account_number_missing',
  );
  await assert.rejects(
    dispatch({ operation: 'innovations.customer_rx_order_status', target: { account_number: 'RETAIL' } }),
    (error) => error.code === 'innova_api_not_configured',
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
