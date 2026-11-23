'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Invoice 93327 was posted to QuickBooks as a credit memo because FinARSalesJournal.CreditAmount
// (credits applied against an invoice) was treated as "this document is a credit". A document is a
// credit only by its own type (OrderTypes.Credit) or a negative total.
const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'qbo-invoice-sync.js'), 'utf8');

test('isCredit is derived from document type and sign only, never CreditAmount', () => {
  const expressions = [...source.matchAll(/CAST\(CASE WHEN([^]*?)THEN 1 ELSE 0 END AS bit\)/g)]
    .map((match) => match[1])
    .filter((expression) => /ot\.Credit/.test(expression));
  assert.ok(expressions.length >= 2, 'expected the isCredit expression in both source queries');
  for (const expression of expressions) {
    assert.match(expression, /ISNULL\(ot\.Credit, 0\) = 1/);
    assert.match(expression, /Total < 0/);
    assert.doesNotMatch(expression, /CreditAmount/i);
  }
});
