const test = require('node:test');
const assert = require('node:assert/strict');

const liveGatewayWorker = require('../lib/live-gateway-worker');

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
