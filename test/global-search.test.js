'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchAll, invoiceHits, shipmentHits, customerHits, cachedReviewRows, PER_GROUP } = require('../lib/global-search');

const row = (id, customer, extra = {}) => ({ sourceInvoiceId: String(id), customer, account: 'ABC', memo: 'Smith, Jo', tracking: '', itemName: 'Lens', total: 100, isCredit: false, lane: 'ready', ...extra });

test('invoice search needs every typed word and links to the filtered screen', () => {
  const rows = [row(95610, 'Courts Optical'), row(95611, 'Eyecare Express', { memo: 'Jones, Ann' })];
  assert.deepEqual(invoiceHits(rows, 'courts smith').map((hit) => hit.title), ['Invoice 95610']);
  assert.equal(invoiceHits(rows, '95611')[0].href, '/modules/automation?q=95611');
  assert.equal(invoiceHits(rows, 'nobody').length, 0);
});

test('invoice hits are capped and report how many more exist', () => {
  const rows = Array.from({ length: 10 }, (_, index) => row(100 + index, 'Same Customer'));
  const hits = invoiceHits(rows, 'same');
  assert.equal(hits.length, PER_GROUP);
  assert.equal(hits.reduce((sum, hit) => sum + hit.more, 0), 4);
});

test('credit notes show a minus sign', () => {
  assert.match(invoiceHits([row(1, 'X', { isCredit: true, total: 12.5, lane: 'attention' })], '1')[0].meta, /-12\.50 · Needs a look/);
});

test('shipment and customer hits point at Delivery & Export', () => {
  assert.equal(shipmentHits(['11274'])[0].href, '/modules/delivery-export?q=11274');
  assert.equal(customerHits([{ customerName: 'Nevis Optical', customerAccount: 'NEVO ', isExportCustomer: true }])[0].meta, 'NEVO · Export');
});

test('searchAll skips groups the person may not read and tolerates failures', async () => {
  const providers = [
    { id: 'a', label: 'A', permission: 'a.read', run: async () => [{ title: 'one' }] },
    { id: 'b', label: 'B', permission: 'b.read', run: async () => [{ title: 'secret' }] },
    { id: 'c', label: 'C', permission: 'a.read', run: async () => { throw new Error('db down'); } },
    { id: 'd', label: 'D', permission: 'a.read', run: async () => [] }
  ];
  const result = await searchAll({ query: 'ab', providers, can: (permission) => permission === 'a.read' });
  assert.deepEqual(result.groups.map((group) => group.id), ['a']);
  assert.deepEqual(result.skipped, ['c']);
});

test('searchAll ignores queries shorter than two characters', async () => {
  const result = await searchAll({ query: 'a', providers: [{ id: 'a', permission: 'x', run: async () => [{ title: 'one' }] }], can: () => true });
  assert.deepEqual(result.groups, []);
});

test('the review read is shared for a minute', async () => {
  let calls = 0; let clock = 0;
  const rows = cachedReviewRows(async () => { calls += 1; return { rows: [row(1, 'X')] }; }, () => clock);
  await Promise.all([rows(), rows()]);
  clock = 30_000; await rows();
  assert.equal(calls, 1);
  clock = 61_000; await rows();
  assert.equal(calls, 2);
});
