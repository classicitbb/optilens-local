/**
 * zen-source.js — read-only access to the Actian Zen (Pervasive) Innovations
 * database over ODBC. Shared by scripts/setup-zen-mirror.js and
 * lib/zen-mirror-sync.js. Requires the optional `odbc` module and the
 * Pervasive ODBC driver/DSN on the host.
 *
 * This module must never issue anything but SELECT/catalog calls.
 */
const { getConfig } = require("./config");
const { connectionStrings } = require("./psql-odbc");

let odbc = null;
try {
  odbc = require("odbc");
} catch {
  odbc = null;
}

function isAvailable() {
  const config = getConfig().sourcePsql;
  return Boolean(odbc && config.user && config.password);
}

async function connectZen() {
  if (!odbc) {
    throw new Error("The odbc module is not installed on this host (npm install odbc).");
  }
  const config = getConfig().sourcePsql;
  if (!config.user || !config.password) {
    throw new Error("PSQL (Zen) credentials are not configured in the vault/env.");
  }

  let lastError;
  for (const connStr of connectionStrings(config)) {
    try {
      return await odbc.connect(connStr);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No PSQL ODBC connection string is configured.");
}

async function listColumns(connection, table) {
  const rows = await connection.columns(null, null, table, null);
  return rows.map((row) => ({
    name: row.COLUMN_NAME,
    type: String(row.TYPE_NAME || "").toUpperCase(),
    size: row.COLUMN_SIZE,
    decimalDigits: row.DECIMAL_DIGITS,
    nullable: row.NULLABLE !== 0
  }));
}

async function listPrimaryKeyColumns(connection, table) {
  try {
    const rows = await connection.primaryKeys(null, null, table);
    return rows
      .sort((a, b) => Number(a.KEY_SEQ || 0) - Number(b.KEY_SEQ || 0))
      .map((row) => row.COLUMN_NAME)
      .filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  connectZen,
  isAvailable,
  listColumns,
  listPrimaryKeyColumns
};
