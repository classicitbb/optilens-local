'use strict';
const { clear } = require('./qbo-secret-store');
const { syncInvoices } = require('./qbo-invoice-sync');
async function runOnce() {
  const base = process.env.OPTILENS_QBO_GATEWAY_URL; const token = process.env.OPTILENS_QBO_HANDOFF_TOKEN;
  if (!base || !token) throw new Error('QBO command worker is not configured.');
  const headers = { 'Content-Type': 'application/json', 'x-qbo-handoff-token': token }; const root = base.replace(/\/$/, '');
  const claim = await fetch(`${root}/qbo/commands/claim`, { method: 'POST', headers }); const { command } = await claim.json();
  if (!claim.ok || !command) return { claimed: false };
  try {
    let result;
    if (command.command === 'reconcile') { const raw = await syncInvoices({ dryRun: true, trigger: 'cvweb-command' }); result = { counts: raw.counts || {}, mode: 'reconciliation_only' }; }
    else if (command.command === 'disconnect') { clear(); result = { disconnected: true }; }
    else throw new Error('Unsupported QBO command.');
    await fetch(`${root}/qbo/commands/result`, { method: 'POST', headers, body: JSON.stringify({ id: command.id, status: 'completed', result_sanitized: result }) });
    return { claimed: true, command: command.command, ok: true };
  } catch (error) {
    await fetch(`${root}/qbo/commands/result`, { method: 'POST', headers, body: JSON.stringify({ id: command.id, status: 'error' }) });
    return { claimed: true, command: command.command, ok: false };
  }
}
module.exports = { runOnce };
