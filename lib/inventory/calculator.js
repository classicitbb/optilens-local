/**
 * Deterministic replenishment calculation engine for OptiLens Local.
 *
 * NON-NEGOTIABLE RULES:
 * 1. The engine is 100% deterministic. AI may summarize or explain, never calculate.
 * 2. Usage uses weighted recent windows (30-day and 90-day), never a lifetime average.
 * 3. Open PO quantity is subtracted before suggesting another order.
 * 4. Suggested quantities respect MOQ and pack multiple; rounding up happens only
 *    where an order is required.
 * 5. Already-covered-by-PO items are distinguished and never appear in Order More.
 *
 * The function is pure: it reads only its input and the supplied policy, so a
 * stored evidence snapshot plus the stored policy reproduces the result exactly.
 */

const DEFAULT_POLICY = Object.freeze({
  weight30: 0.70,
  weight90: 0.30,
  targetCoverDays: 30,
  defaultLeadTimeDays: 14,
  defaultSafetyStock: 5,
  defaultMoq: 1,
  defaultPackMultiple: 1,
  writeOffDaysThreshold: 365,
  overstockCoverRatio: 2.0,
  // An approved order point counts as "materially above" demand when it exceeds the
  // freshly calculated one by more than this fraction (and by at least minOrderPointExcess units).
  orderLessTolerance: 0.25,
  minOrderPointExcess: 3,
  minTrendUnits: 5,
  trendUpRatio: 1.15,
  trendDownRatio: 0.85,
  confidenceThreshold: 50,
  // A rejected recommendation is not re-raised unchanged for this many days.
  decidedSuppressionDays: 30,
  calculationVersion: "1.1.0",
  policyVersion: "1.0.0"
});

const round4 = (n) => Math.round(n * 10000) / 10000;

/** Weights must be non-negative and sum to 1; anything else falls back to the defaults. */
function normaliseWeights(weight30, weight90) {
  const a = Number(weight30);
  const b = Number(weight90);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0 || a + b <= 0) {
    return { weight30: DEFAULT_POLICY.weight30, weight90: DEFAULT_POLICY.weight90 };
  }
  const total = a + b;
  return { weight30: round4(a / total), weight90: round4(b / total) };
}

/**
 * Rounds upward to MOQ and pack multiple ONLY if rawQuantity > 0.
 * If rawQuantity <= 0, returns 0 (an order that is not required is never rounded up).
 */
function roundUpOrderQuantity(rawQuantity, moq, packMultiple) {
  if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) return 0;
  const minQty = Number.isFinite(moq) && moq > 0 ? Math.ceil(moq) : 1;
  const pack = Number.isFinite(packMultiple) && packMultiple > 0 ? Math.ceil(packMultiple) : 1;
  const qty = Math.max(rawQuantity, minQty);
  return Math.ceil(qty / pack) * pack;
}

/**
 * Trend: the last 30 days against the TRAILING 60 days (days 31-90), so the
 * recent window is not compared with a baseline that already contains it.
 * Returns 'UP' | 'DOWN' | 'STABLE' | 'UNKNOWN'. UNKNOWN when 90-day volume is
 * below minUnits: a handful of units cannot support a direction.
 */
function calculateTrend(usage30, usage90, minUnits = DEFAULT_POLICY.minTrendUnits, ratios = {}) {
  const u30 = Math.max(0, Number(usage30) || 0);
  const u90 = Math.max(0, Number(usage90) || 0);
  if (u90 < minUnits || u90 <= 0) return "UNKNOWN";

  const recentDaily = u30 / 30;
  const trailingDaily = Math.max(0, u90 - u30) / 60;
  if (trailingDaily === 0) return recentDaily > 0 ? "UP" : "UNKNOWN";

  const ratio = recentDaily / trailingDaily;
  if (ratio > (ratios.up || DEFAULT_POLICY.trendUpRatio)) return "UP";
  if (ratio < (ratios.down || DEFAULT_POLICY.trendDownRatio)) return "DOWN";
  return "STABLE";
}

