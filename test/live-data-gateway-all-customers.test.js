const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the database layer before the gateway loads so no SQL Server is needed.
const dbPath = require.resolve('../lib/db');
const pools = { app: null, source: null };
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { getAppPool: async () => pools.app, getSourcePool: async () => pools.source },
};
const gateway = require('../lib/live-data-gateway');
const {
  dispatch, normalizeRequest, OPERATIONS, ALL_CUSTOMER_OPERATIONS, ALL_ORDER_STATUS_QUERY,
  CUSTOMER_ORDER_STATUS_QUERY, fitToBudget, allOrderPayload,
} = gateway;

function fakePool(handler) {
  const calls = [];
  return {
    calls,
    request() {
      const inputs = {};
      const req = {
        inputs,
        input(name, value) { inputs[name] = value; return req; },
        async query(sql) { calls.push({ sql, inputs: { ...inputs } }); return { recordset: handler(sql, inputs) }; },
      };
      return req;
    },
  };
}

const allCustomers = { scope: 'all_customers' };

test('the all-customer operations are advertised and need an explicit all_customers scope', () => {
  assert.deepEqual(ALL_CUSTOMER_OPERATIONS, ['innovations.all_orders', 'optilens.all_deliveries']);
  for (const operation of ALL_CUSTOMER_OPERATIONS) {
    assert.ok(OPERATIONS.includes(operation));
    const request = normalizeRequest({ operation, target: allCustomers, arguments: { status_scope: 'active' } });
    assert.deepEqual(request.target, allCustomers);
    assert.equal(request.args.status_scope, 'active');
    assert.throws(() => normalizeRequest({ operation, target: {} }), (e) => e.code === 'invalid_scope');
    // A customer mapping must never turn it into a customer read, or the reverse.
    assert.throws(() => normalizeRequest({ operation, target: { account_number: 'CV-42' } }), (e) => e.code === 'invalid_scope');
  }
  assert.throws(
    () => normalizeRequest({ operation: 'innovations.customer_orders', target: allCustomers }),
    /no customer mapping/i,
  );
});

test('the all-orders query applies the same active-WIP rules as the per-customer query, with no customer filter', () => {
  const wipRules = [
    /b\.Active = 1/, /a\.JobID IS NOT NULL/, /a\.JobID <> ''/, /a\.OrderType IN \(1, 3\)/,
    /a\.ShipDate = CAST\(SYSDATETIME\(\) AS date\)/, /Terminating = 1/, /Cancellation = 0/,
    /COALESCE\(i\.Status, 0\) <> 99/, /t\.TypeID = 19/, /l\.ShortName IN \('en', 'en-us'\)/,
  ];
  for (const rule of wipRules) {
    assert.match(CUSTOMER_ORDER_STATUS_QUERY, rule);
    assert.match(ALL_ORDER_STATUS_QUERY, rule);
  }
  assert.doesNotMatch(ALL_ORDER_STATUS_QUERY, /@account_number|@customer_id|@order_lookup/);
  assert.doesNotMatch(ALL_ORDER_STATUS_QUERY, /dbo\.Now\(\)/);
  assert.match(ALL_ORDER_STATUS_QUERY, /customer\.CustomerName AS customer_name/);
});

test('all_orders returns every active order with its own customer and passes dates as parameters', async () => {
  pools.source = fakePool(() => [
    { order_id: 11, invoice_id: null, rx_number: 'RX-1', patient: 'ADA', received_at: '2026-11-10T10:00:00Z', promise_date: null, status_name: 'Surfacing', account_number: 'A1', customer_name: 'Acme Optical' },
    { order_id: 12, invoice_id: 77, rx_number: '', patient: 'BOB', received_at: '2026-11-09T10:00:00Z', promise_date: '2026-11-16T10:00:00Z', status_name: 'Coating', account_number: 'B2', customer_name: 'Bay Eyes' },
  ]);
  const data = await dispatch({ operation: 'innovations.all_orders', target: allCustomers, arguments: { status_scope: 'active', from_date: '2026-11-01', to_date: 'oops; DROP TABLE x' } });
  assert.equal(data.source_status, 'live');
  assert.equal(data.truncated, false);
  assert.deepEqual(data.orders.map((o) => [o.order_id, o.account_number, o.customer_name]), [[11, 'A1', 'Acme Optical'], [12, 'B2', 'Bay Eyes']]);
  assert.equal(data.orders[1].rx_number, null);
  assert.equal(data.orders[0].promise_date, null);
  const [{ inputs, sql }] = pools.source.calls;
  assert.equal(inputs.from_date, '2026-11-01');
  assert.equal(inputs.to_date, null);
  assert.doesNotMatch(sql, /2026-11-01/);
  assert.ok(!('amount' in data.orders[0]));
});

test('all_orders flags truncation at the row cap and at the size budget instead of failing', async () => {
  pools.source = fakePool((sql, inputs) => Array.from({ length: inputs.max_rows }, (_, i) => ({ order_id: i + 1, account_number: 'A', customer_name: 'N' })));
  const capped = await dispatch({ operation: 'innovations.all_orders', target: allCustomers, arguments: {} });
  assert.equal(capped.truncated, true);
  assert.equal(pools.source.calls[0].inputs.max_rows, 5001);
  assert.ok(capped.orders.length > 0 && capped.orders.length <= 5000);

  const rows = Array.from({ length: 10 }, (_, i) => ({ order_id: i, patient: 'x'.repeat(100) }));
  const fitted = fitToBudget(rows.map(allOrderPayload), 500);
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.rows.length > 0 && fitted.rows.length < 10);
  assert.equal(fitToBudget([{ a: 1 }], 500).truncated, false);
});

