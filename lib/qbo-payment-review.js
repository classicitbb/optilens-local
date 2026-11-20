'use strict';

// Pure read-only reconciliation. No accounting transaction payloads or writes.
const METHODS = { 1: 'Cheque', 2: 'Cash', 3: 'Credit Card', 4: 'Direct Debit' };
function cents(value) {
  const text = String(value ?? '').trim();
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  if (/[1-9]/.test(fraction.slice(2))) return null;
  const result = Number(whole) * 100 + Number(fraction.slice(0, 2).padEnd(2, '0'));
  return Number.isSafeInteger(result) ? (text.startsWith('-') ? -result : result) : null;
}
const marker = (id) => `OptiLens source Innovations payment ${id}`;
const hasMarker = (note, id) => String(note || '').trim().split(/\r?\n/).at(-1) === marker(id);
const dateOnly = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
function allocations(lines, key, amount) {
  const result = new Map();
  for (const line of lines) {
    const id = key(line), value = cents(amount(line));
    if (!id || value === null || value <= 0) return null;
    result.set(String(id), (result.get(String(id)) || 0) + value);
  }
  return result;
}
function sameAllocations(left, right) {
  return left && right && left.size === right.size && [...left].every(([id, amount]) => right.get(id) === amount);
}
function qboAllocations(payment) {
  return allocations(payment.Line || [], (line) => {
    const links = line.LinkedTxn || [];
    return links.length === 1 && links[0].TxnType === 'Invoice' ? links[0].TxnId : null;
  }, (line) => line.Amount);
}
function methodFor(source) {
  // A note is displayed as evidence, never interpreted into an automatic wire mapping.
  return METHODS[source.methodCode] || 'Unknown';
}
function reviewPayment(source, { invoices = [], payments = [], deposits = [], mappings = [], complete = true } = {}) {
  const row = { ...source, date: dateOnly(source.date), method: methodFor(source), marker: marker(source.id),
    status: 'ready', reasons: [], qboPaymentId: null, qboDepositIds: [], matchKind: null };
  const hold = (reason, status = 'exception') => {
    row.reasons.push(reason);
    if (row.status !== 'exception') row.status = status;
  };
  if (!complete) hold('QuickBooks comparison is incomplete. Narrow the receipt date range or retry.');
  if (!/^\d+$/.test(String(source.id))) hold('Receipt identity is missing or invalid.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) hold('Receipt date is missing or invalid.');
  const amount = cents(source.amount), discount = cents(source.discount), allowance = cents(source.allowance);
  if (amount === null || amount <= 0) hold('Receipt amount must be positive and exact to the cent.');
  if (discount === null || allowance === null) hold('Discount or allowance is missing or has unsupported precision.');
  if (discount !== 0 || allowance !== 0) hold('Discount or allowance requires an agreed accounting treatment.', 'needs_review');
  if (!METHODS[source.methodCode]) hold('Unknown payment method. Confirm the source method.');
  if (Number(source.methodCode) === 4 && /\bwire\b/i.test(source.comments || '')) hold('Wire note requires method confirmation.', 'needs_review');
  if (source.pending || Number(source.reversalId) > 0 || Number(source.reversalTypeId) > 0) hold('Pending or reversed receipt requires review.');
  const customerIds = [...new Set(mappings.filter((m) => String(m.source_account) === String(source.account)).map((m) => String(m.qbo_customer_id)))];
  if (customerIds.length !== 1) hold('Confirm one QuickBooks customer mapping for this account.');
  const customerId = customerIds.length === 1 ? customerIds[0] : null;
  row.qboCustomerId = customerId;
  const sourceAllocations = allocations(source.allocations || [], (a) => a.invoiceNumber, (a) => a.amount);
  if (!sourceAllocations?.size) hold('Receipt has no valid positive invoice allocations.');
  const allocated = sourceAllocations ? [...sourceAllocations.values()].reduce((sum, n) => sum + n, 0) : null;
  if (amount !== null && discount !== null && allowance !== null && allocated !== amount + discount + allowance) hold('Receipt and allocations differ. Unapplied or excess amounts stay on hold.');
  const expected = new Map();
  row.invoices = [];
  for (const [number, applied] of sourceAllocations || []) {
    const matches = invoices.filter((invoice) => String(invoice.DocNumber) === number && String(invoice.CustomerRef?.value) === customerId);
    if (matches.length !== 1) { hold(`Invoice ${number}: ${matches.length ? 'multiple matches' : 'not posted for the mapped customer'}.`); continue; }
    const invoice = matches[0];
    expected.set(String(invoice.Id), applied);
    row.invoices.push({ number, qboId: String(invoice.Id), applied: applied / 100, balance: invoice.Balance });
  }
  const allocationMatch = (payment) => expected.size === sourceAllocations?.size && expected.size > 0 && sameAllocations(expected, qboAllocations(payment));
  const identityMatch = (payment) => String(payment.CustomerRef?.value) === customerId && cents(payment.TotalAmt) === amount && dateOnly(payment.TxnDate) === row.date && cents(payment.UnappliedAmt) === 0;
  const marked = payments.filter((payment) => hasMarker(payment.PrivateNote, source.id));
  const strong = payments.filter((payment) => identityMatch(payment) && allocationMatch(payment));
  let match = null;
  if (marked.length) {
    if (marked.length !== 1 || !identityMatch(marked[0]) || !allocationMatch(marked[0]) || strong.some((p) => p.Id !== marked[0].Id)) hold('Source marker conflicts with payment evidence or multiple payments exist.');
    else { match = marked[0]; row.matchKind = 'marker'; }
  } else if (strong.length > 1) hold('Multiple QuickBooks payments match this receipt.');
  else if (strong.length === 1) {
    if (/OptiLens source Innovations payment /.test(strong[0].PrivateNote || '')) hold('Matching payment is marked for another source receipt.');
    else { match = strong[0]; row.matchKind = 'historical_candidate'; }
  } else if (payments.some(identityMatch)) hold('A payment matches customer, date and amount but has different allocations. Review before creating anything.');
  if (match) {
    row.qboPaymentId = String(match.Id);
    const linked = deposits.filter((deposit) => (deposit.Line || []).some((line) => (line.LinkedTxn || []).some((link) => link.TxnType === 'Payment' && String(link.TxnId) === String(match.Id))));
    row.qboDepositIds = linked.map((deposit) => String(deposit.Id));
    if (linked.length !== 1) hold(linked.length ? 'Payment is linked to multiple deposits.' : 'Payment exists; deposit has not been found.', linked.length ? 'exception' : 'needs_review');
    else {
      const lines = (linked[0].Line || []).filter((line) => (line.LinkedTxn || []).some((link) => link.TxnType === 'Payment' && String(link.TxnId) === String(match.Id)));
      if (lines.some((line) => line.LinkedTxn.length !== 1) || lines.reduce((sum, line) => sum + (cents(line.Amount) ?? NaN), 0) !== amount) hold('Deposit allocation does not equal the receipt.');
    }
    if (!row.reasons.length) row.status = 'matched';
  } else {
    for (const invoice of row.invoices) if (cents(invoice.balance) === null || cents(invoice.balance) < cents(invoice.applied)) hold(`Invoice ${invoice.number}: insufficient open balance.`);
  }
  row.memo = `${source.customer || source.account}. ${row.method}. Paid against invoices ${[...(sourceAllocations?.keys() || [])].join(', ')}.\n${row.marker}`;
  return row;
}
function buildReview(sources, evidence) {
  const rows = sources.map((source) => reviewPayment(source, evidence));
  // Two source receipts must never silently claim the same destination payment.
  for (const row of rows) if (row.qboPaymentId && rows.filter((other) => other.qboPaymentId === row.qboPaymentId).length > 1) {
    row.status = 'exception'; row.reasons.push('Multiple source receipts claim this QuickBooks payment.');
  }
  const counts = { all: rows.length, ready: 0, needs_review: 0, exception: 0, matched: 0 };
  rows.forEach((row) => counts[row.status]++);
  return { rows, counts, readOnly: true, postingEnabled: false };
}
module.exports = { cents, marker, hasMarker, buildReview, reviewPayment };
