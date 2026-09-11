// Standalone PIN gate for the Chemistrie clip module's shop-floor tablet
// page. Deliberately independent of core.users / the platform login cookie:
// per the module's design decision, the tablet stays signed in on one
// shared PIN rather than a per-person login, while still satisfying
// AGENTS.md's "change-capable endpoints require authentication" rule. Not
// a secrets vault -- do not reuse for anything that needs per-user audit
// identity.
const fs = require("node:fs");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
const { protectString, unprotectString } = require("./windows-protected-store");

const dataDir = path.join(__dirname, "..", "data");
const configFile = path.join(dataDir, "chemistry-pin.json");
const sessionFile = path.join(dataDir, "chemistry-pin-sessions.protected");
const SALT = "optilens-chemistry-pin-v1";
const COOKIE_NAME = "optilens_chemistry_session";
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days -- avoid mid-shift re-prompts

const sessions = loadSessions(); // token -> expiresAt

function hashPin(pin) {
  return nodeCrypto.createHash("sha256").update(String(pin) + SALT).digest("base64");
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch {
    return { pinHash: null };
  }
}

function writeConfig(config) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function loadSessions() {
  try {
    const serialized = unprotectString(fs.readFileSync(sessionFile, "utf8"));
    const entries = JSON.parse(serialized);
    const now = Date.now();
    const valid = (Array.isArray(entries) ? entries : []).filter(
      ([token, expiresAt]) => typeof token === "string" && /^[a-f0-9]{64}$/i.test(token) && Number(expiresAt) > now
    );
    return new Map(valid.map(([token, expiresAt]) => [token, Number(expiresAt)]));
  } catch {
    return new Map();
  }
}

function persistSessions() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const temporaryFile = `${sessionFile}.tmp`;
    fs.writeFileSync(temporaryFile, protectString(JSON.stringify([...sessions])), { mode: 0o600 });
    fs.renameSync(temporaryFile, sessionFile);
  } catch (error) {
    console.error("Could not persist chemistry PIN sessions:", error.message);
  }
}

function getState() {
  return { hasPin: !!readConfig().pinHash };
}

// First-time setup only -- once a PIN is configured, setup is refused until
// an explicit reset. Not gated by a platform login (the PIN gate IS the
// gate for this module), so whoever is physically at the shop-floor
// terminal when it's first configured sets it. Acceptable on a LAN-only,
// non-internet-exposed host per AGENTS.md; do not loosen that exposure.
function setupPin(pin) {
  if (!pin || String(pin).length < 4) {
    throw Object.assign(new Error("PIN must be at least 4 characters."), { statusCode: 400 });
  }
  const existing = readConfig();
  if (existing.pinHash) {
    throw Object.assign(new Error("A PIN is already configured. Reset it first."), { statusCode: 409 });
  }
  writeConfig({ pinHash: hashPin(pin) });
  return createSession();
}

function resetPin(currentPin, newPin) {
  const config = readConfig();
  if (config.pinHash && hashPin(currentPin) !== config.pinHash) {
    throw Object.assign(new Error("Incorrect current PIN."), { statusCode: 401 });
  }
  if (!newPin || String(newPin).length < 4) {
    throw Object.assign(new Error("PIN must be at least 4 characters."), { statusCode: 400 });
  }
  writeConfig({ pinHash: hashPin(newPin) });
  sessions.clear();
  persistSessions();
  return createSession();
}

function unlock(pin) {
  const config = readConfig();
  if (!config.pinHash) throw Object.assign(new Error("Chemistry PIN is not configured yet."), { statusCode: 404 });
  if (hashPin(pin) !== config.pinHash) throw Object.assign(new Error("Incorrect PIN."), { statusCode: 401 });
  return createSession();
}

function createSession() {
  const token = nodeCrypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL);
  persistSessions();
  return token;
}

function validateToken(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    sessions.delete(token);
    persistSessions();
    return false;
  }
  return true;
}

function destroySession(token) {
  if (sessions.delete(token)) persistSessions();
}

function parseCookies(cookieHeader) {
  return String(cookieHeader || "").split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");
    if (index < 0) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function setSessionCookie(res, token) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(SESSION_TTL / 1000)}`
  ];
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

// Route guard: throws 401 when the tablet has not unlocked with the PIN.
function requireChemistrySession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME] || "";
  if (!validateToken(token)) {
    throw Object.assign(new Error("Chemistry session locked. Enter the PIN."), { statusCode: 401 });
  }
  return true;
}

module.exports = {
  COOKIE_NAME,
  getState,
  setupPin,
  resetPin,
  unlock,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  requireChemistrySession,
  parseCookies
};
