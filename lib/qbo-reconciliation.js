'use strict';

// Read-only comparison of every QuickBooks invoice and credit memo with the Innovations invoices, matched on
// invoice number. It does not care who created the QuickBooks document: this tool, a CSV import or a person.
const TOLERANCE_CENTS = 1;
const MARKER = /OptiLens source Innovations invoice\s+\S+\s*$/;

const STATE_TEXT = {
  matched: 'Matches',
  differs: 'Amount differs',
  duplicate: 'Duplicate number',
  missing: 'Not in QuickBooks',
  qbo_only: 'Only in QuickBooks'
};

const cents = (value) => Math.round(Number(value || 0) * 100);
const fromCents = (value) => value / 100;
const signed = (amount, isCredit) => (isCredit ? -Math.abs(amount) : Math.abs(amount));

function qboOrigin(note) {
  const lastLine = String(note || '').trim().split(/\r?\n/).pop();
  return MARKER.test(lastLine) ? 'optilens' : 'other';
}

function normalizeQboDoc(raw, type) {
  const total = Number(raw.TotalAmt || 0);
  return {
    id: String(raw.Id),
    type,
    docNumber: String(raw.DocNumber || '').trim(),
    date: raw.TxnDate || null,
    total: type === 'CreditMemo' ? -Math.abs(total) : total,
    customer: raw.CustomerRef?.name || '',
    origin: qboOrigin(raw.PrivateNote)
  };
}

// rows: review rows from Innovations (sourceInvoiceId, total as an absolute amount, isCredit, customer, invoiceDate, lane).
// qboDocs: normalized QuickBooks documents. Documents dated before `from` are used for matching only, so a few
// days of date skew around the cutover cannot hide a match, but they are never reported as extra.
function reconcile({ rows, qboDocs, from = null }) {
  const byNumber = new Map();
  for (const doc of qboDocs) {
    if (!doc.docNumber) continue;
    if (!byNumber.has(doc.docNumber)) byNumber.set(doc.docNumber, []);
    byNumber.get(doc.docNumber).push(doc);
  }
  const known = new Set(rows.map((row) => String(row.sourceInvoiceId)));
  const out = [];

  for (const row of rows) {
    const docNumber = String(row.sourceInvoiceId);
    const docs = byNumber.get(docNumber) || [];
    const innovationsTotal = signed(row.total, row.isCredit);
    const base = {
      key: docNumber, docNumber, invoiceDate: row.invoiceDate, customer: row.customer, innovationsTotal,
      isCredit: Boolean(row.isCredit), lane: row.lane, mappedCustomer: row.qboCustomer || '',
      qboId: null, qboType: null, qboTotal: null, qboCustomer: '', qboDate: null, origin: null, difference: null, qboIds: [], note: ''
    };
    if (!docs.length) { out.push({ ...base, state: 'missing', note: 'Not in QuickBooks yet.' }); continue; }
    const doc = docs[0];
    const filled = { ...base, qboId: doc.id, qboType: doc.type, qboTotal: doc.total, qboCustomer: doc.customer, qboDate: doc.date, origin: doc.origin, qboIds: docs.map((item) => item.id) };
    if (docs.length > 1) { out.push({ ...filled, state: 'duplicate', note: `QuickBooks has ${docs.length} documents numbered ${docNumber}.` }); continue; }
    const wrongType = (doc.type === 'CreditMemo') !== Boolean(row.isCredit);
    const gap = cents(doc.total) - cents(innovationsTotal);
    const difference = fromCents(gap);
    if (wrongType) out.push({ ...filled, difference, state: 'differs', note: `Innovations has a ${row.isCredit ? 'credit note' : 'invoice'}, QuickBooks has ${doc.type === 'CreditMemo' ? 'a credit memo' : 'an invoice'}.` });
    else if (Math.abs(gap) > TOLERANCE_CENTS) out.push({ ...filled, difference, state: 'differs', note: `QuickBooks is ${difference > 0 ? 'higher' : 'lower'} by ${Math.abs(difference).toFixed(2)}.` });
    else out.push({ ...filled, difference: 0, state: 'matched' });
  }

  for (const [docNumber, docs] of byNumber) {
    if (known.has(docNumber)) continue;
    const dated = docs.filter((doc) => !from || (doc.date && doc.date >= from));
    if (!dated.length) continue;
    const doc = dated[0];
    out.push({
      key: `qbo-${doc.id}`, docNumber, invoiceDate: doc.date, customer: doc.customer, innovationsTotal: null, isCredit: doc.type === 'CreditMemo',
      lane: null, mappedCustomer: '', qboId: doc.id, qboType: doc.type, qboTotal: doc.total, qboCustomer: doc.customer, qboDate: doc.date,
      origin: doc.origin, difference: null, qboIds: dated.map((item) => item.id), state: 'qbo_only',
      note: 'No Innovations invoice in this period has this number. It may be an older invoice.'
    });
  }
  return out;
}

function summarize(rows) {
  const counts = { matched: 0, differs: 0, duplicate: 0, missing: 0, qbo_only: 0 };
  let innovations = 0; let quickbooks = 0;
  for (const row of rows) {
    counts[row.state] += 1;
    if (row.innovationsTotal != null) innovations += cents(row.innovationsTotal);
    if (row.qboTotal != null) quickbooks += cents(row.qboTotal);
  }
  return {
    counts,
    total: rows.length,
    needsReconciling: rows.length - counts.matched,
    innovationsTotal: fromCents(innovations),
    quickbooksTotal: fromCents(quickbooks)
  };
}

module.exports = { reconcile, summarize, normalizeQboDoc, qboOrigin, STATE_TEXT };
