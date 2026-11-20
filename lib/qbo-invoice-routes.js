'use strict';

const { saveLocalCustomer, customerJobStatus, confirmCustomerMapping, getExceptionFixOptions, recheckInvoices, saveStandardTaxCode, setAutoPost, approveProductionProposal, getQboInvoiceSyncStatus, listQboInvoiceLedger, syncInvoices, loadReview, loadReconciliation, productionApplyEnabled } = require('./qbo-invoice-sync');
const { rowsForScope, toQuickBooksCsv } = require('./qbo-invoice-review');
const { createApprovalJobs } = require('./qbo-approval-jobs');

const approvalJobs = createApprovalJobs({ recheck: recheckInvoices, approve: approveProductionProposal });

function reviewDates(url) {
  const fromDate = url.searchParams.get('fromDate') || null;
  const toDate = url.searchParams.get('toDate') || null;
  const valid = (date) => {
    if (!date) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000')) return false;
    const parsed = new Date(date + 'T00:00:00Z');
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
  };
  if (!valid(fromDate) || !valid(toDate) || (fromDate && toDate && fromDate > toDate)) {
    throw Object.assign(new Error('Choose a valid invoice date range.'), { statusCode: 400 });
  }
  return { fromDate, toDate };
}

async function handleQboInvoiceRoute({ req, res, url, handleApi, readJsonBody, requirePermission }) {
  if (!url.pathname.startsWith('/api/automation/qbo-invoices')) return false;
  if (url.pathname === '/api/automation/qbo-invoices' && req.method === 'GET') {
    await handleApi(res, async () => { await requirePermission(req, 'automation.read'); return getQboInvoiceSyncStatus(); });
    return true;
  }
  if (url.pathname === '/api/automation/qbo-invoices/customers' && req.method === 'POST') {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, 'automation.manage');
      const body = await readJsonBody(req);
      return saveLocalCustomer({ account: body.account, name: body.name, actorUserId: actor.userId });
    });
    return true;
  }
  if (url.pathname === '/api/automation/qbo-invoices/customers' && req.method === 'GET') {
    await handleApi(res, async () => {
      await requirePermission(req, 'automation.manage');
      return customerJobStatus();
    });
    return true;
  }
  if (url.pathname === '/api/automation/qbo-invoices/ledger' && req.method === 'GET') {
    await handleApi(res, async () => { await requirePermission(req, 'automation.read'); return { rows: await listQboInvoiceLedger({ limit: url.searchParams.get('limit'), status: url.searchParams.get('status') }) }; });
    return true;
  }
  if (url.pathname === '/api/automation/qbo-invoices/run' && req.method === 'POST') {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, 'automation.manage');
      const body = await readJsonBody(req);
      return syncInvoices({ fromDate: body.fromDate || null, toDate: body.toDate || null, dryRun: body.dryRun !== false, trigger: 'manual', actorUserId: actor.userId });
    });
    return true;
  }
  if (url.pathname === '/api/automation/qbo-invoices/fix-options' && req.method === 'GET') {
    await handleApi(res, async () => { await requirePermission(req, 'automation.manage'); return getExceptionFixOptions(); });
    return true;
  }
  if (url.pathname === '/api/automation/qbo-invoices/customer-mappings' && req.method === 'POST') {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, 'automation.manage');
      const body = await readJsonBody(req);
      return confirmCustomerMapping({ sourceAccount: body.sourceAccount, qboCustomerId: body.qboCustomerId, actorUserId: actor.userId });
    });
    return true;
  }
  if (url.pathname === '/api/automation/qbo-invoices/tax-code' && req.method === 'POST') {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, 'automation.manage');
      const body = await readJsonBody(req);
      return saveStandardTaxCode({ taxCodeId: body.taxCodeId, actorUserId: actor.userId });
    });
    return true;
  }
  if (url.pathname === '/api/automation/qbo-invoices/recheck' && req.method === 'POST') {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, 'automation.manage');
      const body = await readJsonBody(req);
      return recheckInvoices({ sourceInvoiceIds: Array.isArray(body.sourceInvoiceIds) ? body.sourceInvoiceIds : [], actorUserId: actor.userId });
    });
    return true;
  }
  if (url.pathname === '/api/automation/qbo-invoices/review' && req.method === 'GET') {
    await handleApi(res, async () => { await requirePermission(req, 'automation.read'); const canManage = await requirePermission(req, 'automation.manage').then(() => true, () => false);
      return { ...(await loadReview(reviewDates(url))), canManage, job: approvalJobs.running() };
    });
    return true;
  }
  if (url.pathname === '/api/automation/qbo-invoices/reconcile' && req.method === 'GET') {
    await handleApi(res, async () => { await requirePermission(req, 'automation.read'); return loadReconciliation(); });
    return true;
  }
  if (url.pathname === '/api/automation/qbo-invoices/export.csv' && req.method === 'GET') {
    try {
      await requirePermission(req, 'automation.manage');
      const scope = url.searchParams.get('scope') || 'unposted';
      const { csv, exported, skippedCredits } = toQuickBooksCsv(rowsForScope((await loadReview(reviewDates(url))).rows, scope));
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="quickbooks-invoices-${scope}-${new Date().toISOString().slice(0, 10)}.csv"`,
        'X-Exported-Count': String(exported),
        'X-Skipped-Credits': String(skippedCredits),
        'Cache-Control': 'no-store'
      });
      res.end(csv);
    } catch (error) {
      await handleApi(res, async () => { throw error; });
    }
    return true;
  }
  if (url.pathname === '/api/automation/qbo-invoices/approve-batch' && req.method === 'POST') {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, 'automation.manage');
      if (!productionApplyEnabled()) throw Object.assign(new Error('Posting to QuickBooks is switched off on this server.'), { statusCode: 403 });
      const body = await readJsonBody(req);
      return approvalJobs.start({ sourceInvoiceIds: Array.isArray(body.sourceInvoiceIds) ? body.sourceInvoiceIds : [], actorUserId: actor.userId });
    });
    return true;
  }
  if (url.pathname === '/api/automation/qbo-invoices/auto-post' && req.method === 'POST') {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, 'automation.manage');
      const body = await readJsonBody(req);
      if (typeof body.enabled !== 'boolean') throw Object.assign(new Error('Say whether auto-post should be on or off.'), { statusCode: 400 });
      const saved = await setAutoPost({ enabled: body.enabled, actorUserId: actor.userId });
      return { autoPost: saved.autoPost, changedAt: saved.changedAt };
    });
    return true;
  }
  const jobMatch = url.pathname.match(/^\/api\/automation\/qbo-invoices\/approval-jobs\/([^/]+)$/);
  if (jobMatch && req.method === 'GET') {
    await handleApi(res, async () => { await requirePermission(req, 'automation.read'); return approvalJobs.get(decodeURIComponent(jobMatch[1])); });
    return true;
  }
  const approvalMatch = url.pathname.match(/^\/api\/automation\/qbo-invoices\/([^/]+)\/approve$/);
  if (approvalMatch && req.method === 'POST') {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, 'automation.manage');
      return approveProductionProposal({ sourceInvoiceId: decodeURIComponent(approvalMatch[1]), actorUserId: actor.userId });
    });
    return true;
  }
  return false;
}

module.exports = { handleQboInvoiceRoute };
