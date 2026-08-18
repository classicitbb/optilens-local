'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const envPath = path.join(root, 'public', 'tools', 'QBO', '.env');
const tokenPath = path.join(root, 'public', 'tools', 'QBO', 'data', 'tokens.json');
const vaultPath = path.join(root, 'data', 'vault.json');

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).map((line) => line.match(/^\s*([^#=]+)=(.*)\s*$/)).filter(Boolean).map((match) => [match[1].trim(), match[2].trim()]));
}
function upsertField(fields, label, value, secret) {
  const existing = fields.find((field) => String(field.label || '').toLowerCase().replace(/[^a-z0-9]/g, '') === label.toLowerCase().replace(/[^a-z0-9]/g, ''));
  if (existing) existing.val = value;
  else fields.push({ label, val: value, secret });
}

const env = parseEnv(fs.readFileSync(envPath, 'utf8'));
const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
const vault = JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
if (!vault.pinHash || !vault.data) throw new Error('Credentials vault is not initialized.');
if (!env.INTUIT_CLIENT_ID || !env.INTUIT_CLIENT_SECRET || !token.refresh_token || !token.realmId) throw new Error('QBO sandbox .env/token files are incomplete.');

const entries = Array.isArray(vault.data['API Keys']) ? vault.data['API Keys'] : [];
let entry = entries.find((item) => String(item.name || '').toLowerCase().includes('quickbooks'));
if (!entry) { entry = { name: 'QuickBooks Online', type: 'API Keys', fields: [] }; entries.push(entry); }
entry.fields = Array.isArray(entry.fields) ? entry.fields : [];
upsertField(entry.fields, 'clientId', env.INTUIT_CLIENT_ID, false);
upsertField(entry.fields, 'clientSecret', env.INTUIT_CLIENT_SECRET, true);
upsertField(entry.fields, 'refreshToken', token.refresh_token, true);
upsertField(entry.fields, 'accessToken', token.access_token || '', true);
upsertField(entry.fields, 'realmId', String(token.realmId), false);
upsertField(entry.fields, 'createdAt', String(token.createdAt || Date.now()), false);
upsertField(entry.fields, 'environment', env.INTUIT_ENVIRONMENT || 'sandbox', false);
vault.data['API Keys'] = entries;
fs.writeFileSync(vaultPath, JSON.stringify(vault, null, 2));
console.log(`Migrated QuickBooks ${env.INTUIT_ENVIRONMENT || 'sandbox'} authorization to the Credentials Vault entry '${entry.name}'.`);