const TASK_BY_QUEUE = Object.freeze({
  ORDER_MORE: "APPROVE_REPLENISHMENT_CHANGE",
  ORDER_LESS: "REVIEW_OVERSTOCK",
  WRITE_OFF_REVIEW: "REVIEW_WRITE_OFF",
  SHELF_CHECK: "COUNT_SHELF"
});

/** Queues whose approval changes ItemReplenishmentSettings. */
const SETTINGS_QUEUES = Object.freeze(["ORDER_MORE", "ORDER_LESS"]);

function mappingSignal(signals) {
  return signals.some((s) => s.code === "UNMAPPED_SUPPLIER" || s.code === "CONFLICTING_SUPPLIER_MAPPING");
}

function countSignal(signals) {
  return signals.some((s) => s.code === "NEGATIVE_STOCK" || s.code === "STALE_STOCK_COUNT" || s.code === "COUNT_DISCREPANCY");
}

/**
 * Calculates replenishment metrics and the queue classification for one item.
 *
 * @param {Object} input
 * @param {string} input.itemId
 * @param {number} input.onHand               current on-hand (may be negative: a data defect)
 * @param {number} [input.openPoQuantity=0]   open PO quantity net of received/cancelled
 * @param {number} input.usage30              units used in the last 30 days
 * @param {number} input.usage90              units used in the last 90 days
 * @param {number} [input.unitCost=0]
 * @param {Object} [input.settings]           approved ItemReplenishmentSettings (camelCase)
 * @param {Object} [input.confidence]         result of evaluateConfidence()
 * @param {Object} [input.policyOverrides]    configured policy values
 * @param {Object} [input.provenance]         where the evidence came from, with timestamps
 * @returns {Object|null-type} result; recommendationType is null when no action is needed
 */
