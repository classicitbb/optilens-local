/** One-way Actian Zen -> Innovations MSSQL lens active/inactive synchronization. */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const sql = require("mssql");
const { getConfig } = require("./config");
const zen = require("./zen-source");

const INACTIVE_BIT = 2;
const TASK_NAME = "OptiLens Actian Lens Status Sync";
const LOG_FILE = path.join(__dirname, "..", "data", "logs", "actian-lens-status-sync.jsonl");
const LOCK_FILE = path.join(__dirname, "..", "data", "logs", "actian-lens-status-sync.lock");
const DEFAULT_INTERVAL_MINUTES = Number(process.env.OPTILENS_LENS_STATUS_SYNC_INTERVAL_MINUTES || 60);
const ENTITIES = [
  { name: "LensType", sourceTable: "LensType", targetTable: "dbo.LensType", sourceKeys: ["Groupnum", "Matlnum", "MFnum", "Lnum"], targetKeys: ["Groupnum", "Matlnum", "MFnum", "Lnum"] },
  { name: "LensOptions", sourceTable: "LensOptions", targetTable: "dbo.LensOptions", sourceKeys: ["Groupnum", "Matlnum", "MFnum", "Lnum", "Num"], targetKeys: ["Groupnum", "Matlnum", "MFnum", "Lnum", "Num"] },
  { name: "LensItem", sourceTable: "LensItem", targetTable: "dbo.LensItem", sourceKeys: ["MaterialGroup", "Material", "MFType", "LensType", "Option", "Num"], targetKeys: ["MaterialGroup", "Material", "MFType", "LensType", "[Option]", "Num"] },
];
let activeRun = null;

function inactiveBit(flags) { return Number(flags) & INACTIVE_BIT; }
function rowValue(row, key) {
  if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  const match = Object.entries(row).find(([column]) => column.toLowerCase() === String(key).toLowerCase());
  return match ? match[1] : undefined;
}
function keyFromRow(row, columns) {
  return columns.map((column) => {
    const value = Number(rowValue(row, column));
    if (!Number.isSafeInteger(value)) throw new Error(`Invalid key ${column} in source/target row.`);
    return value;
  });
}
function compareKeys(left, right) { for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return left[i] - right[i]; return 0; }

function compareRows(sourceRows, targetRows, entity) {
  let sourceIndex = 0; let targetIndex = 0;
  const summary = { sourceRows: sourceRows.length, targetRows: targetRows.length, missingInTarget: 0, missingInSource: 0, statusMismatches: 0 };
  const operations = [];
  while (sourceIndex < sourceRows.length || targetIndex < targetRows.length) {
    const sourceRow = sourceRows[sourceIndex]; const targetRow = targetRows[targetIndex];
    const sourceKey = sourceRow ? keyFromRow(sourceRow, entity.sourceKeys) : null;
    const targetKey = targetRow ? keyFromRow(targetRow, entity.sourceKeys) : null;
    const comparison = sourceRow && targetRow ? compareKeys(sourceKey, targetKey) : sourceRow ? -1 : 1;
    if (comparison < 0) { summary.missingInTarget += 1; sourceIndex += 1; continue; }
    if (comparison > 0) { summary.missingInSource += 1; targetIndex += 1; continue; }
    const sourceInactiveBit = inactiveBit(sourceRow.Flags); const targetInactiveBit = inactiveBit(targetRow.Flags);
    if (sourceInactiveBit !== targetInactiveBit) {
      summary.statusMismatches += 1;
      operations.push({ entity: entity.name, key: sourceKey, sourceInactiveBit, targetInactiveBit });
    }
    sourceIndex += 1; targetIndex += 1;
  }
  return { summary, operations };
}

