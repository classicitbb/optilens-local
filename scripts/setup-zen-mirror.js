/**
 * setup-zen-mirror.js — provision the innovations_mirror database from the
 * live Actian Zen catalog. Rerunnable: creates the database, sync schema,
 * SyncState table, and any missing dbo tables; reports (but does not alter)
 * column drift on existing tables.
 *
 * Usage: node scripts/setup-zen-mirror.js
 */
const sql = require("mssql");
const { getConfig } = require("../lib/config");
const zen = require("../lib/zen-source");
const { TABLES, buildCreateTableSql } = require("../lib/zen-mirror-sync");

async function main() {
  const mirror = getConfig().sourceMirror;
  if (!mirror.user || !mirror.password) {
    throw new Error("Mirror database credentials are not configured.");
  }

  // 1. Ensure the database exists (connect via master).
  const master = await new sql.ConnectionPool({
    server: mirror.server,
    database: "master",
    user: mirror.user,
    password: mirror.password,
    options: { encrypt: mirror.encrypt, trustServerCertificate: mirror.trustServerCertificate },
    connectionTimeout: 8000
  }).connect();
  const dbName = mirror.database.replaceAll("]", "]]");
  await master.request().batch(`IF DB_ID(N'${mirror.database.replaceAll("'", "''")}') IS NULL CREATE DATABASE [${dbName}];`);
  await master.close();
  console.log(`Database ${mirror.database} present on ${mirror.server}.`);

  // 2. Connect to the mirror and ensure the sync schema + state table.
  const pool = await new sql.ConnectionPool({
    server: mirror.server,
    database: mirror.database,
    user: mirror.user,
    password: mirror.password,
    options: { encrypt: mirror.encrypt, trustServerCertificate: mirror.trustServerCertificate },
    connectionTimeout: 8000,
    requestTimeout: 60000
  }).connect();

  await pool.request().batch(`IF SCHEMA_ID(N'sync') IS NULL EXEC('CREATE SCHEMA sync');`);
  await pool.request().batch(`
    IF OBJECT_ID(N'sync.SyncState', N'U') IS NULL
    CREATE TABLE sync.SyncState (
      table_name nvarchar(128) NOT NULL CONSTRAINT PK_sync_SyncState PRIMARY KEY,
      strategy nvarchar(20) NULL,
      watermark datetime2(3) NULL,
      last_run_at datetime2(0) NULL,
      last_full_at datetime2(0) NULL,
      last_rows int NULL,
      total_rows int NULL,
      last_error nvarchar(max) NULL
    );
  `);
  console.log("sync schema + SyncState ready.");

  // 3. Create dbo tables from the Zen catalog.
  const connection = await zen.connectZen();
  try {
    for (const table of TABLES) {
      const columns = await zen.listColumns(connection, table.name);
      if (!columns.length) {
        console.warn(`  SKIP ${table.name}: not found on Zen source.`);
        continue;
      }
      const pkColumns = await zen.listPrimaryKeyColumns(connection, table.name);

      const exists = await pool.request()
        .input("table", table.name)
        .query("SELECT 1 AS present FROM sys.tables WHERE name = @table AND schema_id = SCHEMA_ID('dbo')");

      if (!exists.recordset.length) {
        await pool.request().batch(buildCreateTableSql(table.name, columns, pkColumns));
        console.log(`  CREATED dbo.${table.name} (${columns.length} cols, pk: ${pkColumns.join("+") || "none"})`);
      } else {
        const mirrorCols = await pool.request()
          .input("table", table.name)
          .query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @table");
        const have = new Set(mirrorCols.recordset.map((r) => r.COLUMN_NAME.toLowerCase()));
        const missing = columns.filter((c) => !have.has(String(c.name).toLowerCase()));
        const mirrorPk = await pool.request()
          .input("table", table.name)
          .query(`
            SELECT c.name AS column_name
            FROM sys.indexes i
            INNER JOIN sys.index_columns ic
              ON ic.object_id = i.object_id AND ic.index_id = i.index_id
            INNER JOIN sys.columns c
              ON c.object_id = ic.object_id AND c.column_id = ic.column_id
            WHERE i.object_id = OBJECT_ID(N'dbo.' + @table)
              AND i.is_primary_key = 1
            ORDER BY ic.key_ordinal
          `);
        const mirrorPkColumns = mirrorPk.recordset.map((row) => row.column_name);
        const pkMatches = pkColumns.length === mirrorPkColumns.length
          && pkColumns.every((column, index) => String(column).toLowerCase() === String(mirrorPkColumns[index]).toLowerCase());
        if (missing.length) {
          console.warn(`  DRIFT dbo.${table.name}: mirror is missing ${missing.map((c) => c.name).join(", ")} — drop the table and rerun setup to pick up new columns.`);
        } else if (!pkMatches) {
          console.warn(`  DRIFT dbo.${table.name}: primary key is ${mirrorPkColumns.join("+") || "missing"}, expected ${pkColumns.join("+") || "none"} — rebuild the table before relying on delete reconciliation.`);
        } else {
          console.log(`  OK dbo.${table.name} (pk: ${pkColumns.join("+") || "none"})`);
        }
      }
    }
  } finally {
    try { await connection.close(); } catch {}
    await pool.close();
  }

  console.log("Mirror setup complete. Run a sync with: node scripts/run-zen-mirror-sync.js");
}

main().catch((error) => {
  console.error(`Setup failed: ${error.message}`);
  process.exit(1);
});
