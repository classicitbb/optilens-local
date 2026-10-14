/**
 * Cockpit summary: the six KPI cards and the scan status banner.
 *
 * Cards distinguish three states that must never be confused:
 *   ready        - there is work in this queue;
 *   no_work      - a scan completed and found nothing for this queue;
 *   unavailable  - no scan has completed, so the queue says nothing either way.
 */

const { summarizeActive } = require("./recommendations-service");
const { getLatestScanStatus, getLatestCompletedScan } = require("./scan-runner");
const { listRequests } = require("./events");

const STALE_AFTER_HOURS = 36;
const RANK_TO_PRIORITY = { 5: "CRITICAL", 4: "HIGH", 3: "MEDIUM", 2: "LOW", 1: "INFO", 0: "NONE" };

const CARD_DEFINITIONS = Object.freeze([
  { cardKey: "ORDER_MORE", title: "Order More", queueMeaning: "Items with a supported replenishment shortfall not already covered by an open PO." },
  { cardKey: "ORDER_LESS", title: "Order Less", queueMeaning: "Items whose approved setting or proposed quantity is materially above weighted demand." },
  { cardKey: "WRITE_OFF_REVIEW", title: "Write-Off Review", queueMeaning: "Slow/non-moving or obsolete-risk stock requiring a write-off decision; not an automatic financial write-off." },
  { cardKey: "SHELF_CHECK", title: "Shelf Check", queueMeaning: "Items whose stock position or confidence requires a physical count." },
  { cardKey: "PENDING_APPROVAL", title: "Pending Approval", queueMeaning: "Replenishment recommendations/tasks awaiting an authorized decision." },
  { cardKey: "ALREADY_COVERED_BY_PO", title: "Already Covered by PO", queueMeaning: "Items where open PO supply covers the current replenishment need; shown to make non-ordering visible." }
]);

const money = (value) => `$${Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function describe(cardKey, count, units, value) {
  switch (cardKey) {
    case "ORDER_MORE": return `${units} units short (${money(value)})`;
    case "ORDER_LESS": return `${units} excess units (${money(value)})`;
    case "WRITE_OFF_REVIEW": return `${units} dormant units (${money(value)})`;
    case "SHELF_CHECK": return `${count} item${count === 1 ? "" : "s"} need a physical count`;
    case "PENDING_APPROVAL": return `${count} decision${count === 1 ? "" : "s"} waiting (${money(value)} exposure)`;
    case "ALREADY_COVERED_BY_PO": return `${units} units already on PO (${money(value)})`;
    default: return "";
  }
}

async function getCockpitSummary() {
  const [rows, latestScan, completedScan, pending] = await Promise.all([
    summarizeActive(),
    getLatestScanStatus(),
    getLatestCompletedScan(),
    listRequests({ status: "PENDING", limit: 50 })
  ]);

  const hasData = Boolean(completedScan);
  const cards = CARD_DEFINITIONS.map((definition) => {
    const matching = definition.cardKey === "PENDING_APPROVAL"
      ? rows.filter((r) => r.status === "PENDING_APPROVAL")
      : rows.filter((r) => r.recommendationType === definition.cardKey);

    const count = matching.reduce((sum, r) => sum + r.count, 0);
    const units = Math.round(matching.reduce((sum, r) => sum + r.contextUnits, 0));
    const valueAtRisk = Number(matching.reduce((sum, r) => sum + r.valueAtRisk, 0).toFixed(2));
    const rank = matching.reduce((max, r) => Math.max(max, r.maxPriorityRank || 0), 0);
    const priority = RANK_TO_PRIORITY[rank];

    let status = "ready";
    let unitContext = describe(definition.cardKey, count, units, valueAtRisk);
    if (!hasData) {
      status = "unavailable";
      unitContext = "No scan has completed yet";
    } else if (count === 0) {
      status = "no_work";
      unitContext = "Nothing in this queue";
    }

    return {
      ...definition,
      count,
      priority: status === "ready" ? priority : "NONE",
      severityLevel: status === "ready" ? priority.toLowerCase() : "none",
      totalUnits: units,
      valueAtRisk,
      unitContext,
      status
    };
  });

  let dataStatus = "ok";
  let message = null;
  if (!completedScan) {
    dataStatus = latestScan && latestScan.status === "FAILED" ? "last_scan_failed" : "never_scanned";
    message = dataStatus === "last_scan_failed"
      ? "The last scan could not read the source data, and no earlier scan exists, so there is nothing to show yet."
      : "No scan has completed yet. Run a scan to populate the queues.";
  } else if (latestScan && latestScan.status === "FAILED" && latestScan.scanRunId !== completedScan.scanRunId) {
    dataStatus = "last_scan_failed";
    message = "The most recent scan failed; the queues show the last scan that completed.";
  } else if (latestScan && latestScan.status === "RUNNING") {
    dataStatus = "scanning";
    message = "A scan is running; counts may change when it finishes.";
  } else {
    const ageHours = (Date.now() - new Date(completedScan.completedAt || completedScan.startedAt).getTime()) / 3600000;
    if (ageHours > STALE_AFTER_HOURS) {
      dataStatus = "stale";
      message = `The last completed scan is ${Math.round(ageHours)} hours old.`;
    }
  }

  const slim = (scan) => (scan ? {
    scanRunId: scan.scanRunId,
    triggerType: scan.triggerType,
    status: scan.status,
    itemsEvaluated: scan.itemsEvaluated,
    startedAt: scan.startedAt,
    completedAt: scan.completedAt,
    errorCount: scan.errors ? scan.errors.length : 0,
    truncated: scan.sourceWatermarks ? Boolean(scan.sourceWatermarks.truncated) : false,
    evidenceAsOf: scan.sourceWatermarks ? scan.sourceWatermarks.evidenceAsOf : null
  } : null);

  return {
    cards,
    dataStatus,
    message,
    latestScan: slim(latestScan),
    dataScan: slim(completedScan),
    pendingRequests: pending.length,
    sourceCaveats: completedScan && completedScan.summary ? completedScan.summary.sourceCaveats || [] : [],
    totalActive: rows.reduce((sum, r) => sum + r.count, 0),
    timestamp: new Date().toISOString()
  };
}

module.exports = { CARD_DEFINITIONS, STALE_AFTER_HOURS, getCockpitSummary };
