#!/usr/bin/env node
'use strict';

// Seeds the production QuickBooks application identity so the OAuth handoff can
// run for the first time. An operator types the values on the host console and
// they go straight into the DPAPI-protected production store. Nothing is echoed,
// logged, or written to the repository.

const readline = require('node:readline');
const { bootstrapConfigured, configured, fileFor, load, save } = require('../lib/qbo-secret-store');

const ENVIRONMENT = 'production';
const replace = process.argv.includes('--replace');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.muted = false;
    rl._writeToOutput = (chunk) => { if (!rl.muted) rl.output.write(chunk); };
    rl.question(question, (value) => {
      if (hidden) rl.output.write('\n');
      rl.close();
      resolve(String(value).trim());
    });
    if (hidden) rl.muted = true;
  });
}

async function askRequired(label, options) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = await ask(label, options);
    if (value) return value;
    console.error('A value is required.');
  }
  throw new Error('No value was provided.');
}

async function main() {
  if (!process.stdin.isTTY) throw new Error('Run this at the host console. It will not read secrets from a pipe, a file, or a scheduled task.');

  const existing = load(ENVIRONMENT);
  if (existing && !replace) throw new Error(`A production QBO store already exists at ${fileFor(ENVIRONMENT)}. Re-run with --replace to overwrite it.`);

  console.log(`Seeding the QuickBooks ${ENVIRONMENT} application identity.`);
  console.log('Values are not echoed, logged, or committed.\n');

  const clientId = await askRequired('Production Client ID: ');
  const clientSecret = await askRequired('Production Client Secret (hidden): ', { hidden: true });
  const realmId = await askRequired('Production Realm / Company ID: ');
  if (!/^\d+$/.test(realmId)) throw new Error('The realm ID must be numeric.');
  const vatZeroTaxCodeId = await ask('VAT zero-rate tax code ID (optional): ');
  const vatStandardTaxCodeId = await ask('VAT standard-rate tax code ID (optional): ');

  save({
    clientId,
    clientSecret,
    refreshToken: replace && existing ? existing.refreshToken || '' : '',
    accessToken: '',
    realmId,
    createdAt: 0,
    environment: ENVIRONMENT,
    vatZeroTaxCodeId: vatZeroTaxCodeId || null,
    vatStandardTaxCodeId: vatStandardTaxCodeId || null
  }, ENVIRONMENT);

  const stored = bootstrapConfigured(ENVIRONMENT);
  if (!stored) throw new Error('The production store did not read back with a complete application identity.');

  console.log(`\nStored the production application identity for realm ...${String(stored.realmId).slice(-4)}.`);
  console.log(configured(ENVIRONMENT)
    ? 'A refresh token is already present; this store can run a sync.'
    : 'No refresh token yet. Authorize through the CV Web gateway, then run: npm run qbo:auth:exchange');
}

main().catch((error) => {
  console.error(`QuickBooks production seed failed: ${error.message}`);
  process.exit(1);
});
