#!/usr/bin/env node
/**
 * innovations-pricing-counts.js — the dry-run gate for the pricing mirror.
 *
 * Runs a plain SELECT COUNT(*) against Innovations for the exact rows a FULL mirror run reads
 * (same FROM/WHERE as lib/innovations-pricing-mirror.js), so the numbers can be compared with
 * the `read` count of `innovations-sync-cli.js --entities all-inn --dry-run` and, after a
 * commit, with the row counts in Supabase. Read-only; writes nothing, calls no receiver.
 *
 *   node scripts/innovations-pricing-counts.js            # table
 *   node scripts/innovations-pricing-counts.js --json
 *
 * Also prints the two derived figures the reconciliation views must reproduce.
 */
const path = require('node:path');
const mirror = require(path.join(__dirname, '..', 'lib', 'innovations-pricing-mirror'));
const { getLongSourcePool } = require(path.join(__dirname, '..', 'lib', 'db'));

const PREFIX = 'SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; ';

// Options ON at every level with every ancestor row present (the locked lens rule).
const LENS_FULL_PATH_SQL = `SELECT COUNT(*) AS n
  FROM dbo.LensOptions lo
  JOIN dbo.LensType lt ON lt.Groupnum = lo.Groupnum AND lt.Matlnum = lo.Matlnum AND lt.MFnum = lo.MFnum AND lt.Lnum = lo.Lnum
  JOIN dbo.MFTypes mt ON mt.GroupNum = lo.Groupnum AND mt.MtrlNum = lo.Matlnum AND mt.MFNum = lo.MFnum
  JOIN dbo.Materials ma ON ma.GroupNum = lo.Groupnum AND ma.MtrlNum = lo.Matlnum
  JOIN dbo.MaterialGroup mg ON mg.Groupnum = lo.Groupnum
  WHERE (ISNULL(lo.Flags,0) & 2) = 0 AND (ISNULL(lt.Flags,0) & 2) = 0 AND (ISNULL(mt.Flags,0) & 2) = 0
    AND (ISNULL(ma.Flags,0) & 2) = 0 AND (ISNULL(mg.Flags,0) & 2) = 0`;

// Reconciliation (c): 2026 lens lines with no cost.
const ZERO_COST_SQL = `SELECT COUNT(*) AS n_zero_cost, SUM(CASE WHEN ISNULL(il.InvoicePrice,0) > 0 AND il.Suppressed = 0 THEN 1 ELSE 0 END) AS n_charged_unsuppressed
  FROM dbo.InvoiceLines il JOIN dbo.Invoices inv ON inv.InvoiceID = il.InvoiceID
  WHERE inv.InvoiceTime >= '2026-01-01' AND inv.InvoiceTime < '2027-01-01' AND il.CategoryType = 1 AND ISNULL(il.CostPrice,0) = 0`;

(async () => {
  const pool = await getLongSourcePool();
  const rows = [];
  for (const spec of mirror.SPECS) {
    const r = await pool.request().query(PREFIX + mirror.countSql(spec.name));
    rows.push({ entity: spec.name, source: spec.from && typeof spec.from === 'string' ? spec.from.split(' ')[0] : 'dbo.LensItem (active path)', expected_rows: Number(r.recordset[0].n) });
  }
  const full = (await pool.request().query(PREFIX + LENS_FULL_PATH_SQL)).recordset[0].n;
  const zero = (await pool.request().query(PREFIX + ZERO_COST_SQL)).recordset[0];
  const derived = {
    lens_options_on_full_path: Number(full),
    invoice_lens_lines_2026_zero_cost: Number(zero.n_zero_cost),
    invoice_lens_lines_2026_zero_cost_charged_unsuppressed: Number(zero.n_charged_unsuppressed),
  };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ at: new Date().toISOString(), invoicesFrom: mirror.INVOICE_LINES_FROM, entities: rows, derived }, null, 2));
  } else {
    console.log(`Expected row counts (SELECT COUNT(*), full run) at ${new Date().toISOString()}`);
    for (const r of rows) console.log(`${r.entity.padEnd(28)} ${String(r.expected_rows).padStart(9)}`);
    console.log('\nDerived (the Supabase views must reproduce these):');
    for (const [k, v] of Object.entries(derived)) console.log(`${k.padEnd(60)} ${String(v).padStart(7)}`);
  }
  await pool.close();
  process.exit(0);
})().catch((e) => { console.error('Count failed:', e.message); process.exit(1); });
