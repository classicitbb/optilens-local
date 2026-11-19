'use strict';

const crypto = require('node:crypto');

const MAX_BATCH = 25;

// Posting an invoice to QuickBooks takes about 20 seconds, so a batch runs as a background job the screen polls.
// Jobs live in memory only: the sync ledger stays the source of truth if the app restarts mid-batch.
// Every invoice is re-checked first (its payload may have changed since it was proposed), then approved by the
// same guarded function the single-invoice route uses.
function createApprovalJobs({ recheck, approve, maxBatch = MAX_BATCH, keep = 20 }) {
  const jobs = new Map();
  let active = null;

  const view = (job) => ({
    id: job.id,
    state: job.state,
    total: job.items.length,
    finished: job.items.filter((item) => item.status !== 'waiting' && item.status !== 'working').length,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    items: job.items.map((item) => ({ ...item }))
  });

  async function runItem(job, item, actorUserId) {
    item.status = 'working';
    try {
      const checked = (await recheck({ sourceInvoiceIds: [item.sourceInvoiceId], actorUserId })).results?.[0];
      if (checked?.status !== 'pending_approval') {
        item.status = 'skipped';
        item.message = checked?.reason || `Status is ${checked?.status || 'unknown'}, nothing to post.`;
        return;
      }
      const posted = await approve({ sourceInvoiceId: item.sourceInvoiceId, actorUserId });
      item.status = posted.status;
      item.qboId = posted.qboId || null;
    } catch (error) {
      item.status = 'failed';
      item.message = String(error.message || error).slice(0, 300);
    }
  }

  async function run(job, actorUserId) {
    for (const item of job.items) await runItem(job, item, actorUserId);
    job.state = job.items.some((item) => item.status === 'failed') ? 'finished_with_errors' : 'finished';
    job.finishedAt = new Date().toISOString();
    active = null;
    while (jobs.size > keep) jobs.delete(jobs.keys().next().value);
  }

  return {
    start({ sourceInvoiceIds, actorUserId = null }) {
      if (active) throw Object.assign(new Error('A posting batch is already running. Wait for it to finish.'), { statusCode: 409 });
      const ids = [...new Set((sourceInvoiceIds || []).map((id) => String(id).trim()).filter(Boolean))];
      if (!ids.length) throw Object.assign(new Error('Choose at least one invoice to post.'), { statusCode: 400 });
      if (ids.length > maxBatch) throw Object.assign(new Error(`Post at most ${maxBatch} invoices at a time.`), { statusCode: 400 });
      const job = {
        id: crypto.randomUUID(), state: 'running', startedAt: new Date().toISOString(), finishedAt: null,
        items: ids.map((sourceInvoiceId) => ({ sourceInvoiceId, status: 'waiting', qboId: null, message: null }))
      };
      jobs.set(job.id, job);
      active = job;
      void run(job, actorUserId);
      return view(job);
    },
    get(id) {
      const job = jobs.get(id);
      if (!job) throw Object.assign(new Error('That posting batch is no longer available.'), { statusCode: 404 });
      return view(job);
    },
    running() { return active ? view(active) : null; }
  };
}

module.exports = { MAX_BATCH, createApprovalJobs };
