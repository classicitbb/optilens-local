#!/usr/bin/env node
/**
 * innovations-sync-cli.js — unattended Innovations → Classic Visions cloud sync,
 * for scheduled runs. Runs the sync in-process (no HTTP session needed).
 *
 * Auth: needs the vault PASSPHRASE (not a token) — this is a separate process
 * from the server, so it unlocks the vault itself. Provide it via
 *   --passphrase <p>   or   the OPTILENS_SYNC_PASSPHRASE environment variable.
 * Commits by default; pass --dry-run to preview without writing.
 * Optional: --entities customers,contacts
 *
 * Exit codes: 0 ok · 1 sync error/partial · 2 no passphrase · 3 wrong passphrase · 4 no key.
 */
const path = require('path');
const plSecure = require(path.join(__dirname, '..', 'lib', 'secure-config-pricelist'));
const innovationsSync = require(path.join(__dirname, '..', 'lib', 'innovations-sync'));

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

(async () => {
  const passphrase = (typeof arg('--passphrase') === 'string' && arg('--passphrase')) || process.env.OPTILENS_SYNC_PASSPHRASE || '';
  const dryRun = process.argv.includes('--dry-run');
  if (!passphrase) {
    console.error('Missing vault passphrase: set OPTILENS_SYNC_PASSPHRASE or pass --passphrase <p>.');
    process.exit(2);
  }
  // Separate process from the server, so unlock the vault here to get a token.
  const token = plSecure.unlock(passphrase);
  if (!token) {
    console.error('Wrong vault passphrase (could not unlock).');
    process.exit(3);
  }
  let creds;
  try {
    creds = plSecure.getCvApi(token);
  } catch (e) {
    console.error('CV API key not configured:', e.message);
    process.exit(4);
  }
  const entitiesArg = arg('--entities');
  const entities = typeof entitiesArg === 'string'
    ? entitiesArg.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  try {
    const result = await innovationsSync.sync(creds, { commit: !dryRun, entities });
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...result }, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    console.error('Sync failed:', e.message);
    process.exit(1);
  }
})();
