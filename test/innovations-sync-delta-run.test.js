const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.OPTILENS_SYNC_FINGERPRINT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-run-'));
const innovationsSync = require('../lib/innovations-sync');

// Guards the sync() delta path end to end (a bad merge once left it referencing
// undefined variables, which would have failed every entity on the host).
test('sync() in delta mode sends changed rows only and advances fingerprints after delivery', async (t) => {
  const banks = innovationsSync.ENTITIES.banks;
  const originalRead = banks.read;
  const originalFetch = globalThis.fetch;
  let rows = [{ innovations_eft_institution_id: 1, name: 'A' }, { innovations_eft_institution_id: 2, name: 'B' }];
  const posted = [];
  banks.read = async () => rows;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/version')) return new Response(JSON.stringify({ version: 't', entities: ['banks'] }), { status: 200 });
    const body = JSON.parse(options.body);
    posted.push(body.records.length);
    return new Response(JSON.stringify({ received: body.records.length, upserted: body.records.length, failed: 0 }), { status: 200 });
  };
  t.after(() => { banks.read = originalRead; globalThis.fetch = originalFetch; });

  const creds = { apiKey: 'k', baseUrl: 'https://example.supabase.co/functions/v1' };
  const first = await innovationsSync.sync(creds, { entities: ['banks'], commit: true, useLock: false, deltaMode: true });
  assert.equal(first.entities.banks.ok, true, JSON.stringify(first.entities.banks));
  assert.equal(first.entities.banks.sent, 2);

  rows = [{ innovations_eft_institution_id: 1, name: 'A' }, { innovations_eft_institution_id: 2, name: 'B2' }];
  const second = await innovationsSync.sync(creds, { entities: ['banks'], commit: true, useLock: false, deltaMode: true });
  assert.equal(second.entities.banks.sent, 1);
  assert.equal(second.entities.banks.unchanged, 1);
});
