const test = require("node:test");
const assert = require("node:assert/strict");
const { ENTITIES, buildUpdateStatement, compareRows, inactiveBit } = require("../lib/actian-lens-status-sync");

test("inactive status is exactly Flags bit 2", () => {
  assert.equal(inactiveBit(4168), 0);
  assert.equal(inactiveBit(4170), 2);
  assert.equal(inactiveBit(16384), 0);
  assert.equal(inactiveBit(16386), 2);
});

test("row comparison reports only inactive-bit changes", () => {
  const entity = ENTITIES[0];
  const source = [{ GroupNum: 1, MatlNum: 1, MFNum: 4, LNum: 10, Flags: 4170 }, { GroupNum: 1, MatlNum: 1, MFNum: 4, LNum: 11, Flags: 4168 }];
  const target = [{ Groupnum: 1, Matlnum: 1, MFnum: 4, Lnum: 10, Flags: 4168 }, { Groupnum: 1, Matlnum: 1, MFnum: 4, Lnum: 11, Flags: 520 }];
  const result = compareRows(source, target, entity);
  assert.equal(result.summary.statusMismatches, 1);
  assert.deepEqual(result.operations[0], { entity: "LensType", key: [1, 1, 4, 10], sourceInactiveBit: 2, targetInactiveBit: 0 });
});

test("conditional updates preserve all non-status flag bits", () => {
  assert.match(buildUpdateStatement(ENTITIES[1]), /SET Flags = \(Flags & ~2\) \| @sourceInactiveBit/);
  assert.match(buildUpdateStatement(ENTITIES[2]), /\[Option\] = @key4/);
});
