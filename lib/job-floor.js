'use strict';

/**
 * job-floor.js — shop-floor order status updates written straight to the
 * Innovations database (job-floor-source.js), found by order, RX number or tray.
 *
 * Previews are always available. Writes change the source system, so they are
 * gated: they run only when the `job_floor.writes_enabled` app setting (or the
 * JOB_FLOOR_WRITES_ENABLED env var) is "true" AND the caller passes
 * dryRun:false. Status writes also need `job_floor.source_user_account_id`
 * (or JOB_FLOOR_SOURCE_USER_ACCOUNT_ID): the Innovations UserAccounts row the
 * history is attributed to. Every write attempt, including dry runs and
 * refusals, is recorded as an audit event.
 */
const source = require('./job-floor-source');
const { getSetting } = require('./app-settings');
const { recordAuditEvent } = require('./audit');

const MODULE_CODE = 'job-floor';
const WRITES_SETTING = 'job_floor.writes_enabled';
const SOURCE_USER_SETTING = 'job_floor.source_user_account_id';

const defaultDeps = { source, getSetting, recordAuditEvent };

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

// ---- gated writes --------------------------------------------------------

/**
 * Set an order's status by orderId, rxNumber or trayId, directly in the source
 * database. Dry runs read current state and report the writes they would make.
 * Optional `expectedCurrentStatusId` refuses the write if the order moved.
 */
async function updateStatus({ orderId, rxNumber, trayId, statusItemId, expectedCurrentStatusId, note, email }, { dryRun = true, actorUserId = null } = {}, deps = defaultDeps) {
  if (present(note) || email === true) throw new JobFloorError('Notes and e-mail are not supported for direct status updates.');
  const ids = [orderId, rxNumber, trayId].filter(present);
  if (ids.length !== 1) throw new JobFloorError('Provide exactly one of orderId, rxNumber or trayId.');
  const statusId = toPositiveInt(statusItemId, 'statusItemId');
  const identifier = present(orderId) ? 'orderId' : present(rxNumber) ? 'rxNumber' : 'trayId';
  const entityType = { orderId: 'order', rxNumber: 'rx_number', trayId: 'tray' }[identifier];
  const entityId = identifier === 'orderId' ? toPositiveInt(orderId, 'orderId') : String(identifier === 'rxNumber' ? rxNumber : trayId).trim();
  const input = {
    [identifier]: entityId,
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

module.exports = {
  JobFloorError, WRITES_SETTING, SOURCE_USER_SETTING, writesEnabled, sourceUserAccountId,
  listStatusItems, updateStatus,
};
