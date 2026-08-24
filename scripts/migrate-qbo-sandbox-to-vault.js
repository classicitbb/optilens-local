'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { save } = require('../lib/qbo-secret-store');

const root = path.join(__dirname, '..');
const envPath = path.join(root, 'public', 'tools', 'QBO', '.env');
const tokenPath = path.join(root, 'public', 'tools', 'QBO', 'data', 'tokens.json');

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).map((line) => line.match(/^\s*([^#=]+)=(.*)\s*$/)).filter(Boolean).map((match) => [match[1].trim(), match[2].trim()]));
}
const env = parseEnv(fs.readFileSync(envPath, 'utf8'));
const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
if (!env.INTUIT_CLIENT_ID || !env.INTUIT_CLIENT_SECRET || !token.refresh_token || !token.realmId) throw new Error('QBO sandbox .env/token files are incomplete.');
const environment = String(env.INTUIT_ENVIRONMENT || 'sandbox').trim().toLowerCase();
if (environment !== 'sandbox') throw new Error('This migration only accepts sandbox credentials. Production credentials use the OAuth handoff and production protected store.');
save({
  clientId: env.INTUIT_CLIENT_ID,
  clientSecret: env.INTUIT_CLIENT_SECRET,
  refreshToken: token.refresh_token,
  accessToken: token.access_token || '',
  realmId: String(token.realmId),
  createdAt: Number(token.createdAt || Date.now()),
  environment,
  vatZeroTaxCodeId: env.QBO_VAT_ZERO_TAX_CODE_ID || null,
  vatStandardTaxCodeId: env.QBO_VAT_STANDARD_TAX_CODE_ID || null
});
console.log('Migrated QuickBooks sandbox authorization to the Windows-protected sandbox store. Remove the legacy sandbox .env and tokens.json manually after verifying a dry run.');
