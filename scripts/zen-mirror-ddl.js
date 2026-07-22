/**
 * Generate rerunnable innovations_mirror DDL from the live Actian Zen catalog.
 *
 * Usage:
 *   node scripts/zen-mirror-ddl.js
 *   node scripts/zen-mirror-ddl.js --out database/innovations_mirror.generated.sql
 *
 * The script reads catalog metadata only. It does not create or modify tables.
 */
const fs = require("node:fs");
const path = require("node:path");
const zen = require("../lib/zen-source");
const { TABLES, buildCreateTableSql } = require("../lib/zen-mirror-sync");

async function main() {
  const outIndex = process.argv.indexOf("--out");
  const outFile = outIndex >= 0 ? process.argv[outIndex + 1] : "";
  if (outIndex >= 0 && !outFile) {
    throw new Error("--out requires a file path.");
  }

  const connection = await zen.connectZen();
  const statements = [
    "-- Generated innovations_mirror DDL from the Actian Zen catalog.",
    "-- Review before applying. This script intentionally contains no source write-back.",
    "IF SCHEMA_ID(N'sync') IS NULL EXEC('CREATE SCHEMA sync');",
    "GO",
    `IF OBJECT_ID(N'sync.SyncState', N'U') IS NULL
BEGIN
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
END;`,
    "GO"
  ];

  try {
    for (const table of TABLES) {
      const columns = await zen.listColumns(connection, table.name);
      if (!columns.length) {
        statements.push(`-- SKIP ${table.name}: not found in Zen catalog.`);
        continue;
      }
      const pkColumns = await zen.listPrimaryKeyColumns(connection, table.name);
      statements.push(buildCreateTableSql(table.name, columns, pkColumns), "GO");
    }
  } finally {
    try { await connection.close(); } catch {}
  }

  const text = statements.join("\n\n") + "\n";
  if (outFile) {
    const target = path.resolve(process.cwd(), outFile);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, "utf8");
    console.log(`Wrote ${target}`);
  } else {
    process.stdout.write(text);
  }
}

main().catch((error) => {
  console.error(`DDL generation failed: ${error.message}`);
  process.exit(1);
});
