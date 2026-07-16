/**
 * zen-mirror-sync.js — refreshes the innovations_mirror database from the
 * Actian Zen (Pervasive) Innovations source over ODBC.
 *
 * Strategy per table:
 *  - "full": small reference tables — DELETE + bulk reload inside a transaction.
 *  - "incremental": large tables — pull rows with LastUpdated >= watermark
 *    (minus an overlap window), bulk into a sync.stage_* table, MERGE by
 *    primary key. A forced full run ({ full: true }) pulls everything, merges,
 *    and then deletes mirror rows missing from the source (hard-delete
 *    reconciliation).
 *
 * The Zen source is read-only here, always. Writes go only to the mirror.
 */
const sql = require("mssql");
const { getConfig } = require("./config");
const { getMirrorPool } = require("./db");
const zen = require("./zen-source");

const OVERLAP_MS = 2 * 60 * 60 * 1000; // re-pull 2h of history to absorb clock skew
const BULK_CHUNK = 5000;

const TABLES = [
  { name: "Customers", strategy: "full" },
  { name: "UserAccounts", strategy: "full" },
  { name: "ShippingMethods", strategy: "full" },
  { name: "EFTInstitutions", strategy: "full" },
  { name: "Contacts", strategy: "full" },
  { name: "CustomerAddresses", strategy: "full" },
  { name: "Countries", strategy: "full" },
  { name: "BuyinGroups", strategy: "full" },
  { name: "OrderTypes", strategy: "full" },
  { name: "GenStatus", strategy: "full" },
  { name: "StatusItems", strategy: "full" },
  { name: "CustomerBalances", strategy: "full" },
  { name: "StockLots", strategy: "full" },
  { name: "FinAROpenItems", strategy: "full" },
  { name: "FinARAgingPeriods", strategy: "full" },
  { name: "FinARPeriods", strategy: "full" },
  { name: "Shipments", strategy: "incremental" },
  { name: "ShipmentItems", strategy: "incremental" },
  { name: "Orders", strategy: "incremental", initialRangeColumn: "ReceivedTime", initialRangeDaysConfig: "initialOrderDays" },
  { name: "RxArchive", strategy: "incremental", initialRangeColumn: "RxDate", initialRangeDaysConfig: "initialOrderDays" },
  { name: "Invoices", strategy: "incremental" },
  { name: "InvoiceLines", strategy: "incremental" },
  { name: "FinARSalesJournal", strategy: "incremental" },
  { name: "FinARStatements", strategy: "incremental" },
  { name: "FinARStatementItems", strategy: "incremental" }
];

const WATERMARK_COLUMN = "LastUpdated";

// ── Type mapping ─────────────────────────────────────────────────────────────

function mapZenTypeToSqlDecl(column) {
  const type = String(column.type || "").toUpperCase();
  const size = Number(column.size) || 0;
  const digits = Number(column.decimalDigits) || 0;

  switch (type) {
    case "INTEGER": return "int";
    case "SMALLINT": return "smallint";
    case "TINYINT": return "tinyint";
    case "BIGINT": return "bigint";
    case "UTINYINT": case "USMALLINT": return "int";
    case "UINTEGER": return "bigint";
    case "UBIGINT": return "decimal(20,0)";
    case "AUTOINC": case "IDENTITY": return "int";
    case "BIT": return "bit";
    case "CURRENCY": case "MONEY": return "money";
    case "DOUBLE": case "FLOAT": return "float";
    case "REAL": case "BFLOAT4": case "BFLOAT8": return "float";
    case "DECIMAL": case "NUMERIC": case "NUMERICSA": case "NUMERICSTS":
      return `decimal(${Math.min(Math.max(size, 1), 38)},${Math.min(digits, 37)})`;
    case "DATE": return "date";
    case "TIME": return "time(0)";
    case "TIMESTAMP": case "DATETIME": return "datetime2(3)";
    case "CHAR": case "UCHAR": case "VARCHAR": case "UVARCHAR": case "NCHAR": case "NVARCHAR":
      return size > 0 && size <= 4000 ? `nvarchar(${size})` : "nvarchar(max)";
    case "LONGVARCHAR": case "NOTE": case "LVAR": return "nvarchar(max)";
    case "BINARY": case "VARBINARY": case "LONGVARBINARY": case "BLOB": return "varbinary(max)";
    case "GUID": case "UNIQUEIDENTIFIER": return "uniqueidentifier";
    default: return "nvarchar(max)";
  }
}

