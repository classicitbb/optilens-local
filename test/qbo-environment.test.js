const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../lib/qbo-secret-store');

test('QBO defaults to sandbox and uses separate protected store paths', () => {
  assert.equal(store.normalizeEnvironment(), 'sandbox');
  assert.match(store.fileFor('sandbox'), /qbo-sandbox-secrets\.json$/);
  assert.match(store.fileFor('production'), /qbo-production-secrets\.json$/);
  assert.notEqual(store.fileFor('sandbox'), store.fileFor('production'));
});

test('unknown QBO environment values cannot select production', () => {
  assert.equal(store.normalizeEnvironment('staging'), 'sandbox');
  assert.equal(store.normalizeEnvironment('production'), 'production');
});