test('all_deliveries lists open and closed shipments with each item on its own customer', async () => {
  const openId = '11111111-1111-1111-1111-111111111111';
  const closedId = '22222222-2222-2222-2222-222222222222';
  pools.app = fakePool((sql) => {
    if (/GROUP BY/.test(sql)) {
      return [
        { shipment_session_id: openId, source_shipment_id: 501, customer_account: 'A1', app_status: 'open', started_at: '2026-11-12T08:00:00Z', closed_at: null, tracking_number: null, shipping_method_name: '1 Tia Lewis', source_item_count: 2, item_count: 0 },
        { shipment_session_id: closedId, source_shipment_id: null, customer_account: 'B2', app_status: 'closed', started_at: '2026-11-01T08:00:00Z', closed_at: '2026-11-02T08:00:00Z', tracking_number: '123456789012', shipping_method_name: '2 FedEx', source_item_count: null, item_count: 1 },
      ];
    }
    return [{ shipment_session_id: closedId, source_order_id: '9001', invoice_number: 'INV-5', patient_name: 'CY', item_state: 'shipped' }];
  });
  pools.source = fakePool((sql) => {
    if (/FROM dbo\.ShipmentItems/.test(sql)) {
      return [
        { shipment_id: 501, order_id: 31, account_number: 'A1', customer_name: 'Acme Optical', rx_number: 'RX-1', patient: 'ADA', received_at: '2026-11-10T10:00:00Z', order_type_name: 'Rx', invoice_id: null, source_shipped: false },
        { shipment_id: 501, order_id: 32, account_number: 'C3', customer_name: 'Coast Vision', rx_number: 'RX-2', patient: 'DEE', received_at: '2026-11-10T11:00:00Z', order_type_name: 'Stock', invoice_id: 88, source_shipped: false },
      ];
    }
    if (/WHERE o\.OrderID IN/.test(sql)) {
      return [{ order_id: 9001, account_number: 'B2', customer_name: 'Bay Eyes', rx_number: 'RX-9', received_at: '2026-10-30T09:00:00Z' }];
    }
    if (/FROM dbo\.Customers/.test(sql)) {
      return [{ account_number: 'A1', customer_name: 'Acme Optical' }, { account_number: 'B2', customer_name: 'Bay Eyes' }];
    }
    return [];
  });

  const data = await dispatch({
    operation: 'optilens.all_deliveries', target: allCustomers,
    arguments: { include_open: true, closed_since: '2026-10-01' },
  });

  assert.equal(data.source_status, 'live');
  assert.equal(data.truncated, false);
  const [open, closed] = data.deliveries;
  assert.equal(open.closed_at, null);
  assert.equal(open.item_count, 2);
  assert.deepEqual(open.orders.map((o) => o.customer_name), ['Acme Optical', 'Coast Vision']);
  assert.deepEqual(open.orders.map((o) => o.rx_number), ['RX-1', 'RX-2']);
  assert.ok(closed.closed_at);
  assert.equal(closed.orders[0].customer_name, 'Bay Eyes');
  assert.equal(closed.orders[0].rx_number, 'RX-9');
  assert.equal(closed.orders[0].description, 'Invoice INV-5');
  assert.equal(closed.tracking_url, 'https://www.fedex.com/fedextrack/?trknbr=123456789012');
  assert.equal(closed.shipping_method_name, '2 FedEx');

  const [sessionsCall] = pools.app.calls;
  assert.equal(sessionsCall.inputs.include_open, 1);
  assert.equal(sessionsCall.inputs.closed_since, '2026-10-01');
  assert.doesNotMatch(sessionsCall.sql, /customer_account\s*=/);
  // Source lookups bind ids as parameters rather than inlining them.
  const itemsCall = pools.source.calls.find((c) => /FROM dbo\.ShipmentItems/.test(c.sql));
  assert.equal(itemsCall.inputs.v0, 501);
  assert.match(itemsCall.sql, /IN \(@v0\)/);
});

test('all_deliveries leaves open shipments out unless asked, and falls back to the shipment account for unplaced lines', async () => {
  const id = '33333333-3333-3333-3333-333333333333';
  pools.app = fakePool((sql) => (/GROUP BY/.test(sql)
    ? [{ shipment_session_id: id, source_shipment_id: null, customer_account: 'B2', app_status: 'closed', started_at: null, closed_at: '2026-11-03T00:00:00Z', tracking_number: null, shipping_method_name: null, source_item_count: null, item_count: 1 }]
    : [{ shipment_session_id: id, source_order_id: 'not-numeric', invoice_number: null, patient_name: 'EVE', item_state: 'prep' }]));
  pools.source = fakePool((sql) => (/FROM dbo\.Customers/.test(sql) ? [{ account_number: 'B2', customer_name: 'Bay Eyes' }] : []));

  const data = await dispatch({ operation: 'optilens.all_deliveries', target: allCustomers, arguments: {} });
  assert.equal(pools.app.calls[0].inputs.include_open, 0);
  assert.match(pools.app.calls[0].inputs.closed_since, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(data.deliveries[0].orders.map((o) => [o.account_number, o.customer_name]), [['B2', 'Bay Eyes']]);
});

test('all_deliveries flags truncation at the session cap', async () => {
  pools.app = fakePool((sql, inputs) => (/GROUP BY/.test(sql)
    ? Array.from({ length: inputs.max_rows }, (_, i) => ({ shipment_session_id: `s${i}`, source_shipment_id: null, customer_account: null, closed_at: null, item_count: 0 }))
    : []));
  pools.source = fakePool(() => []);
  const data = await dispatch({ operation: 'optilens.all_deliveries', target: allCustomers, arguments: { include_open: true } });
  assert.equal(data.truncated, true);
  assert.equal(data.deliveries.length, 2000);
});
