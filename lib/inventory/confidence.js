/**
 * Inventory confidence evaluation for OptiLens Local.
 *
 * Deterministically evaluates data quality, freshness, and completeness signals.
 * Items with low confidence trigger shelf-check or data-review tasks rather
 * than auto-approvable order recommendations.
 */

const CONFIDENCE_THRESHOLDS = Object.freeze({
  highScoreMin: 75,
  mediumScoreMin: 50,
  staleCountDays: 180,
  stalePoDays: 60,
  minSufficientUsageUnits: 5
});

/**
 * Evaluates confidence for an item based on read-only evidence.
 *
 * @param {Object} params
 * @param {number} params.onHand
 * @param {number} [params.stockFreshnessDays] - Days since last physical count or cycle count
 * @param {string|Date} [params.lastVerifiedCountDate]
 * @param {number} params.usage30
 * @param {number} params.usage90
 * @param {number} [params.openPoQuantity=0]
 * @param {boolean} [params.poComplete=true]
 * @param {number} [params.poFreshnessDays=0]
 * @param {string} [params.supplierId]
 * @param {string} [params.supplierMappingQuality='CONFIRMED'] - 'CONFIRMED' | 'UNMAPPED' | 'CONFLICTING'
 * @param {Object} [params.settings] - Existing approved replenishment settings (camelCase)
 * @param {Object} [options]
 * @param {number} [options.confidenceThreshold] - scores below this are LOW (policy value)
 */
