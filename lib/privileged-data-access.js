const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sql = require("mssql");
const ExcelJS = require("exceljs");
const { getConfig } = require("./config");
const { getAppPool } = require("./db");
const { recordAuditEvent } = require("./audit");

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const challenges = new Map();
const executions = new Map();

function createPrivilegedDataAccess(deps = {}) {
  const configFor = deps.getConfig || getConfig;
  const sqlDriver = deps.sql || sql;
  const now = deps.now || (() => Date.now());
  const audit = deps.recordAuditEvent || recordAuditEvent;
  const appPool = deps.getAppPool || getAppPool;
  const outputDir = deps.outputDir || path.join(__dirname, "..", "data", "privileged-artifacts");

  function getSource(sourceName, mode) {
    const settings = configFor().privilegedDataAccess;
    if (!settings?.enabled) throw httpError("Privileged data access is disabled by configuration.", 503);
    const source = settings.sources?.[sourceName];
    if (!source) throw httpError(`Unknown data source "${sourceName}".`, 400);
    const profile = source[mode];
    if (!profile?.user || !profile?.password) {
      throw httpError(`${mode === "write" ? "Write" : "Read"} credentials are not configured for ${sourceName}.`, 409);
    }
    return { settings, profile, engine: "mssql" };
  }

  function requestChallenge({ source, sql: statement, mode = "read" }, actor) {
    validateStatement(source, statement, mode);
    getSource(source, mode);
    const normalized = String(statement).trim();
    const digest = digestFor(source, mode, normalized);
    const challengeId = crypto.randomUUID();
    challenges.set(challengeId, { source, mode, sql: normalized, digest, actorUserId: actor.userId, expiresAt: now() + CHALLENGE_TTL_MS });
    return {
      challengeId,
      source,
      mode,
      sql: normalized,
      confirmation: `EXECUTE ${digest}`,
      writeConfirmation: mode === "write" ? `WRITE ${digest}` : null,
      expiresAt: new Date(now() + CHALLENGE_TTL_MS).toISOString()
    };
  }

  async function execute({ challengeId, confirmation, writeConfirmation, artifactFormat }, actor) {
    const challenge = challenges.get(String(challengeId || ""));
    if (!challenge || challenge.expiresAt <= now()) {
      challenges.delete(String(challengeId || ""));
      throw httpError("Challenge is missing or expired. Request a new challenge.", 409);
    }
    if (challenge.actorUserId !== actor.userId) throw httpError("Challenge belongs to another user.", 403);
    if (confirmation !== `EXECUTE ${challenge.digest}`) throw httpError("Exact execution confirmation is required.", 400);
    if (challenge.mode === "write" && writeConfirmation !== `WRITE ${challenge.digest}`) throw httpError("Exact write confirmation is required.", 400);
    challenges.delete(String(challengeId));

    const startedAt = now();
    let result;
    let errorMessage = null;
    try {
      const source = getSource(challenge.source, challenge.mode);
      result = await executeStatement(source, challenge.sql);
      if (artifactFormat) result.artifact = await writeArtifact(result.rows, artifactFormat, outputDir, challenge);
      const executionId = crypto.randomUUID();
      executions.set(executionId, { actorUserId: actor.userId, source: challenge.source, rows: result.rows, expiresAt: now() + CHALLENGE_TTL_MS });
      return { ...result, executionId, source: challenge.source, mode: challenge.mode, durationMs: now() - startedAt };
    } catch (error) {
      errorMessage = error.message;
      throw error;
    } finally {
      audit({
        moduleCode: "admin-data-access",
        actorUserId: actor.userId,
        eventType: "admin.data_access.executed",
        entityType: challenge.source,
        entityId: challenge.digest,
        eventData: { mode: challenge.mode, sqlDigest: challenge.digest, durationMs: now() - startedAt, outcome: errorMessage ? "error" : "success", error: errorMessage }
      }).catch(() => {});
    }
  }

  async function createDashboardMetric({ title, description, executionId }, actor) {
    const execution = executions.get(String(executionId || ""));
    if (!execution || execution.expiresAt <= now()) throw httpError("Execution result is missing or expired. Run the metric query again.", 409);
    if (execution.actorUserId !== actor.userId) throw httpError("Execution result belongs to another user.", 403);
    executions.delete(String(executionId));
    const value = firstScalar(execution?.rows || []);
    if (value === null) throw httpError("A dashboard metric requires a query result with at least one scalar value.", 400);
    const cleanTitle = String(title || "").trim().slice(0, 200);
    if (!cleanTitle) throw httpError("A metric title is required.", 400);
    const metricId = crypto.randomUUID();
    const tileKey = `admin-metric-${metricId}`;
    const pool = await appPool();
    await pool.request()
      .input("metric_id", metricId)
      .input("tile_key", tileKey)
      .input("title", cleanTitle)
      .input("description", String(description || "Privileged administrator metric.").slice(0, 500))
      .input("source_name", execution.source)
      .input("value_text", String(value).slice(0, 200))
      .input("actor_user_id", actor.userId)
      .query(`
        INSERT INTO core.admin_dashboard_metrics (metric_id, tile_key, title, description, source_name, value_text, state, created_by)
        VALUES (@metric_id, @tile_key, @title, @description, @source_name, @value_text, N'online', @actor_user_id);
        INSERT INTO core.dashboard_tiles (tile_key, title, description, module_code, tile_type, default_size, default_sort, is_default_visible)
        VALUES (@tile_key, @title, @description, NULL, N'kpi', N'normal', 900, 1);
      `);
    await audit({ moduleCode: "admin-data-access", actorUserId: actor.userId, eventType: "admin.data_access.metric_created", entityType: "core.dashboard_tiles", entityId: tileKey, eventData: { source: execution.source, value: String(value) } }).catch(() => {});
    return { metricId, tileKey, title: cleanTitle, value: String(value) };
  }

  async function executeStatement(source, statement) {
    const pool = await new sqlDriver.ConnectionPool({
      server: source.profile.server, database: source.profile.database, user: source.profile.user, password: source.profile.password,
      options: { encrypt: source.profile.encrypt, trustServerCertificate: source.profile.trustServerCertificate },
      connectionTimeout: source.settings.requestTimeoutMs, requestTimeout: source.settings.requestTimeoutMs
    }).connect();
    try {
      const maxRows = source.settings.maxRows;
      const result = await pool.request().batch(`SET ROWCOUNT ${maxRows};\n${statement}\n; SET ROWCOUNT 0;`);
      const rows = (result.recordsets || []).flat().slice(0, maxRows);
      return { rows: normalizeRows(rows), rowCount: rows.length, recordsAffected: result.rowsAffected || [] };
    } finally { await pool.close().catch(() => {}); }
  }

  return { requestChallenge, execute, createDashboardMetric, getSource };
}

