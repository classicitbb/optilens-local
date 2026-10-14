const assert = require("node:assert/strict");
const test = require("node:test");

const scan = require("../lib/metrics/costing-scan");
const fixes = require("../lib/metrics/costing-fix");

/* ─────────── scan input ─────────── */

test("scans are cleaned of scanner control characters and Code 39 asterisks", () => {
  assert.equal(scan.normaliseScan("  138711\r\n"), "138711");
  assert.equal(scan.normaliseScan("*138711*"), "138711");
  assert.equal(scan.normaliseScan("\u0000\t0038116802\t"), "0038116802");
  assert.equal(scan.normaliseScan("   "), null);
  assert.equal(scan.normaliseScan("x".repeat(65)), null);
});

test("several scans are split, de-duplicated case-insensitively and capped", () => {
  assert.deepEqual(scan.normaliseScans("138711\n138715, 138711;abc\nABC"), ["138711", "138715", "abc"]);
  assert.deepEqual(scan.normaliseScans(["1", "2", "1"]), ["1", "2"]);
  assert.equal(scan.normaliseScans(Array.from({ length: 60 }, (_, i) => String(i + 1))).length, 25);
});

test("a short numeric scan is tried as an order and as a zero-padded OPC", () => {
  assert.deepEqual(scan.codeForms("138711"), { code: "138711", orderId: 138711, opc: "0000138711" });
  const opc = scan.codeForms("0038116802");
  assert.equal(opc.orderId, null, "a 10-digit OPC must not be read as an int order id");
  assert.equal(opc.opc, "0038116802");
  assert.equal(scan.codeForms("PSMTCLOTHPOUCH").orderId, null);
});

/* ─────────── currency ─────────── */

test("supplier list prices convert to base currency by dividing by the rate", () => {
  // Verified on the live data: order 138711, Thai Optical Lab, 43.00 URX at 0.465 = 92.47.
  assert.equal(scan.listCostToBase(43, 0.465), 92.47);
  assert.equal(scan.listCostToBase(57.34, 0.465), 123.31);
  assert.equal(scan.listCostToBase(19, 1), 19);
  assert.equal(scan.listCostToBase(43, 0), null, "a zero rate must not produce Infinity");
  assert.equal(scan.listCostToBase(0, 0.5), null);
});

test("Rx lens lines are matched to an eye from their description", () => {
  assert.equal(scan.eyeOf("Left: Resin Poly 1.59"), "left");
  assert.equal(scan.eyeOf("Right: Resin Poly 1.59"), "right");
  assert.equal(scan.eyeOf("MS LENS CLEANER"), "right");
});

/* ─────────── line judgement ─────────── */

const lens = (over) => ({ category: 1, type: 1, sku: null, quantity: 1, cost: 0, price: 0, description: "Right: Resin", ...over });
const codes = (verdict) => verdict.issues.map((i) => i.code);
const expectedList = {
  lab: "Thai Optical Lab", tupleKnown: true,
  options: [{ listName: "Thai Optical Lab", price: 43, currencyName: "URX", rate: 0.465, costBase: 92.47 }],
  others: []
};

test("a package line is zero-cost by design and is never flagged", () => {
  const v = scan.analyseLine({ category: 16, type: 1, sku: "393791", quantity: 1, cost: 0, price: 250.91 }, { hasPackage: true });
  assert.deepEqual(v.issues, []);
  assert.equal(v.isPackage, true);
});

test("a lens component inside a package with no cost is the defect", () => {
  const v = scan.analyseLine(lens({}), { hasPackage: true });
  assert.deepEqual(codes(v), ["rx-lens-uncosted"]);
  assert.equal(v.issues[0].severity, "critical");
});

test("an uncosted outsourced lens suggests the lab's list cost converted to base currency", () => {
  const v = scan.analyseLine(lens({}), { hasPackage: true, expected: expectedList });
  assert.equal(v.suggestedCost, 92.47);
  assert.match(v.issues[0].message, /92\.47/);
});

test("a lens costed exactly as the lab's list says is clean and attributed to the list", () => {
  const v = scan.analyseLine(lens({ cost: 92.47 }), { hasPackage: true, expected: expectedList });
  assert.deepEqual(v.issues, []);
  assert.equal(v.costSource, "supplier-list");
});

test("a lens costed differently from the lab's list is flagged with the expected figure", () => {
  const v = scan.analyseLine(lens({ cost: 80 }), { hasPackage: true, expected: expectedList });
  assert.deepEqual(codes(v), ["cost-differs-list"]);
  assert.equal(v.suggestedCost, 92.47);
});

