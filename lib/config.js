const fs = require("node:fs");
const path = require("node:path");
const { mergePsqlVaultEntry, mergeSqlServerVaultEntry } = require("./credential-vault");

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

    if (!process.env[key]) {
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

  const sourcePsql = mergePsqlVaultEntry({
    dsn: process.env.OPTILENS_SOURCE_PSQL_DSN || "Innovations",
    driver: process.env.OPTILENS_SOURCE_PSQL_DRIVER || "Pervasive ODBC Interface",
    host: process.env.OPTILENS_SOURCE_PSQL_HOST || "192.168.254.5",
    port: Number(process.env.OPTILENS_SOURCE_PSQL_PORT || 1583),
    database: process.env.OPTILENS_SOURCE_PSQL_DATABASE || "INNOVATIONS",
    user: process.env.OPTILENS_SOURCE_PSQL_USER || "",
    password: process.env.OPTILENS_SOURCE_PSQL_PASSWORD || "",
    mode: process.env.OPTILENS_SOURCE_PSQL_MODE || "read-only"
  }, ["innovations", "psql"]);

  return {
    host: process.env.OPTILENS_HOST || "0.0.0.0",
    port: Number(process.env.OPTILENS_PORT || 8080),
    appDb,
    sourceMssql,
    sourcePsql,
    writeBackEnabled: parseBool(process.env.OPTILENS_WRITEBACK_ENABLED, false)
  };
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

module.exports = { getConfig };
