/**
 * zen-catalog-dump.js — read-only discovery of the Actian Zen (Pervasive)
 * Innovations database. Lists tables, dumps column metadata for the tables the
 * source-MSSQL consumers rely on, and (best effort) row counts.
 *
 * Usage: node scripts/zen-catalog-dump.js [output.json]
 * Only SELECT/catalog calls are issued. Never writes to the source.
 */
const fs = require("node:fs");
const path = require("node:path");
const odbc = require("odbc");
const { getConfig } = require("../lib/config");

// Every source table referenced through getSourcePool() consumers
// (source-innovations, innovations-sync, beswift-co, business-metrics,
// shipment-sync, live-gateway-worker, db health check).
const TARGET_TABLES = [
  "Customers",
  "UserAccounts",
  "ShippingMethods",
  "EFTInstitutions",
  "Contacts",
  "CustomerAddresses",
  "Countries",
  "BuyinGroups",
  "Shipments",
  "ShipmentItems",
  "Orders",
  "OrderTypes",
  "Invoices",
  "InvoiceLines",
  "FinARSalesJournal",
  "CustomerBalances",
  "StockLots",
  "FinAROpenItems",
  "FinARAgingPeriods",
  "FinARStatements",
  "FinARStatementItems"
];

const COUNT_TIMEOUT_MS = 15000;

function connectionString(config) {
  const auth = `UID=${config.user};PWD=${config.password}`;
  if (config.dsn) return `DSN=${config.dsn};${auth}`;
  return `Driver=${config.driver};ServerName=${config.host}.${config.port};DBQ=${config.database};${auth}`;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

async function main() {
  const config = getConfig().sourcePsql;
  if (!config.user || !config.password) {
    throw new Error("PSQL credentials are not configured (vault/env).");
  }

  const connStr = connectionString(config);
  let connection = await odbc.connect(connStr);
  const result = {
    generatedAt: new Date().toISOString(),
    source: { dsn: config.dsn, host: config.host, database: config.database },
    tables: [],
    targets: {},
    missingTargets: []
  };

  const tableRows = await connection.tables(null, null, null, null);
  const allTables = tableRows
    .map((row) => ({
      name: row.TABLE_NAME,
      type: row.TABLE_TYPE
    }))
    .filter((t) => t.name && !String(t.name).startsWith("X$"));
  result.tables = allTables;

  const byLower = new Map(allTables.map((t) => [String(t.name).toLowerCase(), t.name]));

  for (const target of TARGET_TABLES) {
    const actual = byLower.get(target.toLowerCase());
    if (!actual) {
      result.missingTargets.push(target);
      continue;
    }

    const columns = await connection.columns(null, null, actual, null);
    result.targets[target] = {
      actualName: actual,
      columns: columns.map((c) => ({
        name: c.COLUMN_NAME,
        type: c.TYPE_NAME,
        size: c.COLUMN_SIZE,
        decimalDigits: c.DECIMAL_DIGITS,
        nullable: c.NULLABLE
      })),
      rowCount: null
    };
  }

  for (const target of Object.keys(result.targets)) {
    const info = result.targets[target];
    try {
      const rows = await withTimeout(
        connection.query(`SELECT COUNT(*) AS n FROM "${info.actualName}"`),
        COUNT_TIMEOUT_MS,
        `COUNT ${info.actualName}`
      );
      const first = rows && rows[0] ? rows[0] : {};
      const key = Object.keys(first).find((k) => k.toLowerCase() === "n") || Object.keys(first)[0];
      info.rowCount = key ? Number(first[key]) : null;
    } catch (error) {
      info.rowCount = null;
      info.rowCountError = error.message;
      // A timed-out count can leave the connection busy; start fresh.
      try { await connection.close(); } catch {}
      connection = await odbc.connect(connStr);
    }
  }

  try { await connection.close(); } catch {}

  const outPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, "..", "data", "zen-catalog.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  const found = Object.keys(result.targets);
  console.log(`Tables on source: ${allTables.length}`);
  console.log(`Targets found: ${found.length}/${TARGET_TABLES.length}`);
  if (result.missingTargets.length) {
    console.log(`MISSING: ${result.missingTargets.join(", ")}`);
  }
  for (const name of found) {
    const t = result.targets[name];
    console.log(`  ${t.actualName}: ${t.columns.length} cols, rows=${t.rowCount ?? "?"}`);
  }
  console.log(`Catalog written to ${outPath}`);
}

main().catch((error) => {
  console.error(`Discovery failed: ${error.message}`);
  process.exit(1);
});
