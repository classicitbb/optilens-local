#!/usr/bin/env node
/**
 * innovations-sync-cli.js — unattended Innovations → Classic Visions cloud sync,
 * for scheduled runs. Runs the sync in-process (no HTTP session needed).
 *
 * Auth: needs the vault token to decrypt the stored CV API key. Provide it via
 *   --token <token>   or   the OPTILENS_SYNC_TOKEN environment variable.
 * Commits by default; pass --dry-run to preview without writing.
 * Optional: --entities customers,contacts
 *
 * Exit codes: 0 ok · 1 sync error/partial · 2 no token · 3 bad token · 4 no key.
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
  const token = (typeof arg('--token') === 'string' && arg('--token')) || process.env.OPTILENS_SYNC_TOKEN || '';
  const dryRun = process.argv.includes('--dry-run');
  if (!token) {
    console.error('Missing vault token: set OPTILENS_SYNC_TOKEN or pass --token <token>.');
    process.exit(2);
  }
  if (!plSecure.keyForToken(token)) {
    console.error('Invalid or locked vault token.');
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
