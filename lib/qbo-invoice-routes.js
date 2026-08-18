'use strict';

const { getQboInvoiceSyncStatus, listQboInvoiceLedger, syncInvoices } = require('./qbo-invoice-sync');

async function handleQboInvoiceRoute({ req, res, url, handleApi, readJsonBody, requirePermission }) {
  if (!url.pathname.startsWith('/api/automation/qbo-invoices')) return false;
  if (url.pathname === '/api/automation/qbo-invoices' && req.method === 'GET') {
    await handleApi(res, async () => { await requirePermission(req, 'automation.read'); return getQboInvoiceSyncStatus(); });
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
  return false;
}

module.exports = { handleQboInvoiceRoute };
