const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveCustomLineFigures } = require("../lib/beswift-co");

test("custom line amount calculates from quantity x unit price", () => {
  assert.deepEqual(resolveCustomLineFigures({ quantity: "3", unitPrice: "12.50", amount: "" }),
    { quantity: 3, unitPrice: 12.5, amount: 37.5 });
});

test("a keyed amount drives the unit price from quantity", () => {
  assert.deepEqual(resolveCustomLineFigures({ quantity: "4", unitPrice: "", amount: "100" }),
    { quantity: 4, unitPrice: 25, amount: 100 });
});

test("a keyed amount with only a unit price derives the quantity", () => {
  assert.deepEqual(resolveCustomLineFigures({ quantity: "", unitPrice: "20", amount: "100" }),
    { quantity: 5, unitPrice: 20, amount: 100 });
});

test("figures stay blank until enough data is present", () => {
  assert.deepEqual(resolveCustomLineFigures({ quantity: "2", unitPrice: "", amount: "" }),
    { quantity: 2, unitPrice: null, amount: null });
});
