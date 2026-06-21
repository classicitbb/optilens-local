const fs = require("node:fs");
const path = require("node:path");

const vaultFile = path.join(__dirname, "..", "data", "vault.json");

function readVaultData() {
  try {
    if (!fs.existsSync(vaultFile)) return null;
    const vault = JSON.parse(fs.readFileSync(vaultFile, "utf8"));
    return vault && vault.data ? vault.data : null;
  } catch {
    return null;
  }
}

function findVaultEntry(category, matchers) {
  const data = readVaultData();
  const entries = data && Array.isArray(data[category]) ? data[category] : [];
  const tests = matchers.map((matcher) => String(matcher).toLowerCase());

  return entries.find((entry) => {
    const name = String(entry.name || "").toLowerCase();
    return tests.some((matcher) => name.includes(matcher));
  }) || null;
}

function findSqlServerEntry(matchers) {
  return findVaultEntry("SQL Server", matchers);
}

function findPsqlEntry(matchers) {
  return findVaultEntry("PSQL", matchers);
}

function fieldMap(entry) {
  return (entry.fields || []).reduce((fields, field) => {
    const key = normalizeFieldName(field.label);
    if (key) fields[key] = field.val;
    return fields;
  }, {});
}

function normalizeFieldName(label) {
  return String(label || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function mergeSqlServerVaultEntry(baseConfig, matchers) {
  const entry = findSqlServerEntry(matchers);
  if (!entry) return baseConfig;

  const fields = fieldMap(entry);
  const password = fields.password || fields.pwd || "";

  if (!password) return baseConfig;

  return {
    ...baseConfig,
    server: fields.server || fields.host || baseConfig.server,
    database: fields.database || fields.db || baseConfig.database,
    user: fields.username || fields.user || fields.userid || baseConfig.user,
    password,
    encrypt: parseBool(fields.encrypt, baseConfig.encrypt),
    trustServerCertificate: parseBool(
      fields.trustcert || fields.trustservercertificate,
      baseConfig.trustServerCertificate
    )
  };
}

function mergePsqlVaultEntry(baseConfig, matchers) {
  const entry = findPsqlEntry(matchers);
  if (!entry) return baseConfig;

  const fields = fieldMap(entry);
  const password = fields.password || fields.pwd || "";

  if (!password) return baseConfig;

  return {
    ...baseConfig,
    dsn: fields.dsn || fields.dsnname || baseConfig.dsn,
    host: fields.host || fields.server || baseConfig.host,
    port: Number(fields.port || baseConfig.port),
    database: fields.database || fields.db || baseConfig.database,
    user: fields.username || fields.user || fields.userid || baseConfig.user,
    password
  };
}

module.exports = {
  mergePsqlVaultEntry,
  mergeSqlServerVaultEntry
};
