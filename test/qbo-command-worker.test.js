const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadWorker({ command, syncResult = { counts: { matched: 2 } } }) {
  const workerPath = require.resolve('../lib/qbo-command-worker');
  const syncPath = require.resolve('../lib/qbo-invoice-sync');
  const storePath = require.resolve('../lib/qbo-secret-store');
  delete require.cache[workerPath];
  require.cache[syncPath] = { id: syncPath, filename: syncPath, loaded: true, exports: { syncInvoices: async (input) => { assert.equal(input.dryRun, true); return syncResult; } } };
  let cleared = false;
  require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { clear: () => { cleared = true; } } };
  return { runOnce: require('../lib/qbo-command-worker').runOnce, cleared: () => cleared };
}

test('QBO command worker claims and runs reconciliation as dry-run only', async () => {
  const priorFetch = global.fetch; const priorUrl = process.env.OPTILENS_QBO_GATEWAY_URL; const priorToken = process.env.OPTILENS_QBO_HANDOFF_TOKEN;
  process.env.OPTILENS_QBO_GATEWAY_URL = 'https://qbo.example.test'; process.env.OPTILENS_QBO_HANDOFF_TOKEN = 'test-token';
  const calls = []; global.fetch = async (url, init = {}) => { calls.push({ url, init }); return { ok: true, json: async () => String(url).endsWith('/claim') ? { command: { id: 'id-1', command: 'reconcile' } } : { ok: true } }; };
  try { const { runOnce } = loadWorker({ command: 'reconcile' }); assert.deepEqual(await runOnce(), { claimed: true, command: 'reconcile', ok: true }); assert.match(calls[1].init.body, /reconciliation_only/); }
  finally { global.fetch = priorFetch; process.env.OPTILENS_QBO_GATEWAY_URL = priorUrl; process.env.OPTILENS_QBO_HANDOFF_TOKEN = priorToken; }
});
