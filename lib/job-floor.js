'use strict';

/**
 * job-floor.js — shop-floor operations against InnovaAPI: job staging and
 * order status updates (the authenticated functions of the Innovations Mobile
 * app and the web "order status update" / "scan and verify" screens).
 *
 * Reads are always available. Writes change the source system, so they are
 * gated: they run only when the `job_floor.writes_enabled` app setting (or the
 * JOB_FLOOR_WRITES_ENABLED env var) is "true" AND the caller passes
 * dryRun:false. Every write attempt, including dry runs and refusals, is
 * recorded as an audit event.
 */
const innova = require('./innova-api-client');
const { getSetting } = require('./app-settings');
const { recordAuditEvent } = require('./audit');

const MODULE_CODE = 'job-floor';
const WRITES_SETTING = 'job_floor.writes_enabled';

const defaultDeps = { api: innova, getSetting, recordAuditEvent };

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

// ---- reads ---------------------------------------------------------------

async function listStatusItems(filters = {}, deps = defaultDeps) {
  const body = await deps.api.request('GET', '/status_items', {
    query: {
      status_group_id: filters.statusGroupId,
      order_type: filters.orderType,
      status_availability: filters.statusAvailability,
      active: filters.active === undefined ? true : filters.active,
    },
  });
  return body?.data?.statusItem ?? [];
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

/** Set an order's status by exactly one of orderId, rxNumber, or trayId. */
async function updateStatus({ orderId, rxNumber, trayId, statusItemId, note, email, emailAddress }, options, deps = defaultDeps) {
  const ids = [orderId, rxNumber, trayId].filter(present);
  if (ids.length !== 1) throw new JobFloorError('Provide exactly one of orderId, rxNumber, or trayId.');
  const statusId = toPositiveInt(statusItemId, 'statusItemId');
  let path; let entityType; let entityId;
  if (present(orderId)) { entityId = toPositiveInt(orderId, 'orderId'); path = `/orders/${entityId}/status_item/${statusId}`; entityType = 'order'; }
  else if (present(rxNumber)) { entityId = String(rxNumber).trim(); path = `/rx_number/${encodeURIComponent(entityId)}/status_item/${statusId}`; entityType = 'rx_number'; }
  else { entityId = String(trayId).trim(); path = `/trays/${encodeURIComponent(entityId)}/status_item/${statusId}`; entityType = 'tray'; }
  const orderUpdateNote = {};
  if (present(note)) orderUpdateNote.note = String(note);
  if (email === true) { orderUpdateNote.email = true; orderUpdateNote.EMailAddress = String(emailAddress ?? ''); }
  return runWrite({
    action: 'update_status', method: 'PUT', path, entityType, entityId,
    body: Object.keys(orderUpdateNote).length ? { orderUpdateNote } : undefined,
  }, options, deps);
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
  JobFloorError, WRITES_SETTING, writesEnabled,
  listStatusItems, listJobQueues, listStagingActions, getRxJob,
  updateStatus, stageJob,
};
