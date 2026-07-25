/**
 * reset-zen-mirror-retention.js - purge retained transactional mirror tables
 * and reset their sync watermarks before a fresh bounded resync.
 *
 * Usage:
 *   node scripts/reset-zen-mirror-retention.js
 *   node scripts/reset-zen-mirror-retention.js --confirm-delete
 *   node scripts/reset-zen-mirror-retention.js --set-simple-recovery --confirm-delete
 *
 * The default is a dry run. This writes only to innovations_mirror.
 */
const { getMirrorPool } = require("../lib/db");
const { TABLES } = require("../lib/zen-mirror-sync");

const confirmDelete = process.argv.includes("--confirm-delete");
const setSimpleRecovery = process.argv.includes("--set-simple-recovery");

function quoteIdent(name) {
  return `[${String(name).replaceAll("]", "]]")}]`;
}

function sqlString(value) {
  return `N'${String(value).replaceAll("'", "''")}'`;
}

const retainedTables = TABLES
  .filter((table) => table.retentionDaysConfig)
  .map((table) => table.name);

const deleteOrder = [...retainedTables].reverse();

async function countRows(pool, table) {
  const result = await pool.request().query(`SELECT COUNT_BIG(*) AS n FROM dbo.${quoteIdent(table)};`);
  return Number(result.recordset[0].n);
}

async function ensureSimpleRecovery(pool) {
  const dbResult = await pool.request().query("SELECT DB_NAME() AS database_name;");
  const databaseName = dbResult.recordset[0].database_name;
  const escaped = quoteIdent(databaseName);
  await pool.request().query(`
    ALTER DATABASE ${escaped} SET RECOVERY SIMPLE WITH NO_WAIT;
    CHECKPOINT;
  `);
  console.log(`Recovery model set to SIMPLE for ${databaseName}.`);
}

async function main() {
  const pool = await getMirrorPool();
  const counts = [];
  for (const table of deleteOrder) {
    counts.push({ table, rows: await countRows(pool, table) });
  }

  console.log(confirmDelete
    ? "Purging retained transactional mirror tables..."
    : "Dry run: retained transactional mirror rows that would be purged:");
  for (const row of counts) {
    console.log(`  ${row.table.padEnd(22)} ${row.rows.toLocaleString()}`);
  }

  if (!confirmDelete) {
    console.log("No rows deleted. Re-run with --confirm-delete to purge innovations_mirror retained tables and reset watermarks.");
    console.log("If SQL Server reports the mirror transaction log is full due to LOG_BACKUP, add --set-simple-recovery.");
    return;
  }

  if (setSimpleRecovery) {
    await ensureSimpleRecovery(pool);
  }

  for (const table of deleteOrder) {
    await pool.request().query(`
      TRUNCATE TABLE dbo.${quoteIdent(table)};
      DELETE FROM sync.SyncState
      WHERE table_name = ${sqlString(table)};
    `);
  }

  console.log("Purge complete. Next step: node scripts/run-zen-mirror-sync.js --full");
}

main()
  .catch((error) => {
    console.error(`Mirror retention reset failed: ${error.message}`);
    process.exit(1);
  });
