const assert = require("node:assert/strict");
const test = require("node:test");
const { createPrivilegedDataAccess } = require("../lib/privileged-data-access");

function testConfig() {
  return {
    privilegedDataAccess: {
      enabled: true,
      maxRows: 2,
      requestTimeoutMs: 5000,
      sources: {
        "reporting-mssql": {
          read: { server: "test", database: "reports", user: "reader", password: "secret", encrypt: false, trustServerCertificate: true },
          write: { server: "test", database: "reports", user: "writer", password: "secret", encrypt: false, trustServerCertificate: true }
        }
      }
    }
  };
}

test("privileged SQL requires a bound exact confirmation and clamps MSSQL rows", async () => {
  let batchSql = "";
  class Pool {
    async connect() { return this; }
    request() { return { batch: async (statement) => { batchSql = statement; return { recordsets: [[{ value: 1 }, { value: 2 }, { value: 3 }]], rowsAffected: [2] }; } }; }
    async close() {}
  }
  const service = createPrivilegedDataAccess({ getConfig: testConfig, sql: { ConnectionPool: Pool }, recordAuditEvent: async () => {} });
  const actor = { userId: "user-a" };
  const challenge = service.requestChallenge({ source: "reporting-mssql", sql: "SELECT value FROM report", mode: "read" }, actor);
  await assert.rejects(() => service.execute({ challengeId: challenge.challengeId, confirmation: "EXECUTE NOPE" }, actor), /Exact execution confirmation/);
  const result = await service.execute({ challengeId: challenge.challengeId, confirmation: challenge.confirmation }, actor);
  assert.equal(result.rowCount, 2);
  assert.equal(result.rows.length, 2);
  assert.match(batchSql, /SET ROWCOUNT 2/);
  assert.match(batchSql, /SELECT value FROM report/);
});

test("write execution requires a second confirmation", async () => {
  class Pool {
    async connect() { return this; }
    request() { return { batch: async () => ({ recordsets: [[]], rowsAffected: [1] }) }; }
    async close() {}
  }
  const service = createPrivilegedDataAccess({ getConfig: testConfig, sql: { ConnectionPool: Pool }, recordAuditEvent: async () => {} });
  const actor = { userId: "user-a" };
  const challenge = service.requestChallenge({ source: "reporting-mssql", sql: "UPDATE report SET value = 1", mode: "write" }, actor);
  await assert.rejects(() => service.execute({ challengeId: challenge.challengeId, confirmation: challenge.confirmation }, actor), /Exact write confirmation/);
  const result = await service.execute({ challengeId: challenge.challengeId, confirmation: challenge.confirmation, writeConfirmation: challenge.writeConfirmation }, actor);
  assert.equal(result.mode, "write");
});

test("dashboard metrics use an execution result owned by the same admin", async () => {
  class Pool {
    async connect() { return this; }
    request() { return { batch: async () => ({ recordsets: [[{ total: 42 }]], rowsAffected: [] }) }; }
    async close() {}
  }
  let insertParams = {};
  const fakeAppPool = async () => ({ request: () => ({ input(key, value) { insertParams[key] = value; return this; }, query: async () => ({}) }) });
  const service = createPrivilegedDataAccess({ getConfig: testConfig, sql: { ConnectionPool: Pool }, getAppPool: fakeAppPool, recordAuditEvent: async () => {} });
  const actor = { userId: "user-a" };
  const challenge = service.requestChallenge({ source: "reporting-mssql", sql: "SELECT 42 AS total" }, actor);
  const execution = await service.execute({ challengeId: challenge.challengeId, confirmation: challenge.confirmation }, actor);
  const metric = await service.createDashboardMetric({ title: "Test total", executionId: execution.executionId }, actor);
  assert.equal(metric.value, "42");
  assert.equal(insertParams.value_text, "42");
  await assert.rejects(() => service.createDashboardMetric({ title: "Again", executionId: execution.executionId }, actor), /missing or expired/);
});
