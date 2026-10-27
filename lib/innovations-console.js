'use strict';

/**
 * innovations-console.js — server side of the Innovations Console module, a
 * replica of the vendor's Innovations web client (Tracking, Status Update,
 * Rx Job Details, Stock). Reads come straight from the Innovations source
 * database through lib/innovations-console-db.js, the same read path the other
 * OptiLens modules use, so no vendor REST service or service account is needed.
 * Nothing is shared with the Job Floor module.
 *
 * Writes (status update, stock adjustment) are not performed from here: they
 * change the source system and the vendor's own application rules are not
 * replicated. They are refused and audited, so the page keeps its layout and the
 * attempt is on record. (Status writes belong to Job Floor's guarded writer.)
 */
const dbBackend = require('./innovations-console-db');
const { recordAuditEvent } = require('./audit');

const MODULE_CODE = 'innovations-console';
const WRITES_SETTING = 'innovations_console.writes_enabled';

class ConsoleError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = 'InnovationsConsoleError';
    this.statusCode = status;
    this.code = code;
  }
}

const present = (v) => v !== null && v !== undefined && String(v).trim() !== '';

const defaultDeps = { backend: dbBackend, recordAuditEvent };

// Vendor look (purple bar, orange accent) used when no skin is supplied by a service.
const DEFAULT_SKIN = {
  primaryColor: { R: 51, G: 0, B: 102 },
  secondaryColor: { R: 255, G: 102, B: 51 },
};

function wrapBackendError(error) {
  if (error instanceof ConsoleError) return error;
  if (error?.name === 'ConsoleError') return new ConsoleError(error.message, error.statusCode ?? 400, error.code ?? null);
  return new ConsoleError(`Innovations database lookup failed: ${error?.code || error?.message || 'unknown error'}`, 502, 'database_error');
}

async function viaBackend(fn) {
  try { return await fn(); } catch (error) { throw wrapBackendError(error); }
}

// ---- status --------------------------------------------------------------

// Writes are never performed in database mode, whatever the flag says; the flag
// is still read so the page can show the same "writes disabled" state.
async function writesEnabled() { return false; }

async function status(deps = defaultDeps) {
  const info = deps.backend.status();
  return { ...info, writesEnabled: await writesEnabled(deps) };
}

// ---- reads ---------------------------------------------------------------

async function getTracking(input, deps = defaultDeps) {
  return viaBackend(() => deps.backend.getTracking(input));
}

async function listStatusItems(deps = defaultDeps) {
  return viaBackend(() => deps.backend.listStatusItems());
}

async function getRxDetails(input, deps = defaultDeps) {
  return viaBackend(() => deps.backend.getRxDetails(input));
}

async function getStockDescription(input, deps = defaultDeps) {
  return viaBackend(() => deps.backend.getStockDescription(input));
}

async function getSkin() {
  return { ...DEFAULT_SKIN };
}

// ---- refused writes ------------------------------------------------------

async function refuseWrite({ eventType, entityType, entityId, request, actorUserId }, deps) {
  await deps.recordAuditEvent({
    moduleCode: MODULE_CODE, actorUserId, eventType: `innovations_console.${eventType}.refused`,
    entityType, entityId: String(entityId), eventData: { request, reason: 'writes not available from the database console' },
  }).catch(() => {});
  throw new ConsoleError('Source-system writes are not available from the Innovations Console. Use Innovations itself, or Job Floor for status updates.', 403, 'writes_disabled');
}

async function updateStatus({ trayId, statusId }, { actorUserId = null } = {}, deps = defaultDeps) {
  if (!present(trayId)) throw new ConsoleError('Enter a tray ID.');
  const id = Number(statusId);
  if (!Number.isInteger(id) || id <= 0) throw new ConsoleError('Choose a status.');
  const request = { TrayID: String(trayId).trim(), StatusID: id };
  return refuseWrite({ eventType: 'update_status', entityType: 'tray', entityId: request.TrayID, request, actorUserId }, deps);
}

async function adjustStock({ opc, qty }, { actorUserId = null } = {}, deps = defaultDeps) {
  if (!present(opc)) throw new ConsoleError('An OPC is required.');
  const n = Number(qty);
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 10000) throw new ConsoleError('Quantity must be a non-zero whole number.');
  const request = { OPC: String(opc).trim(), qty: n };
  return refuseWrite({ eventType: 'adjust_stock', entityType: 'opc', entityId: request.OPC, request, actorUserId }, deps);
}

module.exports = {
  ConsoleError, WRITES_SETTING, writesEnabled, status,
  getTracking, listStatusItems, getRxDetails, getStockDescription, getSkin, updateStatus, adjustStock,
};
