'use strict';

/**
 * innovations-console.js — server side of the Innovations Console module, a
 * replica of the vendor's Innovations REST web client (Tracking, Status Update,
 * Rx Job Details, Stock). It talks to the same vendor REST service the original
 * page used (ISAPIRest, `<host>/rest/`) so the vendor's own rules run for every
 * read and write; nothing here touches the Innovations database directly and
 * nothing is shared with the Job Floor module.
 *
 * Wire protocol (from the vendor's innovations-1.0.js): every call is a JSON
 * body carrying `token`; the reply is `{ result: [ { ..., token? } ] }` and the
 * first element is the payload. `GetLogin/` exchanges {user,password} for a JWT
 * whose payload says `valid`.
 *
 * Config resolution (credentials never leave this box, never go in Git):
 *   1. env: INNOVATIONS_REST_BASE / INNOVATIONS_REST_USER / INNOVATIONS_REST_PASSWORD
 *      (INNOVATIONS_REST_INSECURE_TLS=true accepts a self-signed server certificate)
 *   2. credential vault entry whose name contains "innovations rest"
 *      (fields: baseurl/url, username/user, password, insecuretls)
 *   3. data/innovations-rest.json ({ baseUrl, username, password, insecureTls })
 *
 * Reads are always available. The two writes (UpdateStatus, AdjustStock) change
 * the source system, so they run only when the `innovations_console.writes_enabled`
 * app setting (or INNOVATIONS_CONSOLE_WRITES_ENABLED) is "true", and every
 * attempt, refusal and failure is audited.
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { findVaultEntry, fieldMap } = require('./credential-vault');
const { getSetting } = require('./app-settings');
const { recordAuditEvent } = require('./audit');

const MODULE_CODE = 'innovations-console';
const WRITES_SETTING = 'innovations_console.writes_enabled';
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'innovations-rest.json');
const TIMEOUT_MS = Number(process.env.INNOVATIONS_REST_TIMEOUT_MS ?? 20000);

class ConsoleError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = 'InnovationsConsoleError';
    this.statusCode = status;
    this.code = code;
  }
}

const present = (v) => v !== null && v !== undefined && String(v).trim() !== '';
const truthy = (v) => ['1', 'true', 'yes'].includes(String(v ?? '').trim().toLowerCase());

// ---- configuration -------------------------------------------------------

function normaliseBase(url) {
  const s = String(url || '').trim();
  return s ? s.replace(/\/+$/, '') + '/' : '';
}

function fromEnv() {
  const baseUrl = normaliseBase(process.env.INNOVATIONS_REST_BASE);
  const username = (process.env.INNOVATIONS_REST_USER || '').trim();
  const password = (process.env.INNOVATIONS_REST_PASSWORD || '').trim();
  if (baseUrl && username && password) {
    return { baseUrl, username, password, insecureTls: truthy(process.env.INNOVATIONS_REST_INSECURE_TLS), source: 'env' };
  }
  return null;
}

function fromVault() {
  for (const category of ['API', 'APIs', 'Other', 'Web', 'SQL Server']) {
    const entry = findVaultEntry(category, ['innovations rest', 'innovationsrest', 'isapirest']);
    if (!entry) continue;
    const f = fieldMap(entry);
    const baseUrl = normaliseBase(f.baseurl || f.url || f.endpoint);
    const username = String(f.username || f.user || '').trim();
    const password = String(f.password || '').trim();
    if (baseUrl && username && password) {
      return { baseUrl, username, password, insecureTls: truthy(f.insecuretls), source: `vault:${entry.name}` };
    }
  }
  return null;
}

function fromFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const baseUrl = normaliseBase(raw.baseUrl);
    if (baseUrl && raw.username && raw.password) {
      return { baseUrl, username: String(raw.username), password: String(raw.password), insecureTls: truthy(raw.insecureTls), source: 'file' };
    }
  } catch { /* not configured via file */ }
  return null;
}