function evaluateConfidence(params, options = {}) {
  let score = 100;
  const signals = [];
  const missingSettingsFlags = [];

  const onHand = Number.isFinite(params.onHand) ? params.onHand : 0;
  const usage90 = Number.isFinite(params.usage90) ? params.usage90 : 0;
  const openPoQuantity = Math.max(0, Number.isFinite(params.openPoQuantity) ? params.openPoQuantity : 0);

  // 1. Stock freshness: how long ago a person last verified the shelf.
  const stockFreshnessDays = Number.isFinite(params.stockFreshnessDays) ? params.stockFreshnessDays : null;
  const countIsFresh = stockFreshnessDays !== null && stockFreshnessDays <= CONFIDENCE_THRESHOLDS.staleCountDays;

  // 2. Negative stock. A negative balance is always a data defect. If someone has
  // already counted the shelf recently, the shelf is known and the fault is in the
  // source record, which this app is not allowed to change.
  if (onHand < 0) {
    if (countIsFresh) {
      score -= 15;
      signals.push({
        code: "SOURCE_NEGATIVE_AFTER_COUNT",
        severity: "WARNING",
        message: `Source on-hand is still negative (${onHand}) although the shelf was counted ${stockFreshnessDays === 0 ? "today" : `${stockFreshnessDays} day(s) ago`}. Correct the stock record in Innovations.`
      });
    } else {
      score -= 40;
      signals.push({
        code: "NEGATIVE_STOCK",
        severity: "CRITICAL",
        message: `Negative on-hand balance (${onHand} units). Physical shelf count required.`
      });
    }
  }

  if (stockFreshnessDays === null) {
    score -= 5;
    signals.push({
      code: "UNVERIFIED_STOCK",
      severity: "INFO",
      message: "No physical count is recorded for this item in this app; the on-hand figure is unverified."
    });
  } else if (stockFreshnessDays > CONFIDENCE_THRESHOLDS.staleCountDays) {
    score -= 15;
    signals.push({
      code: "STALE_STOCK_COUNT",
      severity: "WARNING",
      message: `Last verified count was ${stockFreshnessDays} days ago (exceeds ${CONFIDENCE_THRESHOLDS.staleCountDays} day threshold).`
    });
  }

  // 3. Usage data sufficiency
  let usageSufficiency = "SUFFICIENT";
  if (usage90 === 0) {
    usageSufficiency = "INSUFFICIENT";
    score -= 15;
    signals.push({
      code: "INSUFFICIENT_USAGE",
      severity: "WARNING",
      message: "No movement recorded in the 90-day window."
    });
  } else if (usage90 < CONFIDENCE_THRESHOLDS.minSufficientUsageUnits) {
    usageSufficiency = "MARGINAL";
    score -= 10;
    signals.push({
      code: "MARGINAL_USAGE",
      severity: "INFO",
      message: `Low volume in 90-day window (${usage90} units).`
    });
  }

  // 4. Supplier mapping quality
  const mappingQuality = params.supplierMappingQuality || (params.supplierId ? "CONFIRMED" : "UNMAPPED");
  if (mappingQuality === "UNMAPPED") {
    score -= 25;
    signals.push({
      code: "UNMAPPED_SUPPLIER",
      severity: "CRITICAL",
      message: "Item has no confirmed supplier mapping."
    });
  } else if (mappingQuality === "CONFLICTING") {
    score -= 30;
    signals.push({
      code: "CONFLICTING_SUPPLIER_MAPPING",
      severity: "CRITICAL",
      message: "Conflicting supplier mappings detected across systems."
    });
  }

  // 5. Open PO integrity
  const poComplete = params.poComplete !== false;
  const poFreshnessDays = Number.isFinite(params.poFreshnessDays) ? params.poFreshnessDays : null;
  if (openPoQuantity > 0) {
    if (params.poComplete === null || params.poComplete === undefined) {
      signals.push({
        code: "PO_SOURCE_AGGREGATE",
        severity: "INFO",
        message: "Open PO quantity is the item-level on-order balance in Innovations; individual PO lines were not checked for receipt or cancellation."
      });
    }
    if (!poComplete) {
      score -= 15;
      signals.push({
        code: "INCOMPLETE_PO_STATE",
        severity: "WARNING",
        message: "Open PO contains missing line details or unconfirmed receipt dates."
      });
    }
    if (poFreshnessDays !== null && poFreshnessDays > CONFIDENCE_THRESHOLDS.stalePoDays) {
      score -= 15;
      signals.push({
        code: "STALE_OPEN_PO",
        severity: "WARNING",
        message: `Open PO is ${poFreshnessDays} days old without receipt.`
      });
    }
  }

  // 6. Existing approved settings check
  const settings = params.settings;
  if (!settings) {
    missingSettingsFlags.push("NO_APPROVED_SETTINGS");
    score -= 15;
    signals.push({
      code: "MISSING_SETTINGS",
      severity: "INFO",
      message: "Item is operating on system defaults without approved item-specific settings."
    });
  } else {
    if (settings.minOrderQty == null || settings.minOrderQty <= 0) {
      missingSettingsFlags.push("MISSING_MOQ");
    }
    if (settings.packMultiple == null || settings.packMultiple <= 0) {
      missingSettingsFlags.push("MISSING_PACK_MULTIPLE");
    }
    if (settings.leadTimeDays == null || settings.leadTimeDays <= 0) {
      missingSettingsFlags.push("MISSING_LEAD_TIME");
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // Below the approved policy threshold the level is LOW and ordering is withheld.
  const lowBelow = Number.isFinite(options.confidenceThreshold) ? options.confidenceThreshold : CONFIDENCE_THRESHOLDS.mediumScoreMin;
  let confidenceLevel;
  if (score < lowBelow) {
    confidenceLevel = "LOW";
  } else if (score >= CONFIDENCE_THRESHOLDS.highScoreMin) {
    confidenceLevel = "HIGH";
  } else {
    confidenceLevel = "MEDIUM";
  }

  return {
    confidenceScore: score,
    confidenceLevel,
    stockFreshnessDays,
    lastVerifiedCountDate: params.lastVerifiedCountDate || null,
    usageSufficiency,
    coverageWindowDays: 90,
    confidenceThreshold: lowBelow,
    poCompletenessFlag: poComplete,
    poFreshnessDays,
    supplierMappingQuality: mappingQuality,
    missingSettingsFlags,
    signals,
    calculatedAt: new Date().toISOString()
  };
}

module.exports = {
  CONFIDENCE_THRESHOLDS,
  evaluateConfidence
};
