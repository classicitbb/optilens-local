const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLiveGatewayAutostart } = require('../lib/live-gateway-autostart');
const liveGatewayWorker = require('../lib/live-gateway-worker');

test('live gateway sends Supabase platform auth alongside the scoped CV API key', () => {
  assert.deepEqual(
    liveGatewayWorker.gatewayRequestHeaders({ apiKey: 'cv-key', anonKey: 'project-anon-key' }),
    {
      'content-type': 'application/json',
      authorization: 'Bearer project-anon-key',
      apikey: 'project-anon-key',
      'x-api-key': 'cv-key',
    },
  );
});

test('live gateway uses the functions base URL for its sibling edge function', () => {
  assert.equal(
    liveGatewayWorker.gatewayBase('https://xstmeirxhfbiyayrrsob.supabase.co/functions/v1/api-v1'),
    'https://xstmeirxhfbiyayrrsob.supabase.co/functions/v1',
  );
  assert.equal(
    liveGatewayWorker.gatewayBase('https://xstmeirxhfbiyayrrsob.supabase.co/functions/v1/api-v1/'),
    'https://xstmeirxhfbiyayrrsob.supabase.co/functions/v1',
  );
  assert.equal(
    liveGatewayWorker.gatewayBase(''),
    'https://xstmeirxhfbiyayrrsob.supabase.co/functions/v1',
  );
});

test('live gateway autostart persists credentials through a protected local store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optilens-live-gateway-'));
  const stateFile = path.join(root, 'autostart.json');
  const store = createLiveGatewayAutostart({
    stateFile,
    protect: (value) => Buffer.from(value, 'utf8').toString('base64'),
    unprotect: (value) => Buffer.from(value, 'base64').toString('utf8'),
  });

  try {
    assert.deepEqual(store.status(), { enabled: false, updatedAt: null });

    store.save({ baseUrl: 'https://example.test/functions/v1/api-v1', apiKey: 'secret-key', anonKey: 'project-anon-key' });

    assert.equal(store.status().enabled, true);
    assert.deepEqual(store.load(), {
      baseUrl: 'https://example.test/functions/v1/api-v1',
      apiKey: 'secret-key',
      anonKey: 'project-anon-key',
    });

    const persisted = fs.readFileSync(stateFile, 'utf8');
    assert.doesNotMatch(persisted, /secret-key/);

    store.clear();
    assert.deepEqual(store.status(), { enabled: false, updatedAt: null });
    assert.equal(store.load(), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
