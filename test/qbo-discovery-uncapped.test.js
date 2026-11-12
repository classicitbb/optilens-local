const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Discovery used SELECT TOP (500) ... ORDER BY InvoiceTime, so every run re-read the same
// oldest 500 invoices in the window and newer ones were never reconciled or applied.
test('source invoice discovery has no row cap', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'qbo-invoice-sync.js'), 'utf8');
  const start = src.indexOf('async function discoverSourceInvoices');
  const end = src.indexOf('async function findLedger');
  assert.ok(start > -1 && end > start, 'discoverSourceInvoices not found');
  assert.doesNotMatch(src.slice(start, end), /\bTOP\s*\(/i);
});
