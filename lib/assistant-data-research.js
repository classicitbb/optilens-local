// Bounded, read-only Innovations research for the in-app assistant.
// The model may propose a query, but deterministic code rejects anything other
// than a single read-only T-SQL statement before it reaches the source reader.

const { getSourcePool } = require("./db");
const { recordAuditEvent } = require("./audit");

const MAX_ROWS = 500;
const DISALLOWED = /\b(?:insert|update|delete|merge|drop|alter|create|truncate|exec(?:ute)?|grant|revoke|deny|backup|restore|dbcc|use|set|waitfor|openrowset|opendatasource|bulk|into)\b/i;

function httpError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function extractDataQuery(text) {
  const match = String(text || "").match(/```data_query\s*\n([\s\S]*?)\n```/i);
  if (!match) return null;
  let request;
  try { request = JSON.parse(match[1]); } catch (_) { throw httpError("The assistant returned an invalid data research request.", 502); }
  if (!request || typeof request.sql !== "string") throw httpError("The assistant data research request did not include SQL.", 502);
  return {
    sql: request.sql.trim(),
    title: String(request.title || "Innovations research").trim().slice(0, 160),
    artifactFormat: ["csv", "xlsx", "pdf"].includes(request.artifactFormat) ? request.artifactFormat : null
  };
}

function withoutLiterals(sql) {
  return String(sql)
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/\[(?:[^\]])*\]/g, "[]")
    .replace(/"(?:[^"])*"/g, '""');
}

function validateReadOnlySql(statement) {
  const sql = String(statement || "").trim();
  if (!sql || sql.length > 12000) throw httpError("Research SQL must be between 1 and 12,000 characters.");
  if (/--|\/\*/.test(sql)) throw httpError("Research SQL may not contain comments.");
  if (/;\s*\S/.test(sql)) throw httpError("Research SQL must contain exactly one statement.");
  const normalized = sql.replace(/;\s*$/, "").trim();
  if (!/^(select|with)\b/i.test(normalized)) throw httpError("Research SQL must start with SELECT or WITH.");
  const sanitized = withoutLiterals(normalized);
  if (DISALLOWED.test(sanitized)) throw httpError("Research SQL contains a command that is not permitted.");
  if (!/\bselect\b/i.test(sanitized)) throw httpError("Research SQL must include a SELECT statement.");
  return normalized;
}

function normalizeRows(rows) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value])));
}

async function runInnovationsResearch({ sql, title = "Innovations research", actor = {}, getPool = getSourcePool, audit = recordAuditEvent }) {
  const statement = validateReadOnlySql(sql);
  const started = Date.now();
  let outcome = "success";
  let rowCount = 0;
  try {
    const pool = await getPool();
    const result = await pool.request().batch(`SET ROWCOUNT ${MAX_ROWS};\n${statement};\nSET ROWCOUNT 0;`);
    const rows = normalizeRows((result.recordsets || []).flat().slice(0, MAX_ROWS));
    rowCount = rows.length;
    return {
      title,
      source: "Innovations MSSQL (read-only)",
      rows,
      rowCount,
      truncated: rowCount >= MAX_ROWS,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - started
    };
  } catch (error) {
    outcome = "error";
    throw error;
  } finally {
    audit({
      moduleCode: "assistant-data-research",
      actorUserId: actor.userId || null,
      eventType: "assistant.data_research.executed",
      entityType: "innovations-mssql",
      entityId: title.slice(0, 160),
      eventData: { mode: "read", durationMs: Date.now() - started, rowCount, outcome }
    }).catch(() => {});
  }
}

function researchContext(research) {
  return JSON.stringify({
    title: research.title,
    source: research.source,
    generatedAt: research.generatedAt,
    rowCount: research.rowCount,
    truncated: research.truncated,
    rows: research.rows
  });
}

module.exports = { extractDataQuery, validateReadOnlySql, runInnovationsResearch, researchContext, MAX_ROWS };
