const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeEntities, trim } = require('../lib/innovations-sync-log');
const { ENTITIES, normalizeEntitySelection } = require('../lib/innovations-sync');

test('sync log summaries preserve counts but cap diagnostic text', () => {
  const result = summarizeEntities({
    customers: { ok: false, read: 3, received: 2, upserted: 1, failed: 1, batches: 1, error: 'x'.repeat(600) },
  });
  assert.deepEqual({ ...result.customers, error: undefined }, {
    ok: false, read: 3, received: 2, upserted: 1, failed: 1, batches: 1, error: undefined,
  });
  assert.equal(result.customers.error.length, 500);
  assert.equal(trim('a\nb'), 'a b');
});

test('statement sync selection automatically includes statement lines in dependency order', () => {
  assert.deepEqual(normalizeEntitySelection(['statements']), ['statements', 'statement_lines']);
  assert.deepEqual(
    normalizeEntitySelection(['statement_lines', 'customers', 'statements']),
    ['customers', 'statements', 'statement_lines'],
  );
});

test('order activity is included in the default scheduled sync and emits only the cloud contract fields', () => {
  assert.ok(normalizeEntitySelection().includes('order_activity'));
  assert.deepEqual(ENTITIES.order_activity.map({
    CustomerID: 12345,
    LastOrderDate: '2026-07-11',
    OrdersLast7Days: 9,
    OrdersLast30Days: 41,
    OrdersLast90Days: 122,
    AvgGapDays: '1.4',
  }), {
    innovations_customer_id: 12345,
    last_order_date: '2026-07-11',
    orders_last_7_days: 9,
    orders_last_30_days: 41,
    orders_last_90_days: 122,
    avg_gap_days: 1.4,
  });
  assert.equal(ENTITIES.order_activity.map({
    CustomerID: 12345,
    LastOrderDate: null,
    OrdersLast7Days: 0,
    OrdersLast30Days: 0,
    OrdersLast90Days: 2,
    AvgGapDays: null,
  }).avg_gap_days, null);
});

test('bank sync preserves the exact Innovations EFT institution name', () => {
  const sourceName = 'First Caribbean International ';
  assert.deepEqual(ENTITIES.banks.map({ EFTInstitutionID: 3, EFTInstitutionName: sourceName }), {
    innovations_eft_institution_id: 3,
    bank_name: sourceName,
  });
});
