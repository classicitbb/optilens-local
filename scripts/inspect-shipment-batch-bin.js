#!/usr/bin/env node
/**
 * inspect-shipment-batch-bin.js — one-off, read-only schema probe.
 *
 * We need to know whether Innovations' dbo.Shipments carries Batch ID / Bin
 * columns directly, or whether those live on a related table, before wiring
 * the OptiLens Local shipment sync to mirror the legacy delivery screen.
 *
 * No writes, no vault passphrase needed — same posture as
 * innovations-sync-cli.js --schema (it only reads INFORMATION_SCHEMA / sys.*).
 *
 * Run from the app folder on the machine that has LAN access to MSSQL-SVR:
 *   node scripts/inspect-shipment-batch-bin.js
 */
const path = require('path');
const { getSourcePool } = require(path.join(__dirname, '..', 'lib', 'db'));

(async () => {
  try {
    const pool = await getSourcePool();

    // 1) Every column currently on dbo.Shipments.
    const shipmentCols = await pool.request().query(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, ORDINAL_POSITION
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'Shipments'
      ORDER BY ORDINAL_POSITION
    `);

    // 2) Any table whose name suggests batching/binning of shipments.
    const candidateTables = await pool.request().query(`
      SELECT TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
        AND (
          TABLE_NAME LIKE '%Batch%'
          OR TABLE_NAME LIKE '%Bin%'
          OR TABLE_NAME LIKE '%Shipment%'
        )
      ORDER BY TABLE_NAME
    `);

    // 3) Any column (on any table) literally named like Batch/Bin, in case
    //    they hang off Shipments under a less obvious table name.
    const candidateColumns = await pool.request().query(`
      SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE COLUMN_NAME LIKE '%Batch%'
         OR COLUMN_NAME LIKE '%Bin%'
      ORDER BY TABLE_NAME, COLUMN_NAME
    `);

    console.log('=== dbo.Shipments columns ===');
    console.log(JSON.stringify(shipmentCols.recordset, null, 2));

    console.log('\n=== Tables matching %Batch%, %Bin%, %Shipment% ===');
    console.log(JSON.stringify(candidateTables.recordset.map(r => r.TABLE_NAME), null, 2));

    console.log('\n=== Columns named like %Batch% or %Bin% (any table) ===');
    console.log(JSON.stringify(candidateColumns.recordset, null, 2));

    process.exit(0);
  } catch (e) {
    console.error('Schema probe failed:', e.message);
    process.exit(1);
  }
})();
