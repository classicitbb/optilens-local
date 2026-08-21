'use strict';
const { configured, save } = require('./qbo-secret-store');
const REDIRECT_URI = 'https://qbo.classicvisions.net/qbo/oauth/callback';
async function claimAndExchange(transactionId) {
  const gateway = process.env.OPTILENS_QBO_GATEWAY_URL; const token = process.env.OPTILENS_QBO_HANDOFF_TOKEN; const current = configured();
  if (!gateway || !token || !current) throw new Error('QBO production handoff is not configured.');
  const root = gateway.replace(/\/$/, ''); const headers = { 'Content-Type': 'application/json', 'x-qbo-handoff-token': token };
  let claimed = false;
  try {
    const claim = await fetch(`${root}/qbo/handoff/claim`, { method: 'POST', headers, body: JSON.stringify({ transaction_id: transactionId }) });
    const handoff = await claim.json(); if (!claim.ok || !handoff.code || !handoff.realm_id || handoff.environment !== 'production' || handoff.redirect_uri !== REDIRECT_URI) throw new Error('QBO authorization handoff was rejected.');
    claimed = true;
    const auth = Buffer.from(`${current.clientId}:${current.clientSecret}`).toString('base64');
    const exchange = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: handoff.code, redirect_uri: handoff.redirect_uri }) });
    const result = await exchange.json(); if (!exchange.ok || !result.refresh_token || !result.access_token) throw new Error('QuickBooks token exchange failed.');
    const next = save({ ...current, realmId: String(handoff.realm_id), refreshToken: result.refresh_token, accessToken: result.access_token, createdAt: Date.now() });
    const safe = { ok: true, status: 'connected', realm_id_masked: String(next.realmId).slice(-4), connected_at: new Date().toISOString() };
    const complete = await fetch(`${root}/qbo/handoff/result`, { method: 'POST', headers, body: JSON.stringify({ transaction_id: transactionId, ...safe }) });
    if (!complete.ok) throw new Error('QuickBooks connection status could not be recorded.');
    return safe;
  } catch (error) {
    if (claimed) await fetch(`${root}/qbo/handoff/result`, { method: 'POST', headers, body: JSON.stringify({ transaction_id: transactionId, status: 'error' }) }).catch(() => {});
    throw error;
  }
}
module.exports = { claimAndExchange };