test("when the lab's list has no price for the lens, a costed line is noted but not condemned", () => {
  const v = scan.analyseLine(lens({ cost: 50 }), {
    hasPackage: true, expected: { lab: "Thai Optical Lab", tupleKnown: true, options: [], others: [] }
  });
  assert.deepEqual(codes(v), ["list-cell-missing"]);
  assert.equal(v.issues[0].severity, "info");
});

test("a priced item with no cost is critical; zero both ways on a free add-on is not", () => {
  const priced = scan.analyseLine({ category: 11, type: 1, sku: "AR", quantity: 1, cost: 0, price: 20 }, {});
  assert.deepEqual(codes(priced), ["no-cost"]);
  const free = scan.analyseLine({ category: 11, type: 1, sku: "NOAR", quantity: 1, cost: 0, price: 0 }, {});
  assert.deepEqual(free.issues, []);
});

test("a zero-cost item the business has exempted is not flagged", () => {
  const v = scan.analyseLine(
    { category: 9, type: 1, sku: "edginvtrig", quantity: 1, cost: 0, price: 5 },
    { exempt: new Set(["zero-cost␟EDGINVTRIG"]) }
  );
  assert.deepEqual(v.issues, []);
  assert.equal(v.exempt, true);
});

test("cost at or above price is critical, a thin margin is a warning, a healthy one is clean", () => {
  const over = scan.analyseLine({ category: 11, type: 1, sku: "X", quantity: 1, cost: 20, price: 20 }, {});
  assert.deepEqual(codes(over), ["cost-ge-price"]);
  const thin = scan.analyseLine({ category: 11, type: 1, sku: "X", quantity: 1, cost: 18, price: 20 }, {});
  assert.deepEqual(codes(thin), ["low-margin"]);
  const fine = scan.analyseLine({ category: 11, type: 1, sku: "X", quantity: 1, cost: 10, price: 20 }, {});
  assert.deepEqual(fine.issues, []);
  assert.equal(fine.marginPct, 50);
});

test("a line cost that disagrees with the item master is flagged", () => {
  const v = scan.analyseLine(
    { category: 1, type: 1, sku: "0038116802", quantity: 1, cost: 6, price: 90 },
    { master: { kind: "lens", id: 1, cost: 19 } }
  );
  assert.deepEqual(codes(v), ["cost-differs-master"]);
});

test("quantity scales extended cost, price and margin", () => {
  const v = scan.analyseLine({ category: 9, type: 1, sku: "X", quantity: 3, cost: 2, price: 5 }, {});
  assert.equal(v.extCost, 6);
  assert.equal(v.extPrice, 15);
  assert.equal(v.margin, 9);
  assert.equal(v.marginPct, 60);
});

test("order totals are provisional while any line is missing its cost", () => {
  const lines = [
    scan.analyseLine({ category: 16, type: 1, sku: "P", quantity: 1, cost: 0, price: 250 }, { hasPackage: true }),
    scan.analyseLine(lens({}), { hasPackage: true }),
    scan.analyseLine({ category: 7, type: 1, sku: "E", quantity: 1, cost: 6, price: 0 }, { hasPackage: true })
  ];
  const t = scan.summariseLines(lines);
  assert.equal(t.revenue, 250);
  assert.equal(t.cost, 6);
  assert.equal(t.linesMissingCost, 1);
  assert.equal(t.provisional, true);
});

test("lab names are matched to cost lists on distinctive words, not on filler", () => {
  const lists = [
    { priceListName: "Thai Optical Lab" },
    { priceListName: "Skylab - Labtech Prices" },
    { priceListName: "Value Optical Lab" }
  ];
  assert.deepEqual(scan.matchCostLists("Thai Optical Group", lists).map((l) => l.priceListName), ["Thai Optical Lab"]);
  assert.equal(scan.matchCostLists("Optical Lab", lists).length, 0, "only filler words give no match");
});

/* ─────────── SQL shape ─────────── */

test("every lookup is parameterised and avoids the 50-second stock item view", () => {
  const all = [
    scan.buildResolveQuery(), scan.buildOrderQueries(), scan.buildLensMasterQuery(2), scan.buildMiscMasterQuery(2),
    scan.buildItemHistoryQueries(2), scan.buildRxTupleQuery(), scan.buildListCostQuery()
  ].join("\n");
  assert.doesNotMatch(all, /vw\.StockItems/);
  assert.doesNotMatch(all, /\b(UPDATE|INSERT|DELETE|MERGE|DROP|EXEC)\b/i, "the scan is read-only");
  assert.match(scan.buildResolveQuery(), /@code/);
  assert.match(scan.buildLensMasterQuery(2), /\(@s0\),\(@s1\)/);
  assert.equal((scan.buildLensMasterQuery(1).match(/UNION ALL/g) || []).length, 5, "one arm per SKU column");
});

