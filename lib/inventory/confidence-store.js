/**
 * Persistence for InventoryConfidence: the current and historical data-reliability
 * signals per item. A new row is written only when the picture changed (score,
 * level or the set of signals), so the history records real changes, not scans.
 */

const { randomUUID, createHash } = require("node:crypto");
const sql = require("mssql");
const store = require("./store");

function signatureOf(confidence) {
  const codes = (confidence.signals || []).map((s) => s.code).sort().join(",");
  return createHash("sha1").update(`${confidence.confidenceScore}|${confidence.confidenceLevel}|${codes}`).digest("hex");
}

/** Signature of the current row for every item, to skip unchanged writes cheaply. */
async function loadCurrentSignatures() {
  const map = new Map();
  if (store.isTestMode()) {
    for (const row of store.mem.confidence) {
      if (row.isCurrent) map.set(row.itemId, row.signature);
    }
    return map;
  }
  const req = await store.request();
  const result = await req.query(`
    SELECT item_id AS itemId, confidence_score AS score, confidence_level AS level, reasons_json AS reasonsJson
    FROM inventory.confidence WHERE is_current = 1;
  `);
  for (const row of result.recordset) {
    const signals = store.parseJson(row.reasonsJson, {}).signals || [];
    map.set(row.itemId, signatureOf({ confidenceScore: Number(row.score), confidenceLevel: row.level, signals }));
  }
  return map;
}

/** Writes a new current confidence row if it differs from `knownSignatures`. Returns true when written. */
async function saveConfidence({ itemId, supplierId = null, confidence, knownSignatures = null, tx = null }) {
  const signature = signatureOf(confidence);
  if (knownSignatures && knownSignatures.get(itemId) === signature) return false;

  const calculatedAt = new Date(confidence.calculatedAt || Date.now());
  const lastCount = confidence.lastVerifiedCountDate ? String(confidence.lastVerifiedCountDate).slice(0, 10) : null;
  const reasons = { signals: confidence.signals || [], confidenceThreshold: confidence.confidenceThreshold };

  if (store.isTestMode()) {
    for (const row of store.mem.confidence) if (row.itemId === itemId) row.isCurrent = false;
    store.mem.confidence.push({
      confidenceId: randomUUID(), itemId, supplierId,
      confidenceScore: confidence.confidenceScore, confidenceLevel: confidence.confidenceLevel,
      stockFreshnessDays: confidence.stockFreshnessDays, lastVerifiedCountDate: lastCount,
      usageSufficiency: confidence.usageSufficiency, coverageWindowDays: confidence.coverageWindowDays,
      poCompletenessFlag: confidence.poCompletenessFlag, poFreshnessDays: confidence.poFreshnessDays,
      supplierMappingQuality: confidence.supplierMappingQuality,
      missingSettingsFlags: confidence.missingSettingsFlags, reasons,
      calculatedAt: calculatedAt.toISOString(), isCurrent: true, signature
    });
    if (knownSignatures) knownSignatures.set(itemId, signature);
    return true;
  }

  const retire = await store.request(tx);
  await retire.input("item_id", sql.NVarChar(100), itemId)
    .query("UPDATE inventory.confidence SET is_current = 0 WHERE item_id = @item_id AND is_current = 1;");

  const req = await store.request(tx);
  await req
    .input("confidence_id", sql.UniqueIdentifier, randomUUID())
    .input("item_id", sql.NVarChar(100), itemId)
    .input("supplier_id", sql.NVarChar(100), supplierId)
    .input("confidence_score", sql.Decimal(5, 2), confidence.confidenceScore)
    .input("confidence_level", sql.NVarChar(20), confidence.confidenceLevel)
    .input("stock_freshness_days", sql.Int, confidence.stockFreshnessDays)
    .input("last_verified_count_date", sql.VarChar(10), lastCount)
    .input("usage_sufficiency", sql.NVarChar(50), confidence.usageSufficiency)
    .input("coverage_window_days", sql.Int, confidence.coverageWindowDays)
    .input("po_completeness_flag", sql.Bit, confidence.poCompletenessFlag === null || confidence.poCompletenessFlag === undefined ? null : confidence.poCompletenessFlag ? 1 : 0)
    .input("po_freshness_days", sql.Int, confidence.poFreshnessDays)
    .input("supplier_mapping_quality", sql.NVarChar(50), confidence.supplierMappingQuality)
    .input("missing_settings_flags_json", sql.NVarChar(sql.MAX), JSON.stringify(confidence.missingSettingsFlags || []))
    .input("reasons_json", sql.NVarChar(sql.MAX), JSON.stringify(reasons))
    .input("calculated_at", sql.DateTime2, calculatedAt)
    .query(`
      INSERT INTO inventory.confidence (
        confidence_id, item_id, supplier_id, confidence_score, confidence_level,
        stock_freshness_days, last_verified_count_date, usage_sufficiency, coverage_window_days,
        po_completeness_flag, po_freshness_days, supplier_mapping_quality,
        missing_settings_flags_json, reasons_json, calculated_at, is_current
      ) VALUES (
        @confidence_id, @item_id, @supplier_id, @confidence_score, @confidence_level,
        @stock_freshness_days, @last_verified_count_date, @usage_sufficiency, @coverage_window_days,
        @po_completeness_flag, @po_freshness_days, @supplier_mapping_quality,
        @missing_settings_flags_json, @reasons_json, @calculated_at, 1
      );
    `);
  if (knownSignatures) knownSignatures.set(itemId, signature);
  return true;
}

/** Confidence history for one item, newest first. */
async function listConfidenceHistory(itemId, limit = 20) {
  const take = Math.max(1, Math.min(100, Number(limit) || 20));
  if (store.isTestMode()) {
    return store.mem.confidence.map((r, index) => ({ r, index })).filter(({ r }) => r.itemId === itemId)
      .sort((a, b) => (Number(b.r.isCurrent) - Number(a.r.isCurrent)) || String(b.r.calculatedAt).localeCompare(String(a.r.calculatedAt)) || (b.index - a.index))
      .slice(0, take).map(({ r }) => ({ ...r }));
  }
  const req = await store.request();
  const result = await req
    .input("item_id", sql.NVarChar(100), itemId).input("take", sql.Int, take)
    .query(`
      SELECT TOP (@take) confidence_score AS confidenceScore, confidence_level AS confidenceLevel,
             stock_freshness_days AS stockFreshnessDays, usage_sufficiency AS usageSufficiency,
             supplier_mapping_quality AS supplierMappingQuality, reasons_json AS reasonsJson,
             calculated_at AS calculatedAt, is_current AS isCurrent
      FROM inventory.confidence WHERE item_id = @item_id ORDER BY is_current DESC, calculated_at DESC;
    `);
  return result.recordset.map((r) => ({ ...r, reasons: store.parseJson(r.reasonsJson), calculatedAt: store.toIso(r.calculatedAt), isCurrent: Boolean(r.isCurrent) }));
}

function clearFallbackConfidence() {
  store.mem.confidence.length = 0;
}

module.exports = { signatureOf, loadCurrentSignatures, saveConfidence, listConfidenceHistory, clearFallbackConfidence };
