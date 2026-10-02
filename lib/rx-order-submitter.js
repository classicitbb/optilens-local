/**
 * rx-order-submitter.js — office-side worker for the CV Rx order outbox.
 *
 * Flow (see CVWeb migration 20260801131000_rx_order_submissions_outbox.sql):
 *   CV: paid/confirmed web order → rx_order_submissions (pending_review)
 *   CV: staff "Release" → approved
 *   here: claim next approved row via the innovations-sync edge function
 *         (`/_rx_submissions/next`, same claim/complete pattern as _requests),
 *         write the Hashref order the website rendered (the same writer the
 *         Gatekeeper route uses) into the Innovations Incoming folder, wait
 *         for the intake watcher's verdict, and report the result back
 *         (`/_rx_submissions/complete`).
 *
 * Nothing is submitted without a human click in CV first, and every result
 * (message or error) lands back on the CV row for audit. buildOrder() is the
 * retired legacy .rx builder, kept only for its fixture tests.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const rxGenerator = require('./rx-generator');
const stockGenerator = require('./stock-order-generator');
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

/**
 * Build the rx-generator "order" object from a CV submission payload.
 *
 * Reserving an identifier consumes a number from the shared, live RX sequence
 * and can never be handed back, so callers that only need the rendered order
 * (tests, dry runs) pass reserveIdentifiers: false.
 */
