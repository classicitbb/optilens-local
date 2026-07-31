/**
 * run-inventory-snapshot.js — capture one point-in-time inventory snapshot.
 *
 * Usage: node scripts/run-inventory-snapshot.js [--date YYYY-MM-DD]
 *   --date  capture under a specific date instead of today. Idempotent: a
 *           re-run for the same date updates its rows rather than duplicating.
 *
 * Install as a weekly scheduled task with:
 *   scripts/install-inventory-snapshot-task.ps1
 *
 * This is the one piece of the inventory build that cannot be backfilled —
 * on-hand quantity has no history in Innovations, and reconstructing it from
 * StockTransactions is only ~89% accurate with no way to tell which items are
 * wrong. Every run that does not happen is a gap that stays a gap.
 */
const { captureInventorySnapshot, getSnapshotCoverage } = require("../lib/metrics/inventory-snapshot");

const dateFlag = process.argv.indexOf("--date");
const snapshotDate = dateFlag !== -1 ? process.argv[dateFlag + 1] : null;

if (snapshotDate && !/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
  console.error(`Invalid --date "${snapshotDate}". Expected YYYY-MM-DD.`);
  process.exit(1);
}

captureInventorySnapshot({ snapshotDate })
  .then(async (summary) => {
    console.log(
      `Snapshot ${summary.snapshotDate}: ${summary.rowsWritten} rows ` +
      `(${summary.lensRows} lens, ${summary.miscRows} misc) ` +
      `over a ${summary.windowMonths}-month window.`
    );

    const coverage = await getSnapshotCoverage();
    console.log(
      `History: ${coverage.snapshots} snapshot date(s), ${coverage.rows} rows` +
      (coverage.firstDate ? `, ${coverage.firstDate} to ${coverage.lastDate}` : "") +
      `. Cover trends ${coverage.trendsAvailable ? "available" : "need at least two dates"}.`
    );
    process.exit(0);
  })
  .catch((error) => {
    console.error(`Snapshot failed: ${error.message}`);
    process.exit(1);
  });