function getConfig() {
  return fromEnv() || fromVault() || fromFile();
}

// ---- transport -----------------------------------------------------------

/** One HTTP exchange; returns the parsed JSON body. A seam: tests replace it. */
function httpJson(config, method, endpoint, body) {
  const url = new URL(endpoint, config.baseUrl);
  const lib = url.protocol === 'http:' ? http : https;
  const payload = JSON.stringify(body ?? {});
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method,
      timeout: TIMEOUT_MS,
      rejectUnauthorized: !config.insecureTls,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new ConsoleError(`Innovations REST ${endpoint} returned HTTP ${res.statusCode}.`, 502));
        }
        try { resolve(JSON.parse(text)); } catch { reject(new ConsoleError(`Innovations REST ${endpoint} returned non-JSON.`, 502)); }
      });
    });
    req.on('timeout', () => req.destroy(new ConsoleError(`Innovations REST ${endpoint} timed out.`, 504)));
    req.on('error', (e) => reject(e instanceof ConsoleError ? e : new ConsoleError(`Innovations REST unreachable: ${e.code || e.message}`, 502)));
    req.end(payload);
  });
}

function decodeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return null; }
}

let cachedToken = null; // { token, expiresAt }

function resetSession() { cachedToken = null; }

async function login(config, deps) {
  const body = await deps.httpJson(config, 'POST', 'GetLogin/', { user: config.username, password: config.password, token: '' });
  const result = body?.result?.[0];
  const claims = decodeJwtPayload(result?.token);
  if (!result?.token || !claims?.valid) throw new ConsoleError('Innovations REST login was rejected for the configured account.', 502, 'login_rejected');
  const exp = Number(claims.exp);
  cachedToken = { token: result.token, expiresAt: Number.isFinite(exp) && exp > 0 ? exp - 30000 : Date.now() + 5 * 60 * 1000 };
  return cachedToken.token;
}

async function currentToken(config, deps) {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  return login(config, deps);
}

/** Authenticated call; one re-login retry when the token has gone invalid. */
async function call(method, endpoint, data = {}, deps = defaultDeps) {
  const config = deps.getConfig();
  if (!config) throw new ConsoleError('The Innovations REST service is not configured for this host.', 503, 'not_configured');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await currentToken(config, deps);
    const body = await deps.httpJson(config, method, endpoint, { ...data, token });
    const result = body?.result?.[0];
    if (!result) throw new ConsoleError(`Innovations REST ${endpoint} returned no result.`, 502);
    if (result.token) cachedToken = { token: result.token, expiresAt: cachedToken?.expiresAt ?? Date.now() + 5 * 60 * 1000 };
    const claims = decodeJwtPayload(result.token || token);
    if (claims && claims.valid === false && attempt === 0) { resetSession(); continue; }
    return result;
  }
  throw new ConsoleError('Innovations REST session could not be established.', 502);
}

const defaultDeps = { getConfig, httpJson, getSetting, recordAuditEvent };

// ---- helpers -------------------------------------------------------------

async function writesEnabled(deps = defaultDeps) {
  const env = String(process.env.INNOVATIONS_CONSOLE_WRITES_ENABLED ?? '').trim().toLowerCase();
  if (env) return env === 'true';
  return String(await deps.getSetting(WRITES_SETTING).catch(() => null)).toLowerCase() === 'true';
}

function status(deps = defaultDeps) {
  const config = deps.getConfig();
  return Promise.resolve(writesEnabled(deps)).then((writes) => ({
    configured: Boolean(config),
    configSource: config?.source ?? null,
    host: config ? new URL(config.baseUrl).host : null,
    writesEnabled: writes,
  }));
}

// ---- reads ---------------------------------------------------------------

const TRACKING_FIELDS = { AccountID: 'AccountID', TrayID: 'TrayID', OrderID: 'OrderID', RxID: 'RxID', PatientID: 'PatientID' };

