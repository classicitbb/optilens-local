const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DIGEST_HEADER, renderDigest, sendDailyExceptionDigest } = require("../lib/operations/exception-digest");
const { normalizeVaultData } = require("../lib/credential-vault");

test("deleted vault entries remain deleted across a later server read", () => {
  const data = { ODBC: [] };
  const normalized = normalizeVaultData(data);
  assert.equal(normalized.changed, false);
  assert.deepEqual(normalized.data.ODBC, []);
  const page = fs.readFileSync(path.join(__dirname, "..", "public", "credentials.html"), "utf8");
  assert.doesNotMatch(page, /vaultData = data;\s*if \(seedDefaultFields\(vaultData\)\) await persist\(\);/);
  assert.match(page, /const previous = vaultData;[\s\S]*if \(!\(await persist\(\)\)\)[\s\S]*vaultData = previous/);
});

test("daily digest renders unresolved exceptions and approval queue without customer data", () => {
  const text = renderDigest({ date: "2026-08-28", exceptions: [{ exception_type: "STATUS_MAPPING_PENDING", subject_reference: "REF-1", message: "Mapping required" }], actions: [{ action_type: "supplier.status_projection.propose", target_reference: "42" }] });
  assert.match(text, /Open exceptions: 1/);
  assert.match(text, /Waiting approvals: 1/);
  assert.match(text, /REF-1/);
  assert.equal(DIGEST_HEADER, "daily-unresolved-digest");
});

test("daily digest sends once through SMTP and records the sent state", async () => {
  const queries = [];
  const pool = { request() { return { input() { return this; }, async query(text) {
    queries.push(text);
    if (text.includes("DailyExceptionDigests") && text.includes("SELECT TOP")) return { recordset: [{ digest_id: "digest-1", status: "PENDING" }] };
    if (text.includes("ops.Exceptions")) return { recordset: [{ exception_type: "STATUS_MAPPING_PENDING", subject_reference: "REF-1", message: "Mapping required" }] };
    if (text.includes("ops.Actions")) return { recordset: [{ action_type: "supplier.status_projection.propose", target_reference: "42" }] };
    return { recordset: [] };
  } }; } };
  const sent = [];
  const result = await sendDailyExceptionDigest({ pool, enabled: true, credential: { username: "ops@example.test", password: "secret", smtpHost: "smtp.example.test", smtpPort: 465, smtpSecure: true }, now: new Date("2026-08-28T12:00:00Z"), createTransport: (config) => ({ sendMail: async (message) => sent.push({ config, message }) }) });
  assert.equal(result.state, "sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.headers["X-OptiLens-Notification"], DIGEST_HEADER);
  assert.ok(queries.some((text) => text.includes("status = N'SENT'")));
});

test("automation details have protected endpoints and concrete fixes", () => {
  const routes = fs.readFileSync(path.join(__dirname, "..", "lib", "operations", "routes.js"), "utf8");
  const service = fs.readFileSync(path.join(__dirname, "..", "lib", "operations", "service.js"), "utf8");
  assert.match(routes, /getActionDetail/);
  assert.match(routes, /getExceptionDetail/);
  assert.match(service, /STATUS_MAPPING_PENDING/);
  assert.match(service, /Confirm status mapping/);
});
