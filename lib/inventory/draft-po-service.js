/**
 * Internal draft purchase-order preview.
 *
 * CONTRACT:
 * 1. Reads ONLY approved, effective ItemReplenishmentSettings. It never reads a
 *    pending, rejected or superseded recommendation.
 * 2. Reads current source stock and open-PO quantity to present the line, but the
 *    reorder rule (order point, reorder quantity, MOQ, pack multiple) comes from
 *    the approved setting.
 * 3. Every line names the settings revision, approver and the task and
 *    recommendation that produced it.
 * 4. A review artifact only: nothing is submitted to a supplier, no source PO is
 *    written, and the preview is not stored.
 *
 * A line's id is the id of the settings revision it was generated from, so
 * generating the preview twice yields the same lines and never duplicates one.
 * An approved item with no live stock evidence is listed as "not evaluated";
 * its stock is never assumed to be zero.
 */

const { randomUUID } = require("node:crypto");
const { listActiveSettings } = require("./settings-service");
const { loadInventoryEvidence, MAX_ROWS } = require("./source-adapter");
const { roundUpOrderQuantity } = require("./calculator");
const { recordInventoryAudit } = require("./audit-service");

async function generateDraftPoPreview(options = {}) {
  const actor = options.actor || "system";
  const approved = await listActiveSettings();
  const evidence = await loadInventoryEvidence({ useFixtures: options.useFixtures, limit: MAX_ROWS });

  const byItem = new Map(evidence.items.map((e) => [e.itemId, e]));
  const lines = [];
  const notEvaluated = [];

  for (const [itemId, setting] of approved.entries()) {
    if (!setting.isActive) continue;
    if (options.supplierId && setting.supplierId !== options.supplierId) continue;

    const live = byItem.get(itemId);
    if (!live) {
      notEvaluated.push({
        itemId,
        itemLabel: setting.itemLabel || itemId,
        supplierName: setting.supplierName || null,
        reason: evidence.truncated
          ? "Live stock evidence was truncated; this item could not be evaluated."
          : "No live stock, on-order or movement for this item, so no order is indicated."
      });
      continue;
    }

    const availableCoverage = Math.max(0, live.onHand) + live.openPoQuantity;
    if (availableCoverage >= setting.orderPoint) continue;

    const shortfall = setting.orderPoint - availableCoverage;
    const quantity = roundUpOrderQuantity(Math.max(setting.reorderQuantity, shortfall), setting.minOrderQty, setting.packMultiple);
    if (quantity <= 0) continue;

    lines.push({
      lineId: `line:${setting.settingId}`,
      itemId,
      sku: setting.sku || live.sku,
      itemLabel: setting.itemLabel || live.itemLabel || itemId,
      supplierId: setting.supplierId,
      supplierName: setting.supplierName || live.supplierName || null,
      currentOnHand: live.onHand,
      currentOpenPo: live.openPoQuantity,
      availableCoverage,
      approvedOrderPoint: setting.orderPoint,
      approvedSafetyStock: setting.safetyStock,
      approvedReorderQty: setting.reorderQuantity,
      leadTimeDays: setting.leadTimeDays,
      minOrderQty: setting.minOrderQty,
      packMultiple: setting.packMultiple,
      quantity,
      unitCost: live.unitCost,
      extendedCost: Number((quantity * live.unitCost).toFixed(2)),
      lineage: {
        settingId: setting.settingId,
        version: setting.version,
        approvedBy: setting.approvedBy,
        approvedAt: setting.approvedAt,
        approvedRecommendationId: setting.approvedRecommendationId,
        approvedTaskId: setting.approvedTaskId,
        source: "ItemReplenishmentSettings"
      }
    });
  }

  lines.sort((a, b) => (a.supplierName || "").localeCompare(b.supplierName || "") || a.itemLabel.localeCompare(b.itemLabel));

  const bySupplier = new Map();
  let grandTotalCost = 0;
  let totalUnits = 0;
  for (const line of lines) {
    grandTotalCost += line.extendedCost;
    totalUnits += line.quantity;
    const key = line.supplierId || "UNASSIGNED";
    if (!bySupplier.has(key)) {
      bySupplier.set(key, { supplierId: line.supplierId, supplierName: line.supplierName, lines: [], totalUnits: 0, totalCost: 0 });
    }
    const group = bySupplier.get(key);
    group.lines.push(line);
    group.totalUnits += line.quantity;
    group.totalCost = Number((group.totalCost + line.extendedCost).toFixed(2));
  }

  const previewId = randomUUID();
  const result = {
    draftPoPreviewId: previewId,
    generatedAt: new Date().toISOString(),
    generatedBy: actor,
    evidenceAsOf: evidence.asOf,
    evidenceTruncated: evidence.truncated,
    approvedSettingsCount: approved.size,
    totalLines: lines.length,
    totalUnits,
    grandTotalCost: Number(grandTotalCost.toFixed(2)),
    suppliers: Array.from(bySupplier.values()),
    lines,
    notEvaluated,
    disclaimer: "Internal review draft only. Built strictly from approved ItemReplenishmentSettings. Nothing is sent to a supplier and no purchase order is created."
  };

  await recordInventoryAudit({
    actor,
    action: "DRAFT_PO_GENERATED",
    entityType: "DraftPurchaseOrder",
    entityId: previewId,
    afterState: {
      totalLines: lines.length,
      totalUnits,
      grandTotalCost: result.grandTotalCost,
      lineSettingIds: lines.map((l) => l.lineage.settingId),
      notEvaluated: notEvaluated.length
    },
    reason: `Generated draft PO preview with ${lines.length} approved line(s)`
  });

  return result;
}

module.exports = { generateDraftPoPreview };
