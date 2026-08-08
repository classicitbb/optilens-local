const test = require("node:test");
const assert = require("node:assert/strict");
const { applyCurrentStatusUpdate } = require("../lib/operations/source-status-writeback");

test("CurrentStatusID write-back fails closed while the global source-write switch is disabled", async () => {
  const prior = process.env.OPTILENS_WRITEBACK_ENABLED;
  process.env.OPTILENS_WRITEBACK_ENABLED = "false";
  try {
    await assert.rejects(
      () => applyCurrentStatusUpdate({ orderId: 123, targetStatusId: 456, expectedCurrentStatusId: 1 }),
      /Source status write-back is disabled/
    );
  } finally {
    if (prior === undefined) delete process.env.OPTILENS_WRITEBACK_ENABLED;
    else process.env.OPTILENS_WRITEBACK_ENABLED = prior;
  }
});
