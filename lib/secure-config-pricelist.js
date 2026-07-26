/**
 * secure-config-pricelist.js — passphrase-locked credential vault for the
 * pricelist builder connector secrets (ported from pricelist-automation).
 * Store file lives in data/pricelist/ so it's separate from other vault data.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const credentialVault = require('./credential-vault');

const FILE = path.join(__dirname, '..', 'data', 'pricelist', 'connector-config.json');
const TOKEN_TTL_MS = 30 * 60 * 1000;
const tokens = new Map();

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; }
}
function save(cfg) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
}

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32);
}
function enc(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex') };
}
function dec(blob, key) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'));
  d.setAuthTag(Buffer.from(blob.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(blob.data, 'hex')), d.final()]).toString('utf8');
}

function isInitialised() { const c = load(); return !!(c && c.verifier); }

function setPassphrase(passphrase) {
  if (!passphrase || passphrase.length < 6) throw new Error('Passphrase must be at least 6 characters.');
  const salt = crypto.randomBytes(16).toString('hex');
  const key = deriveKey(passphrase, salt);
  const verifier = enc('ok', key);
  save({ salt, verifier, optilens: null });
  return true;
}

function unlock(passphrase) {
  const c = load();
  if (!c || !c.verifier) throw new Error('Not initialised — set a passphrase first.');
  const key = deriveKey(passphrase, c.salt);
  try { if (dec(c.verifier, key) !== 'ok') throw 0; } catch { return null; }
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { key, expires: Date.now() + TOKEN_TTL_MS });
  return token;
}
function keyForToken(token) {
  const t = tokens.get(token);
  if (!t) return null;
  if (Date.now() > t.expires) { tokens.delete(token); return null; }
  return t.key;
}
function lock(token) { tokens.delete(token); }

function status() {
  const c = load();
  const o = c && c.optilens;
  const a = c && c.cvapi;
  // Report which store the key will actually be read from, and the last 4 of
  // the key that will actually be sent. Previously this only ever showed the
  // connector-config copy, so an operator could edit the vault, see an
  // unchanged mask here, and have no way to tell which key was really in play.
  const fromVault = credentialVault.cvApiFromVault();
  const effective = fromVault
    ? { baseUrl: fromVault.baseUrl, apiKeyMasked: '••••' + fromVault.apiKey.slice(-4), source: `vault:${fromVault.entryName}` }
    : (a ? { baseUrl: a.baseUrl || '', apiKeyMasked: a.keyLast4 ? '••••' + a.keyLast4 : '', source: 'connector-config' } : null);
  return {
    initialised: !!(c && c.verifier),
    optilens: o ? { url: o.url || '', anonKeyMasked: o.anonLast4 ? '••••' + o.anonLast4 : '', serviceKeyMasked: o.serviceLast4 ? '••••' + o.serviceLast4 : '', updatedAt: o.updatedAt || null } : null,
    cvapi: a ? { baseUrl: a.baseUrl || '', apiKeyMasked: a.keyLast4 ? '••••' + a.keyLast4 : '', updatedAt: a.updatedAt || null } : null,
    cvapiEffective: effective,
  };
}

function saveOptilens(token, { url, anonKey, serviceKey }) {
  const key = keyForToken(token);
  if (!key) throw new Error('Locked — unlock first.');
  const c = load();
  const o = c.optilens || {};
  o.url = url || o.url || '';
  if (anonKey) { o.anon = enc(anonKey, key); o.anonLast4 = anonKey.slice(-4); }
  if (serviceKey) { o.service = enc(serviceKey, key); o.serviceLast4 = serviceKey.slice(-4); }
  o.updatedAt = new Date().toISOString();
  c.optilens = o;
  save(c);
  return status();
}

function getOptilens(token, { needService = false } = {}) {
  const key = keyForToken(token);
  if (!key) throw new Error('Locked — unlock first.');
  const c = load();
  const o = c && c.optilens;
  if (!o || !o.url) throw new Error('Optilens not configured.');
  const out = { url: o.url };
  if (o.anon) out.anonKey = dec(o.anon, key);
  if (needService) { if (!o.service) throw new Error('No service-role key stored (needed for push).'); out.serviceKey = dec(o.service, key); }
  return out;
}

function reveal(token) {
  const key = keyForToken(token);
  if (!key) throw new Error('Locked — unlock first.');
  const c = load();
  const o = c && c.optilens; if (!o) return { url: '', anonKey: '', serviceKey: '' };
  return { url: o.url || '', anonKey: o.anon ? dec(o.anon, key) : '', serviceKey: o.service ? dec(o.service, key) : '' };
}

function saveCvApi(token, { baseUrl, apiKey }) {
  const key = keyForToken(token);
  if (!key) throw new Error('Locked — unlock first.');
  const c = load();
  const a = c.cvapi || {};
  if (baseUrl != null) a.baseUrl = String(baseUrl).trim().replace(/\/$/, '');
  if (apiKey) { a.apiKey = enc(apiKey, key); a.keyLast4 = apiKey.slice(-4); }
  a.updatedAt = new Date().toISOString();
  c.cvapi = a;
  save(c);
  return status();
}

/**
 * Resolve the CV API credentials actually used by the sync and live gateway.
 *
 * Order: Credentials Vault first, this encrypted store second.
 *
 * The vault is the operator-facing place credentials are edited, and it is
 * already authoritative for SQL Server and PSQL. Having the CV API key live
 * only here meant saving it in the vault changed nothing — the sync kept
 * sending a stale, revoked key with no indication why. The vault now wins, and
 * this store remains as a fallback so existing installs keep working until
 * their key is moved.
 *
 * The unlock token is still required even on the vault path. Reading the key is
 * a privileged operation and every caller already holds a token; dropping that
 * check would quietly widen access to the endpoints that call this.
 */
function getCvApi(token) {
  const key = keyForToken(token);
  if (!key) throw new Error('Locked — unlock first.');

  const fromVault = credentialVault.cvApiFromVault();
  if (fromVault) {
    return { baseUrl: fromVault.baseUrl, apiKey: fromVault.apiKey, source: `vault:${fromVault.entryName}` };
  }

  const c = load();
  const a = c && c.cvapi;
  if (!a || !a.apiKey) {
    throw new Error('API key not configured. Add an "API Keys" entry with a Base URL and API Key in the Credentials Vault.');
  }
  return { baseUrl: a.baseUrl || '', apiKey: dec(a.apiKey, key), source: 'connector-config' };
}

function revealCvApi(token) {
  const key = keyForToken(token);
  if (!key) throw new Error('Locked — unlock first.');
  const c = load();
  const a = c && c.cvapi; if (!a) return { baseUrl: '', apiKey: '' };
  return { baseUrl: a.baseUrl || '', apiKey: a.apiKey ? dec(a.apiKey, key) : '' };
}

module.exports = { isInitialised, setPassphrase, unlock, lock, keyForToken, status, saveOptilens, getOptilens, reveal, saveCvApi, getCvApi, revealCvApi };
