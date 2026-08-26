const test = require("node:test");
const assert = require("node:assert/strict");
const { applyCurrentStatusUpdate, sourceWriteConfiguration } = require("../lib/operations/source-status-writeback");

function writebackConfig(overrides = {}) {
  return {
    writeBackEnabled: true,
    writeBackStatusIds: [190],
    sourceMssql: { user: "source-read" },
    privilegedDataAccess: { sources: { "source-mssql": { write: { user: "source-write", password: "test-only" } } } },
    ...overrides
  };
}

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

test("source write-back requires a separate writer identity and an explicit status allowlist", () => {
  assert.equal(sourceWriteConfiguration(writebackConfig()).ready, true);
  assert.equal(sourceWriteConfiguration(writebackConfig({ privilegedDataAccess: { sources: { "source-mssql": { write: null } } } })).code, "writeback_writer_credentials_missing");
  assert.equal(sourceWriteConfiguration(writebackConfig({ sourceMssql: { user: "source-write" } })).code, "writeback_writer_not_separate");
  assert.equal(sourceWriteConfiguration(writebackConfig({ writeBackStatusIds: [] })).code, "writeback_status_allowlist_missing");
});
