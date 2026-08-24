'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { protectString, unprotectString } = require('./windows-protected-store');
<<<<<<< Updated upstream

const STORE_FILES = {
  sandbox: path.join(__dirname, '..', 'data', 'qbo-sandbox-secrets.json'),
  production: path.join(__dirname, '..', 'data', 'qbo-production-secrets.json')
};

function supportedEnvironment(environment) {
  return environment === 'sandbox' || environment === 'production';
}

function fileFor(environment) {
  if (!supportedEnvironment(environment)) throw new Error('QBO environment must be sandbox or production.');
  return STORE_FILES[environment];
}

function load(environment) {
  try { return JSON.parse(unprotectString(fs.readFileSync(fileFor(environment), 'utf8'))); } catch { return null; }
}

function save(value) {
  const environment = String(value?.environment || '').trim().toLowerCase();
  const file = fileFor(environment);
  const normalized = { ...value, environment };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, protectString(JSON.stringify(normalized)), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return load(environment);
}

function configured(environment) {
  const value = load(environment);
  return value && value.environment === environment && value.clientId && value.clientSecret && value.refreshToken && value.realmId ? value : null;
}

module.exports = { STORE_FILES, configured, fileFor, load, save, supportedEnvironment };
=======
const DEFAULT_ENVIRONMENT = 'sandbox';
function normalizeEnvironment(value) { return String(value || DEFAULT_ENVIRONMENT).trim().toLowerCase() === 'production' ? 'production' : 'sandbox'; }
function environmentFromProcess() { return normalizeEnvironment(process.env.OPTILENS_QBO_ENVIRONMENT); }
function fileFor(environment) { return path.join(__dirname, '..', 'data', `qbo-${normalizeEnvironment(environment)}-secrets.json`); }
function load(environment = environmentFromProcess()) { try { return JSON.parse(unprotectString(fs.readFileSync(fileFor(environment), 'utf8'))); } catch { return null; } }
function save(value, environment = value?.environment || environmentFromProcess()) {
  const selected = normalizeEnvironment(environment);
  const next = { ...value, environment: selected };
  const file = fileFor(selected);
  fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, protectString(JSON.stringify(next)), { mode: 0o600 }); fs.renameSync(tmp, file); return load(selected);
}
function configured(environment = environmentFromProcess()) {
  const selected = normalizeEnvironment(environment); const value = load(selected);
  return value && value.environment === selected && value.clientId && value.clientSecret && value.refreshToken && value.realmId ? value : null;
}
module.exports = { configured, environmentFromProcess, fileFor, load, normalizeEnvironment, save };
>>>>>>> Stashed changes