function sourceQuery(entity, groupNum, materialNum) {
  // The Actian ODBC driver binds unsigned lens codes as signed C values. Cast
  // every key plus Flags before fetching so high option codes cannot overflow.
  const keys = entity.sourceKeys.map((column) => `CONVERT(${column}, SQL_INTEGER) AS ${column}`).join(", ");
  const groupColumn = entity.name === "LensItem" ? "MaterialGroup" : "Groupnum";
  const materialColumn = entity.name === "LensItem" ? "Material" : "Matlnum";
  return `SELECT ${keys}, CONVERT(Flags, SQL_INTEGER) AS Flags FROM ${entity.sourceTable} WHERE ${groupColumn} = ${groupNum} AND ${materialColumn} = ${materialNum} ORDER BY ${entity.sourceKeys.join(", ")}`;
}
function targetQuery(entity) {
  const selectKeys = entity.targetKeys.map((column, index) => `${column} AS [${entity.sourceKeys[index]}]`).join(", ");
  const groupColumn = entity.name === "LensItem" ? "MaterialGroup" : "Groupnum";
  const materialColumn = entity.name === "LensItem" ? "Material" : "Matlnum";
  return `SELECT ${selectKeys}, Flags FROM ${entity.targetTable} WHERE ${groupColumn} = @groupNum AND ${materialColumn} = @materialNum ORDER BY ${entity.targetKeys.join(", ")}`;
}
function buildUpdateStatement(entity) {
  const predicates = entity.targetKeys.map((column, index) => `${column} = @key${index}`).join(" AND ");
  return `UPDATE ${entity.targetTable} SET Flags = (Flags & ~2) | @sourceInactiveBit WHERE ${predicates} AND (Flags & 2) = @targetInactiveBit`;
}
function buildVerifyStatement(entity) {
  const predicates = entity.targetKeys.map((column, index) => `${column} = @key${index}`).join(" AND ");
  return `SELECT Flags FROM ${entity.targetTable} WHERE ${predicates}`;
}
function appendLog(event, details = {}) { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`); }
function readRecent() { try { return fs.readFileSync(LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean).slice(-50).map(JSON.parse); } catch { return []; } }
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  try {
    const handle = fs.openSync(LOCK_FILE, "wx"); fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return () => { try { fs.closeSync(handle); } catch {} try { fs.unlinkSync(LOCK_FILE); } catch {} };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let stale = false; try { stale = Date.now() - fs.statSync(LOCK_FILE).mtimeMs > 30 * 60 * 1000; } catch {}
    if (stale) { fs.unlinkSync(LOCK_FILE); return acquireLock(); }
    const running = new Error("A lens status sync is already running."); running.statusCode = 409; throw running;
  }
}
function sourcePoolConfig(config) {
  return { server: config.server, database: config.database, user: config.user, password: config.password, options: { encrypt: config.encrypt, trustServerCertificate: config.trustServerCertificate }, connectionTimeout: 15000, requestTimeout: 120000, pool: { max: 2, min: 0, idleTimeoutMillis: 30000 } };
}

async function collectOperations(connection, pool) {
  const materials = await connection.query("SELECT Groupnum, MtrlNum FROM Materials ORDER BY Groupnum, MtrlNum");
  const summaries = Object.fromEntries(ENTITIES.map((entity) => [entity.name, { sourceRows: 0, targetRows: 0, missingInTarget: 0, missingInSource: 0, statusMismatches: 0 }]));
  const operations = [];
  for (const material of materials) {
    const groupNum = Number(rowValue(material, "Groupnum")); const materialNum = Number(rowValue(material, "MtrlNum"));
    if (!Number.isSafeInteger(groupNum) || !Number.isSafeInteger(materialNum)) throw new Error("Invalid Materials key from Actian.");
    for (const entity of ENTITIES) {
      let sourceRows; let targetResult;
      try {
        [sourceRows, targetResult] = await Promise.all([
          connection.query(sourceQuery(entity, groupNum, materialNum)),
          pool.request().input("groupNum", sql.Int, groupNum).input("materialNum", sql.Int, materialNum).query(targetQuery(entity)),
        ]);
      } catch (error) {
        throw new Error(`${entity.name} ${groupNum}/${materialNum}: ${error.message}`);
      }
      const comparison = compareRows(sourceRows, targetResult.recordset, entity);
      const summary = summaries[entity.name]; for (const [key, value] of Object.entries(comparison.summary)) summary[key] += value;
      operations.push(...comparison.operations);
    }
  }
  for (const [name, summary] of Object.entries(summaries)) if (summary.missingInTarget || summary.missingInSource) throw new Error(`${name} key set differs (missing in MSSQL: ${summary.missingInTarget}, missing in Actian: ${summary.missingInSource}).`);
  return { summaries, operations };
}
async function applyOperations(pool, operations) {
  const entitiesByName = new Map(ENTITIES.map((entity) => [entity.name, entity]));
  const updated = Object.fromEntries(ENTITIES.map((entity) => [entity.name, 0]));
  const transaction = new sql.Transaction(pool); await transaction.begin();
  try {
    for (const operation of operations) {
      const entity = entitiesByName.get(operation.entity);
      const request = new sql.Request(transaction).input("sourceInactiveBit", sql.Int, operation.sourceInactiveBit).input("targetInactiveBit", sql.Int, operation.targetInactiveBit);
      operation.key.forEach((value, index) => request.input(`key${index}`, sql.Int, value));
      const result = await request.query(buildUpdateStatement(entity));
      if (result.rowsAffected[0] !== 1) throw new Error(`Stale MSSQL status for ${operation.entity} (${operation.key.join(", ")}).`);
      updated[operation.entity] += 1;
    }
    for (const operation of operations) {
      const entity = entitiesByName.get(operation.entity); const request = new sql.Request(transaction);
      operation.key.forEach((value, index) => request.input(`key${index}`, sql.Int, value));
      const result = await request.query(buildVerifyStatement(entity));
      if (!result.recordset[0] || inactiveBit(result.recordset[0].Flags) !== operation.sourceInactiveBit) throw new Error(`Verification failed for ${operation.entity} (${operation.key.join(", ")}).`);
    }
    await transaction.commit(); return updated;
  } catch (error) { await transaction.rollback().catch(() => {}); throw error; }
}
async function syncLensStatuses({ dryRun = false, trigger = "manual" } = {}) {
  const config = getConfig(); if (!config.sourceMssql.user || !config.sourceMssql.password) throw new Error("Innovations MSSQL credentials are not configured in the vault.");
  const releaseLock = acquireLock(); let connection; let pool; const startedAt = new Date().toISOString();
  try {
    connection = await zen.connectZen(); pool = await new sql.ConnectionPool(sourcePoolConfig(config.sourceMssql)).connect();
    const { summaries, operations } = await collectOperations(connection, pool);
    const updated = dryRun ? Object.fromEntries(ENTITIES.map((entity) => [entity.name, 0])) : await applyOperations(pool, operations);
    const result = { ok: true, trigger, dryRun, startedAt, finishedAt: new Date().toISOString(), preflight: summaries, plannedUpdates: operations.length, updated };
    appendLog("sync.finished", result); return result;
  } catch (error) {
    appendLog("sync.failed", { ok: false, trigger, dryRun, startedAt, finishedAt: new Date().toISOString(), error: error.message }); throw error;
  } finally { await connection?.close().catch(() => {}); await pool?.close().catch(() => {}); releaseLock(); }
}
function runLensStatusSync(options = {}) { if (activeRun) return activeRun; activeRun = syncLensStatuses(options).finally(() => { activeRun = null; }); return activeRun; }
function queryTask() {
  if (process.platform !== "win32") return null;
  try {
    const output = execFileSync("schtasks.exe", ["/Query", "/TN", TASK_NAME, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
    const fields = (output.split(/\r?\n/)[0].match(/("(?:[^"]|"")*"|[^,]*)/g) || []).filter(Boolean).map((field) => field.startsWith('"') ? field.slice(1, -1).replace(/""/g, '"') : field);
    return { name: TASK_NAME, nextRun: fields[1] || null, state: fields[2] || null };
  } catch { return null; }
}
function getLensStatusSyncStatus({ now = new Date(), taskReader = queryTask, recentReader = readRecent } = {}) {
  const task = taskReader(); const lastRun = [...recentReader()].reverse().find((event) => event.event === "sync.finished" || event.event === "sync.failed") || null;
  const lastRunAt = lastRun?.at || null; const ageMinutes = lastRunAt ? Math.max(0, Math.round((now.getTime() - new Date(lastRunAt).getTime()) / 60000)) : null;
  const expected = DEFAULT_INTERVAL_MINUTES > 0 ? DEFAULT_INTERVAL_MINUTES : 60; const lastOk = lastRun?.event === "sync.finished" && lastRun.ok === true;
  const state = activeRun ? "running" : !task ? "warning" : lastRun && !lastOk ? "error" : "online";
  const detail = activeRun ? "A synchronization is running now." : !task ? "Not scheduled — install the OptiLens Actian Lens Status Sync task." : lastRun && !lastOk ? `Last run failed at ${lastRunAt}.` : lastOk && ageMinutes > expected * 2 ? `Last successful run is stale (${ageMinutes} minutes old; expected every ${expected} minutes).` : lastRunAt ? `Last run succeeded at ${lastRunAt}.` : "Scheduled; no completed run recorded yet.";
  return { name: "Actian lens status sync", state, detail, task, intervalMinutes: expected, lastRun: lastRunAt, lastRunOk: lastRun ? lastOk : null, lastRunAgeMinutes: ageMinutes, running: Boolean(activeRun), lastResult: lastRun };
}
module.exports = { DEFAULT_INTERVAL_MINUTES, ENTITIES, INACTIVE_BIT, LOG_FILE, TASK_NAME, buildUpdateStatement, compareRows, getLensStatusSyncStatus, inactiveBit, runLensStatusSync };
