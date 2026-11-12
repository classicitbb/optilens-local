const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/qbo-secret-store');
const { createQboGatewayWorker, revokeAndForget, INTUIT_REVOKE } = require('../lib/qbo-gateway-worker');

function gatewayFetch(routes, calls) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null, headers: options.headers });
    const handler = Object.entries(routes).find(([suffix]) => String(url).endsWith(suffix));
    const [status, body] = handler ? handler[1]() : [404, {}];
    return new Response(JSON.stringify(body), { status });
  };
}

test.beforeEach(() => {
  process.env.OPTILENS_QBO_GATEWAY_URL = 'https://qbo-sandbox.example.net';
  process.env.OPTILENS_QBO_HANDOFF_TOKEN = 'tok';
  process.env.OPTILENS_QBO_ENVIRONMENT = 'sandbox';
});

test('a finished sign-in at the gateway is exchanged for tokens', async () => {
  const calls = [];
  const handoffs = [{ transaction_id: '11111111-1111-1111-1111-111111111111' }];
  const exchanged = [];
  const worker = createQboGatewayWorker({
    syncInvoices: async () => ({}),
    exchange: async (id) => { exchanged.push(id); },
    fetchImpl: gatewayFetch({ '/qbo/handoff/next': () => [200, handoffs.shift() || {}], '/qbo/commands/claim': () => [200, { command: null }] }, calls),
  });
  await worker.tick();
  assert.deepEqual(exchanged, ['11111111-1111-1111-1111-111111111111']);
  assert.equal(calls[0].headers['x-qbo-handoff-token'], 'tok');
  assert.equal(worker.status().lastError, null);
});

test('a reconcile command runs a dry-run sync and reports sanitized counts', async () => {
  const calls = [];
  const commands = [{ id: 'c1', command: 'reconcile', environment: 'sandbox' }];
  let syncOpts;
  const worker = createQboGatewayWorker({
    syncInvoices: async (opts) => { syncOpts = opts; return { counts: { discovered: 3 }, results: ['secret detail'] }; },
    exchange: async () => {},
    fetchImpl: gatewayFetch({ '/qbo/handoff/next': () => [200, {}], '/qbo/commands/claim': () => [200, { command: commands.shift() || null }], '/qbo/commands/result': () => [200, { ok: true }] }, calls),
  });
  await worker.tick();
  assert.equal(syncOpts.dryRun, true);
  const result = calls.find((c) => c.url.endsWith('/qbo/commands/result')).body;
  assert.deepEqual(result, { id: 'c1', command: 'reconcile', status: 'completed', result_sanitized: { counts: { discovered: 3 } } });
});

test('disconnect revokes the refresh token at Intuit and forgets the tokens', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-'));
  const original = store.STORE_FILES.sandbox;
  store.STORE_FILES.sandbox = path.join(dir, 'sandbox.json');
  t.after(() => { store.STORE_FILES.sandbox = original; });
  let saved;
  // Bypass DPAPI in tests: write via the module's own save when available on Windows only.
  const fakeLoad = { environment: 'sandbox', clientId: 'id', clientSecret: 'sec', realmId: '123', refreshToken: 'RT', accessToken: 'AT' };
  const calls = [];
  const fetchImpl = gatewayFetch({ [INTUIT_REVOKE]: () => [200, {}] }, calls);
  const mod = require('../lib/qbo-gateway-worker');
  const secret = require('../lib/qbo-secret-store');
  const realLoad = secret.load; const realSave = secret.save;
  secret.load = () => fakeLoad; secret.save = (v) => { saved = v; return v; };
  t.after(() => { secret.load = realLoad; secret.save = realSave; });
  // Re-require with patched store functions.
  delete require.cache[require.resolve('../lib/qbo-gateway-worker')];
  const fresh = require('../lib/qbo-gateway-worker');
  const outcome = await fresh.revokeAndForget({ environment: 'sandbox', fetchImpl });
  assert.equal(outcome.revoked, true);
  assert.equal(calls[0].url, INTUIT_REVOKE);
  assert.deepEqual(calls[0].body, { token: 'RT' });
  assert.match(calls[0].headers.Authorization, /^Basic /);
  assert.equal(saved.refreshToken, null);
  assert.equal(saved.clientId, 'id');
  void mod; void revokeAndForget;
});
