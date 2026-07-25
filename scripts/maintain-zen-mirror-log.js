/**
 * maintain-zen-mirror-log.js - compact the disposable innovations_mirror log.
 *
 * Usage:
 *   node scripts/maintain-zen-mirror-log.js
 *   node scripts/maintain-zen-mirror-log.js --confirm-shrink
 *
 * The default is a dry run. Confirmed mode writes only to the configured
 * innovations_mirror database: set SIMPLE recovery, CHECKPOINT, shrink log.
 */
const { getMirrorPool } = require("../lib/db");

const confirmShrink = process.argv.includes("--confirm-shrink");
const targetMbArg = process.argv.find((arg) => arg.startsWith("--target-mb="));
const targetMb = targetMbArg ? Number(targetMbArg.slice("--target-mb=".length)) : 256;

function quoteIdent(name) {
  return `[${String(name).replaceAll("]", "]]")}]`;
}

async function readState(pool) {
  const database = await pool.request().query(`
    SELECT
      DB_NAME() AS database_name,
      d.recovery_model_desc,
      d.log_reuse_wait_desc
    FROM sys.databases d
    WHERE d.database_id = DB_ID();
  `);
  const files = await pool.request().query(`
    SELECT
      name,
      type_desc,
      CAST(size * 8.0 / 1024 AS decimal(18, 2)) AS size_mb,
      CAST(FILEPROPERTY(name, 'SpaceUsed') * 8.0 / 1024 AS decimal(18, 2)) AS used_mb
    FROM sys.database_files
    ORDER BY type_desc, name;
  `);
  return { database: database.recordset[0], files: files.recordset };
}

function printState(state) {
  const db = state.database;
  console.log(`${db.database_name}: recovery=${db.recovery_model_desc}, log_reuse_wait=${db.log_reuse_wait_desc}`);
  for (const file of state.files) {
    console.log(`  ${String(file.type_desc).padEnd(4)} ${String(file.name).padEnd(40)} size=${file.size_mb}MB used=${file.used_mb}MB`);
  }
}

async function shrinkMirrorLog(pool) {
  if (!Number.isFinite(targetMb) || targetMb < 64 || targetMb > 4096) {
    throw new Error("--target-mb must be between 64 and 4096.");
  }

  const before = await readState(pool);
  const databaseName = before.database.database_name;
  if (String(databaseName).toLowerCase() !== "innovations_mirror") {
    throw new Error(`Refusing to maintain unexpected database '${databaseName}'.`);
  }

  const logFiles = before.files.filter((file) => file.type_desc === "LOG");
  if (!logFiles.length) throw new Error("No log file found.");

  await pool.request().query(`
    ALTER DATABASE ${quoteIdent(databaseName)} SET RECOVERY SIMPLE WITH NO_WAIT;
    CHECKPOINT;
  `);

  for (const file of logFiles) {
    await pool.request().query(`DBCC SHRINKFILE (${quoteIdent(file.name)}, ${Math.round(targetMb)});`);
  }

  await pool.request().query("CHECKPOINT;");
}

async function main() {
  const pool = await getMirrorPool();
  const before = await readState(pool);
  console.log(confirmShrink ? "Before mirror log maintenance:" : "Dry run: current mirror database file state:");
  printState(before);

  if (!confirmShrink) {
    console.log("No changes made. Re-run with --confirm-shrink to set SIMPLE recovery, checkpoint, and shrink the mirror log.");
    return;
  }

  await shrinkMirrorLog(pool);
  const after = await readState(pool);
  console.log("After mirror log maintenance:");
  printState(after);
}

main()
  .catch((error) => {
    console.error(`Mirror log maintenance failed: ${error.message}`);
    process.exit(1);
  });
