/**
 * run-inventory-intelligence-scan.js - queue and run the Inventory Intelligence scan.
 *
 * Usage:
 *   node scripts/run-inventory-intelligence-scan.js            scheduled full scan
 *   node scripts/run-inventory-intelligence-scan.js --drain    only process requests already queued
 *
 * The scheduled scan is a request in inventory.recalculation_requests, drained by
 * the same worker that handles usage, stock-adjustment, PO, settings and manual
 * requests, so it takes exactly the same path as every other trigger. The script
 * reads the Innovations source and writes only to the app database's inventory
 * schema; it changes no purchasing setting by itself (settings change only when a
 * person approves a recommendation) and never writes to Innovations.
 *
 * This is not installed as a scheduled task by the app. To run it daily, create a
 * task that executes the command above once the owner has approved the schedule.
 *
 * Exit code 0 when every scan completed, 1 when a scan failed or had item errors.
 */

const { enqueueRecalculation } = require("../lib/inventory/events");
const { processPendingRequests } = require("../lib/inventory/scan-runner");

const drainOnly = process.argv.includes("--drain");

async function main() {
  if (!drainOnly) {
    const { request, created } = await enqueueRecalculation({ eventType: "SCHEDULED_FULL", actor: "scheduler" });
    console.log(created ? `Queued scheduled full scan ${request.requestId}.` : `A full scan is already queued (${request.requestId}).`);
  }

  const scans = await processPendingRequests({ actor: "scheduler" });
  if (!scans.length) {
    console.log("Nothing to process.");
    return 0;
  }

  let exitCode = 0;
  for (const scan of scans) {
    const actions = (scan.summary && scan.summary.actions) || {};
    console.log(
      `Scan ${scan.scanRunId} (${scan.triggerType}): ${scan.status}, ${scan.itemsEvaluated} items, ` +
      `${actions.CREATED || 0} new, ${actions.REVISED || 0} revised, ${actions.REFRESHED || 0} refreshed, ` +
      `${actions.RETIRED || 0} retired, ${actions.SUPPRESSED || 0} already decided, ${scan.tasksCreated} tasks opened.`
    );
    if (scan.sourceWatermarks && scan.sourceWatermarks.truncated) {
      console.log("  Note: the source page was full, so items beyond it were not evaluated.");
    }
    for (const error of (scan.errors || []).slice(0, 5)) {
      console.log(`  ${error.itemId || "scan"}: ${error.message}`);
    }
    if (scan.status !== "COMPLETED") exitCode = 1;
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`Inventory Intelligence scan failed: ${error && error.message ? error.message : error}`);
    process.exit(1);
  });
