/**
 * stock-order-submitter.js — office-side worker for the CV stock order
 * outbox. Mirrors lib/rx-order-submitter.js's shape exactly (claim/complete
 * against the innovations-sync edge function, one item per poll) but for
 * `.stockhashref` stock orders, which are a completely separate order type
 * from `.rx`/RXI patient prescriptions — see lib/stock-order-generator.js's
 * header comment. This module does not require rx-generator.js or
 * rx-order-submitter.js, and does not touch their identifier sequence.
 *
 * Flow (see cvweb-deploy migration 20260811000000_stock_order_pricing_and_outbox.sql):
 *   CVWeb: staff builds + stages an order in the Stock Order Builder → 'staged'
 *   CVWeb: staff clicks "Release" (release_stock_order_submission RPC,
 *          re-prices from the live pricelist first) → 'approved'
 *   here: claim the next 'approved' row via the innovations-sync edge
 *         function (`/_stock_submissions/next`, same claim pattern as
 *         _rx_submissions/_requests), build the .stockhashref text with
 *         stock-order-generator, generate() to local staging, then
 *         release() into the real Incoming share, and report the result
 *         back (`/_stock_submissions/complete`).
 *
 * Nothing is released to Innova without a staff "Release" click in CVWeb
 * first — by the time this worker claims a row, that approval has already
 * happened; this worker's job is purely mechanical (build file, drop file,
 * report back), same division of responsibility as the Rx submitter.
 */
const stockGenerator = require('./stock-order-generator');
const syncLog = require('./innovations-sync-log');
const { functionsBase, fetchWithRetry } = require('./innovations-sync');

const text = (value, fallback = '') => {
  const s = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  return s || fallback;
};

/** Build the stock-order-generator payload from a CVWeb submission row. */
function buildPayload(sub, config) {
  const p = sub.payload || {};
  const account = p.account || {};
  const items = Array.isArray(p.items) ? p.items : [];
  if (!items.length) throw new Error('Submission has no items.');

  const custNum = text(account.account_number) || text(account.innovations_customer_id);
  if (!custNum) throw new Error('Submission has no account number — assign the account an ERP/Innovations customer number.');

  return {
    customer: {
      labNum: config.defaults.labNum,
      custNum,
      custSeqNum: config.defaults.custSeqNum,
      shipName: text(account.name, config.defaults.shipName),
    },
    poNum: text(p.po_number),
    patientName: text(p.order_reference, 'Stock Order'),
    instructions: text(p.instructions),
    items: items.map((item) => ({
      sku: text(item.sku),
      source: text(item.source).toUpperCase(),
      description: text(item.description),
      quantity: Number(item.quantity) || 1,
      comment: text(item.comment),
      partRx: text(item.part_rx, 'Y'),
    })),
  };
}

async function claimNext(creds) {
  const base = functionsBase(creds.baseUrl);
  const res = await fetchWithRetry(`${base}/innovations-sync/_stock_submissions/next`, { headers: { 'x-api-key': creds.apiKey } }, { timeoutMs: 15000 });
  if (!res.ok) throw new Error(`_stock_submissions/next ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json().catch(() => ({}));
  return body.submission || null;
}

async function complete(creds, result) {
  const base = functionsBase(creds.baseUrl);
  const res = await fetchWithRetry(`${base}/innovations-sync/_stock_submissions/complete`, {
    method: 'POST',
    headers: { 'x-api-key': creds.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(result),
  }, { timeoutMs: 15000 });
  if (!res.ok) throw new Error(`_stock_submissions/complete ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/**
 * Process up to `max` released stock order submissions. Transport is
 * always file_drop — there is no InnovaAPI endpoint for stock orders (see
 * docs/innova-stockhashref-format.md). generate() stages locally, release()
 * is the one call that reaches the real Incoming share.
 */
async function runOnce(creds, { max = 3 } = {}) {
  if (!creds || !creds.apiKey) throw new Error('CV API key not configured (unlock the vault first).');
  const processed = [];
  for (let i = 0; i < max; i += 1) {
    const sub = await claimNext(creds);
    if (!sub) break;
    syncLog.write('stock_submission.claimed', { id: sub.id, accountId: sub.account_id });
    try {
      const payload = buildPayload(sub, stockGeneratorConfig());
      const staged = stockGenerator.generate(payload, { username: 'cvweb-stock-order' });
      const released = stockGenerator.release({ filenames: [staged.filename] }, { username: 'cvweb-stock-order' });
      await complete(creds, {
        id: sub.id, ok: true, transport: 'file_drop', filename: released.released[0], attempts: sub.attempts,
      });
      syncLog.write('stock_submission.finished', { id: sub.id, transport: 'file_drop', ok: true, file: released.released[0] });
      processed.push({ id: sub.id, ok: true, transport: 'file_drop', filename: released.released[0] });
    } catch (err) {
      const message = String(err.message || err);
      syncLog.write('stock_submission.failed', { id: sub.id, error: syncLog.trim(message) });
      try {
        await complete(creds, { id: sub.id, ok: false, attempts: sub.attempts, error: message });
      } catch (completeErr) {
        // The row stays 'claimed'; surface both errors for the operator.
        syncLog.write('stock_submission.complete_failed', { id: sub.id, error: syncLog.trim(completeErr.message || completeErr) });
      }
      processed.push({ id: sub.id, ok: false, error: message });
    }
  }
  return { processed, count: processed.length };
}

// stock-order-generator.js reads its own config straight from
// data/rx/config.json (see its header comment on why it's standalone) —
// this local re-read keeps that module's public API untouched (no config
// param on generate()/release()) while still giving buildPayload() access
// to the same defaults for labNum/custSeqNum/shipName fallbacks.
function stockGeneratorConfig() {
  const fs = require('node:fs');
  const path = require('node:path');
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'rx', 'config.json'), 'utf8'));
}

module.exports = { runOnce, buildPayload, claimNext, complete };
