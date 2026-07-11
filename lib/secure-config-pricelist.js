/**
 * secure-config-pricelist.js — passphrase-locked credential vault for the
 * pricelist builder connector secrets (ported from pricelist-automation).
 * Store file lives in data/pricelist/ so it's separate from other vault data.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  return {
    initialised: !!(c && c.verifier),
    optilens: o ? { url: o.url || '', anonKeyMasked: o.anonLast4 ? '••••' + o.anonLast4 : '', serviceKeyMasked: o.serviceLast4 ? '••••' + o.serviceLast4 : '', updatedAt: o.updatedAt || null } : null,
    cvapi: a ? { baseUrl: a.baseUrl || '', apiKeyMasked: a.keyLast4 ? '••••' + a.keyLast4 : '', updatedAt: a.updatedAt || null } : null,
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

function getCvApi(token) {
  const key = keyForToken(token);
  if (!key) throw new Error('Locked — unlock first.');
  const c = load();
  const a = c && c.cvapi;
  if (!a || !a.apiKey) throw new Error('API key not configured.');
  return { baseUrl: a.baseUrl || '', apiKey: dec(a.apiKey, key) };
}

function revealCvApi(token) {
  const key = keyForToken(token);
  if (!key) throw new Error('Locked — unlock first.');
  const c = load();
  const a = c && c.cvapi; if (!a) return { baseUrl: '', apiKey: '' };
  return { baseUrl: a.baseUrl || '', apiKey: a.apiKey ? dec(a.apiKey, key) : '' };
}

module.exports = { isInitialised, setPassphrase, unlock, lock, keyForToken, status, saveOptilens, getOptilens, reveal, saveCvApi, getCvApi, revealCvApi };
