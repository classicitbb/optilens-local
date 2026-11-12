const test = require('node:test');
const assert = require('node:assert/strict');
const { reportReconnectRequired } = require('../lib/qbo-oauth-exchange');

test('reconnect-required status is posted to the CV Web gateway with the handoff token', async (t) => {
  const originalFetch = globalThis.fetch;
  const env = { gw: process.env.OPTILENS_QBO_GATEWAY_URL, tok: process.env.OPTILENS_QBO_HANDOFF_TOKEN };
  t.after(() => { globalThis.fetch = originalFetch; process.env.OPTILENS_QBO_GATEWAY_URL = env.gw ?? ''; process.env.OPTILENS_QBO_HANDOFF_TOKEN = env.tok ?? ''; });
  process.env.OPTILENS_QBO_GATEWAY_URL = 'https://qbo-sandbox.example.net/';
  process.env.OPTILENS_QBO_HANDOFF_TOKEN = 't0k';
  let call;
  globalThis.fetch = async (url, options) => { call = { url, options }; return new Response('{"ok":true}', { status: 200 }); };
  assert.equal(await reportReconnectRequired(), true);
  assert.equal(call.url, 'https://qbo-sandbox.example.net/qbo/handoff/result');
  assert.equal(call.options.headers['x-qbo-handoff-token'], 't0k');
  assert.deepEqual(JSON.parse(call.options.body), { status: 'token_refresh_required' });
});

test('reconnect-required reporting never throws when the gateway is unset or down', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  delete process.env.OPTILENS_QBO_GATEWAY_URL;
  assert.equal(await reportReconnectRequired(), false);
  process.env.OPTILENS_QBO_GATEWAY_URL = 'https://x.example.net';
  process.env.OPTILENS_QBO_HANDOFF_TOKEN = 't';
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal(await reportReconnectRequired(), false);
});