/** Tracking search by exactly one of AccountID, TrayID, OrderID, RxID, PatientID. */
async function getTracking({ searchType, value }, deps = defaultDeps) {
  const field = TRACKING_FIELDS[searchType];
  if (!field) throw new ConsoleError('Search type must be AccountID, TrayID, OrderID, RxID or PatientID.');
  if (!present(value)) throw new ConsoleError('Enter a value to search for.');
  const data = { TrayID: '', AccountID: '', OrderID: 0, RxID: '', PatientID: '' };
  data[field] = field === 'OrderID' ? Number(value) : String(value).trim();
  if (field === 'OrderID' && !Number.isInteger(data.OrderID)) throw new ConsoleError('Order ID must be a whole number.');
  return call('POST', 'GetTrackingData/', data, deps);
}

async function listStatusItems(deps = defaultDeps) {
  return call('GET', 'GetStatusItemList/', {}, deps);
}

async function getRxDetails({ trayId }, deps = defaultDeps) {
  if (!present(trayId)) throw new ConsoleError('Enter a tray ID.');
  return call('POST', 'GetRxDetails/', { TrayID: String(trayId).trim() }, deps);
}

async function getStockDescription({ opc }, deps = defaultDeps) {
  if (!present(opc)) throw new ConsoleError('Enter an OPC.');
  return call('POST', 'GetDescription/', { OPC: String(opc).trim() }, deps);
}

async function getSkin(deps = defaultDeps) {
  return call('GET', 'GetSkin/', {}, deps);
}

// ---- gated writes --------------------------------------------------------

async function guardedWrite({ eventType, entityType, entityId, request, actorUserId }, run, deps) {
  const audit = (suffix, extra = {}) => deps.recordAuditEvent({
    moduleCode: MODULE_CODE, actorUserId, eventType: `innovations_console.${eventType}.${suffix}`,
    entityType, entityId: String(entityId), eventData: { request, ...extra },
  }).catch(() => {});
  if (!(await writesEnabled(deps))) {
    await audit('refused', { reason: 'writes disabled' });
    throw new ConsoleError('Source-system writes are disabled for the Innovations Console.', 403, 'writes_disabled');
  }
  await audit('attempted');
  try {
    const result = await run();
    await audit('succeeded', { response: { processed: result?.processed, processMessage: result?.processMessage } });
    return result;
  } catch (error) {
    await audit('failed', { error: String(error.message).slice(0, 300) });
    throw error;
  }
}

/** Status Update by tray, exactly as the vendor page posts it. */
async function updateStatus({ trayId, statusId, timestamp }, { actorUserId = null } = {}, deps = defaultDeps) {
  if (!present(trayId)) throw new ConsoleError('Enter a tray ID.');
  const id = Number(statusId);
  if (!Number.isInteger(id) || id <= 0) throw new ConsoleError('Choose a status.');
  const request = { TrayID: String(trayId).trim(), StatusID: id, timestamp: Number(timestamp) || Date.now() };
  return guardedWrite({ eventType: 'update_status', entityType: 'tray', entityId: request.TrayID, request, actorUserId },
    () => call('POST', 'UpdateStatus/', request, deps), deps);
}

/** Stock adjustment by OPC; `qty` may be negative. */
async function adjustStock({ opc, qty }, { actorUserId = null } = {}, deps = defaultDeps) {
  if (!present(opc)) throw new ConsoleError('An OPC is required.');
  const n = Number(qty);
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 10000) throw new ConsoleError('Quantity must be a non-zero whole number.');
  const request = { OPC: String(opc).trim(), qty: n };
  return guardedWrite({ eventType: 'adjust_stock', entityType: 'opc', entityId: request.OPC, request, actorUserId },
    () => call('POST', 'AdjustStock/', request, deps), deps);
}

module.exports = {
  ConsoleError, WRITES_SETTING, getConfig, writesEnabled, status, resetSession, decodeJwtPayload,
  getTracking, listStatusItems, getRxDetails, getStockDescription, getSkin, updateStatus, adjustStock,
};