function validateStatement(source, statement, mode) {
  if (!source || !/^[a-z0-9-]+$/i.test(source)) throw httpError("A valid source is required.", 400);
  if (!["read", "write"].includes(mode)) throw httpError("Mode must be read or write.", 400);
  if (!statement || typeof statement !== "string" || statement.trim().length > 100000) throw httpError("SQL must be between 1 and 100,000 characters.", 400);
}

function digestFor(source, mode, statement) { return crypto.createHash("sha256").update(`${source}\n${mode}\n${statement}`).digest("hex").slice(0, 12).toUpperCase(); }
function normalizeRows(rows) { return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]))); }
function firstScalar(rows) { const row = rows[0]; return row && Object.keys(row).length ? row[Object.keys(row)[0]] : null; }
function httpError(message, statusCode) { return Object.assign(new Error(message), { statusCode }); }

async function writeArtifact(rows, format, outputDir, challenge) {
  const extension = { csv: "csv", xlsx: "xlsx", pdf: "pdf" }[format];
  if (!extension) throw httpError("Artifact format must be csv, xlsx, or pdf.", 400);
  fs.mkdirSync(outputDir, { recursive: true });
  const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${challenge.digest}.${extension}`;
  const filePath = path.join(outputDir, fileName);
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (format === "csv") fs.writeFileSync(filePath, [columns, ...rows.map((row) => columns.map((key) => csvCell(row[key])))].map((row) => row.join(",")).join("\r\n"), "utf8");
  if (format === "xlsx") { const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet("Results"); sheet.columns = columns.map((key) => ({ header: key, key })); sheet.addRows(rows); await workbook.xlsx.writeFile(filePath); }
  if (format === "pdf") fs.writeFileSync(filePath, simplePdf([columns.join(" | "), ...rows.slice(0, 100).map((row) => columns.map((key) => String(row[key] ?? "")).join(" | "))]));
  return { fileName, format, rowCount: rows.length, downloadUrl: `/api/admin/data-access/artifacts/${encodeURIComponent(fileName)}` };
}

function csvCell(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function simplePdf(lines) {
  const body = lines.map((line, index) => `BT /F1 8 Tf 40 ${760 - Math.min(index, 70) * 10} Td (${String(line).replace(/[\\()]/g, "\\$&").slice(0, 150)}) Tj ET`).join("\n");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`];
  let pdf = "%PDF-1.4\n"; const offsets = [0]; objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }); const start = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`; return Buffer.from(pdf);
}

module.exports = { createPrivilegedDataAccess, digestFor, simplePdf };
