'use strict';

/**
 * qbo-gateway-worker.js — OptiLens Local's outbound half of the CV Web QBO gateway.
 *
 * CV Web cannot call the office, so it queues work and this worker polls for it
 * (every 30 s, outbound only, authenticated with OPTILENS_QBO_HANDOFF_TOKEN):
 *   - handoff/next   : a QuickBooks sign-in finished at the gateway -> exchange the
 *                      code for tokens (qbo-oauth-exchange.claimAndExchange).
 *   - commands/claim : "disconnect" -> revoke the refresh token at Intuit (as Intuit
 *                      requires for an in-app disconnect) and drop the tokens locally;
 *                      "reconcile"  -> run a preview (dry-run) invoice reconciliation.
 * Results go back through commands/result as sanitized status only.
 *
 * Enabled with OPTILENS_QBO_WORKER=on.
 */
const { claimAndExchange } = require('./qbo-oauth-exchange');
const { environmentFromProcess, load, save } = require('./qbo-secret-store');

const INTUIT_REVOKE = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const TICK_MS = 30 * 1000;

function gatewayConfig() {
  const gateway = String(process.env.OPTILENS_QBO_GATEWAY_URL || '').replace(/\/$/, '');
  const token = process.env.OPTILENS_QBO_HANDOFF_TOKEN || '';
  if (!gateway || !token) throw new Error('OPTILENS_QBO_GATEWAY_URL and OPTILENS_QBO_HANDOFF_TOKEN are required for the QBO worker.');
  return { gateway, token };
}

async function postGateway(path, body, { fetchImpl = fetch } = {}) {
  const { gateway, token } = gatewayConfig();
  const res = await fetchImpl(`${gateway}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-qbo-handoff-token': token },
    body: JSON.stringify(body || {})
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`QBO gateway ${path} failed (${res.status}).`), { statusCode: res.status });
  return json;
}

// Intuit: an in-app disconnect must call the revoke endpoint. Revoking the refresh
// token revokes the whole grant. The app identity (client id/secret, realm) stays so
// a later Connect works without re-seeding.
async function revokeAndForget({ environment = environmentFromProcess(), fetchImpl = fetch } = {}) {
  const current = load(environment);
  if (!current) return { revoked: false, reason: 'no stored credentials' };
  const token = current.refreshToken || current.accessToken;
  let revoked = false;
  if (token) {
    const auth = Buffer.from(`${current.clientId}:${current.clientSecret}`).toString('base64');
    const res = await fetchImpl(INTUIT_REVOKE, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token })
    });
    // 400 = token already invalid (e.g. disconnected from inside QuickBooks): still forget it.
    if (!res.ok && res.status !== 400) throw new Error(`QuickBooks revoke failed (${res.status}).`);
    revoked = res.ok;
  }
  save({ ...current, refreshToken: null, accessToken: null, createdAt: null }, environment);
  return { revoked };
}

function createQboGatewayWorker({ syncInvoices, fetchImpl = fetch, exchange = claimAndExchange, log = () => {} } = {}) {
  let timer = null;
  let busy = false;
  let lastError = null;
  let lastActivity = null;

  async function serveHandoff() {
    const next = await postGateway('/qbo/handoff/next', {}, { fetchImpl });
    if (!next.transaction_id) return false;
    try {
      await exchange(next.transaction_id);
      log('qbo.connect.completed', {});
    } catch (error) {
      // Report a sanitized failure so CV Web stops showing "pending".
      await postGateway('/qbo/handoff/result', { transaction_id: next.transaction_id, status: 'error' }, { fetchImpl }).catch(() => {});
      log('qbo.connect.failed', { error: String(error.message || error) });
    }
    return true;
  }

  async function serveCommand() {
    const { command } = await postGateway('/qbo/commands/claim', {}, { fetchImpl });
    if (!command) return false;
    let status = 'completed';
    let resultSanitized = null;
    try {
      if (command.command === 'disconnect') {
        const outcome = await revokeAndForget({ environment: command.environment, fetchImpl });
        resultSanitized = { revoked: outcome.revoked };
      } else if (command.command === 'reconcile') {
        const run = await syncInvoices({ dryRun: true, trigger: 'cv-web-reconcile' });
        resultSanitized = { counts: run.counts };
      } else {
        status = 'error';
      }
    } catch (error) {
      status = 'error';
      log('qbo.command.failed', { command: command.command, error: String(error.message || error) });
    }
    await postGateway('/qbo/commands/result', { id: command.id, command: command.command, status, result_sanitized: resultSanitized }, { fetchImpl });
    log('qbo.command.finished', { command: command.command, status });
    return true;
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      while (await serveHandoff()) { /* drain */ }
      while (await serveCommand()) { /* drain */ }
      lastError = null;
      lastActivity = new Date().toISOString();
    } catch (error) {
      lastError = { at: new Date().toISOString(), message: String(error.message || error) };
      log('qbo.worker.error', { error: lastError.message });
    } finally {
      busy = false;
    }
  }

  return {
    start() { if (timer) return; timer = setInterval(() => { tick(); }, TICK_MS); timer.unref?.(); setTimeout(() => { tick(); }, 5000).unref?.(); },
    stop() { if (timer) clearInterval(timer); timer = null; },
    tick,
    status() { return { running: Boolean(timer), busy, lastError, lastActivity }; }
  };
}

module.exports = { createQboGatewayWorker, revokeAndForget, INTUIT_REVOKE };