function mapZenTypeToBulkType(column) {
  const type = String(column.type || "").toUpperCase();
  const size = Number(column.size) || 0;
  const digits = Number(column.decimalDigits) || 0;

  switch (type) {
    case "INTEGER": case "UTINYINT": case "USMALLINT": case "AUTOINC": case "IDENTITY": return sql.Int;
    case "SMALLINT": return sql.SmallInt;
    case "TINYINT": return sql.TinyInt;
    case "BIGINT": case "UINTEGER": return sql.BigInt;
    case "UBIGINT": return sql.Decimal(20, 0);
    case "BIT": return sql.Bit;
    case "CURRENCY": case "MONEY": return sql.Money;
    case "DOUBLE": case "FLOAT": case "REAL": case "BFLOAT4": case "BFLOAT8": return sql.Float;
    case "DECIMAL": case "NUMERIC": case "NUMERICSA": case "NUMERICSTS":
      return sql.Decimal(Math.min(Math.max(size, 1), 38), Math.min(digits, 37));
    case "DATE": return sql.Date;
    case "TIME": return sql.Time(0);
    case "TIMESTAMP": case "DATETIME": return sql.DateTime2(3);
    case "CHAR": case "UCHAR": case "VARCHAR": case "UVARCHAR": case "NCHAR": case "NVARCHAR":
      return size > 0 && size <= 4000 ? sql.NVarChar(size) : sql.NVarChar(sql.MAX);
    case "BINARY": case "VARBINARY": case "LONGVARBINARY": case "BLOB": return sql.VarBinary(sql.MAX);
    case "GUID": case "UNIQUEIDENTIFIER": return sql.UniqueIdentifier;
    default: return sql.NVarChar(sql.MAX);
  }
}

function isDateFamily(column) {
  return ["DATE", "TIME", "TIMESTAMP", "DATETIME"].includes(String(column.type || "").toUpperCase());
}

function isNumericFamily(column) {
  const type = String(column.type || "").toUpperCase();
  return [
    "INTEGER", "SMALLINT", "TINYINT", "BIGINT", "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT",
    "AUTOINC", "IDENTITY", "CURRENCY", "MONEY", "DOUBLE", "FLOAT", "REAL", "BFLOAT4", "BFLOAT8",
    "DECIMAL", "NUMERIC", "NUMERICSA", "NUMERICSTS"
  ].includes(type);
}

