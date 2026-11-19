const test = require('node:test');
const assert = require('node:assert/strict');

const { buildReviewRows, exceptionAdvice, holdReasons, revenueSegment, rowsForScope, shippingSummary, summarizeRows, toQuickBooksCsv } = require('../lib/qbo-invoice-review');

const invoice = (overrides = {}) => ({
  sourceInvoiceId: 95307, customerAccount: 'CVO', customerName: 'Clear Vision Optical', itemName: 'Rx Orders - Local', memo: 'MILLER-GAIL',
  jobMemo: 'MILLER-GAIL. OD -0.25.', total: 264, taxAmount: 0, invoiceTime: '2026-11-16T10:00:00Z', dueDate: '2026-12-16T10:00:00Z', isCredit: false,
  shipMethod: '0 Randall Hunte - Delivery', shippedTime: '2026-11-16T18:00:00Z', trackingNumber: ' ', ...overrides
});

test('Local / Export follows the item suffix, and any VAT forces Local', () => {
  assert.equal(revenueSegment(invoice()), 'Local');
  assert.equal(revenueSegment(invoice({ itemName: 'Rx Orders - Export' })), 'Export');
  assert.equal(revenueSegment(invoice({ itemName: 'Rx Orders - Export', taxAmount: 12 })), 'Local');
});

test('shipping summary drops the route number, formats the Barbados date and ignores blank tracking', () => {
  assert.deepEqual(shippingSummary(invoice()), { via: 'Randall Hunte - Delivery', date: '2026-11-16', tracking: null });
  assert.deepEqual(shippingSummary(invoice({ shipMethod: 'FedEx', trackingNumber: '8800 1' })), { via: 'FedEx', date: '2026-11-16', tracking: '8800 1' });
  assert.deepEqual(shippingSummary(invoice({ shipMethod: null, shippedTime: null })), { via: null, date: null, tracking: null });
});

test('VAT, credits and large totals are held for a person; a plain invoice is not', () => {
  assert.deepEqual(holdReasons(invoice()), []);
  assert.equal(holdReasons(invoice({ taxAmount: 10 })).length, 1);
  assert.equal(holdReasons(invoice({ isCredit: true })).length, 1);
  assert.equal(holdReasons(invoice({ total: 6000 })).length, 1);
  assert.equal(holdReasons(invoice({ total: 6000 }), { reviewLimit: 10000 }).length, 0);
});

test('rows are placed in the right lane from their ledger status', () => {
  const ledger = [
    { source_invoice_id: 1, status: 'pending_approval' },
    { source_invoice_id: 2, status: 'pending_approval', qbo_transaction_id: '70058' },
    { source_invoice_id: 3, status: 'synced', qbo_transaction_id: '70059', qbo_transaction_type: 'Invoice' },
    { source_invoice_id: 4, status: 'exception', last_error: "No confirmed QBO customer mapping for Innovations account 'CVO'." },
    { source_invoice_id: 6, status: 'pending_approval' }
  ];
  const invoices = [1, 2, 3, 4, 5, 6].map((id) => invoice({ sourceInvoiceId: id, taxAmount: id === 6 ? 5 : 0 }));
  const rows = buildReviewRows({ invoices, ledger });
  assert.deepEqual(rows.map((row) => row.lane), ['ready', 'ready', 'posted', 'exception', 'new', 'attention']);
  assert.equal(rows[0].kind, 'create');
  assert.equal(rows[1].kind, 'update');
  assert.equal(rows[3].advice.kind, 'customer');
  assert.equal(rows[5].holds.length, 1);
  assert.equal(rows[5].taxCode, 'VAT 17.5%');
  assert.equal(rows[0].className, 'Local Sales');
  assert.deepEqual(summarizeRows(rows).lanes.ready, { count: 2, total: 528 });
});

test('exception advice tells people what to do next', () => {
  assert.equal(exceptionAdvice('Innovations has conflicting account or name matches.').kind, 'customer');
  assert.equal(exceptionAdvice("No exact QBO item mapping for 'X'.").kind, 'item');
  assert.equal(exceptionAdvice("Production reconciliation found 1 QBO transaction(s) for source invoice '95002'").kind, 'duplicate');
  assert.equal(exceptionAdvice('anything else').kind, 'other');
});

test('CSV fallback matches the legacy import columns, quotes safely, and leaves credits out', () => {
  const rows = buildReviewRows({
    invoices: [invoice({ sourceInvoiceId: 7, jobMemo: '=HYPERLINK("x"), LAST', customerName: 'A, B' }), invoice({ sourceInvoiceId: 8, isCredit: true, total: -50 })],
    ledger: [], customerNames: new Map([['CVO', 'Clear Vision Optical - CVO']])
  });
  const { csv, exported, skippedCredits } = toQuickBooksCsv(rows);
  const [header, line] = csv.trim().split('\r\n');
  assert.equal(header, 'InvoiceNo,Customer,Item (Product/Service),Memo,ItemRate,ItemAmount,InvoiceDate,DueDate,ItemTaxCode,Location');
  assert.equal(line, `7,Clear Vision Optical - CVO,Rx Orders - Local,"'=HYPERLINK(""x""), LAST",264.00,264.00,16/11/2026,16/12/2026,VAT-0%,Local`);
  assert.deepEqual([exported, skippedCredits], [1, 1]);
});

test('CSV scopes pick the right rows and reject unknown scopes', () => {
  const rows = ['ready', 'attention', 'new', 'posted', 'exception'].map((lane, index) => ({ sourceInvoiceId: String(index), lane }));
  assert.deepEqual(rowsForScope(rows, 'unposted').map((row) => row.lane), ['ready', 'attention', 'new']);
  assert.deepEqual(rowsForScope(rows, 'ready').map((row) => row.lane), ['ready']);
  assert.equal(rowsForScope(rows, 'all').length, 5);
  assert.equal(rowsForScope(rows).length, 3);
  assert.throws(() => rowsForScope(rows, 'nope'), { statusCode: 400 });
});
