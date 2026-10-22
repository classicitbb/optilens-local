'use strict';

const jobFloor = require('./job-floor');

// Reuses the existing automation permissions: read for lookups, manage for any
// route that can write (writes are additionally gated inside job-floor.js).
async function handleJobFloorRoute({ req, res, url, handleApi, readJsonBody, requirePermission }) {
  if (!url.pathname.startsWith('/api/job-floor')) return false;
  const sub = url.pathname.slice('/api/job-floor'.length) || '/';
  const q = url.searchParams;

  const read = (fn) => handleApi(res, async () => { await requirePermission(req, 'automation.read'); return fn(); });
  const write = (fn) => handleApi(res, async () => {
    const actor = await requirePermission(req, 'automation.manage');
    const body = await readJsonBody(req);
    return fn(body, { dryRun: body.dryRun !== false, actorUserId: actor.userId });
  });

  if (req.method === 'GET') {
    if (sub === '/status-items') { await read(async () => ({ rows: await jobFloor.listStatusItems({ statusGroupId: q.get('statusGroupId'), orderType: q.get('orderType'), statusAvailability: q.get('statusAvailability') }) })); return true; }
    if (sub === '/job-queues') { await read(async () => ({ rows: await jobFloor.listJobQueues() })); return true; }
    if (sub === '/staging-actions') { await read(async () => ({ rows: await jobFloor.listStagingActions() })); return true; }
    if (sub === '/rx-job') { await read(async () => ({ rxJob: await jobFloor.getRxJob({ orderId: q.get('orderId'), trayId: q.get('trayId') }) })); return true; }
    if (sub === '/status') { await read(async () => ({ writesEnabled: await jobFloor.writesEnabled(undefined) })); return true; }
  }
  if (req.method === 'POST') {
    if (sub === '/status-update') { await write((body, opts) => jobFloor.updateStatus(body, opts)); return true; }
    if (sub === '/stage') { await write((body, opts) => jobFloor.stageJob(body, opts)); return true; }
  }
  return false;
}

module.exports = { handleJobFloorRoute };