function coerceValue(column, value) {
  if (value === null || value === undefined) return null;
  if (String(column.type || "").toUpperCase() === "BIT") {
    return value === true || value === 1 || value === "1";
  }
  if (isNumericFamily(column)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (isDateFamily(column)) {
    if (value instanceof Date) return value;
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return value;
}

// ── SQL builders (pure; unit-tested) ─────────────────────────────────────────

function quoteIdent(name) {
  return `[${String(name).replaceAll("]", "]]")}]`;
}

function buildCreateTableSql(table, columns, pkColumns = []) {
  const pkSet = new Set(pkColumns.map((column) => String(column).toLowerCase()));
  const cols = columns
    .map((column) => {
      const nullable = pkSet.has(String(column.name).toLowerCase()) ? "NOT NULL" : "NULL";
      return `    ${quoteIdent(column.name)} ${mapZenTypeToSqlDecl(column)} ${nullable}`;
    });
  const pk = pkColumns.length
    ? `    CONSTRAINT ${quoteIdent(`PK_${table}`)} PRIMARY KEY (${pkColumns.map(quoteIdent).join(", ")})`
    : null;
  const body = pk ? cols.concat(pk).join(",\n") : cols.join(",\n");
  return `IF OBJECT_ID(N'dbo.${table}', N'U') IS NULL\nBEGIN\n  CREATE TABLE dbo.${quoteIdent(table)} (\n${body}\n  );\nEND;`;
}

function buildMergeSql(table, columns, pkColumns) {
  const allCols = columns.map((c) => quoteIdent(c.name));
  const pkSet = new Set(pkColumns.map((c) => c.toLowerCase()));
  const updateCols = columns.filter((c) => !pkSet.has(String(c.name).toLowerCase()));
  const onClause = pkColumns
    .map((pk) => `target.${quoteIdent(pk)} = source.${quoteIdent(pk)}`)
    .join(" AND ");
  const updateClause = updateCols
    .map((c) => `target.${quoteIdent(c.name)} = source.${quoteIdent(c.name)}`)
    .join(", ");
  const insertCols = allCols.join(", ");
  const insertVals = allCols.map((c) => `source.${c}`).join(", ");

  return [
    `MERGE dbo.${quoteIdent(table)} AS target`,
    `USING sync.${quoteIdent(`stage_${table}`)} AS source`,
    `  ON ${onClause}`,
    updateClause ? `WHEN MATCHED THEN UPDATE SET ${updateClause}` : null,
    `WHEN NOT MATCHED BY TARGET THEN INSERT (${insertCols}) VALUES (${insertVals});`
  ].filter(Boolean).join("\n");
}

function buildDeleteMissingSql(table, pkColumns) {
  const onClause = pkColumns
    .map((pk) => `stage.${quoteIdent(pk)} = target.${quoteIdent(pk)}`)
    .join(" AND ");
  return `DELETE target FROM dbo.${quoteIdent(table)} AS target WHERE NOT EXISTS (SELECT 1 FROM sync.${quoteIdent(`stage_${table}`)} AS stage WHERE ${onClause});`;
}

function formatZenTimestamp(date) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `{ts '${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}'}`;
}

function hasColumn(columns, name) {
  return columns.some((column) => String(column.name).toLowerCase() === String(name).toLowerCase());
}

function initialRangeDays(table) {
  if (!table.initialRangeDaysConfig) return 0;
  const days = Number(getConfig().sourceMirror[table.initialRangeDaysConfig]);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

function buildZenSelectQuery(table, columns, { full = false, watermark = null, now = new Date() } = {}) {
  if (full) {
    return { query: `SELECT * FROM "${table.name}"`, sourceComplete: true, boundedInitial: false };
  }

  if (watermark) {
    const since = new Date(watermark.getTime() - OVERLAP_MS);
    return {
      query: `SELECT * FROM "${table.name}" WHERE "${WATERMARK_COLUMN}" >= ${formatZenTimestamp(since)}`,
      sourceComplete: false,
      boundedInitial: false
    };
  }

  const rangeDays = initialRangeDays(table);
  const rangeColumn = table.initialRangeColumn && hasColumn(columns, table.initialRangeColumn)
    ? table.initialRangeColumn
    : null;
  if (rangeDays && rangeColumn) {
    const since = new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000);
    return {
      query: `SELECT * FROM "${table.name}" WHERE "${rangeColumn}" >= ${formatZenTimestamp(since)}`,
      sourceComplete: false,
      boundedInitial: true,
      rangeColumn,
      rangeDays
    };
  }

  return { query: `SELECT * FROM "${table.name}"`, sourceComplete: true, boundedInitial: false };
}

function chunk(rows, size) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

// ── Sync engine ──────────────────────────────────────────────────────────────

let running = false;
let lastResult = null;

function buildBulkTable(tableName, columns, rows, nullableByColumn = null) {
  const bulkTable = new sql.Table(tableName);
  bulkTable.create = false;
  for (const column of columns) {
    const nullable = nullableByColumn
      ? nullableByColumn.get(String(column.name).toLowerCase()) !== false
      : true;
    bulkTable.columns.add(column.name, mapZenTypeToBulkType(column), { nullable });
  }
  for (const row of rows) {
    bulkTable.rows.add(...columns.map((column) => coerceValue(column, row[column.name])));
  }
  return bulkTable;
}

async function bulkInsert(request, tableName, columns, rows, nullableByColumn = null) {
  for (const part of chunk(rows, BULK_CHUNK)) {
    await request.bulk(buildBulkTable(tableName, columns, part, nullableByColumn));
  }
}

async function readTargetNullability(request, schema, table) {
  const result = await request
    .input("objectName", `${schema}.${table}`)
    .query(`
      SELECT name, is_nullable
      FROM sys.columns
      WHERE object_id = OBJECT_ID(@objectName)
    `);
  return new Map(result.recordset.map((row) => [String(row.name).toLowerCase(), Boolean(row.is_nullable)]));
}

async function readSyncState(pool, table) {
  const result = await pool.request()
    .input("table", table)
    .query("SELECT watermark FROM sync.SyncState WHERE table_name = @table");
  return result.recordset[0] || null;
}

async function writeSyncState(pool, table, patch) {
  await pool.request()
    .input("table", table)
    .input("strategy", patch.strategy || null)
    .input("watermark", patch.watermark ?? null)
    .input("lastRows", patch.lastRows ?? null)
    .input("totalRows", patch.totalRows ?? null)
    .input("lastError", patch.lastError ?? null)
    .input("wasFull", patch.wasFull ? 1 : 0)
    .query(`
      MERGE sync.SyncState AS target
      USING (SELECT @table AS table_name) AS source
        ON target.table_name = source.table_name
      WHEN MATCHED THEN UPDATE SET
        strategy = COALESCE(@strategy, target.strategy),
        watermark = COALESCE(@watermark, target.watermark),
        last_run_at = SYSUTCDATETIME(),
        last_full_at = CASE WHEN @wasFull = 1 THEN SYSUTCDATETIME() ELSE target.last_full_at END,
        last_rows = @lastRows,
        total_rows = COALESCE(@totalRows, target.total_rows),
        last_error = @lastError
      WHEN NOT MATCHED THEN INSERT (table_name, strategy, watermark, last_run_at, last_full_at, last_rows, total_rows, last_error)
      VALUES (@table, @strategy, @watermark, SYSUTCDATETIME(), CASE WHEN @wasFull = 1 THEN SYSUTCDATETIME() ELSE NULL END, @lastRows, @totalRows, @lastError);
    `);
}

function maxWatermark(rows) {
  let max = null;
  for (const row of rows) {
    const value = row[WATERMARK_COLUMN];
    if (!value) continue;
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) continue;
    if (!max || date > max) max = date;
  }
  return max;
}

