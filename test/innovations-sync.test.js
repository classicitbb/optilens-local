const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeEntitySelection } = require('../lib/innovations-sync');

test('default Innovations cloud sync excludes catalog entities that require explicit rollout', () => {
  assert.deepEqual(normalizeEntitySelection(), [
    'banks',
    'customers',
    'contacts',
    'balances',
    'order_activity',
    'statements',
    'statement_lines',
    'lens_aliases',
  ]);
});

test('explicit Innovations cloud sync selection can still request catalog entities', () => {
  assert.deepEqual(normalizeEntitySelection(['store_lens_power_rows', 'supplies']), [
    'supplies',
    'store_lens_power_rows',
  ]);
});
