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

function mailboxFromVault(matchers = ["classic visions orders", "classic visions", "orders mailbox"]) {
  const entry = findVaultEntry("Email", matchers);
  if (!entry) return null;
  const fields = fieldMap(entry);
  const password = String(fields.password || fields.pass || "").trim();
  const username = String(fields.username || fields.user || fields.email || "").trim();
  if (!password || !username) return null;
  return {
    host: String(fields.server || fields.host || "").trim(),
    port: Number(fields.port || 993),
    username,
    password,
    folder: String(fields.folder || "Inbox").trim() || "Inbox"
  };
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

function findQboVaultEntry() {
  return findVaultEntry("API Keys", ["quickbooks online", "quickbooks", "qbo"]);
}

const ASSISTANT_ENTRY_MATCHERS = ["assistant", "chat api", "chat", "openai", "gemini", "llm", "litellm"];

function findAssistantVaultEntry() {
  const data = readVaultData();
  const entries = data && Array.isArray(data["API Keys"]) ? data["API Keys"] : [];
  for (const matcher of ASSISTANT_ENTRY_MATCHERS) {
    const hit = entries.find((entry) => String(entry?.name || "").toLowerCase().includes(matcher));
    if (hit) return hit;
  }
  return null;
}

function assistantFromVault() {
  const entry = findAssistantVaultEntry();
  if (!entry) return null;
  const fields = fieldMap(entry);
  const apiKey = String(fields.apikey || fields.key || fields.token || fields.secret || fields.password || "").trim();
  const baseUrl = String(fields.baseurl || fields.url || fields.endpoint || "").trim().replace(/\/+$/, "");
  const model = String(fields.model || fields.modelname || "").trim();
  const provider = String(fields.provider || "").trim().toLowerCase();

  if (!apiKey && !baseUrl && !model) return null;
  return {
    apiKey: apiKey || null,
    baseUrl: baseUrl || null,
    model: model || null,
    provider: provider || null,
    entryName: String(entry.name || "").trim()
  };
}

function qboFromVault() {
  const entry = findQboVaultEntry();
  if (!entry) return null;
  const fields = fieldMap(entry);
  const clientId = String(fields.clientid || fields.client || "").trim();
  const clientSecret = String(fields.clientsecret || fields.secret || "").trim();
  const refreshToken = String(fields.refreshtoken || fields.refresh || "").trim();
  const realmId = String(fields.realmid || fields.companyid || "").trim();
  if (!clientId || !clientSecret || !refreshToken || !realmId) return null;
  return {
    clientId,
    clientSecret,
    refreshToken,
    realmId,
    accessToken: String(fields.accesstoken || fields.access || "").trim(),
    createdAt: Number(fields.createdat || 0) || 0,
    environment: String(fields.environment || "sandbox").trim().toLowerCase() === "production" ? "production" : "sandbox",
    vatZeroTaxCodeId: String(fields.vatzerotaxcodeid || "").trim() || null,
    vatStandardTaxCodeId: String(fields.vatstandardtaxcodeid || "").trim() || null,
    entryName: String(entry.name || "QuickBooks Online").trim()
  };
}

function saveQboTokens(tokens) {
  let record;
  try { record = JSON.parse(fs.readFileSync(vaultFile, "utf8")); } catch { record = null; }
  const vault = record?.data ? normalizeVaultData(record.data).data : null;
  if (!vault || !record.pinHash) throw new Error("Credentials vault is not initialized.");
  const entries = Array.isArray(vault["API Keys"]) ? vault["API Keys"] : [];
  let entry = findQboVaultEntry();
  if (!entry) {
    entry = { name: "QuickBooks Online", type: "API Keys", fields: [] };
    entries.push(entry);
  }
  const next = {
    clientId: tokens.clientId,
    clientSecret: tokens.clientSecret,
    refreshToken: tokens.refreshToken,
    realmId: tokens.realmId,
    accessToken: tokens.accessToken,
    createdAt: tokens.createdAt,
    environment: tokens.environment || "sandbox"
  };
  const labels = new Map(Object.entries(next).map(([key, value]) => [key, value]));
  const fields = Array.isArray(entry.fields) ? entry.fields : [];
  for (const [key, value] of labels) {
    const existing = fields.find((field) => normalizeFieldName(field.label) === key.toLowerCase());
    if (existing) existing.val = String(value ?? "");
    else fields.push({ label: key, val: String(value ?? ""), secret: ["clientSecret", "refreshToken", "accessToken"].includes(key) });
  }
  entry.fields = fields;
  vault["API Keys"] = entries;
  fs.writeFileSync(vaultFile, JSON.stringify({ ...record, data: vault }, null, 2));
  return qboFromVault();
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

module.exports = {
  assistantFromVault,
  cvApiFromVault,
  fieldMap,
  findCvApiVaultEntry,
  findVaultEntry,
  mailboxFromVault,
  mergeSqlServerVaultEntry,
  normalizeVaultData,
  findQboVaultEntry,
  qboFromVault,
  saveQboTokens
};
