/**
 * run-zen-mirror-sync.js — run one Zen → innovations_mirror sync from the CLI.
 *
 * Usage: node scripts/run-zen-mirror-sync.js [--full]
 *   --full  pull every row, merge, and reconcile hard deletes on large tables
 */
const { runMirrorSync } = require("../lib/zen-mirror-sync");

const full = process.argv.includes("--full");

runMirrorSync({ full })
  .then((summary) => {
    if (summary.skipped) {
      console.log(summary.reason);
      return;
    }
    for (const table of summary.tables) {
      const status = table.error ? `ERROR ${table.error}` : `${table.rows} pulled, ${table.totalRows} total`;
      console.log(`  ${table.table.padEnd(22)} [${table.strategy}] ${status}`);
    }
    console.log(`${summary.ok ? "Sync OK" : "Sync finished WITH ERRORS"} (${summary.startedAt} -> ${summary.finishedAt})`);
    process.exit(summary.ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(`Sync failed: ${error.message}`);
    process.exit(1);
  });
