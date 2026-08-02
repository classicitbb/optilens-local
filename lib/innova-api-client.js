/**
 * innova-api-client.js — minimal client for the real InnovaAPI (OpenAPI spec:
 * docs/innova api - prototype.htm, servers: /api/v2).
 *
 * Scope: exactly what order submission needs —
 *   GET  /user_authentication   (basicAuth + x-api-key)  → bearer jwtToken
 *   POST /process_rxi           ({ RXIRequest: { mode, RXIData } })
 *                               → { data: { RXTResponse: { resultCode, resultMessage, RXTData } } }
 *
 * Credentials never leave this box (same trust boundary as the Zen DB and
 * the customer sync). Config resolution order:
 *   1. env: INNOVA_API_BASE / INNOVA_API_KEY / INNOVA_API_USER / INNOVA_API_PASSWORD
 *   2. credential vault entry whose name contains "innova" (fields: baseurl/url,
 *      apikey/key, username/user, password)
 *   3. data/innova-api.json ({ baseUrl, apiKey, username, password })
 * Returns null from getConfig() when nothing is configured — callers treat
 * that as "API transport unavailable, use the file drop".
 */
const fs = require('node:fs');
const path = require('node:path');
const { findVaultEntry, fieldMap } = require('./credential-vault');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'innova-api.json');
const DEFAULT_TIMEOUT_MS = Number(process.env.INNOVA_API_TIMEOUT_MS ?? 30000);

let cachedToken = null; // { jwtToken, expiresAt(ms) }

function fromEnv() {
  const baseUrl = (process.env.INNOVA_API_BASE || '').trim();
  const apiKey = (process.env.INNOVA_API_KEY || '').trim();
  const username = (process.env.INNOVA_API_USER || '').trim();
  const password = (process.env.INNOVA_API_PASSWORD || '').trim();
  if (baseUrl && apiKey && username && password) return { baseUrl, apiKey, username, password, source: 'env' };
  return null;
}

function fromVault() {
  // Try the categories the vault actually uses; entry name just has to
  // mention "innova".
  for (const category of ['API', 'APIs', 'Other', 'Web', 'SQL Server']) {
    const entry = findVaultEntry(category, ['innovaapi', 'innova api', 'innova']);
    if (!entry) continue;
    const f = fieldMap(entry);
    const baseUrl = String(f.baseurl || f.url || f.endpoint || '').trim().replace(/\/+$/, '');
    const apiKey = String(f.apikey || f.key || f.token || '').trim();
    const username = String(f.username || f.user || '').trim();
    const password = String(f.password || '').trim();
    if (baseUrl && apiKey && username && password) return { baseUrl, apiKey, username, password, source: `vault:${entry.name}` };
  }
  return null;
}

function fromFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const baseUrl = String(raw.baseUrl || '').trim().replace(/\/+$/, '');
    if (baseUrl && raw.apiKey && raw.username && raw.password) {
      return { baseUrl, apiKey: String(raw.apiKey), username: String(raw.username), password: String(raw.password), source: 'file' };
    }
  } catch { /* not configured via file */ }
  return null;
}

function getConfig() {
  return fromEnv() || fromVault() || fromFile();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Authenticate and cache the bearer token until shortly before expiry. */
async function getToken(config = getConfig()) {
  if (!config) throw new Error('InnovaAPI is not configured.');
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.jwtToken;
  const basic = Buffer.from(`${config.username}:${config.password}`).toString('base64');
  const res = await fetchWithTimeout(`${config.baseUrl}/user_authentication`, {
    headers: { Authorization: `Basic ${basic}`, 'x-api-key': config.apiKey },
  });
  if (!res.ok) throw new Error(`InnovaAPI auth failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json().catch(() => ({}));
  const tok = body?.data?.userAuthenticationToken;
  if (!tok?.jwtToken) throw new Error('InnovaAPI auth returned no jwtToken.');
  const expiresMs = tok.expires ? Date.parse(tok.expires) : Date.now() + 10 * 60 * 1000;
  cachedToken = { jwtToken: tok.jwtToken, expiresAt: (Number.isFinite(expiresMs) ? expiresMs : Date.now() + 10 * 60 * 1000) - 60 * 1000 };
  return cachedToken.jwtToken;
}

/**
 * Submit RXI text. Returns { resultCode, resultMessage, RXTData }.
 * Retries once on a 401 (expired token).
 */
async function processRxi(rxiData, mode = 1, config = getConfig()) {
  if (!config) throw new Error('InnovaAPI is not configured.');
  let token = await getToken(config);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetchWithTimeout(`${config.baseUrl}/process_rxi`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-api-key': config.apiKey },
      body: JSON.stringify({ RXIRequest: { mode, RXIData: rxiData } }),
    });
    if (res.status === 401 && attempt === 0) {
      cachedToken = null;
      token = await getToken(config);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`process_rxi failed: ${res.status} ${text.slice(0, 300)}`);
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`process_rxi returned non-JSON: ${text.slice(0, 300)}`); }
    const r = body?.data?.RXTResponse ?? body?.RXTResponse ?? body;
    return {
      resultCode: r?.resultCode ?? null,
      resultMessage: r?.resultMessage ?? null,
      RXTData: r?.RXTData ?? null,
    };
  }
  throw new Error('process_rxi: unreachable retry state');
}

module.exports = { getConfig, getToken, processRxi };
