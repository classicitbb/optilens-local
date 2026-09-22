const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { extractDataQuery, validateReadOnlySql, runInnovationsResearch } = require("../lib/assistant-data-research");

test("assistant data-query blocks are parsed and keep only supported artifact formats", () => {
  const request = extractDataQuery('```data_query\n{"title":"Inventory report","sql":"SELECT TOP (10) * FROM dbo.StockItems","artifactFormat":"xlsx"}\n```');
  assert.equal(request.title, "Inventory report");
  assert.equal(request.artifactFormat, "xlsx");
  assert.equal(request.sql, "SELECT TOP (10) * FROM dbo.StockItems");
});

test("assistant research accepts one read-only SELECT and rejects data-changing or multi-statement SQL", () => {
  assert.equal(validateReadOnlySql("SELECT TOP (10) Name FROM dbo.StockItems;"), "SELECT TOP (10) Name FROM dbo.StockItems");
  assert.throws(() => validateReadOnlySql("SELECT * FROM dbo.StockItems; DELETE FROM dbo.StockItems"), /exactly one statement/);
  assert.throws(() => validateReadOnlySql("UPDATE dbo.StockItems SET OnHand = 0"), /start with SELECT or WITH/);
  assert.throws(() => validateReadOnlySql("SELECT * INTO dbo.copy FROM dbo.StockItems"), /not permitted/);
});

test("assistant research clamps rows and records a read-only audit event", async () => {
  let batch = "";
  let auditEvent = null;
  const research = await runInnovationsResearch({
    sql: "SELECT value FROM dbo.report",
    actor: { userId: "operator-a" },
    getPool: async () => ({ request: () => ({ batch: async (statement) => {
      batch = statement;
      return { recordsets: [[{ value: 1 }, { value: 2 }]] };
    } }) }),
    audit: async (event) => { auditEvent = event; }
  });
  assert.equal(research.rowCount, 2);
  assert.equal(research.source, "Innovations MSSQL (read-only)");
  assert.match(batch, /SET ROWCOUNT 500/);
  assert.equal(auditEvent.eventType, "assistant.data_research.executed");
  assert.equal(auditEvent.eventData.mode, "read");
});

test("inventory research box is placed above the attention rail", () => {
  const page = fs.readFileSync(path.join(__dirname, "..", "public", "business-metrics-inventory.js"), "utf8");
  assert.ok(page.indexOf('id="invAsk" style="margin:16px 0 12px"') < page.indexOf("What needs attention"));
  assert.match(page, /Ask anything about Innovations inventory or data/);
});
