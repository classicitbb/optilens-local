const fs = require("node:fs");
const path = require("node:path");

const vaultFile = path.join(__dirname, "..", "data", "vault.json");

const DEFAULT_VAULT_TEMPLATES = {
  "Web Portals": [
    {
      name: "BeSwift Training",
      type: "Web Portals",
      fields: [
        { label: "Portal URL", val: "https://sso.training.beswift.gov.bb/", secret: false },
        { label: "Username", val: "randall.hunte", secret: false },
        { label: "Password", val: "", secret: true },
        { label: "Environment", val: "training", secret: false }
      ]
    }
  ]
};

function readVaultData() {
  try {
    if (!fs.existsSync(vaultFile)) return null;
    const vault = JSON.parse(fs.readFileSync(vaultFile, "utf8"));
    if (!vault || !vault.data) return null;
    const normalized = normalizeVaultData(vault.data);
    if (normalized.changed) {
      fs.writeFileSync(vaultFile, JSON.stringify({ ...vault, data: normalized.data }, null, 2));
    }
    return normalized.data;
  } catch {
    return null;
  }
}

function normalizeVaultData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { data, changed: false };
  }

  let changed = false;
  const next = { ...data };

  for (const [category, entries] of Object.entries(DEFAULT_VAULT_TEMPLATES)) {
    if (!Array.isArray(next[category])) {
      next[category] = [];
      changed = true;
    }

    for (const template of entries) {
      const hasEntry = next[category].some((entry) => {
        const name = String(entry?.name || "").toLowerCase();
        return name.includes(String(template.name).toLowerCase());
      });
      if (!hasEntry) {
        next[category] = next[category].concat(cloneTemplate(template));
        changed = true;
      }
    }
  }

  return { data: next, changed };
}

function cloneTemplate(template) {
  return {
    ...template,
    fields: (template.fields || []).map((field) => ({ ...field }))
  };
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
  return (entry?.fields || []).reduce((fields, field) => {
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
  fieldMap,
  findVaultEntry,
  mergePsqlVaultEntry,
  mergeSqlServerVaultEntry,
  normalizeVaultData
};