function calculateItemReplenishment(input) {
  const policy = { ...DEFAULT_POLICY, ...(input.policyOverrides || {}) };
  const weights = normaliseWeights(policy.weight30, policy.weight90);
  policy.weight30 = weights.weight30;
  policy.weight90 = weights.weight90;

  const settings = input.settings || null;
  const confidence = input.confidence || { confidenceScore: 100, confidenceLevel: "HIGH", signals: [] };
  const signals = confidence.signals || [];

  const onHand = Number.isFinite(input.onHand) ? input.onHand : 0;
  const openPoQuantity = Math.max(0, Number.isFinite(input.openPoQuantity) ? input.openPoQuantity : 0);
  const usage30 = Math.max(0, Number.isFinite(input.usage30) ? input.usage30 : 0);
  const usage90 = Math.max(0, Number.isFinite(input.usage90) ? input.usage90 : 0);
  const unitCost = Math.max(0, Number.isFinite(input.unitCost) ? input.unitCost : 0);

  // Approved settings win; otherwise the configured policy defaults apply.
  const effectiveLeadTimeDays = (settings && settings.leadTimeDays > 0) ? settings.leadTimeDays : policy.defaultLeadTimeDays;
  const approvedSafetyStock = (settings && settings.safetyStock != null) ? settings.safetyStock : policy.defaultSafetyStock;
  const targetCoverDays = (settings && settings.targetCoverDays > 0) ? settings.targetCoverDays : policy.targetCoverDays;
  const moq = (settings && settings.minOrderQty > 0) ? settings.minOrderQty : policy.defaultMoq;
  const packMultiple = (settings && settings.packMultiple > 0) ? settings.packMultiple : policy.defaultPackMultiple;

  // 1. Weighted daily usage from the two recent windows (never a lifetime average).
  const dailyUsage30 = usage30 / 30;
  const dailyUsage90 = usage90 / 90;
  const weightedDailyUsage = round4((dailyUsage30 * weights.weight30) + (dailyUsage90 * weights.weight90));

  // 2. Trend: recent versus trailing demand.
  const trend = calculateTrend(usage30, usage90, policy.minTrendUnits, { up: policy.trendUpRatio, down: policy.trendDownRatio });

  // 3. Lead-time demand and order point.
  const leadTimeDemand = round4(weightedDailyUsage * effectiveLeadTimeDays);
  const proposedOrderPoint = Math.ceil(leadTimeDemand + approvedSafetyStock);

  // 4. Explicit target cover (units of demand to hold on top of the order point).
  const targetCover = round4(weightedDailyUsage * targetCoverDays);

  // 5. Supply already in hand or on order. Negative stock does not offset PO supply.
  const availableCoverage = Math.max(0, onHand) + openPoQuantity;

  // 6. Raw requirement and the rounded suggestion.
  const requirement = proposedOrderPoint + targetCover;
  const rawOrderQuantity = round4(Math.max(0, requirement - availableCoverage));
  const suggestedOrderQty = roundUpOrderQuantity(rawOrderQuantity, moq, packMultiple);

  // The same requirement with stock alone: tells us whether a PO is what prevents an order.
  const stockOnlyShortfall = Math.max(0, requirement - Math.max(0, onHand));

  // 7. Standard reorder quantity for the approved setting (one cover period, MOQ/pack rounded).
  const standardReorderQty = roundUpOrderQuantity(Math.max(targetCover, 1), moq, packMultiple);

  // 8. Days remaining: UNKNOWN when there is no usage to divide by.
  let daysRemaining;
  if (weightedDailyUsage <= 0) {
    daysRemaining = onHand > 0 ? "UNKNOWN" : (onHand === 0 ? 0 : "UNKNOWN");
  } else {
    daysRemaining = Math.max(0, Math.round(onHand / weightedDailyUsage));
  }

  const hasDemandEvidence = usage90 > 0;
  const lowConfidence = confidence.confidenceLevel === "LOW";

  // 9. Queue classification. The first matching rule wins.
  let recommendationType = null;
  let rationale = "";
  const recommendedActions = [];
  let priority = "MEDIUM";
  let taskType = null;
  let queueRule = "NO_ACTION";

  const proposedSettings = {
    orderPoint: proposedOrderPoint,
    reorderQuantity: standardReorderQty,
    leadTimeDays: effectiveLeadTimeDays,
    safetyStock: approvedSafetyStock,
    targetCoverDays,
    minOrderQty: moq,
    packMultiple,
    supplierId: input.supplierId || (settings && settings.supplierId) || null,
    supplierName: input.supplierName || (settings && settings.supplierName) || null
  };

  if (onHand < 0 || lowConfidence || mappingSignal(signals)) {
    // Confidence gate: unreliable data never produces an auto-approvable ordering action.
    // An unconfirmed supplier gates ordering whatever the numeric score, because an
    // order needs a supplier. A stock-position problem takes precedence over a mapping
    // problem since a count is the cheaper, faster fix.
    if (signals.some((s) => s.code === "SOURCE_NEGATIVE_AFTER_COUNT")) {
      recommendationType = "DATA_REVIEW";
      taskType = "CORRECT_ITEM_DATA";
      queueRule = "SOURCE_NEGATIVE_AFTER_COUNT";
      recommendedActions.push("Shelf was counted; correct the on-hand balance in Innovations stock control");
      rationale = `The source on-hand is ${onHand} although the shelf was counted recently. The stock record needs correcting in Innovations (this app cannot write to it).`;
      priority = "MEDIUM";
    } else if (mappingSignal(signals) && onHand >= 0 && !countSignal(signals)) {
      recommendationType = "DATA_REVIEW";
      taskType = "RESOLVE_SUPPLIER_MAPPING";
      queueRule = "CONFIDENCE_GATE_SUPPLIER_MAPPING";
      recommendedActions.push("Resolve the supplier mapping before any ordering decision");
      rationale = `The supplier mapping is not confirmed (confidence ${confidence.confidenceLevel}, score ${confidence.confidenceScore}). Ordering is withheld until it is resolved.`;
      priority = "MEDIUM";
    } else {
      recommendationType = "SHELF_CHECK";
      taskType = "COUNT_SHELF";
      queueRule = onHand < 0 ? "CONFIDENCE_GATE_NEGATIVE_STOCK" : "CONFIDENCE_GATE_LOW_CONFIDENCE";
      recommendedActions.push("Physical shelf count required before any ordering decision");
      rationale = `Confidence is ${confidence.confidenceLevel} (score ${confidence.confidenceScore}). On hand: ${onHand}. The stock figure needs physical verification before it can support an order.`;
      priority = onHand < 0 ? "HIGH" : "MEDIUM";
    }
  } else if (hasDemandEvidence && rawOrderQuantity > 0) {
    recommendationType = "ORDER_MORE";
    taskType = TASK_BY_QUEUE.ORDER_MORE;
    queueRule = "SHORTFALL_NOT_COVERED_BY_PO";
    recommendedActions.push(`Order ${suggestedOrderQty} units from ${proposedSettings.supplierName || "the supplier"}`);
    rationale = `Stock ${Math.max(0, onHand)} plus open PO ${openPoQuantity} = ${availableCoverage}, below the requirement of ${round4(requirement)} (order point ${proposedOrderPoint} + target cover ${targetCover}). Lead-time demand: ${leadTimeDemand}.`;
    priority = (typeof daysRemaining === "number" && daysRemaining <= effectiveLeadTimeDays) ? "CRITICAL" : "HIGH";
  } else if (hasDemandEvidence && openPoQuantity > 0 && stockOnlyShortfall > 0) {
    recommendationType = "ALREADY_COVERED_BY_PO";
    queueRule = "SHORTFALL_COVERED_BY_PO";
    recommendedActions.push(`No order required: ${openPoQuantity} units are already on open PO`);
    rationale = `Stock ${Math.max(0, onHand)} alone is below the requirement of ${round4(requirement)}, but the open PO quantity (${openPoQuantity}) brings coverage to ${availableCoverage}, which meets it. No new order is suggested.`;
    priority = "INFO";
  } else if (onHand > 0 && (usage90 === 0 || (typeof daysRemaining === "number" && daysRemaining >= policy.writeOffDaysThreshold))) {
    recommendationType = "WRITE_OFF_REVIEW";
    taskType = TASK_BY_QUEUE.WRITE_OFF_REVIEW;
    queueRule = usage90 === 0 ? "NO_MOVEMENT_90_DAYS" : "COVER_EXCEEDS_WRITE_OFF_DAYS";
    recommendedActions.push("Review slow/non-moving stock for write-off, discount or return to supplier");
    rationale = usage90 === 0
      ? `No movement recorded in the last 90 days with ${onHand} units on hand. Stock value at risk: $${(onHand * unitCost).toFixed(2)}. This is a review, not an automatic write-off.`
      : `${daysRemaining} days of cover exceeds the ${policy.writeOffDaysThreshold}-day write-off review threshold. Stock value at risk: $${(onHand * unitCost).toFixed(2)}.`;
    priority = "MEDIUM";
  } else if (hasDemandEvidence && settings && settings.orderPoint != null
    && settings.orderPoint > proposedOrderPoint + Math.max(policy.minOrderPointExcess, proposedOrderPoint * policy.orderLessTolerance)) {
    recommendationType = "ORDER_LESS";
    taskType = TASK_BY_QUEUE.ORDER_LESS;
    queueRule = "APPROVED_ORDER_POINT_ABOVE_DEMAND";
    recommendedActions.push(`Lower the order point from ${settings.orderPoint} to ${proposedOrderPoint}`);
    rationale = `The approved order point (${settings.orderPoint}) is materially above what weighted demand supports (${proposedOrderPoint}; ${weightedDailyUsage} units/day over ${effectiveLeadTimeDays} days plus ${approvedSafetyStock} safety stock).`;
    priority = "LOW";
  } else if (hasDemandEvidence && onHand + openPoQuantity > requirement
    && typeof daysRemaining === "number" && daysRemaining > targetCoverDays * policy.overstockCoverRatio) {
    recommendationType = "ORDER_LESS";
    taskType = TASK_BY_QUEUE.ORDER_LESS;
    queueRule = "STOCK_ABOVE_COVER_RATIO";
    recommendedActions.push("Delay future orders and review the reorder point");
    rationale = `On hand ${onHand} is ${daysRemaining} days of cover, above ${round4(targetCoverDays * policy.overstockCoverRatio)} days (${policy.overstockCoverRatio}x the ${targetCoverDays}-day target).`;
    priority = "LOW";
  }

  // Value at risk / unit context for cards and rows.
  let valueAtRisk = 0;
  let unitContext = "";
  let contextUnits = 0;
  switch (recommendationType) {
    case "ORDER_MORE":
      contextUnits = suggestedOrderQty;
      valueAtRisk = round4(suggestedOrderQty * unitCost);
      unitContext = `${suggestedOrderQty} units short`;
      break;
    case "ALREADY_COVERED_BY_PO":
      contextUnits = openPoQuantity;
      valueAtRisk = round4(openPoQuantity * unitCost);
      unitContext = `${openPoQuantity} units on PO`;
      break;
    case "ORDER_LESS": {
      const approvedOrderPoint = settings && settings.orderPoint != null ? settings.orderPoint : proposedOrderPoint;
      const excessUnits = queueRule === "APPROVED_ORDER_POINT_ABOVE_DEMAND"
        ? Math.max(0, approvedOrderPoint - proposedOrderPoint)
        : Math.max(0, Math.ceil(onHand + openPoQuantity - requirement));
      contextUnits = excessUnits;
      valueAtRisk = round4(excessUnits * unitCost);
      unitContext = `${excessUnits} excess units`;
      break;
    }
    case "WRITE_OFF_REVIEW":
      contextUnits = onHand;
      valueAtRisk = round4(onHand * unitCost);
      unitContext = `${onHand} dormant units`;
      break;
    case "SHELF_CHECK":
      contextUnits = Math.abs(onHand);
      valueAtRisk = round4(Math.abs(onHand) * unitCost);
      unitContext = `system shows ${onHand}; needs a count`;
      break;
    case "DATA_REVIEW":
      unitContext = "data needs review";
      break;
    default:
      break;
  }

  const result = {
    itemId: input.itemId,
    sku: input.sku || null,
    itemLabel: input.itemLabel || input.itemId,
    supplierId: proposedSettings.supplierId,
    supplierName: proposedSettings.supplierName || "Unassigned",
    recommendationType,
    taskType,
    priority,
    queueRule,
    confidenceScore: confidence.confidenceScore,
    confidenceLevel: confidence.confidenceLevel,
    evidence: {
      onHand,
      openPoQuantity,
      usage30,
      usage90,
      dailyUsage30: round4(dailyUsage30),
      dailyUsage90: round4(dailyUsage90),
      weightedDailyUsage,
      weightsUsed: { weight30: weights.weight30, weight90: weights.weight90 },
      trend,
      daysRemaining,
      effectiveLeadTimeDays,
      approvedSafetyStock,
      targetCoverDays,
      leadTimeDemand,
      proposedOrderPoint,
      targetCover,
      availableCoverage,
      requirement: round4(requirement),
      rawOrderQuantity,
      suggestedOrderQuantity: suggestedOrderQty,
      moq,
      packMultiple,
      unitCost,
      valueAtRisk,
      unitContext,
      contextUnits,
      queueRule,
      approvedOrderPoint: settings && settings.orderPoint != null ? settings.orderPoint : null,
      approvedSettingsVersion: settings ? settings.version : null,
      confidenceSignals: signals,
      thresholds: {
        writeOffDaysThreshold: policy.writeOffDaysThreshold,
        overstockCoverRatio: policy.overstockCoverRatio,
        orderLessTolerance: policy.orderLessTolerance,
        minOrderPointExcess: policy.minOrderPointExcess,
        confidenceThreshold: policy.confidenceThreshold,
        minTrendUnits: policy.minTrendUnits
      },
      provenance: input.provenance || null
    },
    proposedSettings: {
      ...proposedSettings,
      suggestedOrderQuantity: suggestedOrderQty,
      rationale,
      recommendedActions
    },
    calculationVersion: policy.calculationVersion,
    policyVersion: policy.policyVersion
  };

  return result;
}

module.exports = {
  DEFAULT_POLICY,
  SETTINGS_QUEUES,
  TASK_BY_QUEUE,
  normaliseWeights,
  roundUpOrderQuantity,
  calculateTrend,
  calculateItemReplenishment
};
