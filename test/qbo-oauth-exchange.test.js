const test = require('node:test');
const assert = require('node:assert/strict');

function loadExchange() {
  const exchangePath = require.resolve('../lib/qbo-oauth-exchange');
  const storePath = require.resolve('../lib/qbo-secret-store');
  delete require.cache[exchangePath];
  let saved;
  require.cache[storePath] = {
    id: storePath, filename: storePath, loaded: true,
    exports: {
      configured: () => ({ environment: 'production', clientId: 'client', clientSecret: 'secret', refreshToken: 'old', realmId: 'old-realm' }),
      save: (value) => { saved = value; return value; },
    },
  };
  return { claimAndExchange: require('../lib/qbo-oauth-exchange').claimAndExchange, saved: () => saved };
}

test('QBO OAuth exchange stores the callback realm only in the protected Local store', async () => {
  const priorFetch = global.fetch; const priorUrl = process.env.OPTILENS_QBO_GATEWAY_URL; const priorToken = process.env.OPTILENS_QBO_HANDOFF_TOKEN;
  process.env.OPTILENS_QBO_GATEWAY_URL = 'https://qbo.example.test'; process.env.OPTILENS_QBO_HANDOFF_TOKEN = 'test-token';
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (String(url).endsWith('/handoff/claim')) return { ok: true, json: async () => ({ code: 'authorization-code', realm_id: '123456', redirect_uri: 'https://qbo.classicvisions.net/qbo/oauth/callback', environment: 'production' }) };
    if (String(url).includes('intuit.com')) return { ok: true, json: async () => ({ access_token: 'access', refresh_token: 'refresh' }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  try {
    const exchange = loadExchange();
    const result = await exchange.claimAndExchange('00000000-0000-4000-8000-000000000001');
    assert.equal(exchange.saved().realmId, '123456');
    assert.equal(exchange.saved().refreshToken, 'refresh');
    assert.equal(result.realm_id_masked, '3456');
    assert.match(calls.at(-1).init.body, /"realm_id_masked":"3456"/);
    assert.doesNotMatch(calls.at(-1).init.body, /123456/);
  } finally {
    global.fetch = priorFetch; process.env.OPTILENS_QBO_GATEWAY_URL = priorUrl; process.env.OPTILENS_QBO_HANDOFF_TOKEN = priorToken;
  }
});
