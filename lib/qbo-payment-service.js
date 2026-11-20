'use strict';

const { buildReview } = require('./qbo-payment-review');
const MAX_RECEIPTS = 100;
const MAX_INVOICES = 300;
function dateParameter(value, fallback) {
  const text = value || fallback;
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) throw Object.assign(new Error('Use a valid YYYY-MM-DD date.'), { statusCode: 400 });
  return text;
}
function reviewWindow({ from, to, limit } = {}) {
  const calendarDate = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Barbados', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const today = calendarDate(new Date());
  const start = calendarDate(new Date(Date.now() - 90 * 86400000));
  const window = { from: dateParameter(from, start), to: dateParameter(to, today), limit: limit == null || limit === '' ? 50 : Number(limit) };
  if (window.from > window.to || (Date.parse(window.to) - Date.parse(window.from)) / 86400000 > 366) throw Object.assign(new Error('Choose an ordered receipt date range of at most 366 days.'), { statusCode: 400 });
  if (!Number.isInteger(window.limit) || window.limit < 1 || window.limit > MAX_RECEIPTS) throw Object.assign(new Error('Receipt limit must be between 1 and 100.'), { statusCode: 400 });
  return window;
}
async function sourceReceipts(pool, window) {
  const request = pool.request().input('from', window.from).input('to', window.to).input('take', window.limit + 1);
  // Explicit projection excludes payment instrument/account/expiry fields.
  const { recordsets } = await request.query(`
    SELECT TOP (@take) p.FinARPaymentID AS id, p.PaymentDate AS date,
      c.AccountNumber AS account, c.CustomerName AS customer,
      CONVERT(varchar(40), p.Amount, 2) AS amount, CONVERT(varchar(40), p.Discount, 2) AS discount,
      CONVERT(varchar(40), p.Allowance, 2) AS allowance,
      p.PaymentMethod AS methodCode, p.Pending AS pending, p.FinARStatus AS sourceStatus,
      p.ReversalID AS reversalId, p.FinARReversalTypeID AS reversalTypeId,
      p.LastUpdated AS lastUpdated
    INTO #paymentReview
    FROM dbo.FinARPayments p LEFT JOIN dbo.Customers c ON c.CustomerID=p.CustomerID
    WHERE p.PaymentDate >= CONVERT(date,@from) AND p.PaymentDate < DATEADD(day,1,CONVERT(date,@to))
    ORDER BY p.PaymentDate DESC,p.FinARPaymentID DESC;
    SELECT * FROM #paymentReview ORDER BY date DESC,id DESC;
    SELECT l.FinARPaymentID AS paymentId, l.InvoiceID AS invoiceNumber,
      CONVERT(varchar(40),l.AmountPaid,2) AS amount
    FROM dbo.FinARPaymentLinks l JOIN #paymentReview p ON p.id=l.FinARPaymentID;
  `);
  const [receipts = [], links = []] = recordsets;
  return { truncated: receipts.length > window.limit, rows: receipts.slice(0, window.limit).map((receipt) => ({
    ...receipt, id: String(receipt.id), allocations: links.filter((link) => String(link.paymentId) === String(receipt.id)).map((link) => ({ invoiceNumber: link.invoiceNumber == null ? null : String(link.invoiceNumber), amount: link.amount }))
  })) };
}
async function readPages(connection, resource) {
  const rows = [];
  for (let start = 1; start <= 10000; start += 1000) {
    const result = await connection.query(`SELECT * FROM ${resource} ORDERBY Id STARTPOSITION ${start} MAXRESULTS 1000`);
    const page = result[resource] || [];
    rows.push(...page);
    if (page.length < 1000) return { rows, complete: true };
  }
  return { rows, complete: false };
}
function createPaymentService({ getSourcePool, getAppPool, openQboReadConnection }) {
  let active = null;
  return {
    async review(options = {}) {
      const window = reviewWindow(options);
      if (active) throw Object.assign(new Error('A payment comparison is already running. Try again when it finishes.'), { statusCode: 409 });
      active = true;
      try {
        const source = await sourceReceipts(await getSourcePool(), window);
        const opened = await openQboReadConnection();
        const deadline = Date.now() + 120000;
        const connection = { ...opened, query(statement) {
          if (Date.now() > deadline) throw Object.assign(new Error('Comparison exceeded two minutes; choose fewer receipts or a narrower range.'), { statusCode: 409 });
          return opened.query(statement);
        } };
        // Harmless connection read, never a transaction create/update.
        await connection.query('SELECT * FROM CompanyInfo MAXRESULTS 1');
        const appPool = await getAppPool();
        const { recordset: mappings } = await appPool.request().input('realm', connection.realmId).query(`SELECT source_account,qbo_customer_id FROM qbo.customer_mappings WHERE qbo_realm_id=@realm AND mapping_state=N'confirmed'`);
        const paymentEvidence = await readPages(connection, 'Payment');
        const depositEvidence = await readPages(connection, 'Deposit');
        const numbers = [...new Set(source.rows.flatMap((r) => r.allocations.map((a) => a.invoiceNumber)).filter((n) => /^\d+$/.test(n)))];
        const invoices = [];
        // Exact DocNumber reads include pre-cutover/manual invoices; do not reuse the invoice discovery exclusions.
        for (const number of numbers.slice(0, MAX_INVOICES)) {
          const result = await connection.query(`SELECT * FROM Invoice WHERE DocNumber = '${number}' MAXRESULTS 1000`);
          const page = result.Invoice || [];
          if (page.length === 1000) throw Object.assign(new Error('Invoice lookup is incomplete; narrow the receipt range.'), { statusCode: 409 });
          invoices.push(...page);
        }
        const complete = paymentEvidence.complete && depositEvidence.complete && numbers.length <= MAX_INVOICES;
        return { ...buildReview(source.rows, { mappings, invoices, payments: paymentEvidence.rows, deposits: depositEvidence.rows, complete }),
          environment: connection.environment, checkedAt: new Date().toISOString(), window,
          sourceTruncated: source.truncated, comparisonComplete: complete,
          notices: ['Read-only comparison. Ready means ready for review; posting is not implemented.',
            'Historical matches are candidates for confirmation; no QuickBooks memos have been changed.',
            'Currency, source posting-status semantics, deposit account and payment-method details require pilot validation.',
            ...(source.truncated ? ['Only the newest receipts in this date range are shown. Narrow the dates to review the remainder.'] : [])] };
      } finally { active = null; }
    }
  };
}
let service;
async function loadPaymentReview(options) {
  if (!service) service = createPaymentService({ ...require('./db'), openQboReadConnection: require('./qbo-invoice-sync').openQboReadConnection });
  return service.review(options);
}
module.exports = { createPaymentService, loadPaymentReview, reviewWindow, sourceReceipts, readPages };
