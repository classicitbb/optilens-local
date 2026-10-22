'use strict';

/**
 * job-floor.js — shop-floor operations: order status updates written straight
 * to the Innovations database (job-floor-source.js), and job staging through
 * InnovaAPI (the authenticated functions of the Innovations Mobile app).
 *
 * Reads are always available. Writes change the source system, so they are
 * gated: they run only when the `job_floor.writes_enabled` app setting (or the
 * JOB_FLOOR_WRITES_ENABLED env var) is "true" AND the caller passes
 * dryRun:false. Status writes also need `job_floor.source_user_account_id`
 * (or JOB_FLOOR_SOURCE_USER_ACCOUNT_ID): the Innovations UserAccounts row the
 * history is attributed to. Every write attempt, including dry runs and
 * refusals, is recorded as an audit event.
 */
const innova = require('./innova-api-client');
const source = require('./job-floor-source');
const { getSetting } = require('./app-settings');
const { recordAuditEvent } = require('./audit');

const MODULE_CODE = 'job-floor';
const WRITES_SETTING = 'job_floor.writes_enabled';
const SOURCE_USER_SETTING = 'job_floor.source_user_account_id';

const defaultDeps = { api: innova, source, getSetting, recordAuditEvent };

class JobFloorError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'JobFloorError';
    this.statusCode = status;
  }
}

const present = (v) => v !== null && v !== undefined && String(v).trim() !== '';
const toPositiveInt = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new JobFloorError(`${name} must be a positive integer.`);
  return n;
};

async function writesEnabled(deps = defaultDeps) {
  const env = String(process.env.JOB_FLOOR_WRITES_ENABLED ?? '').trim().toLowerCase();
  if (env) return env === 'true';
  return String(await deps.getSetting(WRITES_SETTING).catch(() => null)).toLowerCase() === 'true';
}

async function sourceUserAccountId(deps = defaultDeps) {
  const raw = String(process.env.JOB_FLOOR_SOURCE_USER_ACCOUNT_ID ?? '').trim()
    || String(await deps.getSetting(SOURCE_USER_SETTING).catch(() => '') ?? '').trim();
  if (!raw) return null;
  return toPositiveInt(raw, SOURCE_USER_SETTING);
}

// ---- reads ---------------------------------------------------------------

/** Statuses the direct-database writer will accept (same shape the page expects). */
async function listStatusItems(_filters = {}, deps = defaultDeps) {
  const rows = await deps.source.listAllowedStatuses();
  return rows.map((r) => ({ ID: r.id, name: r.name, inactive: false, showInMobileApp: true }));
}

async function listJobQueues(deps = defaultDeps) {
  const body = await deps.api.request('GET', '/job_queues');
  return body?.data?.jobQueue ?? [];
}

async function listStagingActions(deps = defaultDeps) {
  const body = await deps.api.request('GET', '/job_staging_actions');
  return body?.data?.jobStagingActions ?? [];
}

async function getRxJob({ orderId, trayId }, deps = defaultDeps) {
  if (present(orderId) === present(trayId)) throw new JobFloorError('Provide exactly one of orderId or trayId.');
  const body = present(orderId)
    ? await deps.api.request('GET', `/orders/${toPositiveInt(orderId, 'orderId')}/rx_job`)
    : await deps.api.request('GET', `/trays/${encodeURIComponent(String(trayId).trim())}/rx_job`);
  return body?.data?.rxJob ?? null;
}

// ---- gated writes --------------------------------------------------------

/** Build and (if allowed) execute a write. `plan` = { action, method, path, query, body, entityType, entityId }. */
async function runWrite(plan, { dryRun = true, actorUserId = null } = {}, deps = defaultDeps) {
  const request = { method: plan.method, path: plan.path, query: plan.query ?? {}, body: plan.body };
  const audit = (eventType, extra = {}) => deps.recordAuditEvent({
    moduleCode: MODULE_CODE,
    actorUserId,
    eventType: `job_floor.${plan.action}.${eventType}`,
    entityType: plan.entityType,
    entityId: String(plan.entityId),
    eventData: { request, ...extra },
  });

  if (dryRun !== false) {
    await audit('dry_run');
    return { ok: true, dryRun: true, request };
  }
  if (!(await writesEnabled(deps))) {
    await audit('refused', { reason: 'writes disabled' });
    throw new JobFloorError('Source-system writes are disabled for the job-floor module.', 403);
  }
  await audit('attempted');
  try {
    const response = await deps.api.request(plan.method, plan.path, { query: plan.query, body: plan.body });
    await audit('succeeded');
    return { ok: true, dryRun: false, request, response: response?.data ?? response };
  } catch (error) {
    await audit('failed', { error: String(error.message).slice(0, 300) });
    throw error;
  }
}

