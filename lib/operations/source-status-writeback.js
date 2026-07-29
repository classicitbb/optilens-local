const sql = require("mssql");
const { getConfig } = require("../config");
const { getLiveSourcePool } = require("../db");

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

async function applyCurrentStatusUpdate({ orderId, targetStatusId, expectedCurrentStatusId = null }) {
  const config = getConfig();
  if (!config.writeBackEnabled) {
    throw Object.assign(new Error("Source status write-back is disabled."), { statusCode: 409, code: "writeback_disabled" });
  }

  const internalOrderId = positiveInteger(orderId, "Order ID");
  const target = positiveInteger(targetStatusId, "Target CurrentStatusID");
  const expected = expectedCurrentStatusId == null || expectedCurrentStatusId === ""
    ? null
    : positiveInteger(expectedCurrentStatusId, "Expected CurrentStatusID");
  const pool = await getLiveSourcePool();
  const transaction = pool.transaction();

  try {
    await transaction.begin();
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
  } finally {
    await pool.close().catch(() => {});
  }
}

async function checkSourceWriteCapability() {
  const config = getConfig();
  if (!config.writeBackEnabled) return { enabled: false, writable: false, detail: "Source status write-back is disabled." };
  const pool = await getLiveSourcePool();
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
      loginName: row.login_name,
      databaseName: row.database_name,
      detail: Number(row.can_update) === 1 ? "Live source writer is ready." : "Live source credential cannot update dbo.Orders."
    };
  } finally {
    await pool.close().catch(() => {});
  }
}

module.exports = { applyCurrentStatusUpdate, checkSourceWriteCapability };
