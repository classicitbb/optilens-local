const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeEntitySelection, reconcileLensAliasRecords } = require('../lib/innovations-sync');

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

test('lens alias reconciliation deactivates only aliases removed from the source snapshot', () => {
  const active = [
    { alias: '0010100100001', is_active: true },
    { alias: '0010100100003', is_active: true },
  ];
  const result = reconcileLensAliasRecords(active, new Set(['0010100100001', '0010100100002']));

  assert.deepEqual(result.records.map((record) => ({ alias: record.alias, is_active: record.is_active })), [
    { alias: '0010100100001', is_active: true },
    { alias: '0010100100003', is_active: true },
    { alias: '0010100100002', is_active: false },
  ]);
  assert.deepEqual([...result.currentAliases], ['0010100100001', '0010100100003']);
});
