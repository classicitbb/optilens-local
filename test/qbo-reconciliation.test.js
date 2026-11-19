'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcile, summarize, normalizeQboDoc, qboOrigin } = require('../lib/qbo-reconciliation');

const inv = (id, total, extra = {}) => ({ sourceInvoiceId: String(id), total, isCredit: false, customer: 'Cust', invoiceDate: '2026-11-17', lane: 'ready', ...extra });
const qbo = (id, docNumber, total, extra = {}) => ({ id: String(id), type: 'Invoice', docNumber: String(docNumber), date: '2026-11-17', total, customer: 'Cust', origin: 'other', ...extra });
const stateOf = (rows, docNumber) => rows.find((row) => row.docNumber === String(docNumber)).state;

test('same number and amount matches, whoever created it', () => {
  const rows = reconcile({ rows: [inv(1, 100), inv(2, 50)], qboDocs: [qbo(10, 1, 100, { origin: 'optilens' }), qbo(11, 2, 50)] });
  assert.equal(stateOf(rows, 1), 'matched');
  assert.equal(rows.find((row) => row.docNumber === '1').origin, 'optilens');
  assert.equal(rows.find((row) => row.docNumber === '2').origin, 'other');
});

test('a different amount is reported with the difference, ignoring sub-cent noise', () => {
  const rows = reconcile({ rows: [inv(1, 100), inv(2, 100)], qboDocs: [qbo(10, 1, 99.5), qbo(11, 2, 100.004)] });
  assert.equal(stateOf(rows, 1), 'differs');
  assert.equal(rows.find((row) => row.docNumber === '1').difference, -0.5);
  assert.equal(stateOf(rows, 2), 'matched');
});

test('invoices with no QuickBooks document are missing; QuickBooks documents with no Innovations invoice are extra', () => {
  const rows = reconcile({ rows: [inv(1, 100)], qboDocs: [qbo(20, 999, 10)], from: '2026-11-16' });
  assert.equal(stateOf(rows, 1), 'missing');
  assert.equal(stateOf(rows, 999), 'qbo_only');
});

test('documents dated before the window can match but are never reported as extra', () => {
  const rows = reconcile({ rows: [inv(1, 100)], qboDocs: [qbo(10, 1, 100, { date: '2026-11-12' }), qbo(11, 555, 5, { date: '2026-11-12' })], from: '2026-11-16' });
  assert.equal(stateOf(rows, 1), 'matched');
  assert.equal(rows.some((row) => row.docNumber === '555'), false);
});

test('two QuickBooks documents with one number is a duplicate', () => {
  const rows = reconcile({ rows: [inv(1, 100)], qboDocs: [qbo(10, 1, 100), qbo(11, 1, 100)] });
  assert.equal(stateOf(rows, 1), 'duplicate');
  assert.deepEqual(rows[0].qboIds, ['10', '11']);
});

test('credit notes compare as negative amounts and a type mismatch is flagged', () => {
  const credit = inv(3, 40, { isCredit: true });
  const ok = reconcile({ rows: [credit], qboDocs: [normalizeQboDoc({ Id: 5, DocNumber: '3', TotalAmt: 40, TxnDate: '2026-11-17', CustomerRef: { name: 'Cust' } }, 'CreditMemo')] });
  assert.equal(ok[0].state, 'matched');
  assert.equal(ok[0].qboTotal, -40);
  const wrong = reconcile({ rows: [credit], qboDocs: [qbo(6, 3, -40)] });
  assert.equal(wrong[0].state, 'differs');
  assert.match(wrong[0].note, /credit note/);
});

test('origin comes from the last line of the memo', () => {
  assert.equal(qboOrigin('Job\nOptiLens source Innovations invoice 95001'), 'optilens');
  assert.equal(qboOrigin('typed by hand'), 'other');
  assert.equal(qboOrigin(null), 'other');
});

test('summary counts every state and totals both sides', () => {
  const rows = reconcile({ rows: [inv(1, 100), inv(2, 50), inv(3, 20)], qboDocs: [qbo(10, 1, 100), qbo(11, 2, 45), qbo(12, 9, 7)], from: '2026-11-16' });
  const summary = summarize(rows);
  assert.deepEqual(summary.counts, { matched: 1, differs: 1, duplicate: 0, missing: 1, qbo_only: 1 });
  assert.equal(summary.needsReconciling, 3);
  assert.equal(summary.innovationsTotal, 170);
  assert.equal(summary.quickbooksTotal, 152);
});
