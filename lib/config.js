const fs = require("node:fs");
const path = require("node:path");

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
  return {
    host: process.env.OPTILENS_HOST || "0.0.0.0",
    port: Number(process.env.OPTILENS_PORT || 8080),
    appDb: {
      server: process.env.OPTILENS_DB_SERVER || "MSSQL-SVR",
      database: process.env.OPTILENS_DB_NAME || "optilens_local",
      user: process.env.OPTILENS_DB_USER || "",
      password: process.env.OPTILENS_DB_PASSWORD || "",
      encrypt: parseBool(process.env.OPTILENS_DB_ENCRYPT, true),
      trustServerCertificate: parseBool(process.env.OPTILENS_DB_TRUST_CERT, true)
    },
    sourceMssql: {
      server: process.env.OPTILENS_SOURCE_MSSQL_SERVER || "MSSQL-SVR",
      database: process.env.OPTILENS_SOURCE_MSSQL_DATABASE || "Innovations",
      user: process.env.OPTILENS_SOURCE_MSSQL_USER || "",
      password: process.env.OPTILENS_SOURCE_MSSQL_PASSWORD || "",
      encrypt: parseBool(process.env.OPTILENS_SOURCE_MSSQL_ENCRYPT, true),
      trustServerCertificate: parseBool(process.env.OPTILENS_SOURCE_MSSQL_TRUST_CERT, true),
      mode: process.env.OPTILENS_SOURCE_MSSQL_MODE || "read-only"
    },
    writeBackEnabled: parseBool(process.env.OPTILENS_WRITEBACK_ENABLED, false)
  };
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

module.exports = { getConfig };
