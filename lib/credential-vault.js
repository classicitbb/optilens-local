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

// Ordered most- to least-specific. The vault can hold several API Keys entries
// (e.g. "Innovations Sync" and "Website API") and both carry a Base URL + API
// Key, so resolution has to be deterministic rather than "first one with a key".
const CV_API_ENTRY_MATCHERS = ["innovations sync", "classic visions", "cv api", "website api"];

/**
 * Resolve the Classic Visions API credentials from the Credentials Vault.
 *
 * The vault is the single place an operator edits credentials, and SQL Server /
 * PSQL already read from it via the merge helpers below. The CV API key used to
 * live in a second, separate store (data/pricelist/connector-config.json), so
 * saving the key in the vault had no effect on the sync — it kept sending the
 * old key until someone re-entered it in the connector screen too. Reading it
 * from here makes the vault authoritative for this credential as well.
 *
 * Returns null (not a partial) unless both fields are present, so a half-filled
 * entry never silently shadows a working configured key.
 */
// NOTE: deliberately not findVaultEntry(). That helper returns the first ENTRY
// matching any matcher, so precedence follows the operator's arbitrary ordering
// in the vault UI, not the specificity of the match — with both "Innovations
// Sync" and "Website API" present, simply dragging one above the other would
// silently swap which key the sync sends. Resolve by matcher priority instead,
// so the answer is stable regardless of entry order.
function findCvApiVaultEntry() {
  const data = readVaultData();
  const entries = data && Array.isArray(data["API Keys"]) ? data["API Keys"] : [];
  for (const matcher of CV_API_ENTRY_MATCHERS) {
    const hit = entries.find((entry) => String(entry?.name || "").toLowerCase().includes(matcher));
    if (hit) return hit;
  }
  return null;
}

function cvApiFromVault() {
  const entry = findCvApiVaultEntry();
  if (!entry) return null;
  const fields = fieldMap(entry);
  const baseUrl = String(fields.baseurl || fields.url || fields.endpoint || "").trim().replace(/\/+$/, "");
  const apiKey = String(fields.apikey || fields.token || fields.key || "").trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey, entryName: String(entry.name || "").trim() };
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
  cvApiFromVault,
  fieldMap,
  findCvApiVaultEntry,
  findVaultEntry,
  mergePsqlVaultEntry,
  mergeSqlServerVaultEntry,
  normalizeVaultData
};
