const fs = require("node:fs");
const path = require("node:path");
const { protectString, unprotectString } = require("./windows-protected-store");

const DEFAULT_STATE_FILE = path.join(__dirname, "..", "data", "live-gateway-autostart.json");

function createLiveGatewayAutostart(options = {}) {
  const stateFile = options.stateFile || DEFAULT_STATE_FILE;
  const protect = options.protect || protectString;
  const unprotect = options.unprotect || unprotectString;

  function save(credentials) {
    const normalized = normalizeCredentials(credentials);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      enabled: true,
      protectedCredentials: protect(JSON.stringify(normalized)),
      updatedAt: new Date().toISOString(),
    }, null, 2));
    return status();
  }

  function load() {
    const state = readState();
    if (!state.enabled || !state.protectedCredentials) return null;
    return normalizeCredentials(JSON.parse(unprotect(state.protectedCredentials)));
  }

  function clear() {
    try {
      fs.rmSync(stateFile, { force: true });
    } catch {
      // A failed cleanup should not keep the live worker running.
    }
    return status();
  }

  function status() {
    const state = readState();
    return {
      enabled: !!(state.enabled && state.protectedCredentials),
      updatedAt: state.updatedAt || null,
    };
  }

  function readState() {
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      return {};
    }
  }

  return { save, load, clear, status };
}

function normalizeCredentials(credentials) {
  const apiKey = String(credentials?.apiKey || "");
  if (!apiKey) throw new Error("CV API key is required for live gateway autostart.");
  return {
    baseUrl: String(credentials?.baseUrl || ""),
    apiKey,
  };
}

module.exports = Object.assign(createLiveGatewayAutostart(), {
  createLiveGatewayAutostart,
  normalizeCredentials,
});
