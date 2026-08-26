const sql = require("mssql");
const { getConfig } = require("../config");
const { getSourceWritePool } = require("../db");

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function sourceWriteConfiguration(config = getConfig()) {
  if (!config.writeBackEnabled) {
    return { ready: false, code: "writeback_disabled", detail: "Source status write-back is disabled." };
  }
  const writeProfile = config.privilegedDataAccess?.sources?.["source-mssql"]?.write;
  if (!writeProfile?.user || !writeProfile?.password) {
    return { ready: false, code: "writeback_writer_credentials_missing", detail: "Dedicated source write credentials are not configured." };
  }
  if (String(writeProfile.user).trim().toLowerCase() === String(config.sourceMssql?.user || "").trim().toLowerCase()) {
    return { ready: false, code: "writeback_writer_not_separate", detail: "Source write-back requires a dedicated write identity separate from the read identity." };
  }
  if (!config.writeBackStatusIds.length) {
    return { ready: false, code: "writeback_status_allowlist_missing", detail: "No CurrentStatusID targets are allowlisted for source write-back." };
  }
  return { ready: true, writeProfile };
}

function requireSourceWriteConfiguration(config = getConfig()) {
  const capability = sourceWriteConfiguration(config);
  if (capability.ready) return capability;
  throw Object.assign(new Error(capability.detail), { statusCode: 409, code: capability.code });
}

async function applyCurrentStatusUpdate({ orderId, targetStatusId, expectedCurrentStatusId = null }) {
  const config = getConfig();
  requireSourceWriteConfiguration(config);

  const internalOrderId = positiveInteger(orderId, "Order ID");
  const target = positiveInteger(targetStatusId, "Target CurrentStatusID");
  if (!config.writeBackStatusIds.includes(target)) {
    throw Object.assign(new Error(`Target CurrentStatusID ${target} is not allowlisted for source write-back.`), { statusCode: 409, code: "writeback_status_not_allowed" });
  }
  const expected = expectedCurrentStatusId == null || expectedCurrentStatusId === ""
    ? null
    : positiveInteger(expectedCurrentStatusId, "Expected CurrentStatusID");
  const pool = await getSourceWritePool();
  const transaction = pool.transaction();

  try {
    await transaction.begin();
    const targetResult = await new sql.Request(transaction)
      .input("target_status_id", sql.Int, target)
      .query(`
        SELECT TOP (1) StatusItemID AS status_item_id, StatusItemName AS status_item_name,
               Inactive AS inactive, Terminating AS terminating, Originating AS originating,
               ReceiveFarmout AS receive_farmout, Cancellation AS cancellation
        FROM dbo.StatusItems
        WHERE StatusItemID = @target_status_id;
      `);
    const targetStatus = targetResult.recordset[0];
    if (!targetStatus) throw Object.assign(new Error(`Target CurrentStatusID ${target} was not found.`), { code: "target_status_not_found" });
    if (targetStatus.inactive || targetStatus.terminating || targetStatus.originating || targetStatus.receive_farmout || targetStatus.cancellation) {
      throw Object.assign(new Error(`Target status ${target} (${targetStatus.status_item_name}) is not permitted for write-back.`), { code: "target_status_restricted" });
    }
    const currentResult = await new sql.Request(transaction)
      .input("order_id", sql.Int, internalOrderId)
      .query(`
        SELECT TOP (1)
          o.OrderID AS order_id,
          o.CurrentStatusID AS current_status_id,
          si.StatusItemName AS current_status_description,
          o.GenStatus AS gen_status,
          g.GenStatusName AS gen_status_description
        FROM dbo.Orders o WITH (UPDLOCK, ROWLOCK)
        LEFT JOIN dbo.StatusItems si ON si.StatusItemID = o.CurrentStatusID
        LEFT JOIN dbo.GenStatus g ON g.GenStatus = o.GenStatus
        WHERE o.OrderID = @order_id
          AND g.Active = 1
          AND o.JobID IS NOT NULL
          AND o.JobID <> N''
          AND o.OrderType IN (1, 3);
      `);
    const current = currentResult.recordset[0];
    if (!current) throw Object.assign(new Error(`Active live order ${internalOrderId} was not found.`), { code: "order_not_active" });

    if (expected !== null && Number(current.current_status_id) !== expected) {
      throw Object.assign(new Error(`Order ${internalOrderId} changed before approval.`), { code: "stale_order" });
    }

    if (Number(current.current_status_id) === target) {
      await transaction.commit();
      return {
        orderId: internalOrderId,
        beforeStatusId: current.current_status_id,
        targetStatusId: target,
        verifiedStatusId: target,
        alreadyApplied: true,
        genStatus: current.gen_status,
        genStatusDescription: current.gen_status_description
      };
    }

    const update = await new sql.Request(transaction)
      .input("order_id", sql.Int, internalOrderId)
      .input("target_status_id", sql.Int, target)
      .input("expected_status_id", sql.Int, expected)
      .query(`
        UPDATE dbo.Orders
        SET CurrentStatusID = @target_status_id
        WHERE OrderID = @order_id
          AND (@expected_status_id IS NULL OR CurrentStatusID = @expected_status_id);
      `);
    if (update.rowsAffected[0] !== 1) throw Object.assign(new Error(`Order ${internalOrderId} could not be updated safely.`), { code: "writeback_row_count" });

    const verifiedResult = await new sql.Request(transaction)
      .input("order_id", sql.Int, internalOrderId)
      .query(`SELECT CurrentStatusID AS verified_status_id FROM dbo.Orders WHERE OrderID = @order_id;`);
    const verified = verifiedResult.recordset[0];
    if (!verified || Number(verified.verified_status_id) !== target) {
      throw Object.assign(new Error(`Order ${internalOrderId} failed CurrentStatusID verification.`), { code: "writeback_verification" });
    }

    await transaction.commit();
    return {
      orderId: internalOrderId,
      beforeStatusId: current.current_status_id,
      targetStatusId: target,
      verifiedStatusId: verified.verified_status_id,
      alreadyApplied: false,
      genStatus: current.gen_status,
      genStatusDescription: current.gen_status_description
    };
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  }
}

async function checkSourceWriteCapability() {
  const config = getConfig();
  const configured = sourceWriteConfiguration(config);
  if (!configured.ready) {
    return {
      enabled: Boolean(config.writeBackEnabled),
      writable: false,
      allowlistedStatusIds: config.writeBackStatusIds,
      detail: configured.detail
    };
  }
  const pool = await getSourceWritePool();
  try {
    const result = await pool.request().query(`
      SELECT
        SUSER_SNAME() AS login_name,
        DB_NAME() AS database_name,
        HAS_PERMS_BY_NAME(N'dbo.Orders', N'OBJECT', N'SELECT') AS can_select,
        HAS_PERMS_BY_NAME(N'dbo.Orders', N'OBJECT', N'UPDATE') AS can_update;
    `);
    const row = result.recordset[0] || {};
    return {
      enabled: true,
      writable: Number(row.can_update) === 1,
      allowlistedStatusIds: config.writeBackStatusIds,
      loginName: row.login_name,
      databaseName: row.database_name,
      detail: Number(row.can_update) === 1 ? "Live source writer is ready." : "Live source credential cannot update dbo.Orders."
    };
  } finally {
    // The dedicated write pool is shared and self-healing. Closing it from
    // this read-only capability check could strand an approved action.
  }
}

module.exports = { applyCurrentStatusUpdate, checkSourceWriteCapability, sourceWriteConfiguration };