async function syncFullTable(pool, connection, table, columns) {
  const rows = await connection.query(`SELECT * FROM "${table.name}"`);
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const nullability = await readTargetNullability(new sql.Request(transaction), "dbo", table.name);
    await new sql.Request(transaction).query(`DELETE FROM dbo.${quoteIdent(table.name)}`);
    await bulkInsert(new sql.Request(transaction), table.name, columns, rows, nullability);
    await transaction.commit();
  } catch (error) {
    try { await transaction.rollback(); } catch {}
    throw error;
  }
  return { rows: rows.length, totalRows: rows.length, watermark: maxWatermark(rows) };
}

async function syncIncrementalTable(pool, connection, table, columns, pkColumns, { full = false } = {}) {
  if (!pkColumns.length) {
    // No usable key: fall back to a destructive full reload.
    return syncFullTable(pool, connection, table, columns);
  }

  const state = full ? null : await readSyncState(pool, table.name);
  const watermark = state && state.watermark ? new Date(state.watermark) : null;
  const select = buildZenSelectQuery(table, columns, { full, watermark });
  const rows = await connection.query(select.query);

  const stage = `stage_${table.name}`;
  await pool.request().query(`IF OBJECT_ID(N'sync.${stage}', N'U') IS NOT NULL DROP TABLE sync.${quoteIdent(stage)};`);
  await pool.request().query(`SELECT TOP (0) * INTO sync.${quoteIdent(stage)} FROM dbo.${quoteIdent(table.name)};`);

  if (rows.length) {
    await bulkInsert(pool.request(), `sync.${stage}`, columns, rows);
  }

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    if (rows.length) {
      await new sql.Request(transaction).query(buildMergeSql(table.name, columns, pkColumns));
    }
    if (select.sourceComplete) {
      // The stage holds the complete source set: remove hard-deleted rows.
      await new sql.Request(transaction).query(buildDeleteMissingSql(table.name, pkColumns));
    }
    await transaction.commit();
  } catch (error) {
    try { await transaction.rollback(); } catch {}
    throw error;
  }

  await pool.request().query(`IF OBJECT_ID(N'sync.${stage}', N'U') IS NOT NULL DROP TABLE sync.${quoteIdent(stage)};`);

  const countResult = await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.${quoteIdent(table.name)}`);
  return {
    rows: rows.length,
    totalRows: countResult.recordset[0].n,
    watermark: maxWatermark(rows) || watermark,
    boundedInitial: select.boundedInitial || false,
    rangeColumn: select.rangeColumn || null,
    rangeDays: select.rangeDays || null
  };
}

async function runMirrorSync({ full = false } = {}) {
  if (running) {
    return { skipped: true, reason: "A mirror sync is already running." };
  }
  running = true;
  const startedAt = new Date();
  const summary = { startedAt: startedAt.toISOString(), full, tables: [] };

  let connection = null;
  try {
    const pool = await getMirrorPool();
    connection = await zen.connectZen();

    for (const table of TABLES) {
      const entry = { table: table.name, strategy: table.strategy };
      try {
        const columns = await zen.listColumns(connection, table.name);
        if (!columns.length) throw new Error("Table not found on Zen source.");

        const result = table.strategy === "incremental"
          ? await syncIncrementalTable(pool, connection, table, columns, await zen.listPrimaryKeyColumns(connection, table.name), { full })
          : await syncFullTable(pool, connection, table, columns);

        entry.rows = result.rows;
        entry.totalRows = result.totalRows;
        entry.watermark = result.watermark ? result.watermark.toISOString() : null;
        if (result.boundedInitial) {
          entry.boundedInitial = true;
          entry.rangeColumn = result.rangeColumn;
          entry.rangeDays = result.rangeDays;
        }
        await writeSyncState(pool, table.name, {
          strategy: table.strategy,
          watermark: result.watermark,
          lastRows: result.rows,
          totalRows: result.totalRows,
          lastError: null,
          wasFull: full || table.strategy === "full"
        });
      } catch (error) {
        entry.error = error.message;
        try {
          await writeSyncState(pool, table.name, { strategy: table.strategy, lastRows: 0, lastError: error.message });
        } catch {}
      }
      summary.tables.push(entry);
    }
  } finally {
    if (connection) {
      try { await connection.close(); } catch {}
    }
    running = false;
  }

  summary.finishedAt = new Date().toISOString();
  summary.ok = summary.tables.every((t) => !t.error);
  lastResult = summary;
  return summary;
}

async function getMirrorSyncState() {
  const pool = await getMirrorPool();
  const result = await pool.request().query(`
    SELECT table_name, strategy, watermark, last_run_at, last_full_at, last_rows, total_rows, last_error
    FROM sync.SyncState
    ORDER BY table_name
  `);
  return { running, lastResult, tables: result.recordset };
}

module.exports = {
  TABLES,
  WATERMARK_COLUMN,
  buildCreateTableSql,
  buildZenSelectQuery,
  buildDeleteMissingSql,
  buildMergeSql,
  chunk,
  coerceValue,
  formatZenTimestamp,
  getMirrorSyncState,
  mapZenTypeToBulkType,
  mapZenTypeToSqlDecl,
  runMirrorSync
};
