#!/usr/bin/env node
/**
 * rx-submissions-cli.js — unattended Rx web-order submitter, for scheduled runs.
 *
 * Claims staff-released rows from the CV `rx_order_submissions` outbox (via
 * the innovations-sync edge function's claim/complete pattern), builds the
 * RXI text with rx-generator's template machinery, and submits it — over
 * InnovaAPI /process_rxi when configured, else file-drop into
 * data/rx/config.json's folders.incoming. Mirrors innovations-sync-cli.js's
 * --serve-requests mode so it can run on its own scheduled task alongside it.
 *
 * Auth: needs the vault PASSPHRASE (separate process from the server) via
 *   --passphrase <p>   or   the OPTILENS_SYNC_PASSPHRASE environment variable,
 * or --use-credential-vault to read the CV API key directly from the vault
 * (same option innovations-sync-cli.js supports).
 *
 * Exit codes: 0 ok (including "nothing to do") · 1 one or more submissions
 * failed · 2 no passphrase · 3 wrong passphrase · 4 no CV API key configured.
 */
const path = require('path');
const plSecure = require(path.join(__dirname, '..', 'lib', 'secure-config-pricelist'));
const credentialVault = require(path.join(__dirname, '..', 'lib', 'credential-vault'));
const rxOrderSubmitter = require(path.join(__dirname, '..', 'lib', 'rx-order-submitter'));

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

(async () => {
  const useCredentialVault = process.argv.includes('--use-credential-vault');
  const passphrase = (typeof arg('--passphrase') === 'string' && arg('--passphrase')) || process.env.OPTILENS_SYNC_PASSPHRASE || '';
  const max = Number(arg('--max')) || 3;

  if (!useCredentialVault && !passphrase) {
    console.error('Missing vault passphrase: set OPTILENS_SYNC_PASSPHRASE or pass --passphrase <p> (or --use-credential-vault).');
    process.exit(2);
  }

  let creds;
  if (useCredentialVault) {
    creds = credentialVault.cvApiFromVault();
    if (!creds) {
      console.error('CV API key not configured in the Credentials Vault.');
      process.exit(4);
    }
  } else {
    const token = plSecure.unlock(passphrase);
    if (!token) {
      console.error('Wrong vault passphrase (could not unlock).');
      process.exit(3);
    }
    try {
      creds = plSecure.getCvApi(token);
    } catch (e) {
      console.error('CV API key not configured:', e.message);
      process.exit(4);
    }
  }

  try {
    const result = await rxOrderSubmitter.runOnce(creds, { max });
    console.log(JSON.stringify({ ts: new Date().toISOString(), mode: 'rx-submissions', ...result }, null, 2));
    const failed = result.processed.some((p) => p.ok === false);
    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.error('Rx submission run failed:', e.message);
    process.exit(1);
  }
})();
