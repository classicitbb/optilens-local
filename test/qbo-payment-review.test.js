const test = require('node:test');
const assert = require('node:assert/strict');
const { cents, reviewPayment, buildReview, marker } = require('../lib/qbo-payment-review');
const source = () => ({ id: '42', account: 'TEST', customer: 'Synthetic customer', date: '2026-11-19', methodCode: 2,
  amount: '100.0000', discount: '0.0000', allowance: '0.0000', pending: false,
  allocations: [{ invoiceNumber: '1001', amount: '60.0000' }, { invoiceNumber: '1002', amount: '40.0000' }] });
const evidence = () => ({ mappings: [{ source_account: 'TEST', qbo_customer_id: '9' }],
  invoices: [{ Id: '11', DocNumber: '1001', CustomerRef: { value: '9' }, Balance: 60 }, { Id: '12', DocNumber: '1002', CustomerRef: { value: '9' }, Balance: 40 }],
  payments: [], deposits: [] });
const payment = () => ({ Id: '20', CustomerRef: { value: '9' }, TxnDate: '2026-11-19', TotalAmt: 100, UnappliedAmt: 0,
  Line: [{ Amount: 60, LinkedTxn: [{ TxnType: 'Invoice', TxnId: '11' }] }, { Amount: 40, LinkedTxn: [{ TxnType: 'Invoice', TxnId: '12' }] }] });
const deposit = () => ({ Id: '30', Line: [{ Amount: 100, LinkedTxn: [{ TxnType: 'Payment', TxnId: '20' }] }] });
test('exact cents reject lost precision, malformed values and unsafe amounts', () => {
  assert.equal(cents('100.0000'), 10000); assert.equal(cents('0.29'), 29);
  for (const value of [null, '', '1.0001', '1e2', 'NaN', '99999999999999999']) assert.equal(cents(value), null);
});
test('fully allocated receipt is ready for review with corrected cheque/cash mapping', () => {
  assert.equal(reviewPayment(source(), evidence()).status, 'ready');
  assert.equal(reviewPayment(source(), evidence()).method, 'Cash');
  assert.equal(reviewPayment({ ...source(), methodCode: 1 }, evidence()).method, 'Cheque');
});
test('missing, duplicate or wrong-customer invoices are held', () => {
  const missing = evidence(); missing.invoices.pop();
  assert.equal(reviewPayment(source(), missing).status, 'exception');
  const duplicate = evidence(); duplicate.invoices.push({ ...duplicate.invoices[0], Id: '99' });
  assert.equal(reviewPayment(source(), duplicate).status, 'exception');
  const wrong = evidence(); wrong.invoices[0].CustomerRef.value = 'other';
  assert.equal(reviewPayment(source(), wrong).status, 'exception');
});
test('no customer mapping and conflicting mappings fail closed', () => {
  const e = evidence(); e.mappings = [];
  assert.equal(reviewPayment(source(), e).status, 'exception');
  e.mappings = [{ source_account: 'TEST', qbo_customer_id: '9' }, { source_account: 'TEST', qbo_customer_id: '10' }];
  assert.equal(reviewPayment(source(), e).status, 'exception');
});
test('discounts, allowances and wire notes need review; no balancing amount is invented', () => {
  const s = source(); s.amount = '99'; s.discount = '1';
  assert.equal(reviewPayment(s, evidence()).status, 'needs_review');
  assert.equal(reviewPayment({ ...source(), methodCode: 4, comments: 'wire transfer' }, evidence()).status, 'needs_review');
  assert.equal(reviewPayment({ ...source(), allowance: '2' }, evidence()).status, 'exception');
});
test('unapplied, negative, pending, reversed and unknown-method receipts are held', () => {
  for (const change of [{ allocations: [] }, { amount: '101' }, { amount: '-1' }, { pending: true }, { reversalId: 12 }, { methodCode: 0 }, { methodCode: 5 }]) {
    assert.equal(reviewPayment({ ...source(), ...change }, evidence()).status, 'exception');
  }
});
test('historical match requires exact customer/date/amount and all invoice allocations', () => {
  const e = evidence(); e.payments = [payment()]; e.deposits = [deposit()];
  e.invoices.forEach((i) => { i.Balance = 0; });
  const row = reviewPayment(source(), e);
  assert.equal(row.status, 'matched'); assert.equal(row.matchKind, 'historical_candidate');
  assert.equal(row.qboPaymentId, '20'); assert.deepEqual(row.qboDepositIds, ['30']);
  e.payments[0].Line[0].Amount = 59;
  assert.equal(reviewPayment(source(), e).status, 'exception');
});
test('marker cannot override changed financial evidence or duplicate payments', () => {
  const e = evidence(); e.payments = [{ ...payment(), PrivateNote: `Memo\n${marker('42')}` }]; e.deposits = [deposit()];
  assert.equal(reviewPayment(source(), e).matchKind, 'marker');
  e.payments[0].TotalAmt = 99;
  assert.equal(reviewPayment(source(), e).status, 'exception');
  e.payments = [payment(), { ...payment(), Id: '21' }];
  assert.equal(reviewPayment(source(), e).status, 'exception');
});
test('wrong-source marker is never adopted as a historical match', () => {
  const e = evidence(); e.payments = [{ ...payment(), PrivateNote: marker('43') }];
  assert.equal(reviewPayment(source(), e).status, 'exception');
});
test('payment without deposit stays visible and duplicate or partial deposits are held', () => {
  const e = evidence(); e.payments = [payment()];
  const row = reviewPayment(source(), e); assert.equal(row.status, 'needs_review'); assert.equal(row.qboPaymentId, '20');
  e.deposits = [deposit(), { ...deposit(), Id: '31' }];
  assert.equal(reviewPayment(source(), e).status, 'exception');
  e.deposits = [deposit()]; e.deposits[0].Line[0].Amount = 99;
  assert.equal(reviewPayment(source(), e).status, 'exception');
});
test('incomplete destination scans never show ready or matched', () => {
  assert.equal(reviewPayment(source(), { ...evidence(), complete: false }).status, 'exception');
});
test('two receipts cannot claim one historical payment and inputs are not mutated', () => {
  const e = evidence(); e.payments = [payment()]; e.deposits = [deposit()];
  const s = [source(), { ...source(), id: '43' }]; const before = JSON.stringify({ s, e });
  const result = buildReview(s, e);
  assert.equal(result.counts.exception, 2); assert.equal(result.postingEnabled, false);
  assert.equal(JSON.stringify({ s, e }), before);
});