test("lens SKU lookups are staged: OPC columns first, user SKUs only as a fallback", () => {
  const opc = scan.buildResolveLensQuery(scan.LENS_OPC_COLUMNS);
  assert.match(opc, /OPC_R/);
  assert.doesNotMatch(opc, /UserSKU/);
  assert.match(scan.buildResolveLensQuery(scan.LENS_USER_SKU_COLUMNS), /UserSKU_R/);
  assert.doesNotMatch(scan.buildResolveOrderQuery(), /LensItem/, "an order scan must never touch the 1.5M-row lens master");
});

test("an edging or coating line is not reported as an unresolved item", () => {
  const v = scan.analyseLine({ category: 7, type: 1, sku: "0034804914", quantity: 1, cost: 6, price: 10 }, { master: null, masterChecked: true });
  assert.deepEqual(v.issues, []);
  const lensMiss = scan.analyseLine({ category: 1, type: 1, sku: "NOPE", quantity: 1, cost: 5, price: 50 }, { master: null, masterChecked: true });
  assert.deepEqual(lensMiss.issues.map((i) => i.code), ["unresolved-item"]);
});

test("the Rx lookup reads open jobs and finished jobs keyed by order id", () => {
  const q = scan.buildRxTupleQuery();
  assert.match(q, /dbo\.RxJobs WHERE SerialNum = @orderId/);
  assert.match(q, /dbo\.RxArchive WHERE SerialNum = @orderId/);
  assert.match(scan.buildListCostQuery(), /PricelistGroup = 1 AND pl\.IsActive = 1/);
});

/* ─────────── fixes ─────────── */

test("a line correction is guarded by the value that was read", () => {
  const sql = fixes.buildLineCostStatement({ lineId: 450382, oldCost: 0, newCost: 92.47 });
  assert.equal(
    sql,
    "UPDATE dbo.InvoiceLines SET CostPrice = 92.4700, LastUpdated = SYSDATETIMEOFFSET() WHERE InvoiceLineID = 450382 AND ISNULL(CostPrice, 0) = 0.0000;"
  );
});

test("an item correction names one table and one row", () => {
  assert.match(fixes.buildItemCostStatement({ kind: "lens", id: 7, oldCost: 1, newCost: 2 }), /^UPDATE dbo\.LensItem SET Cost = 2\.0000.*WHERE LensItemID = 7 AND ISNULL\(Cost, 0\) = 1\.0000;$/);
  assert.match(fixes.buildItemCostStatement({ kind: "misc", id: 9, oldCost: 0, newCost: 3 }), /dbo\.MiscItems.*MiscItemID = 9/);
  assert.throws(() => fixes.buildItemCostStatement({ kind: "frame", id: 1, oldCost: 0, newCost: 1 }), /Unknown item kind/);
});

test("new costs are validated before they reach SQL", () => {
  assert.equal(fixes.validCost("92.47"), 92.47);
  assert.equal(fixes.validCost(1.23456), 1.2346);
  for (const bad of [0, -5, "abc", NaN, Infinity, 100001, null, "1; DROP TABLE x"]) {
    assert.throws(() => fixes.validCost(bad), /cost/i, `${bad} must be rejected`);
  }
  assert.throws(() => fixes.buildLineCostStatement({ lineId: "1; DROP", oldCost: 0, newCost: 1 }), /not a valid id/);
});

function fakePool(rows) {
  return {
    request() {
      return { input() { return this; }, query: async () => ({ recordset: rows }) };
    }
  };
}

test("preparing a line fix reads the current cost itself and opens a write challenge", async () => {
  let asked = null;
  const service = { requestChallenge: (req, actor) => { asked = { req, actor }; return { challengeId: "c1", confirmation: "EXECUTE X", writeConfirmation: "WRITE X", sql: req.sql }; } };
  const pool = fakePool([{ InvoiceLineID: 5, CostPrice: 0, InvoicePrice: 0, Quantity: 1, Description: "Right: lens", SKU: null, OrderID: 138711 }]);

  const out = await fixes.prepareCostFix({ type: "line-cost", lineId: 5, newCost: 92.47, oldCost: 9999 }, { userId: "u1" }, { pool, service });

  assert.equal(asked.req.source, "source-mssql");
  assert.equal(asked.req.mode, "write");
  assert.match(asked.req.sql, /= 0\.0000;$/, "the guard uses the value read from the database, not the client's oldCost");
  assert.equal(out.preview.changes[0].before, 0);
  assert.equal(out.preview.changes[0].after, 92.47);
});

