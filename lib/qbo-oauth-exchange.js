'use strict';

const { configured, environmentFromProcess, save } = require('./qbo-secret-store');

async function claimAndExchange(transactionId) {
  const environment = environmentFromProcess();
  const gateway = process.env.OPTILENS_QBO_GATEWAY_URL;
  const token = process.env.OPTILENS_QBO_HANDOFF_TOKEN;
  const current = configured(environment);
  if (!gateway || !token || !current) throw new Error(`QBO ${environment} handoff is not configured.`);

  const expectedRedirectUri = environment === 'sandbox'
    ? 'https://qbo-sandbox.classicvisions.net/qbo/oauth/callback'
    : 'https://qbo.classicvisions.net/qbo/oauth/callback';
  const claim = await fetch(`${gateway.replace(/\/$/, '')}/qbo/handoff/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-qbo-handoff-token': token },
    body: JSON.stringify({ transaction_id: transactionId })
  });
  const handoff = await claim.json();
  if (!claim.ok || !handoff.code || handoff.environment !== environment || handoff.redirect_uri !== expectedRedirectUri) throw new Error('QBO authorization handoff was rejected.');

  const auth = Buffer.from(`${current.clientId}:${current.clientSecret}`).toString('base64');
  const exchange = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: handoff.code, redirect_uri: handoff.redirect_uri })
  });
  const result = await exchange.json();
  if (!exchange.ok || !result.refresh_token || !result.access_token) throw new Error('QuickBooks token exchange failed.');

  const next = save({ ...current, refreshToken: result.refresh_token, accessToken: result.access_token, createdAt: Date.now() }, environment);
  const safe = { ok: true, status: 'connected', realm_id_masked: String(next.realmId).slice(-4), connected_at: new Date().toISOString() };
  await fetch(`${gateway.replace(/\/$/, '')}/qbo/handoff/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-qbo-handoff-token': token },
    body: JSON.stringify({ transaction_id: transactionId, ...safe })
  });
  return safe;
}

module.exports = { claimAndExchange };
