const fs = require("node:fs");
const path = require("node:path");
const { mergeSqlServerVaultEntry } = require("./credential-vault");

loadEnvFile(path.join(__dirname, "..", ".env"));

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();

    if (process.env[key] === undefined) {
      process.env[key] = value.replace(/^"|"$/g, "");
    }
  }
}

function getConfig() {
  const appDb = mergeSqlServerVaultEntry({
    server: process.env.OPTILENS_DB_SERVER || "MSSQL-SVR",
    database: process.env.OPTILENS_DB_NAME || "optilens_local",
    user: process.env.OPTILENS_DB_USER || "",
    password: process.env.OPTILENS_DB_PASSWORD || "",
    encrypt: parseBool(process.env.OPTILENS_DB_ENCRYPT, true),
    trustServerCertificate: parseBool(process.env.OPTILENS_DB_TRUST_CERT, true)
  }, ["app db", "optilens_local", "private app"]);

  const sourceMssql = mergeSqlServerVaultEntry({
    server: process.env.OPTILENS_SOURCE_MSSQL_SERVER || "MSSQL-SVR",
    database: process.env.OPTILENS_SOURCE_MSSQL_DATABASE || "Innovations",
    user: process.env.OPTILENS_SOURCE_MSSQL_USER || "",
    password: process.env.OPTILENS_SOURCE_MSSQL_PASSWORD || "",
    encrypt: parseBool(process.env.OPTILENS_SOURCE_MSSQL_ENCRYPT, true),
    trustServerCertificate: parseBool(process.env.OPTILENS_SOURCE_MSSQL_TRUST_CERT, true),
    mode: process.env.OPTILENS_SOURCE_MSSQL_MODE || "read-only"
  }, ["innovations", "source db", "source mssql"]);

  const reportingDb = mergeSqlServerVaultEntry({
    server: process.env.OPTILENS_REPORTING_DB_SERVER || "192.168.254.9",
    database: process.env.OPTILENS_REPORTING_DB_NAME || "sql_reporting",
    user: process.env.OPTILENS_REPORTING_DB_USER || "sql_reporting",
    password: process.env.OPTILENS_REPORTING_DB_PASSWORD || "",
    encrypt: parseBool(process.env.OPTILENS_REPORTING_DB_ENCRYPT, false),
    trustServerCertificate: parseBool(process.env.OPTILENS_REPORTING_DB_TRUST_CERT, true)
  }, ["reporting db", "business metrics"]);

  const privilegedDataAccess = {
    enabled: parseBool(process.env.OPTILENS_PRIVILEGED_DATA_ACCESS_ENABLED, false),
    maxRows: clampInteger(process.env.OPTILENS_PRIVILEGED_DATA_ACCESS_MAX_ROWS, 1000, 1, 10000),
    requestTimeoutMs: clampInteger(process.env.OPTILENS_PRIVILEGED_DATA_ACCESS_TIMEOUT_MS, 30000, 1000, 120000),
    sources: {
      "app-mssql": { read: appDb, write: sqlWriteProfile("OPTILENS_ADMIN_APP_WRITE", appDb) },
      "source-mssql": { read: sourceMssql, write: sqlWriteProfile("OPTILENS_ADMIN_SOURCE_MSSQL_WRITE", sourceMssql) },
      "reporting-mssql": { read: reportingDb, write: sqlWriteProfile("OPTILENS_ADMIN_REPORTING_WRITE", reportingDb) }
    }
  };

  return {
    host: process.env.OPTILENS_HOST || "0.0.0.0",
    port: Number(process.env.OPTILENS_PORT || process.env.PORT || 8080),
    appDb,
    sourceMssql,
    reportingDb,
    privilegedDataAccess,
    writeBackEnabled: parseBool(process.env.OPTILENS_WRITEBACK_ENABLED, false),
    writeBackStatusIds: parsePositiveIntegerList(process.env.OPTILENS_WRITEBACK_STATUS_IDS),
    supplierStatusAutoApply: parseBool(process.env.OPTILENS_SUPPLIER_STATUS_AUTO_APPLY, false),
    supplierExceptionDigestEnabled: parseBool(process.env.OPTILENS_SUPPLIER_EXCEPTION_DIGEST_ENABLED, false)
  };
}

function sqlWriteProfile(prefix, base) {
  const user = process.env[`${prefix}_USER`] || "";
  const password = process.env[`${prefix}_PASSWORD`] || "";
  if (!user || !password) return null;
  return {
    server: process.env[`${prefix}_SERVER`] || base.server,
    database: process.env[`${prefix}_DATABASE`] || base.database,
    user,
    password,
    encrypt: parseBool(process.env[`${prefix}_ENCRYPT`], base.encrypt),
    trustServerCertificate: parseBool(process.env[`${prefix}_TRUST_CERT`], base.trustServerCertificate)
  };
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parsePositiveIntegerList(value) {
  return [...new Set(String(value || "")
    .split(/[;,\s]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isSafeInteger(item) && item > 0))];
}

module.exports = { getConfig };
