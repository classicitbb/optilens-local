#!/usr/bin/env node
/**
 * innovations-sync-cli.js — unattended Innovations → Classic Visions cloud sync,
 * for scheduled runs. Runs the sync in-process (no HTTP session needed).
 *
 * Auth: needs the vault PASSPHRASE (not a token) — this is a separate process
 * from the server, so it unlocks the vault itself. Provide it via
 *   --passphrase <p>   or   the OPTILENS_SYNC_PASSPHRASE environment variable.
 * Commits by default; pass --dry-run to preview without writing.
 * Optional: --entities customers,contacts,order_activity
 * Optional: --backfill-statements — first-ever historical sync of statements;
 *   suppresses the "statement ready" email that would otherwise fire for
 *   every pre-existing statement (they'd all look "new" on an empty table).
 *   Leave this off on every subsequent run.
 *
 * Exit codes: 0 ok · 1 sync error/partial · 2 no passphrase · 3 wrong passphrase · 4 no key.
 */
const path = require('path');
const plSecure = require(path.join(__dirname, '..', 'lib', 'secure-config-pricelist'));
const credentialVault = require(path.join(__dirname, '..', 'lib', 'credential-vault'));
const innovationsSync = require(path.join(__dirname, '..', 'lib', 'innovations-sync'));

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

(async () => {
  // --schema Table1,Table2 : print real column names from the live DB and exit.
  // No CV key / passphrase needed — this only reads the source schema.
  const schemaArg = arg('--schema');
  if (typeof schemaArg === 'string') {
    try {
      const tables = schemaArg.split(',').map((s) => s.trim()).filter(Boolean);
      const cols = await innovationsSync.describeTables(tables);
      console.log(JSON.stringify(cols, null, 2));
      process.exit(0);
    } catch (e) {
      console.error('Schema read failed:', e.message);
      process.exit(1);
    }
  }

  const useCredentialVault = process.argv.includes('--use-credential-vault');
  const passphrase = (typeof arg('--passphrase') === 'string' && arg('--passphrase')) || process.env.OPTILENS_SYNC_PASSPHRASE || '';
  const dryRun = process.argv.includes('--dry-run');
  if (!useCredentialVault && !passphrase) {
    console.error('Missing vault passphrase: set OPTILENS_SYNC_PASSPHRASE or pass --passphrase <p>.');
    process.exit(2);
  }
  let creds;
  let token = null;
  if (useCredentialVault) {
    creds = credentialVault.cvApiFromVault();
    if (!creds) {
      console.error('CV API key not configured in the Credentials Vault.');
      process.exit(4);
    }
  } else {
    // Separate process from the server, so unlock the vault here to get a token.
    token = plSecure.unlock(passphrase);
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
  const entitiesArg = arg('--entities');
  const entities = typeof entitiesArg === 'string'
    ? entitiesArg.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  const suppressStatementEmails = process.argv.includes('--backfill-statements');

  // --serve-requests: process the cloud "Sync now" queue (writes) instead of a
  // scheduled full sync. Intended to run frequently from the scheduled task.
  const serveRequests = process.argv.includes('--serve-requests');

  try {
    const result = serveRequests
      ? await innovationsSync.runRequested(creds, {})
      : await innovationsSync.sync(creds, { commit: !dryRun, entities, suppressStatementEmails });
    console.log(JSON.stringify({ ts: new Date().toISOString(), mode: serveRequests ? 'serve-requests' : (dryRun ? 'dry-run' : 'sync'), ...result }, null, 2));
    const ok = serveRequests ? true : result.ok;
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('Sync failed:', e.message);
    process.exit(1);
  }
})();