/**
 * Set an order's status by orderId or rxNumber, directly in the source
 * database. Dry runs read current state and report the writes they would make.
 * Optional `expectedCurrentStatusId` refuses the write if the order moved.
 */
async function updateStatus({ orderId, rxNumber, trayId, statusItemId, expectedCurrentStatusId, note, email }, { dryRun = true, actorUserId = null } = {}, deps = defaultDeps) {
  if (present(trayId)) throw new JobFloorError('Tray lookup is not supported for direct status updates; use orderId or rxNumber.');
  if (present(note) || email === true) throw new JobFloorError('Notes and e-mail are not supported for direct status updates.');
  const ids = [orderId, rxNumber].filter(present);
  if (ids.length !== 1) throw new JobFloorError('Provide exactly one of orderId or rxNumber.');
  const statusId = toPositiveInt(statusItemId, 'statusItemId');
  const entityType = present(orderId) ? 'order' : 'rx_number';
  const entityId = present(orderId) ? toPositiveInt(orderId, 'orderId') : String(rxNumber).trim();
  const input = {
    [present(orderId) ? 'orderId' : 'rxNumber']: entityId,
    statusItemId: statusId,
    expectedCurrentStatusId: present(expectedCurrentStatusId) ? toPositiveInt(expectedCurrentStatusId, 'expectedCurrentStatusId') : undefined,
  };
  const audit = (eventType, extra = {}) => deps.recordAuditEvent({
    moduleCode: MODULE_CODE,
    actorUserId,
    eventType: `job_floor.update_status.${eventType}`,
    entityType,
    entityId: String(entityId),
    eventData: { request: input, ...extra },
  });
  const wrap = (error) => (error instanceof source.SourceStatusError
    ? Object.assign(new JobFloorError(error.message, error.statusCode), { code: error.code })
    : error);

  const userAccountId = await sourceUserAccountId(deps);

  if (dryRun !== false) {
    let plan;
    try {
      plan = await deps.source.previewStatusUpdate({ ...input, userAccountId });
    } catch (error) {
      await audit('dry_run_failed', { error: String(error.message).slice(0, 300) });
      throw wrap(error);
    }
    await audit('dry_run', { plan });
    return { ok: true, dryRun: true, request: input, plan, sourceUserConfigured: userAccountId !== null };
  }
  if (!(await writesEnabled(deps))) {
    await audit('refused', { reason: 'writes disabled' });
    throw new JobFloorError('Source-system writes are disabled for the job-floor module.', 403);
  }
  if (userAccountId === null) {
    await audit('refused', { reason: 'source user account not configured' });
    throw new JobFloorError(`Set ${SOURCE_USER_SETTING} (the Innovations user account these updates are attributed to) before writing.`, 409);
  }
  await audit('attempted');
  try {
    const result = await deps.source.applyStatusUpdate({ ...input, userAccountId });
    await audit('succeeded', { result });
    return { ok: true, dryRun: false, request: input, result };
  } catch (error) {
    await audit('failed', { error: String(error.message).slice(0, 300), code: error.code });
    throw wrap(error);
  }
}

/** Add or remove a job from the staging area. `actionId` selects the staging action (see listStagingActions). */
async function stageJob({ trayId, orderId, rxNumber, poNumber, invoiceId, actionId, sku, containerName, checkInsOnly, stagingAreaId }, options, deps = defaultDeps) {
  const ids = [trayId, orderId, rxNumber, poNumber, invoiceId, sku, containerName].filter(present);
  if (ids.length < 1) throw new JobFloorError('Identify the job with trayId, orderId, rxNumber, poNumber, invoiceId, sku or containerName.');
  const query = {
    tray_id: trayId, order_id: present(orderId) ? toPositiveInt(orderId, 'orderId') : undefined,
    rx_number: rxNumber, po_number: poNumber,
    invoice_id: present(invoiceId) ? toPositiveInt(invoiceId, 'invoiceId') : undefined,
    action_id: present(actionId) ? toPositiveInt(actionId, 'actionId') : undefined,
    sku, container_name: containerName,
    check_ins_only: checkInsOnly ? 1 : undefined,
    staging_area_id: present(stagingAreaId) ? toPositiveInt(stagingAreaId, 'stagingAreaId') : undefined,
  };
  const entityId = ids[0];
  return runWrite({ action: 'stage_job', method: 'PUT', path: '/job_staging', query, entityType: 'job', entityId }, options, deps);
}

module.exports = {
  JobFloorError, WRITES_SETTING, SOURCE_USER_SETTING, writesEnabled, sourceUserAccountId,
  listStatusItems, listJobQueues, listStagingActions, getRxJob,
  updateStatus, stageJob,
};