test("preparing a fix that changes nothing is refused", async () => {
  const pool = fakePool([{ InvoiceLineID: 5, CostPrice: 92.47, Description: "x", OrderID: 1 }]);
  await assert.rejects(
    fixes.prepareCostFix({ type: "line-cost", lineId: 5, newCost: 92.47 }, { userId: "u" }, { pool, service: { requestChallenge() { throw new Error("must not be called"); } } }),
    /already the cost/
  );
});

test("an item fix touches only the rows whose cost actually differs", async () => {
  let sqlText = "";
  const service = { requestChallenge: (req) => { sqlText = req.sql; return { challengeId: "c", sql: req.sql }; } };
  const pool = fakePool([{ id: 1, Cost: 5 }, { id: 2, Cost: 7 }]);
  const out = await fixes.prepareCostFix({ type: "item-cost", kind: "lens", ids: [1, 2], newCost: 7 }, { userId: "u" }, { pool, service });
  assert.equal(out.preview.changes.length, 1);
  assert.match(sqlText, /LensItemID = 1 AND ISNULL\(Cost, 0\) = 5\.0000/);
  assert.doesNotMatch(sqlText, /LensItemID = 2/);
});

test("unknown fix types are refused", async () => {
  await assert.rejects(fixes.prepareCostFix({ type: "drop-everything", newCost: 1 }, { userId: "u" }, { pool: fakePool([]), service: {} }), /Unknown fix type/);
});

/* ─────────── roles: one SKU, different lines (order 1700) ─────────── */

test("an edging line that reuses a lens OPC is never compared with the lens master", () => {
  const masters = {
    lens: new Map([["0023407745", { kind: "lens", id: 1150944, ids: [1150944], cost: 1.9, name: "70S400/250" }]]),
    misc: new Map()
  };
  assert.equal(scan.masterFor(masters, 1, "0023407745").cost, 1.9, "the lens line still finds its master");
  assert.equal(scan.masterFor(masters, 7, "0023407745"), null, "the edging line must not borrow the lens cost");
  assert.equal(scan.masterFor(masters, 7, null), null);
  const edging = scan.analyseLine(
    { category: 7, type: 1, sku: "0023407745", quantity: 1, cost: 9, price: 15 },
    { master: scan.masterFor(masters, 7, "0023407745"), masterChecked: true }
  );
  assert.deepEqual(edging.issues, []);
});

function analysedLine(over) {
  return {
    lineId: 1, type: 1, isPackage: false, category: 1, categoryName: "Lens", sku: "A", description: "Left Lens: X",
    cost: 0, price: 24, issues: [{ code: "no-cost", severity: "critical" }], ...over
  };
}

test("an uncosted lens beside an over-costed edging line for the same SKU is flagged as a misplaced cost", () => {
  const lines = [
    analysedLine({ lineId: 4351, sku: "0023407745" }),
    analysedLine({ lineId: 4352, sku: "0024407751", description: "Right Lens: X" }),
    analysedLine({ lineId: 4353, sku: "0023407745", category: 7, categoryName: "Edging", description: "Edging Charge", cost: 9, price: 9, issues: [{ code: "cost-ge-price" }] }),
    analysedLine({ lineId: 4354, sku: "0024407751", category: 7, categoryName: "Edging", description: "Edging Charge", cost: 9, price: 9, issues: [{ code: "cost-ge-price" }] })
  ];
  const notes = scan.markMisplacedCosts(lines);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].code, "cost-misplaced");
  assert.equal(lines[0].misplacedFrom.lineId, 4353, "each eye is paired by SKU");
  assert.equal(lines[1].misplacedFrom.lineId, 4354);
  assert.equal(lines[0].misplacedFrom.cost, 9);
});

test("a healthy edging line does not make an uncosted lens look misplaced", () => {
  const lines = [
    analysedLine({ lineId: 1, sku: "S" }),
    analysedLine({ lineId: 2, sku: "S", category: 7, categoryName: "Edging", cost: 3, price: 9, issues: [] })
  ];
  assert.deepEqual(scan.markMisplacedCosts(lines), []);
  assert.equal(lines[0].misplacedFrom, undefined);
});

/* ─────────── finding a cost ─────────── */

