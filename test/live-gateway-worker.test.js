const test = require('node:test');
const assert = require('node:assert/strict');

const liveGatewayWorker = require('../lib/live-gateway-worker');

test('live gateway uses the configured api-v1 base URL', () => {
  assert.equal(
    liveGatewayWorker.gatewayBase('https://xstmeirxhfbiyayrrsob.supabase.co/functions/v1/api-v1'),
    'https://xstmeirxhfbiyayrrsob.supabase.co/functions/v1/api-v1',
  );
  assert.equal(
    liveGatewayWorker.gatewayBase('https://xstmeirxhfbiyayrrsob.supabase.co/functions/v1/api-v1/'),
    'https://xstmeirxhfbiyayrrsob.supabase.co/functions/v1/api-v1',
  );
  assert.equal(
    liveGatewayWorker.gatewayBase(''),
    'https://xstmeirxhfbiyayrrsob.supabase.co/functions/v1/api-v1',
  );
});
