const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeEntities, trim } = require('../lib/innovations-sync-log');
const { normalizeEntitySelection } = require('../lib/innovations-sync');

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
