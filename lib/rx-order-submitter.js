/**
 * rx-order-submitter.js — office-side worker for the CV Rx order outbox.
 *
 * Flow (see CVWeb migration 20260801131000_rx_order_submissions_outbox.sql):
 *   CV: paid/confirmed web order → rx_order_submissions (pending_review)
 *   CV: staff "Release" → approved
 *   here: claim next approved row via the innovations-sync edge function
 *         (`/_rx_submissions/next`, same claim/complete pattern as _requests),
 *         build the RXI text with the proven rx-generator template machinery,
 *         submit via InnovaAPI POST /process_rxi when configured — otherwise
 *         drop the file into the existing incoming folder — and report the
 *         result back (`/_rx_submissions/complete`).
 *
 * Nothing is submitted without a human click in CV first, and every result
 * (resultCode/resultMessage/RXTData or error) lands back on the CV row for
 * audit.
 */
const path = require('node:path');
const rxGenerator = require('./rx-generator');
const innovaApi = require('./innova-api-client');
const syncLog = require('./innovations-sync-log');
const { functionsBase, fetchWithRetry } = require('./innovations-sync');

const formatSigned = (value) => {
  const n = Number(value) || 0;
  return `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)}`;
};
const formatOne = (value) => Number(value ?? 0).toFixed(1);
const text = (value, fallback = '') => {
  const s = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  return s || fallback;
};

/** Build the rx-generator "order" object from a CV submission payload. */
function buildOrder(payload, config) {
  const quote = payload?.quote || {};
  const account = payload?.account || {};
  const frame = payload?.frame || {};
  const lenses = Array.isArray(payload?.lenses) ? payload.lenses : [];
  const addons = Array.isArray(payload?.addons) ? payload.addons : [];
  if (!lenses.length) throw new Error('Submission has no lens line.');

  const lensLine = lenses[0];
  const codes = lensLine.codes;
  if (!codes || !codes.material_code) {
    throw new Error(`No Innovations alias resolved for "${lensLine.item_name}" — confirm its mapping in Admin → Pricing → Alias Mapping, then re-release.`);
  }
  const behaviour = rxGenerator.LENS_BEHAVIOUR[codes.mf_type] || rxGenerator.LENS_BEHAVIOUR['Single Vision'];

  const rx = lensLine.rx || {};
  const pd = parseFloat(rx.pd) || null;
  const eye = (side) => {
    const near = rx[`${side}_npd`] ?? (pd ? pd / 2 : config.prescription.defaultMonocularPd);
    const far = rx[`${side}_fpd`] ?? (pd ? pd / 2 : config.prescription.defaultMonocularPd);
    return {
      sphere: formatSigned(rx[`${side}_sph`]),
      cylinder: formatSigned(rx[`${side}_cyl`]),
      axis: String(Math.round(Number(rx[`${side}_axis`]) || 0)),
      add: formatSigned(rx[`${side}_add`]),
      near: formatOne(near),
      far: formatOne(far),
      segHeight: behaviour.requiresSegHeight
        ? formatOne(parseFloat(rx.seg_height) || parseFloat(rx.fitting_height) || 0)
        : '0.0',
    };
  };

  const isUncut = frame.is_uncut !== false; // default to uncut when unknown
  const edged = !isUncut && frame.job_scope === 'full_glaze';
  const orderFrame = {
    source: edged ? 'FRAME TRACE' : 'NO TRACE - UNCUT',
    status: 'ENCLOSED',
    tracing: edged ? 'FRAME TRACE' : 'NO TRACE',
    model: text(frame.brand || frame.model_colour, 'UNKNOWN'),
    color: text(frame.model_colour, '1'),
    a: formatOne(frame.a_mm ?? 55),
    b: formatOne(frame.b_mm ?? 38),
    dbl: formatOne(frame.dbl_mm ?? 15),
    radAngle: formatOne(45),
    mounting: '1',
    dress: 'DRESS',
    edge: edged ? 'EDGED' : 'UNCUT',
    edged,
  };

  // Match CV add-on lines to the known coating/add-on item catalog by sku,
  // then by name. Anything unmatched rides along in the instructions so the
  // lab still sees it rather than the RXI silently dropping it.
  const knownItems = [...rxGenerator.getCoatings(), ...rxGenerator.getAddons()];
  const items = [];
  const unmatched = [];
  for (const line of addons) {
    const found = knownItems.find((item) =>
      (line.sku && item.sku && String(item.sku).toLowerCase() === String(line.sku).toLowerCase()) ||
      (item.description && String(item.description).toLowerCase() === String(line.item_name).toLowerCase()));
    if (found) items.push({ sku: text(found.sku), source: text(found.source), description: text(found.description), quantity: String(Number(line.qty || 1)), side: text(found.side, 'NONE'), partRx: text(found.partRx, 'Y') });
    else unmatched.push(line.item_name);
  }
  if (edged && !items.some((item) => /edge to fit/i.test(item.description))) {
    const edgeItem = knownItems.find((item) => /edge to fit/i.test(item.description));
    if (edgeItem) items.push({ sku: text(edgeItem.sku), source: text(edgeItem.source), description: text(edgeItem.description), quantity: '1', side: text(edgeItem.side, 'NONE'), partRx: text(edgeItem.partRx, 'Y') });
    else unmatched.push('EDGE TO FIT (required for edged job — not in item catalog)');
  }

  const instructionParts = [
    `CV web order ${text(quote.quote_number)}`,
    text(quote.notes_customer),
    unmatched.length ? `Also requested: ${unmatched.join(', ')}` : '',
  ].filter(Boolean);

  const identifiers = rxGenerator.nextIdentifiers();
  const custNum = text(account.account_number) || text(account.innovations_customer_id);
  if (!custNum) throw new Error('Submission has no account number — assign the quote to an ERP account.');

  const order = {
    identifiers,
    customer: {
      labNum: config.defaults.labNum,
      custNum,
      custSeqNum: config.defaults.custSeqNum,
      shipName: text(account.name || quote.customer_name, 'Classic Visions'),
      remoteOperator: config.defaults.remoteOperator,
    },
    patient: { name: text(quote.contact_name || quote.customer_name, 'PATIENT').toUpperCase() },
    lens: {
      colorCode: codes.color_code, colorDescription: codes.color_description,
      materialCode: codes.material_code, materialDescription: codes.material_description,
      styleCode: codes.style_code, styleDescription: codes.style_description,
    },
    behaviour,
    frame: orderFrame,
    prescription: { od: eye('od'), os: eye('os') },
    items,
    instructions: instructionParts.join(' | ').slice(0, 500),
  };
  order.filename = rxGenerator.filenameFor(identifiers.orderId, order.patient.name, '.rx');
  order.content = rxGenerator.renderRxText(order, config);
  return order;
}