function buildOrder(payload, config, { reserveIdentifiers = true } = {}) {
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

  // payload.shape comes from the RxOrderForm's "Standard shape" picker (a
  // rescaled canned OMA outline) or an uploaded real tracer file (.oma/.tr/
  // .vca) — see rx-order-engine.js's buildPayload(). Only trust it once the
  // dispenser has ticked "Confirmed" in the shape-verification step; an
  // unconfirmed shape is dropped (sent as NO TRACE) rather than risk cutting
  // to an outline nobody signed off on.
  const shape = payload?.shape;
  const shapeConfirmed = !!(shape && shape.confirmed);
  const traceBlockText = shapeConfirmed ? rxGenerator.renderTraceBlock(shape) : '';
  const hasTrace = !!traceBlockText;

  // Enum values verified against real LabLink .rx samples (see
  // docs/rx-format-field-map.md):
  //   no trace data           -> source "NO TRACE - UNCUT",              tracing "NO TRACE"
  //   real geometry available -> source "TRACE - UNCUT",                 tracing "TRACED" (+ trace block)
  //   status: "UNCUT" for uncut-blank jobs, "ENCLOSED" once a physical frame ships with the job
  // Confirmed combinations from real samples: {no trace, UNCUT} and
  // {trace, ENCLOSED} (real physical tracer). {trace, UNCUT} — this form's
  // "Standard shape" picker on an uncut job — has no confirmed real sample;
  // it's the logical extension of the same two fields and this is a test
  // server, so it ships flagged rather than blocked. Watch the first few
  // real submissions that hit this combination.
  // "FRAME TRACE" (the old value here before 2026-08-09) never appears in
  // any real sample and would misrepresent a job as having geometry it
  // doesn't have.
  const orderFrame = {
    source: hasTrace ? 'TRACE - UNCUT' : 'NO TRACE - UNCUT',
    status: edged ? 'ENCLOSED' : 'UNCUT',
    tracing: hasTrace ? 'TRACED' : 'NO TRACE',
    model: text(frame.brand || frame.model_colour, 'UNKNOWN'),
    color: text(frame.model_colour, '1'),
    a: formatOne(frame.a_mm ?? 55),
    b: formatOne(frame.b_mm ?? 38),
    dbl: formatOne(frame.dbl_mm ?? 15),
    radAngle: formatOne(45),
    // Mount type IS captured on the form (payload.frame.mount: full/supra/
    // rimless) but there's no confirmed mapping to Innova's numeric
    // frame_mounting codes (real samples show 1 and 2 with no clear
    // correlation to rim type) — left as the prior constant rather than
    // guess a code that could route a job to the wrong edging process.
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
    (shape && !shapeConfirmed) ? 'Shape was picked on the order form but not confirmed by the dispenser — sent as NO TRACE. Verify before edging.' : '',
  ].filter(Boolean);

  // Validate before reserving: a rejected submission must not burn an order ID.
  const custNum = text(account.account_number) || text(account.innovations_customer_id);
  if (!custNum) throw new Error('Submission has no account number — assign the quote to an ERP account.');

  const identifiers = reserveIdentifiers
    ? rxGenerator.nextIdentifiers()
    : { orderId: 'PREVIEW', gkOrder: 'PREVIEW', guid: crypto.randomBytes(20).toString('hex') };

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
    traceBlockText,
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
 * Turn a claimed submission into the file to drop. The cloud renders the one
 * Hashref v2.5 order (innovations-sync `hashref_body`); the only two fields it
 * cannot know are the lab number from data/rx/config.json and the customer's
 * ERP account number, which are filled in here. The order number is the one
 * the database allocated, never a local counter.
 */
function buildDropFile(sub, config) {
  const order = sub.canonical_order;
  if (!order || !sub.hashref_body) {
    throw new Error(sub.canonical_error || 'The website did not return a rendered order for this submission.');
  }
  const account = sub.payload?.account || {};
  const custNum = text(account.account_number) || text(account.innovations_customer_id);
  if (!custNum) throw new Error('Submission has no account number — assign the quote to an ERP account.');
  const labDigits = String(config.defaults.labNum ?? '').replace(/\D/g, '');
  if (!Number(labDigits)) throw new Error('data/rx/config.json defaults.labNum is not a lab number.');
  const labNum = String(Number(labDigits)).padStart(3, '0');
  // Same rule as the cloud writer: a colon would end the identifier.
  const content = sub.hashref_body
    .replace('{{lab_num}}', () => labNum)
    .replace('{{cust_num}}', () => custNum.replace(/:/g, ' '));
  if (content.includes('{{')) throw new Error('Rendered order still has unfilled placeholders.');
  const filename = rxGenerator.filenameFor(order.orderId, text(order.patientName, 'PATIENT').toUpperCase(), config.output.extension);
  return { filename, content };
}

/**
 * Process up to `max` released submissions. The transport is the Innovations
 * Incoming folder; the worker then waits for the intake watcher's verdict (a
 * rejected file is renamed <name>.bad) rather than reporting a copy as a
 * delivered order — the same check the stock worker makes.
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
      if (!config.folders.incoming) {
        throw new Error('No incoming folder is configured — set folders.incoming before releasing orders.');
      }
      const drop = buildDropFile(sub, config);
      const incomingDir = path.resolve(path.join(__dirname, '..'), config.folders.incoming);
      const target = path.join(incomingDir, drop.filename);
      // A retry must never write a second copy of an order the watcher may not
      // have collected yet, and must not paper over a file it already rejected.
      if (fs.existsSync(`${target}.bad`)) throw new Error(`Innova rejected ${drop.filename} earlier (renamed .bad in the Incoming folder).`);
      if (!fs.existsSync(target)) rxGenerator.atomicWrite(target, drop.content);
      const outcome = await stockGenerator.checkReleaseOutcome(drop.filename);
      const ok = outcome !== 'rejected';
      await complete(creds, {
        id: sub.id, ok, transport: 'file_drop', attempts: sub.attempts,
        result_message: `Dropped ${drop.filename}; Innovations intake: ${outcome}.`,
        ...(ok ? {} : { error: `Innova rejected ${drop.filename} (renamed .bad in the Incoming folder).` }),
      });
      syncLog.write('rx_submission.finished', { id: sub.id, transport: 'file_drop', ok, outcome, file: drop.filename });
      processed.push({ id: sub.id, ok, outcome, transport: 'file_drop', filename: drop.filename });
    } catch (err) {
      const message = String(err.message || err);
      syncLog.write('rx_submission.failed', { id: sub.id, error: syncLog.trim(message) });
      try {
        await complete(creds, { id: sub.id, ok: false, attempts: sub.attempts, error: message });
      } catch (completeErr) {
        // The row stays 'claimed' until the website's stale-claim sweep fails
        // it for staff; surface both errors for the operator.
        syncLog.write('rx_submission.complete_failed', { id: sub.id, error: syncLog.trim(completeErr.message || completeErr) });
      }
      processed.push({ id: sub.id, ok: false, error: message });
    }
  }
  return { processed, count: processed.length };
}

module.exports = { runOnce, buildDropFile, buildOrder, claimNext, complete };
