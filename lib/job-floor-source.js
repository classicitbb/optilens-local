'use strict';

/**
 * job-floor-source.js — direct-database order status update for the Innovations
 * source system (the same write the Innovations Mobile app makes through
 * InnovaAPI). Sequence confirmed from a live Extended Events trace of one
 * InnovaAPI status update; see docs/JOB_FLOOR_STATUS_UPDATE.md.
 *
 *   1. INSERT OrderStatuses  (new history row, TransactionID NULL, EndDate NULL)
 *   2. UPDATE OrderStatuses  (close the previous open row: EndDate)
 *   3. UPDATE Orders         (CurrentHistoryID, CurrentStatusID, CurrentStatusDate,
 *                             NumberOfStatuses, UpdatedBy, LastUpdated)
 *
 * All three run in one transaction on the dedicated write login, behind a row
 * lock, a stale-state check and a read-back. Only plain mobile-app statuses
 * are writable; anything that carries side effects the app code performs
 * (originating, terminating, cancellation, unship, hold checks, stock,
 * farm-out) is refused, because this module does not replicate those.
 *
 * The data access is a seam: `exec(name, params)` runs one named statement.
 * Production wires it to mssql; tests supply a recording fake.
 */
const sql = require('mssql');
const { getConfig } = require('./config');
const db = require('./db');

