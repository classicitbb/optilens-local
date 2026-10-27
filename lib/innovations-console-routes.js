'use strict';

const consoleService = require('./innovations-console');

// Own permissions: read for every lookup, manage for the two routes that write
// to the source system (writes are additionally gated inside innovations-console.js).
async function handleInnovationsConsoleRoute({ req, res, url, handleApi, readJsonBody, requirePermission }) {
  if (!url.pathname.startsWith('/api/innovations-console')) return false;
  const sub = url.pathname.slice('/api/innovations-console'.length) || '/';
  const q = url.searchParams;

  const read = (fn) => handleApi(res, async () => { await requirePermission(req, 'innovations-console.read'); return fn(); });
  const write = (fn) => handleApi(res, async () => {
    const actor = await requirePermission(req, 'innovations-console.manage');
    const body = await readJsonBody(req);
    return fn(body, { actorUserId: actor.userId });
  });

  if (req.method === 'GET') {
    if (sub === '/status') { await read(() => consoleService.status()); return true; }
    if (sub === '/skin') { await read(() => consoleService.getSkin()); return true; }
    if (sub === '/status-items') { await read(() => consoleService.listStatusItems()); return true; }
    if (sub === '/tracking') { await read(() => consoleService.getTracking({ searchType: q.get('searchType'), value: q.get('value') })); return true; }
    if (sub === '/rx-details') { await read(() => consoleService.getRxDetails({ trayId: q.get('trayId') })); return true; }
    if (sub === '/stock') { await read(() => consoleService.getStockDescription({ opc: q.get('opc') })); return true; }
  }
  if (req.method === 'POST') {
    if (sub === '/status-update') { await write((body, opts) => consoleService.updateStatus(body, opts)); return true; }
    if (sub === '/stock-adjust') { await write((body, opts) => consoleService.adjustStock(body, opts)); return true; }
  }
  return false;
}

module.exports = { handleInnovationsConsoleRoute };
