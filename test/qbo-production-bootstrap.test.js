const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../lib/qbo-secret-store');

const identity = { environment: 'production', clientId: 'client', clientSecret: 'secret', realmId: '4620816365000000000' };

test('an application identity without a refresh token can bootstrap but cannot sync', () => {
  assert.equal(store.hasBootstrapFields(identity, 'production'), true);
  assert.equal(store.hasCompleteFields(identity, 'production'), false);
});

test('a refresh token completes the production store', () => {
  const authorized = { ...identity, refreshToken: 'refresh' };
  assert.equal(store.hasBootstrapFields(authorized, 'production'), true);
  assert.equal(store.hasCompleteFields(authorized, 'production'), true);
});

test('a store from another environment satisfies neither check', () => {
  const sandbox = { ...identity, environment: 'sandbox', refreshToken: 'refresh' };
  assert.equal(store.hasBootstrapFields(sandbox, 'production'), false);
  assert.equal(store.hasCompleteFields(sandbox, 'production'), false);
});

test('every application identity field is required to bootstrap', () => {
  for (const field of ['clientId', 'clientSecret', 'realmId']) {
    assert.equal(store.hasBootstrapFields({ ...identity, [field]: '' }, 'production'), false, `${field} must be required`);
  }
  assert.equal(store.hasBootstrapFields(null, 'production'), false);
  assert.equal(store.hasCompleteFields(null, 'production'), false);
});

test('the production bootstrap check is exposed to the OAuth exchange', () => {
  assert.equal(typeof store.bootstrapConfigured, 'function');
  const exchange = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'qbo-oauth-exchange.js'), 'utf8');
  assert.match(exchange, /bootstrapConfigured\(environment\)/);
});