async function claimNext(creds) {
  const base = functionsBase(creds.baseUrl);
  const res = await fetchWithRetry(`${base}/innovations-sync/_rx_submissions/next`, { headers: { 'x-api-key': creds.apiKey } }, { timeoutMs: 15000 });
  if (!res.ok) throw new Error(`rx_submissions/next ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json().catch(() => ({}));
  return body.submission || null;
}

async function complete(creds, result) {
  const base = functionsBase(creds.baseUrl);
  const res = await fetchWithRetry(`${base}/innovations-sync/_rx_submissions/complete`, {
    method: 'POST',
    headers: { 'x-api-key': creds.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(result),
  }, { timeoutMs: 15000 });
  if (!res.ok) throw new Error(`rx_submissions/complete ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/**
 * Process up to `max` released submissions. Transport: InnovaAPI when
 * configured, else file-drop into the configured incoming folder (the
 * mechanism already used by the RX test generator's release step).
 */
async function runOnce(creds, { max = 3 } = {}) {
  if (!creds || !creds.apiKey) throw new Error('CV API key not configured (unlock the vault first).');
  const processed = [];
  for (let i = 0; i < max; i += 1) {
    const sub = await claimNext(creds);
    if (!sub) break;
    syncLog.write('rx_submission.claimed', { id: sub.id, quoteId: sub.quote_id });
    const config = rxGenerator.loadConfig();
    try {
      const order = buildOrder(sub.payload, config);
      const apiConfig = innovaApi.getConfig();
      if (apiConfig) {
        const result = await innovaApi.processRxi(order.content, sub.mode ?? 1, apiConfig);
        // Result codes are the lab's own semantics; treat an explicit
        // non-positive resultCode as failure so CV shows it loudly.
        const ok = result.resultCode == null || Number(result.resultCode) >= 0;
        await complete(creds, {
          id: sub.id, ok, transport: 'api', attempts: sub.attempts,
          result_code: result.resultCode, result_message: result.resultMessage, rxt_data: result.RXTData,
          error: ok ? null : `process_rxi resultCode ${result.resultCode}`,
        });
        syncLog.write('rx_submission.finished', { id: sub.id, transport: 'api', ok, resultCode: result.resultCode });
        processed.push({ id: sub.id, ok, transport: 'api' });
      } else {
        if (!config.folders.incoming) {
          throw new Error('Neither InnovaAPI credentials nor an incoming folder are configured — set one up before releasing orders.');
        }
        const incomingDir = path.resolve(path.join(__dirname, '..'), config.folders.incoming);
        rxGenerator.atomicWrite(path.join(incomingDir, order.filename), order.content);
        await complete(creds, {
          id: sub.id, ok: true, transport: 'file_drop', attempts: sub.attempts,
          result_message: `Dropped ${order.filename} into the incoming folder.`,
        });
        syncLog.write('rx_submission.finished', { id: sub.id, transport: 'file_drop', ok: true, file: order.filename });
        processed.push({ id: sub.id, ok: true, transport: 'file_drop' });
      }
    } catch (err) {
      const message = String(err.message || err);
      syncLog.write('rx_submission.failed', { id: sub.id, error: syncLog.trim(message) });
      try {
        await complete(creds, { id: sub.id, ok: false, attempts: sub.attempts, error: message });
      } catch (completeErr) {
        // The row stays 'claimed'; surface both errors for the operator.
        syncLog.write('rx_submission.complete_failed', { id: sub.id, error: syncLog.trim(completeErr.message || completeErr) });
      }
      processed.push({ id: sub.id, ok: false, error: message });
    }
  }
  return { processed, count: processed.length };
}

module.exports = { runOnce, buildOrder, claimNext, complete };
