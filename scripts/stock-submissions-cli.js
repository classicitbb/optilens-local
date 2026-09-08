#!/usr/bin/env node
/**
 * stock-submissions-cli.js — unattended stock web-order submitter, for
 * scheduled runs. The exact counterpart of rx-submissions-cli.js.
 *
 * Claims released rows from the CV `stock_order_submissions` outbox (via the
 * innovations-sync edge function's claim/complete pattern), builds the
 * `.stockhashref` text with stock-order-generator's template machinery, and
 * drops it into Innova's watched Incoming folder — the only transport stock
 * orders have, since InnovaAPI exposes no stock endpoint (see
 * docs/innova-stockhashref-format.md).
 *
 * Both sources of those rows land here: the staff Stock Order Builder's
 * "Submit order" (release_stock_order_submission) and a customer's store
 * checkout (the enqueue trigger added in CVWeb migration 20260907180000).
 * Until this ran on a schedule, an 'approved' row was never claimed by
 * anything, so neither ever reached the lab.
 *
 * Auth: needs the vault PASSPHRASE (separate process from the server) via
 *   --passphrase <p>   or   the OPTILENS_SYNC_PASSPHRASE environment variable,
 * or --use-credential-vault to read the CV API key directly from the vault.
 *
 * Exit codes: 0 ok (including "nothing to do") · 1 one or more submissions
 * failed · 2 no passphrase · 3 wrong passphrase · 4 no CV API key configured.
 */
const path = require('path');
const plSecure = require(path.join(__dirname, '..', 'lib', 'secure-config-pricelist'));
const credentialVault = require(path.join(__dirname, '..', 'lib', 'credential-vault'));
const stockOrderSubmitter = require(path.join(__dirname, '..', 'lib', 'stock-order-submitter'));

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
    const result = await stockOrderSubmitter.runOnce(creds, { max });
    console.log(JSON.stringify({ ts: new Date().toISOString(), mode: 'stock-submissions', ...result }, null, 2));
    const failed = result.processed.some((p) => p.ok === false);
    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.error('Stock submission run failed:', e.message);
    process.exit(1);
  }
})();
