// Point-in-time inventory snapshots.
//
// This exists because on-hand history is not recoverable from the source.
// LensItem.OnHand_* and MiscItems.OnHand are CURRENT values, overwritten in
// place. Reconstructing them by walking StockTransactions backwards was
// measured against the 3,497 stocked lens rows and matched exactly for 2,489
// (71%) and to within +/-2 units for 3,105 (89%), with a 6.5% aggregate gap —
// and nothing identifies which items land in the wrong 11%.
//
// So "this item's months of cover is trending down", and every forecast built
// on it, only becomes trustworthy from the day capture starts. Everything else
// the Inventory tab reports is derived from history that already exists
// (RxArchive back to 2017) and can be computed retrospectively; this cannot.
//
// Cost: ~3,762 lens rows + ~340 misc per run. Weekly is ~215k rows a year.

const sql = require("mssql");
const { getAppPool } = require("../db");
const { getUniverse } = require("./inventory");

const BATCH_SIZE = 500;

/** YYYY-MM-DD in the machine's own timezone. */
function localDateString(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Capture one snapshot.
 *
 * Idempotent per day: the unique indexes on (snapshot_date, item identity) mean
 * a second run on the same date updates rather than duplicating, so a retry
 * after a partial failure is safe.
 */
async function captureInventorySnapshot({ snapshotDate = null } = {}) {
  const startedAt = new Date().toISOString();
  const { thresholds, lensItems, miscItems } = await getUniverse({ force: true });
  const pool = await getAppPool();

  // Date, not datetime: one row per item per day is the grain.
  //
  // LOCAL date, not toISOString().slice(0,10). The lab runs at UTC-4, so any
  // run after 20:00 local has a UTC date of tomorrow and would file the
  // snapshot under the wrong day — and, worse, collide with the next day's run.
  const date = snapshotDate || localDateString(new Date());

  const rows = [];

  for (const item of lensItems) {
    // Only capture what is actually held. A moved-but-unstocked item has no
    // stock position to remember, and including it would bloat the table with
    // zero rows that say nothing.
    if (item.onHand === 0) continue;
    rows.push({
      kind: "lens",
      mg: item.materialGroup, mt: item.material, mf: item.mfType,
      lt: item.lensType, op: item.lensOption, it: item.itemNum,
      miscItemId: null,
      label: item.label,
      onHand: item.onHand,
      cost: item.cost,
      value: item.stockValue,
      units: item.units,
      speedClass: item.speedClass,
      cover: item.coverMonths,
      treatment: item.treatment
    });
  }

  for (const item of miscItems) {
    if (item.onHand === 0) continue;
    rows.push({
      kind: "misc",
      mg: null, mt: null, mf: null, lt: null, op: null, it: null,
      miscItemId: item.miscItemId,
      label: item.label,
      onHand: item.onHand,
      cost: item.cost,
      value: item.stockValue,
      units: item.units,
      speedClass: item.speedClass,
      cover: item.coverMonths,
      treatment: null
    });
  }

  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    written += await writeBatch(pool, date, rows.slice(i, i + BATCH_SIZE), thresholds);
  }

  return {
    snapshotDate: date,
    startedAt,
    finishedAt: new Date().toISOString(),
    lensRows: rows.filter((r) => r.kind === "lens").length,
    miscRows: rows.filter((r) => r.kind === "misc").length,
    rowsWritten: written,
    windowMonths: thresholds.windowMonths
  };
}

/**
 * MERGE each row on its natural key. Parameterised per row rather than built as
 * a literal VALUES list, so an item description containing a quote cannot break
 * (or reshape) the statement.
 */
async function writeBatch(pool, date, batch, thresholds) {
  const transaction = pool.transaction();
  await transaction.begin();

  try {
    let written = 0;
    for (const row of batch) {
      const request = new sql.Request(transaction);
      request.input("date", sql.Date, date);
      request.input("kind", sql.NVarChar(10), row.kind);
      request.input("mg", sql.Int, row.mg);
      request.input("mt", sql.Int, row.mt);
      request.input("mf", sql.Int, row.mf);
      request.input("lt", sql.Int, row.lt);
      request.input("op", sql.Int, row.op);
      request.input("it", sql.Int, row.it);
      request.input("miscItemId", sql.Int, row.miscItemId);
      request.input("label", sql.NVarChar(400), (row.label || "").slice(0, 400));
      request.input("onHand", sql.Int, row.onHand);
      request.input("cost", sql.Decimal(18, 4), row.cost);
      request.input("value", sql.Decimal(18, 4), row.value);
      request.input("units", sql.Int, row.units);
      request.input("windowMonths", sql.Int, thresholds.windowMonths);
      request.input("speedClass", sql.NVarChar(20), row.speedClass);
      request.input("cover", sql.Decimal(10, 2), row.cover);
      request.input("treatment", sql.NVarChar(60), row.treatment);

      await request.query(`
        MERGE metrics.inventory_snapshots AS target
        USING (SELECT @date AS snapshot_date, @kind AS item_kind) AS src
          ON target.snapshot_date = src.snapshot_date
         AND target.item_kind = src.item_kind
         AND ((src.item_kind = N'lens'
               AND target.material_group = @mg AND target.material = @mt
               AND target.mf_type = @mf AND target.lens_type = @lt
               AND target.lens_option = @op AND target.item_num = @it)
           OR (src.item_kind = N'misc' AND target.misc_item_id = @miscItemId))
        WHEN MATCHED THEN UPDATE SET
          item_label = @label, on_hand = @onHand, unit_cost = @cost,
          stock_value = @value, units_moved_window = @units, window_months = @windowMonths,
          speed_class = @speedClass, months_of_cover = @cover, treatment = @treatment
        WHEN NOT MATCHED THEN INSERT
          (snapshot_date, item_kind, material_group, material, mf_type, lens_type,
           lens_option, item_num, misc_item_id, item_label, on_hand, unit_cost,
           stock_value, units_moved_window, window_months, speed_class, months_of_cover, treatment)
          VALUES
          (@date, @kind, @mg, @mt, @mf, @lt, @op, @it, @miscItemId, @label, @onHand,
           @cost, @value, @units, @windowMonths, @speedClass, @cover, @treatment);
      `);
      written += 1;
    }

    await transaction.commit();
    return written;
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  }
}

/** How much history exists — used to say honestly whether trends are available yet. */
async function getSnapshotCoverage() {
  try {
    const pool = await getAppPool();
    // Dates come back as strings (style 23 = yyyy-mm-dd). Returned as DATE they
    // become JS Date objects at midnight UTC, which render as the PREVIOUS day
    // in any western timezone — the same off-by-one this module just fixed on
    // the write side.
    const result = await pool.request().query(`
      SELECT COUNT(DISTINCT snapshot_date) AS snapshots,
             CONVERT(char(10), MIN(snapshot_date), 23) AS firstDate,
             CONVERT(char(10), MAX(snapshot_date), 23) AS lastDate,
             COUNT(*) AS rows
      FROM metrics.inventory_snapshots;
    `);
    const row = result.recordset[0] || {};
    return {
      snapshots: Number(row.snapshots || 0),
      firstDate: row.firstDate || null,
      lastDate: row.lastDate || null,
      rows: Number(row.rows || 0),
      trendsAvailable: Number(row.snapshots || 0) >= 2
    };
  } catch {
    return { snapshots: 0, firstDate: null, lastDate: null, rows: 0, trendsAvailable: false };
  }
}

module.exports = { captureInventorySnapshot, getSnapshotCoverage };
