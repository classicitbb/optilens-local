// Site settings: the values that differ from one lab to the next and used to be
// edited by hand in data/rx/config.json (lab number, operator, agent name and the
// Innovations folders). They live in the private app database
// (core.app_settings, key rx.site-settings) and are layered over the checked-in
// defaults, so a new site is configured from the RX Capture page instead of by
// editing files. The Credentials Vault's incoming-folder entry still wins for
// the incoming folder, as before.
const path = require("node:path");
const { getEdition } = require("./edition");

const SETTINGS_KEY = "rx.site-settings";

const FIELDS = [
  { key: "labNum", label: "Lab number", max: 30, kind: "text" },
  { key: "custSeqNum", label: "Customer sequence", max: 30, kind: "text" },
  { key: "remoteOperator", label: "Remote operator", max: 80, kind: "text" },
  { key: "agentName", label: "Agent name", max: 40, kind: "text" },
  { key: "incomingFolder", label: "Innovations incoming folder", max: 500, kind: "folder" },
  { key: "stagingFolder", label: "Staging folder", max: 500, kind: "folder" },
  { key: "archiveFolder", label: "Archive folder", max: 500, kind: "folder" }
];

// What a licensed site must save before it may send a file to Innovations, so a
// new lab never goes out under another lab's number.
const REQUIRED_BEFORE_RELEASE = ["labNum", "remoteOperator", "incomingFolder"];

function inputError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function isAbsoluteFolder(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("//") || path.isAbsolute(value);
}

// Returns the cleaned settings. Blank values are dropped (they fall back to the
// defaults); anything present must be well formed.
function normaliseSiteSettings(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const cleaned = {};
  for (const field of FIELDS) {
    const text = String(source[field.key] ?? "").replace(/[\r\n\t]+/g, " ").trim();
    if (!text) continue;
    if (text.length > field.max) throw inputError(`${field.label} must be ${field.max} characters or fewer.`);
    if (field.kind === "folder") {
      if (text.includes("\0") || /[<>"|?*]/.test(text.replace(/^[A-Za-z]:/, ""))) throw inputError(`${field.label} contains characters a folder name cannot have.`);
      // Folders that hold files for Innovations must be a full path; the app's own
      // staging and archive folders may stay relative to the application folder.
      if (field.key === "incomingFolder" && !isAbsoluteFolder(text)) throw inputError("The incoming folder must be a full path such as D:\\Innovations\\Incoming or \\\\server\\share\\Incoming.");
    } else if (/[^\x20-\x7e]/.test(text)) {
      throw inputError(`${field.label} must use plain letters, digits and punctuation.`);
    }
    cleaned[field.key] = text;
  }
  if (cleaned.labNum && !/^[A-Za-z0-9_-]+$/.test(cleaned.labNum)) throw inputError("Lab number can only contain letters, digits, hyphens and underscores.");
  if (cleaned.custSeqNum && !/^[0-9]+$/.test(cleaned.custSeqNum)) throw inputError("Customer sequence must be a number.");
  return cleaned;
}

function parseStored(value) {
  if (!value) return null;
  try { return normaliseSiteSettings(JSON.parse(value)); } catch { return null; }
}

// Layers saved settings over the checked-in defaults. Pure, so it is easy to test.
function applySiteSettings(config, settings) {
  if (!settings || !Object.keys(settings).length) return config;
  const defaults = { ...config.defaults };
  if (settings.labNum) defaults.labNum = settings.labNum;
  if (settings.custSeqNum) defaults.custSeqNum = settings.custSeqNum;
  if (settings.remoteOperator) defaults.remoteOperator = settings.remoteOperator;
  if (settings.agentName) defaults.agentName = settings.agentName;
  const folders = { ...config.folders };
  if (settings.incomingFolder) folders.incoming = settings.incomingFolder;
  if (settings.stagingFolder) folders.staging = settings.stagingFolder;
  if (settings.archiveFolder) folders.archive = settings.archiveFolder;
  return { ...config, defaults, folders };
}

function missingForRelease(settings) {
  return REQUIRED_BEFORE_RELEASE.filter((key) => !settings?.[key]);
}

function createSiteSettingsStore(dependencies = {}) {
  const read = dependencies.getSetting || (async (key) => require("./app-settings").getSetting(key));
  const write = dependencies.setSetting || (async (key, value, by) => require("./app-settings").setSetting(key, value, by));
  const edition = dependencies.getEdition || getEdition;
  let cached = null;

  // The generator reads its configuration synchronously, so the saved settings are
  // kept in memory: loaded at startup and refreshed on every save.
  async function refresh() {
    cached = parseStored(await read(SETTINGS_KEY));
    return cached;
  }

  async function save(value, actor) {
    const cleaned = normaliseSiteSettings(value);
    await write(SETTINGS_KEY, JSON.stringify(cleaned), actor?.username || actor?.userId || "unknown");
    cached = cleaned;
    return cleaned;
  }

  // A licensed site may not send files until its own lab details are saved.
  function assertReady() {
    if (!edition().restricted) return;
    const missing = missingForRelease(cached);
    if (missing.length) {
      const labels = missing.map((key) => FIELDS.find((field) => field.key === key).label.toLowerCase());
      throw Object.assign(new Error(`An administrator must save Site settings (${labels.join(", ")}) before the first submission to Innovations.`), { statusCode: 409 });
    }
  }

  return { refresh, save, assertReady, current: () => cached };
}

const store = createSiteSettingsStore();

module.exports = {
  FIELDS,
  REQUIRED_BEFORE_RELEASE,
  applySiteSettings,
  createSiteSettingsStore,
  missingForRelease,
  normaliseSiteSettings,
  siteSettings: store
};
