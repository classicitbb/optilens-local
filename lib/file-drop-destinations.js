const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const sql = require("mssql");
const { getAppPool } = require("./db");

function inputError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function text(value, label, max, required = true) {
  const result = String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
  if (required && !result) throw inputError(`${label} is required.`);
  return result;
}

function normalizeDestination(value) {
  const source = value && typeof value === "object" ? value : {};
  const folderPath = text(source.folderPath, "Folder path", 1000);
  if (!path.win32.isAbsolute(folderPath)) throw inputError("Folder path must be an absolute drive or UNC path.");
  const purposeCode = text(source.purposeCode, "Purpose", 60).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(purposeCode)) throw inputError("Purpose may use lowercase letters, numbers, hyphens, and underscores only.");
  return {
    destinationId: source.destinationId ? text(source.destinationId, "Destination ID", 36) : null,
    destinationName: text(source.destinationName, "Destination name", 120),
    purposeCode,
    customerAccount: text(source.customerAccount, "Customer account", 80, false) || null,
    folderPath,
    isActive: source.isActive !== false
  };
}

function publicDestination(row) {
  return {
    destinationId: String(row.destination_id),
    destinationName: row.destination_name,
    purposeCode: row.purpose_code,
    customerAccount: row.customer_account || null,
    folderPath: row.folder_path,
    isActive: Boolean(row.is_active),
    updatedAt: row.updated_at || null
  };
}

function createFileDropDestinationService(dependencies = {}) {
  const getPool = dependencies.getAppPool || getAppPool;
  const access = dependencies.access || fs.promises.access;
  const stat = dependencies.stat || fs.promises.stat;

  async function listDestinations() {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT destination_id, destination_name, purpose_code, customer_account, folder_path, is_active, updated_at
      FROM integration.file_drop_destinations
      ORDER BY purpose_code, CASE WHEN customer_account IS NULL THEN 1 ELSE 0 END, customer_account, destination_name;
    `);
    return result.recordset.map(publicDestination);
  }

  async function saveDestination(value, actor) {
    const destination = normalizeDestination(value);
    const pool = await getPool();
    const id = destination.destinationId || crypto.randomUUID();
    const result = await pool.request()
      .input("destination_id", sql.UniqueIdentifier, id)
      .input("destination_name", sql.NVarChar(120), destination.destinationName)
      .input("purpose_code", sql.NVarChar(60), destination.purposeCode)
      .input("customer_account", sql.NVarChar(80), destination.customerAccount)
      .input("folder_path", sql.NVarChar(1000), destination.folderPath)
      .input("is_active", sql.Bit, destination.isActive)
      .input("actor_user_id", sql.UniqueIdentifier, actor.userId)
      .query(`
        MERGE integration.file_drop_destinations AS target
        USING (SELECT @destination_id AS destination_id) AS source
        ON target.destination_id = source.destination_id
        WHEN MATCHED THEN UPDATE SET
          destination_name = @destination_name, purpose_code = @purpose_code,
          customer_account = @customer_account, folder_path = @folder_path,
          is_active = @is_active, updated_by_user_id = @actor_user_id,
          updated_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (
          destination_id, destination_name, purpose_code, customer_account, folder_path,
          is_active, created_by_user_id, updated_by_user_id
        ) VALUES (
          @destination_id, @destination_name, @purpose_code, @customer_account, @folder_path,
          @is_active, @actor_user_id, @actor_user_id
        )
        OUTPUT inserted.destination_id, inserted.destination_name, inserted.purpose_code,
          inserted.customer_account, inserted.folder_path, inserted.is_active, inserted.updated_at;
      `);
    return publicDestination(result.recordset[0]);
  }

  async function testDestination(destinationId) {
    const destination = await getDestination(destinationId);
    try {
      const info = await stat(destination.folderPath);
      if (!info.isDirectory()) throw inputError("Configured folder is not a directory.", 409);
      await access(destination.folderPath, fs.constants.R_OK | fs.constants.W_OK);
      return { destinationId: destination.destinationId, ok: true, detail: "Folder is reachable and writable." };
    } catch (error) {
      if (error?.statusCode) throw error;
      return { destinationId: destination.destinationId, ok: false, detail: "Folder could not be reached with read/write access." };
    }
  }

  async function resolveDestination({ customerAccount, purposeCode }) {
    const pool = await getPool();
    const result = await pool.request()
      .input("customer_account", sql.NVarChar(80), text(customerAccount, "Customer account", 80, false) || null)
      .input("purpose_code", sql.NVarChar(60), text(purposeCode, "Purpose", 60).toLowerCase())
      .query(`
        SELECT TOP (1) destination_id, destination_name, purpose_code, customer_account, folder_path, is_active, updated_at
        FROM integration.file_drop_destinations
        WHERE is_active = 1 AND purpose_code = @purpose_code
          AND (customer_account = @customer_account OR customer_account IS NULL)
        ORDER BY CASE WHEN customer_account = @customer_account THEN 0 ELSE 1 END, updated_at DESC;
      `);
    return result.recordset[0] ? publicDestination(result.recordset[0]) : null;
  }

  async function getDestination(destinationId) {
    const id = text(destinationId, "Destination ID", 36);
    const pool = await getPool();
    const result = await pool.request().input("destination_id", sql.UniqueIdentifier, id).query(`
      SELECT destination_id, destination_name, purpose_code, customer_account, folder_path, is_active, updated_at
      FROM integration.file_drop_destinations WHERE destination_id = @destination_id;
    `);
    if (!result.recordset[0]) throw inputError("File-drop destination was not found.", 404);
    return publicDestination(result.recordset[0]);
  }

  return { getDestination, listDestinations, resolveDestination, saveDestination, testDestination };
}

const service = createFileDropDestinationService();
module.exports = { createFileDropDestinationService, normalizeDestination, service };
