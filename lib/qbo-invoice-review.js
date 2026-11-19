'use strict';

// Pure view-model logic for the QuickBooks invoice review screen. No I/O happens here:
// the sync module loads the data, this module decides what each invoice means for the people using the screen.

const DEFAULT_REVIEW_LIMIT = 5000;
const STANDARD_VAT_LABEL = 'VAT 17.5%';
const ZERO_VAT_LABEL = 'VAT-0%';

// Barbados sales (and any invoice carrying VAT) are "Local"; non-Barbados export customers are "Export".
// Class ("Local Sales" / "Export Sales") and Location ("Local" / "Export") both follow this one rule.
function revenueSegment(invoice) {
  const exportCustomer = /\s-\s*export\s*$/i.test(String(invoice.itemName || ''));
  return Number(invoice.taxAmount || 0) === 0 && exportCustomer ? 'Export' : 'Local';
}

// Ship via / ship date / tracking number from the Innovations shipment, where available.
// The leading route number on method names ("0 Randall Hunte - Delivery") is dropped.
function shippingSummary(invoice) {
  const via = String(invoice.shipMethod || '').replace(/^\s*\d+\s+/, '').trim();
  const shipped = invoice.shippedTime ? new Date(invoice.shippedTime) : null;
  const date = shipped && !Number.isNaN(shipped.getTime())
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Barbados' }).format(shipped)
    : null;
  const tracking = String(invoice.trackingNumber || '').trim();
  return { via: via || null, date, tracking: tracking || null };
}

function taxCodeLabel(invoice) {
  return Number(invoice.taxAmount || 0) === 0 ? ZERO_VAT_LABEL : STANDARD_VAT_LABEL;
}

// Reasons an otherwise valid invoice should wait for a person instead of being posted in bulk.
function holdReasons(invoice, { reviewLimit = DEFAULT_REVIEW_LIMIT } = {}) {
  const holds = [];
  if (Number(invoice.taxAmount || 0) !== 0) holds.push('Carries VAT 17.5%. Check the first ones by hand.');
  if (invoice.isCredit) holds.push('Credit note.');
  if (Math.abs(Number(invoice.total || 0)) > reviewLimit) holds.push(`Total is over ${reviewLimit.toLocaleString('en-US')}.`);
  return holds;
}

// Plain-language next step for each kind of exception the sync can raise.
function exceptionAdvice(reason) {
  const text = String(reason || '');
  if (/customer mapping/i.test(text)) return { kind: 'customer', action: 'Map this Innovations account to its QuickBooks customer, then re-check.' };
  if (/conflicting|name-only|inactive/i.test(text)) return { kind: 'customer', action: 'The customer master and QuickBooks disagree. Fix the customer record, then re-check.' };
  if (/item mapping/i.test(text)) return { kind: 'item', action: 'Create or rename the QuickBooks item so its name matches exactly, then re-check.' };
  if (/tax code/i.test(text)) return { kind: 'tax', action: 'Choose the QuickBooks code for VAT 17.5%, then re-check.' };
  if (/reconciliation found/i.test(text)) return { kind: 'duplicate', action: 'QuickBooks already has an invoice with this number that the sync did not create. Open it in QuickBooks and decide.' };
  return { kind: 'other', action: 'Re-check. If it comes back, ask for help.' };
}

const POSTED_STATUSES = new Set(['synced', 'reconciled_existing']);

function laneFor(ledger, holds) {
  if (!ledger) return 'new';
  if (POSTED_STATUSES.has(ledger.status)) return 'posted';
  if (ledger.status === 'exception' || ledger.status === 'failed') return 'exception';
  if (ledger.status === 'pending_approval') return holds.length ? 'attention' : 'ready';
  return 'new';
}

