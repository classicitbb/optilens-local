const test = require("node:test");
const assert = require("node:assert/strict");
const { isCommercialInvoiceLensPart } = require("../lib/beswift-co");

test("billable CategoryType 9 lab extras are included with their lens line", () => {
  assert.equal(isCommercialInvoiceLensPart(1), true);
  assert.equal(isCommercialInvoiceLensPart(9), true);
  assert.equal(isCommercialInvoiceLensPart(17), false);
});
