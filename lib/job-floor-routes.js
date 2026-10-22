'use strict';

const jobFloor = require('./job-floor');

// Reuses the existing automation permissions: read for lookups, manage for any
// route that can write (writes are additionally gated inside job-floor.js).
async function handleJobFloorRoute({ req, res, url, handleApi, readJsonBody, requirePermission }) {
  if (!url.pathname.startsWith('/api/job-floor')) return false;
  const sub = url.pathname.slice('/api/job-floor'.length) || '/';

  const read = (fn) => handleApi(res, async () => { await requirePermission(req, 'automation.read'); return fn(); });
  const write = (fn) => handleApi(res, async () => {
    const actor = await requirePermission(req, 'automation.manage');
    const body = await readJsonBody(req);
    return fn(body, { dryRun: body.dryRun !== false, actorUserId: actor.userId });
  });

  if (req.method === 'GET') {
    if (sub === '/status-items') { await read(async () => ({ rows: await jobFloor.listStatusItems() })); return true; }
    if (sub === '/status') { await read(async () => ({ writesEnabled: await jobFloor.writesEnabled(undefined) })); return true; }
  }
  if (req.method === 'POST') {
    if (sub === '/status-update') { await write((body, opts) => jobFloor.updateStatus(body, opts)); return true; }
  }
  return false;
}

module.exports = { handleJobFloorRoute };