function isoDay(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

// Merge Innovations invoices with their sync ledger rows into the rows the screen renders.
function buildReviewRows({ invoices = [], ledger = [], customerNames = new Map(), reviewLimit = DEFAULT_REVIEW_LIMIT } = {}) {
  const ledgerById = new Map(ledger.map((row) => [String(row.source_invoice_id), row]));
  return invoices.map((invoice) => {
    const entry = ledgerById.get(String(invoice.sourceInvoiceId)) || null;
    const holds = holdReasons(invoice, { reviewLimit });
    const lane = laneFor(entry, holds);
    const segment = revenueSegment(invoice);
    const shipping = shippingSummary(invoice);
    const error = lane === 'exception' ? (entry.last_error || 'The last sync attempt failed.') : null;
    return {
      sourceInvoiceId: String(invoice.sourceInvoiceId),
      invoiceDate: isoDay(invoice.invoiceTime),
      dueDate: isoDay(invoice.dueDate),
      account: invoice.customerAccount || '',
      customer: String(invoice.customerName || '').trim(),
      qboCustomer: customerNames.get(String(invoice.customerAccount || '').trim()) || null,
      itemName: invoice.itemName || '',
      total: Math.abs(Number(invoice.total || 0)),
      isCredit: Boolean(invoice.isCredit),
      segment,
      className: `${segment} Sales`,
      location: segment,
      taxCode: taxCodeLabel(invoice),
      memo: invoice.jobMemo || invoice.memo || '',
      shipVia: shipping.via,
      shipDate: shipping.date,
      tracking: shipping.tracking,
      status: entry?.status || 'not_checked',
      lane,
      kind: lane === 'ready' || lane === 'attention' ? (entry.qbo_transaction_id ? 'update' : 'create') : null,
      holds: lane === 'attention' ? holds : [],
      error,
      advice: error ? exceptionAdvice(error) : null,
      qboId: entry?.qbo_transaction_id || null,
      qboType: entry?.qbo_transaction_type || null
    };
  });
}

const LANES = ['ready', 'attention', 'exception', 'posted', 'new'];

function summarizeRows(rows) {
  const lanes = Object.fromEntries(LANES.map((lane) => [lane, { count: 0, total: 0 }]));
  for (const row of rows) {
    const bucket = lanes[row.lane] || lanes.new;
    bucket.count += 1;
    bucket.total += row.isCredit ? -row.total : row.total;
  }
  for (const bucket of Object.values(lanes)) bucket.total = Math.round(bucket.total * 100) / 100;
  return { lanes, count: rows.length };
}

// ---- QuickBooks CSV fallback -------------------------------------------------------------
// Same columns as the CSV import the business used before the sync, plus Location. Credit notes cannot
// be imported as invoices, so they are reported back instead of being written to the file.
const CSV_COLUMNS = ['InvoiceNo', 'Customer', 'Item (Product/Service)', 'Memo', 'ItemRate', 'ItemAmount', 'InvoiceDate', 'DueDate', 'ItemTaxCode', 'Location'];

function csvDate(isoDate) {
  const [year, month, day] = String(isoDate || '').split('-');
  return year && month && day ? `${day}/${month}/${year}` : '';
}

// Spreadsheet programs run cells that begin with these characters as formulas.
function csvText(value) {
  const text = String(value ?? '').replace(/\r?\n/g, ' ');
  const safe = /^[=+\-@\t]/.test(text) ? `'${text}` : text;
  return /[",]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toQuickBooksCsv(rows) {
  const exportable = rows.filter((row) => !row.isCredit);
  const lines = exportable.map((row) => [
    csvText(row.sourceInvoiceId),
    csvText(row.qboCustomer || `${row.customer} - ${row.account}`),
    csvText(row.itemName),
    csvText(row.memo),
    row.total.toFixed(2),
    row.total.toFixed(2),
    csvDate(row.invoiceDate),
    csvDate(row.dueDate),
    csvText(row.taxCode),
    csvText(row.location)
  ].join(','));
  return { csv: `${[CSV_COLUMNS.join(','), ...lines].join('\r\n')}\r\n`, exported: exportable.length, skippedCredits: rows.length - exportable.length };
}

// Which rows a CSV download covers. "unposted" is everything not yet in QuickBooks.
const SCOPES = {
  all: () => true,
  ready: (row) => row.lane === 'ready',
  posted: (row) => row.lane === 'posted',
  unposted: (row) => row.lane === 'ready' || row.lane === 'attention' || row.lane === 'new'
};

function rowsForScope(rows, scope = 'unposted') {
  const keep = SCOPES[scope];
  if (!keep) throw Object.assign(new Error(`Unknown export scope '${scope}'.`), { statusCode: 400 });
  return rows.filter(keep);
}

module.exports = {
  CSV_COLUMNS, DEFAULT_REVIEW_LIMIT, LANES,
  buildReviewRows, exceptionAdvice, holdReasons, laneFor, revenueSegment, rowsForScope, shippingSummary, summarizeRows, taxCodeLabel, toQuickBooksCsv
};