class SourceStatusError extends Error {
  constructor(message, code, statusCode = 409) {
    super(message);
    this.name = 'SourceStatusError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// Status items writable through this module (mirrors the Mobile app's list,
// minus statuses whose side effects are not replicated here).
const ALLOWED_STATUS_PREDICATE = `
  Inactive = 0 AND ShowInMobileApp = 1
  AND Originating = 0 AND Terminating = 0 AND Cancellation = 0 AND Unship = 0
  AND CheckHoldConditions = 0 AND ReceiveFarmout = 0 AND UseFarmoutLabStatus = 0
  AND StockFlags = 0`;

const ORDER_COLUMNS = `
  o.OrderID AS orderId, o.JobID AS jobId, o.CurrentStatusID AS currentStatusId,
  o.CurrentHistoryID AS currentHistoryId, o.NumberOfStatuses AS numberOfStatuses,
  g.GenStatusName AS genStatusName`;
const ORDER_FROM = `
  FROM dbo.Orders o %LOCK%
  JOIN dbo.GenStatus g ON g.GenStatus = o.GenStatus
  WHERE g.Active = 1 AND o.OrderType IN (1, 3) AND o.JobID IS NOT NULL AND o.JobID <> N''`;
const LOCK = 'WITH (UPDLOCK, ROWLOCK)';

const orderById = (lock) => ({
  text: `SELECT TOP (2) ${ORDER_COLUMNS} ${ORDER_FROM.replace('%LOCK%', lock ? LOCK : '')} AND o.OrderID = @orderId;`,
  types: { orderId: sql.Int },
});
const orderByRx = (lock) => ({
  text: `SELECT TOP (2) ${ORDER_COLUMNS} ${ORDER_FROM.replace('%LOCK%', lock ? LOCK : '')} AND o.JobID = @rxNumber;`,
  types: { rxNumber: sql.VarChar(50) },
});
const latestHistory = (lock) => ({
  text: `SELECT TOP (1) OrderStatusID AS id, StatusItemID AS statusItemId, EndDate AS endDate, Iteration AS iteration
         FROM dbo.OrderStatuses ${lock ? LOCK : ''}
         WHERE OrderID = @orderId AND StatusItemID <> -5
         ORDER BY OrderStatusID DESC;`,
  types: { orderId: sql.Int },
});

const STATEMENTS = {
  // A tray's current job is its most recent TrayTransactions row, provided that
  // row has not been checked out (DateOut). Older rows are often never closed.
  latestTrayTransaction: {
    text: `SELECT TOP (1) TrayTransactionID AS id, OrderID AS orderId, DateIn AS dateIn, DateOut AS dateOut
           FROM dbo.TrayTransactions WHERE TrayID = @trayId ORDER BY TrayTransactionID DESC;`,
    types: { trayId: sql.VarChar(40) },
  },
  allowedStatuses: {
    text: `SELECT StatusItemID AS id, StatusItemName AS name FROM dbo.StatusItems WHERE ${ALLOWED_STATUS_PREDICATE} ORDER BY DisplayOrder;`,
    types: {},
  },
  target: {
    text: `SELECT TOP (1) StatusItemID AS id, StatusItemName AS name,
                  CASE WHEN ${ALLOWED_STATUS_PREDICATE} THEN 1 ELSE 0 END AS allowed
           FROM dbo.StatusItems WHERE StatusItemID = @statusItemId;`,
    types: { statusItemId: sql.Int },
  },
  user: {
    text: 'SELECT TOP (1) UserAccountID AS id, Active AS active FROM dbo.UserAccounts WHERE UserAccountID = @userAccountId;',
    types: { userAccountId: sql.Int },
  },
  orderById: orderById(false),
  orderByIdForUpdate: orderById(true),
  orderByRx: orderByRx(false),
  orderByRxForUpdate: orderByRx(true),
  latestHistory: latestHistory(false),
  latestHistoryForUpdate: latestHistory(true),
  realStatusCount: {
    text: 'SELECT COUNT(*) AS n FROM dbo.OrderStatuses WHERE OrderID = @orderId AND StatusItemID <> -5;',
    types: { orderId: sql.Int },
  },
  now: { text: 'SELECT CAST(SYSDATETIMEOFFSET() AS varchar(40)) AS now;', types: {} },
  insertHistory: {
    text: `INSERT INTO dbo.OrderStatuses (OrderID, StatusItemID, TransactionID, UserAccountID, EndDate, Iteration, StatusDate, RecordCreated, LastUpdated)
           VALUES (@orderId, @statusItemId, NULL, @userAccountId, NULL, @iteration, @statusDate, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET());
           SELECT CAST(SCOPE_IDENTITY() AS int) AS id;`,
    types: { orderId: sql.Int, statusItemId: sql.Int, userAccountId: sql.Int, iteration: sql.Int, statusDate: sql.VarChar(40) },
  },
  closePrevious: {
    text: 'UPDATE dbo.OrderStatuses SET EndDate = @endDate, LastUpdated = dbo.now() WHERE OrderStatusID = @id AND EndDate IS NULL;',
    types: { id: sql.Int, endDate: sql.VarChar(40) },
  },
  updateOrder: {
    text: `UPDATE dbo.Orders
           SET CurrentHistoryID = @historyId, CurrentStatusID = @statusItemId, CurrentStatusDate = @statusDate,
               NumberOfStatuses = @numberOfStatuses, UpdatedBy = @userAccountId, LastUpdated = dbo.now()
           WHERE OrderID = @orderId AND CurrentStatusID = @expectedStatusId;`,
    types: { orderId: sql.Int, historyId: sql.Int, statusItemId: sql.Int, statusDate: sql.VarChar(40), numberOfStatuses: sql.Int, userAccountId: sql.Int, expectedStatusId: sql.Int },
  },
  readBack: {
    text: `SELECT o.CurrentStatusID AS currentStatusId, o.CurrentHistoryID AS currentHistoryId, o.NumberOfStatuses AS numberOfStatuses,
                  h.StatusItemID AS historyStatusItemId, h.UserAccountID AS historyUserAccountId, h.EndDate AS historyEndDate
           FROM dbo.Orders o JOIN dbo.OrderStatuses h ON h.OrderStatusID = o.CurrentHistoryID
           WHERE o.OrderID = @orderId;`,
    types: { orderId: sql.Int },
  },
};

const positiveInt = (v, name) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new SourceStatusError(`${name} must be a positive integer.`, 'invalid_input', 400);
  return n;
};

/** Run a named statement on an mssql request factory. */
function makeExec(newRequest) {
  return async (name, params = {}) => {
    const statement = STATEMENTS[name];
    if (!statement) throw new Error(`Unknown statement ${name}`);
    const request = newRequest();
    for (const [key, type] of Object.entries(statement.types)) request.input(key, type, params[key] ?? null);
    const result = await request.query(statement.text);
    return { recordset: result.recordset ?? [], rowsAffected: result.rowsAffected?.[0] ?? 0 };
  };
}

/** The write login must exist and be separate from the read login. */
function requireWriterProfile(config = getConfig()) {
  const profile = config.privilegedDataAccess?.sources?.['source-mssql']?.write;
  if (!profile?.user || !profile?.password) {
    throw new SourceStatusError('Dedicated source write credentials are not configured.', 'writer_credentials_missing');
  }
  if (String(profile.user).trim().toLowerCase() === String(config.sourceMssql?.user || '').trim().toLowerCase()) {
    throw new SourceStatusError('Source writes require a dedicated write identity separate from the read identity.', 'writer_not_separate');
  }
  return profile;
}

const defaultDeps = {
  async openReader() {
    const pool = await db.getSourcePool();
    return { exec: makeExec(() => new sql.Request(pool)) };
  },
  async openWriter() {
    requireWriterProfile();
    const pool = await db.getSourceWritePool();
    const transaction = pool.transaction();
    await transaction.begin();
    return {
      exec: makeExec(() => new sql.Request(transaction)),
      commit: () => transaction.commit(),
      rollback: () => transaction.rollback().catch(() => {}),
    };
  },
};

/**
 * Validate the request against current source state and work out the writes.
 * With `lock`, the order and its latest history row are held for the transaction.
 */
async function evaluate(exec, input, { lock }) {
  const statusItemId = positiveInt(input.statusItemId, 'statusItemId');
  const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  const hasOrder = given(input.orderId);
  const hasRx = given(input.rxNumber);
  const hasTray = given(input.trayId);
  if ([hasOrder, hasRx, hasTray].filter(Boolean).length !== 1) {
    throw new SourceStatusError('Provide exactly one of orderId, rxNumber or trayId.', 'invalid_input', 400);
  }
  const expected = input.expectedCurrentStatusId == null || input.expectedCurrentStatusId === ''
    ? null : positiveInt(input.expectedCurrentStatusId, 'expectedCurrentStatusId');
  const userAccountId = input.userAccountId == null ? null : positiveInt(input.userAccountId, 'userAccountId');

  const target = (await exec('target', { statusItemId })).recordset[0];
  if (!target) throw new SourceStatusError(`Status ${statusItemId} was not found.`, 'target_status_not_found', 404);
  if (!Number(target.allowed)) {
    throw new SourceStatusError(`Status ${statusItemId} (${target.name}) is not writable through the job floor.`, 'target_status_restricted');
  }

  if (userAccountId !== null) {
    const user = (await exec('user', { userAccountId })).recordset[0];
    if (!user || !Number(user.active)) {
      throw new SourceStatusError(`Source user account ${userAccountId} is missing or inactive.`, 'source_user_invalid');
    }
  }

  let tray = null;
  let orderId = hasOrder ? positiveInt(input.orderId, 'orderId') : null;
  if (hasTray) {
    const trayId = String(input.trayId).trim();
    if (trayId.length > 40) throw new SourceStatusError('trayId is too long.', 'invalid_input', 400);
    const latest = (await exec('latestTrayTransaction', { trayId })).recordset[0];
    if (!latest) throw new SourceStatusError(`Tray ${trayId} has no job history.`, 'tray_not_found', 404);
    if (latest.dateOut != null) throw new SourceStatusError(`Tray ${trayId} is not currently holding a job.`, 'tray_empty');
    if (!Number(latest.orderId)) throw new SourceStatusError(`Tray ${trayId} is not linked to an order.`, 'tray_empty');
    orderId = Number(latest.orderId);
    tray = { id: trayId, dateIn: latest.dateIn };
  }
  const orders = hasRx
    ? (await exec(lock ? 'orderByRxForUpdate' : 'orderByRx', { rxNumber: String(input.rxNumber).trim() })).recordset
    : (await exec(lock ? 'orderByIdForUpdate' : 'orderById', { orderId })).recordset;
  if (!orders.length) throw new SourceStatusError('No active live order matched.', 'order_not_active', 404);
  if (orders.length > 1) throw new SourceStatusError('More than one order matched; use the order ID.', 'order_ambiguous');
  const order = orders[0];

  if (expected !== null && Number(order.currentStatusId) !== expected) {
    throw new SourceStatusError(`Order ${order.orderId} changed (status is ${order.currentStatusId}, expected ${expected}).`, 'stale_order');
  }

  const previous = (await exec(lock ? 'latestHistoryForUpdate' : 'latestHistory', { orderId: order.orderId })).recordset[0] ?? null;
  const count = Number((await exec('realStatusCount', { orderId: order.orderId })).recordset[0]?.n ?? 0);
  const alreadyApplied = Number(order.currentStatusId) === statusItemId && previous && Number(previous.statusItemId) === statusItemId;

  return {
    orderId: order.orderId,
    jobId: order.jobId,
    tray,
    genStatusName: order.genStatusName,
    target: { id: target.id, name: target.name },
    before: { statusId: order.currentStatusId, historyId: order.currentHistoryId, numberOfStatuses: order.numberOfStatuses },
    closesHistoryId: previous && previous.endDate == null ? previous.id : null,
    iteration: previous ? Number(previous.iteration ?? 0) : 0,
    numberOfStatusesAfter: count + 1,
    alreadyApplied: Boolean(alreadyApplied),
  };
}

/** Read-only preview of what an update would do. Never writes. */
async function previewStatusUpdate(input, deps = defaultDeps) {
  const reader = await deps.openReader();
  return { ...(await evaluate(reader.exec, input, { lock: false })), writes: ['OrderStatuses insert', 'OrderStatuses close previous', 'Orders update'] };
}

/** Apply the update transactionally. `input.userAccountId` is required. */
async function applyStatusUpdate(input, deps = defaultDeps) {
  if (input.userAccountId == null) throw new SourceStatusError('A source user account is required for live writes.', 'source_user_missing');
  const writer = await deps.openWriter();
  try {
    const plan = await evaluate(writer.exec, input, { lock: true });
    if (plan.alreadyApplied) {
      await writer.commit();
      return { ...plan, applied: false, verified: true };
    }
    const userAccountId = positiveInt(input.userAccountId, 'userAccountId');
    const statusItemId = plan.target.id;
    const now = (await writer.exec('now')).recordset[0].now;

    const inserted = await writer.exec('insertHistory', {
      orderId: plan.orderId, statusItemId, userAccountId, iteration: plan.iteration, statusDate: now,
    });
    const historyId = inserted.recordset[0]?.id;
    if (!historyId) throw new SourceStatusError('History row was not created.', 'write_failed', 500);

    if (plan.closesHistoryId !== null) {
      const closed = await writer.exec('closePrevious', { id: plan.closesHistoryId, endDate: now });
      if (closed.rowsAffected !== 1) throw new SourceStatusError('Previous history row could not be closed.', 'write_failed', 500);
    }

    const updated = await writer.exec('updateOrder', {
      orderId: plan.orderId, historyId, statusItemId, statusDate: now,
      numberOfStatuses: plan.numberOfStatusesAfter, userAccountId, expectedStatusId: plan.before.statusId,
    });
    if (updated.rowsAffected !== 1) throw new SourceStatusError(`Order ${plan.orderId} could not be updated safely.`, 'stale_order');

    const back = (await writer.exec('readBack', { orderId: plan.orderId })).recordset[0];
    if (!back
      || Number(back.currentStatusId) !== statusItemId
      || Number(back.currentHistoryId) !== Number(historyId)
      || Number(back.historyStatusItemId) !== statusItemId
      || Number(back.historyUserAccountId) !== userAccountId
      || Number(back.numberOfStatuses) !== plan.numberOfStatusesAfter) {
      throw new SourceStatusError(`Order ${plan.orderId} failed read-back verification.`, 'verification_failed', 500);
    }

    await writer.commit();
    return { ...plan, applied: true, verified: true, historyId: Number(historyId), statusDate: now };
  } catch (error) {
    await writer.rollback();
    throw error;
  }
}

async function listAllowedStatuses(deps = defaultDeps) {
  const reader = await deps.openReader();
  return (await reader.exec('allowedStatuses')).recordset;
}

module.exports = {
  SourceStatusError, STATEMENTS, ALLOWED_STATUS_PREDICATE,
  requireWriterProfile, previewStatusUpdate, applyStatusUpdate, listAllowedStatuses,
};