test("a description is matched on the product, whichever eye or prefix it carries, and wildcards stay literal", () => {
  assert.equal(scan.descriptionPattern("Left Lens: Plastic CR-39 Bifocal"), "%Plastic CR-39 Bifocal%");
  assert.equal(scan.descriptionPattern("Right: Resin Poly 1.59"), "%Resin Poly 1.59%");
  assert.equal(scan.descriptionPattern("Edging Charge"), "%Edging Charge%");
  assert.equal(scan.descriptionPattern("AR"), null, "too little to match on");
  assert.equal(scan.descriptionPattern("  "), null);
  assert.equal(scan.descriptionPattern("50%_off"), "%50\\%\\_off%");
  assert.equal(scan.likeLiteral("50%_off[1]"), "50\\%\\_off\\[1]");
});

test("the search queries are parameterised and read-only", () => {
  const all = [
    scan.buildSearchLensQuery(scan.LENS_OPC_COLUMNS), scan.buildSearchLensByNameQuery(), scan.buildSearchMiscQuery(), scan.buildSimilarLinesQuery()
  ].join("\n");
  assert.doesNotMatch(all, /vw\.StockItems/);
  assert.doesNotMatch(all, /\b(UPDATE|INSERT|DELETE|MERGE|DROP|EXEC)\b/i);
  assert.match(all, /@prefix/);
  assert.match(scan.buildSimilarLinesQuery(), /LIKE @pattern ESCAPE/);
  assert.match(scan.buildSearchMiscQuery(), /ESCAPE/);
});

test("searching with nothing to look for is refused", async () => {
  await assert.rejects(scan.searchCostItems({ query: "a" }), /at least 2/);
  await assert.rejects(scan.searchCostItems({ query: "x".repeat(65) }), /at least 2|too long/);
});

/* ─────────── moving a cost between lines ─────────── */

function linePool(byId) {
  return {
    request() {
      let id = null;
      return { input(name, type, value) { id = value; return this; }, query: async () => ({ recordset: byId[id] ? [byId[id]] : [] }) };
    }
  };
}

test("a cost can be moved to the right line, zeroing the wrong one, in one guarded change", async () => {
  let asked = null;
  const service = { requestChallenge: (req) => { asked = req; return { challengeId: "c", sql: req.sql }; } };
  const pool = linePool({
    4351: { InvoiceLineID: 4351, CostPrice: 0, Description: "Left Lens: X", OrderID: 1700 },
    4353: { InvoiceLineID: 4353, CostPrice: 9, Description: "Edging Charge", OrderID: 1700 }
  });
  const out = await fixes.prepareCostFix(
    { type: "line-costs", changes: [{ lineId: 4351, newCost: 9 }, { lineId: 4353, newCost: 0 }] }, { userId: "u" }, { pool, service }
  );
  assert.equal(out.preview.changes.length, 2);
  assert.match(asked.sql, /CostPrice = 9\.0000.*InvoiceLineID = 4351 AND ISNULL\(CostPrice, 0\) = 0\.0000;/);
  assert.match(asked.sql, /CostPrice = 0\.0000.*InvoiceLineID = 4353 AND ISNULL\(CostPrice, 0\) = 9\.0000;/);
});

test("a multi-line change refuses mixed orders, duplicates, blanks and no-ops", async () => {
  const service = { requestChallenge() { throw new Error("must not be called"); } };
  const pool = linePool({
    1: { InvoiceLineID: 1, CostPrice: 0, Description: "a", OrderID: 10 },
    2: { InvoiceLineID: 2, CostPrice: 5, Description: "b", OrderID: 11 },
    3: { InvoiceLineID: 3, CostPrice: 5, Description: "c", OrderID: 10 }
  });
  const run = (changes) => fixes.prepareCostFix({ type: "line-costs", changes }, { userId: "u" }, { pool, service });
  await assert.rejects(run([{ lineId: 1, newCost: 5 }, { lineId: 2, newCost: 0 }]), /same order/);
  await assert.rejects(run([{ lineId: 1, newCost: 5 }, { lineId: 1, newCost: 6 }]), /only appear once/);
  await assert.rejects(run([{ lineId: 1, newCost: "" }]), /cost/i);
  await assert.rejects(run([{ lineId: 1, newCost: 0 }, { lineId: 3, newCost: 5 }]), /already carry/);
  await assert.rejects(run([]), /between 1 and/i);
});

test("zero is only accepted when moving a cost, never as a plain correction", async () => {
  assert.equal(fixes.validCost(0, { allowZero: true }), 0);
  assert.throws(() => fixes.validCost(0), /greater than zero/);
  assert.throws(() => fixes.validCost(-1, { allowZero: true }), /cost/i);
});
