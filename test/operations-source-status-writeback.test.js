const test = require("node:test");
const assert = require("node:assert/strict");
const { applyCurrentStatusUpdate } = require("../lib/operations/source-status-writeback");

test("CurrentStatusID write-back fails closed while the global source-write switch is disabled", async () => {
  const originalEnv = process.env.OPTILENS_WRITEBACK_ENABLED;
  process.env.OPTILENS_WRITEBACK_ENABLED = "false";
  try {
    await assert.rejects(
      () => applyCurrentStatusUpdate({ orderId: 123, targetStatusId: 456, expectedCurrentStatusId: 1 }),
      /Source status write-back is disabled/
    );
  } finally {
    if (originalEnv !== undefined) {
      process.env.OPTILENS_WRITEBACK_ENABLED = originalEnv;
    } else {
      delete process.env.OPTILENS_WRITEBACK_ENABLED;
    }
  }
});
