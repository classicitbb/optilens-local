'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { protectString, unprotectString } = require('./windows-protected-store');

const DEFAULT_ENVIRONMENT = 'sandbox';
const STORE_FILES = {
  sandbox: path.join(__dirname, '..', 'data', 'qbo-sandbox-secrets.json'),
  production: path.join(__dirname, '..', 'data', 'qbo-production-secrets.json')
};

function normalizeEnvironment(value) {
  const environment = String(value || DEFAULT_ENVIRONMENT).trim().toLowerCase();
  if (environment !== 'sandbox' && environment !== 'production') throw new Error('QBO environment must be sandbox or production.');
  return environment;
}

function environmentFromProcess() { return normalizeEnvironment(process.env.OPTILENS_QBO_ENVIRONMENT); }
function fileFor(environment) { return STORE_FILES[normalizeEnvironment(environment)]; }

// A store holding only the application identity can complete an authorization-code
// exchange. Minting access tokens additionally requires a refresh token, so the
// bootstrap check is deliberately weaker than the operational one.
function hasBootstrapFields(value, environment) {
  return Boolean(value && value.environment === environment && value.clientId && value.clientSecret && value.realmId);
}
function hasCompleteFields(value, environment) {
  return hasBootstrapFields(value, environment) && Boolean(value.refreshToken);
}

function load(environment = environmentFromProcess()) {
  try { return JSON.parse(unprotectString(fs.readFileSync(fileFor(environment), 'utf8'))); } catch { return null; }
}

function save(value, environment = value?.environment || environmentFromProcess()) {
  const selected = normalizeEnvironment(environment);
  const next = { ...value, environment: selected };
  const file = fileFor(selected);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.tmp`;
  fs.writeFileSync(temporaryFile, protectString(JSON.stringify(next)), { mode: 0o600 });
  fs.renameSync(temporaryFile, file);
  return load(selected);
}

function configured(environment = environmentFromProcess()) {
  const selected = normalizeEnvironment(environment);
  const value = load(selected);
  return hasCompleteFields(value, selected) ? value : null;
}

function bootstrapConfigured(environment = environmentFromProcess()) {
  const selected = normalizeEnvironment(environment);
  const value = load(selected);
  return hasBootstrapFields(value, selected) ? value : null;
}

module.exports = { DEFAULT_ENVIRONMENT, STORE_FILES, bootstrapConfigured, configured, environmentFromProcess, fileFor, hasBootstrapFields, hasCompleteFields, load, normalizeEnvironment, save };
