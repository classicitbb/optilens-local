/**
 * Approved Item Replenishment Settings.
 *
 * The app-owned source of replenishment truth that draft POs read. It keeps
 * the legacy/source item identity (the six-part lens key in item_id) but this
 * module NEVER writes to LensItem or any source system - it has no source
 * connection at all.
 *
 * Only an approved recommendation/task may call writeApprovedSetting(), and it
 * does so inside the caller's transaction so the decision, the settings
 * revision, the task transition and the audit record commit together or not at all.
 */

const { randomUUID } = require("node:crypto");
const sql = require("mssql");
const store = require("./store");
const { recordInventoryAudit } = require("./audit-service");
const { badRequest, conflict } = require("./errors");

const SETTING_COLUMNS = `
  setting_id AS settingId,
  item_id AS itemId,
  item_kind AS itemKind,
  sku,
  item_label AS itemLabel,
  supplier_id AS supplierId,
  supplier_name AS supplierName,
  is_active AS isActive,
  order_point AS orderPoint,
  safety_stock AS safetyStock,
  target_cover_days AS targetCoverDays,
  lead_time_days AS leadTimeDays,
  lead_time_override_reason AS leadTimeOverrideReason,
  reorder_quantity AS reorderQuantity,
  min_order_qty AS minOrderQty,
  pack_multiple AS packMultiple,
  supplier_preference AS supplierPreference,
  substitution_policy AS substitutionPolicy,
  approved_recommendation_id AS approvedRecommendationId,
  approved_task_id AS approvedTaskId,
  approved_by AS approvedBy,
  approved_at AS approvedAt,
  version,
  effective_from AS effectiveFrom,
  effective_to AS effectiveTo,
  created_at AS createdAt`;

function mapSettingRow(row) {
  if (!row) return null;
  return {
    ...row,
    isActive: Boolean(row.isActive),
    approvedAt: store.toIso(row.approvedAt),
    effectiveFrom: store.toIso(row.effectiveFrom),
    effectiveTo: store.toIso(row.effectiveTo),
    createdAt: store.toIso(row.createdAt)
  };
}

function toInteger(value, label, { min = 0, max = 1000000 } = {}) {
  const number = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(number) || !Number.isInteger(number)) {
    throw badRequest(`${label} must be a whole number.`);
  }
  if (number < min || number > max) {
    throw badRequest(`${label} must be between ${min} and ${max}.`);
  }
  return number;
}

/** Validates and normalises the numeric fields of a settings revision. */
function validateSettingValues(values) {
  return {
    orderPoint: toInteger(values.orderPoint, "Order point"),
    safetyStock: toInteger(values.safetyStock == null ? 0 : values.safetyStock, "Safety stock"),
    targetCoverDays: toInteger(values.targetCoverDays == null ? 30 : values.targetCoverDays, "Target cover days", { min: 1, max: 730 }),
    leadTimeDays: toInteger(values.leadTimeDays == null ? 14 : values.leadTimeDays, "Lead time (days)", { min: 1, max: 730 }),
    reorderQuantity: toInteger(values.reorderQuantity, "Reorder quantity"),
    minOrderQty: toInteger(values.minOrderQty == null ? 1 : values.minOrderQty, "MOQ", { min: 1 }),
    packMultiple: toInteger(values.packMultiple == null ? 1 : values.packMultiple, "Pack multiple", { min: 1 })
  };
}

async function getActiveSetting(itemId, { tx = null, lock = false } = {}) {
  if (store.isTestMode()) {
    const found = store.mem.settings.find((s) => s.itemId === itemId && !s.effectiveTo);
    return found ? { ...found } : null;
  }
  const req = await store.request(tx);
  const result = await req
    .input("item_id", sql.NVarChar(100), itemId)
    .query(`
      SELECT TOP 1 ${SETTING_COLUMNS}
      FROM inventory.item_replenishment_settings ${lock ? "WITH (UPDLOCK, HOLDLOCK)" : ""}
      WHERE item_id = @item_id AND effective_to IS NULL;
    `);
  return mapSettingRow(result.recordset[0]);
}

/** All active, effective settings keyed by item_id. */
async function listActiveSettings() {
  if (store.isTestMode()) {
    const map = new Map();
    for (const s of store.mem.settings) {
      if (!s.effectiveTo) map.set(s.itemId, { ...s });
    }
    return map;
  }
  const req = await store.request();
  const result = await req.query(`
    SELECT ${SETTING_COLUMNS}
    FROM inventory.item_replenishment_settings
    WHERE effective_to IS NULL;
  `);
  const map = new Map();
  for (const row of result.recordset) map.set(row.itemId, mapSettingRow(row));
  return map;
}

/**
 * Applies an approved recommendation revision as a new ItemReplenishmentSettings
 * version. Call inside store.withTransaction() and pass `tx`.
 *
 * - Idempotent: a repeat for the same recommendation returns the existing row.
 * - Optimistic: when `expectedVersion` is given (null = "no settings yet") and
 *   the active version differs, the write is refused as stale.
 * - Never updates a previous revision except to close its effective period.
 */
async function writeApprovedSetting({
  itemId,
  itemKind = "lens",
  sku = null,
  itemLabel = null,
  supplierId = null,
  supplierName = null,
  orderPoint,
  safetyStock = 0,
  targetCoverDays = 30,
  leadTimeDays = 14,
  leadTimeOverrideReason = null,
  reorderQuantity,
  minOrderQty = 1,
  packMultiple = 1,
  supplierPreference = null,
  substitutionPolicy = null,
  recommendationId,
  taskId = null,
  approvedBy,
  decisionReason = null,
  expectedVersion,
  tx = null
}) {
  if (!itemId) throw badRequest("An item is required to write replenishment settings.");
  if (!recommendationId) throw badRequest("Settings can only be written from an approved recommendation.");
  if (!approvedBy) throw badRequest("An approver is required to write replenishment settings.");

  const values = validateSettingValues({ orderPoint, safetyStock, targetCoverDays, leadTimeDays, reorderQuantity, minOrderQty, packMultiple });
  const current = await getActiveSetting(itemId, { tx, lock: true });

  if (current && current.approvedRecommendationId === recommendationId) {
    return { setting: current, isDuplicate: true };
  }

  if (expectedVersion !== undefined) {
    const activeVersion = current ? current.version : null;
    if (activeVersion !== expectedVersion) {
      throw conflict("The approved settings for this item changed after this recommendation was created. Refresh and review it again.", "STALE_SETTINGS");
    }
  }

  const nextVersion = current ? current.version + 1 : 1;
  const settingId = randomUUID();
  const nowDate = new Date();
  const now = nowDate.toISOString();

  const record = {
    settingId,
    itemId,
    itemKind,
    sku,
    itemLabel,
    supplierId,
    supplierName,
    isActive: true,
    ...values,
    leadTimeOverrideReason: store.clip(leadTimeOverrideReason, 500),
    supplierPreference,
    substitutionPolicy,
    approvedRecommendationId: recommendationId,
    approvedTaskId: taskId,
    approvedBy: store.clip(approvedBy, 120),
    approvedAt: now,
    version: nextVersion,
    effectiveFrom: now,
    effectiveTo: null,
    createdAt: now
  };

  if (store.isTestMode()) {
    if (current) {
      const live = store.mem.settings.find((s) => s.settingId === current.settingId);
      live.effectiveTo = now;
    }
    store.mem.settings.push(record);
  } else {
    if (current) {
      const retire = await store.request(tx);
      await retire
        .input("setting_id", sql.UniqueIdentifier, current.settingId)
        .input("effective_to", sql.DateTime2, nowDate)
        .query(`
          UPDATE inventory.item_replenishment_settings
          SET effective_to = @effective_to
          WHERE setting_id = @setting_id AND effective_to IS NULL;
        `);
    }

    const insert = await store.request(tx);
    await insert
      .input("setting_id", sql.UniqueIdentifier, settingId)
      .input("item_id", sql.NVarChar(100), itemId)
      .input("item_kind", sql.NVarChar(20), itemKind)
      .input("sku", sql.NVarChar(100), sku)
      .input("item_label", sql.NVarChar(400), store.clip(itemLabel, 400))
      .input("supplier_id", sql.NVarChar(100), supplierId)
      .input("supplier_name", sql.NVarChar(200), store.clip(supplierName, 200))
      .input("order_point", sql.Int, values.orderPoint)
      .input("safety_stock", sql.Int, values.safetyStock)
      .input("target_cover_days", sql.Int, values.targetCoverDays)
      .input("lead_time_days", sql.Int, values.leadTimeDays)
      .input("lead_time_override_reason", sql.NVarChar(500), record.leadTimeOverrideReason)
      .input("reorder_quantity", sql.Int, values.reorderQuantity)
      .input("min_order_qty", sql.Int, values.minOrderQty)
      .input("pack_multiple", sql.Int, values.packMultiple)
      .input("supplier_preference", sql.NVarChar(100), supplierPreference)
      .input("substitution_policy", sql.NVarChar(200), substitutionPolicy)
      .input("approved_recommendation_id", sql.UniqueIdentifier, recommendationId)
      .input("approved_task_id", sql.UniqueIdentifier, taskId)
      .input("approved_by", sql.NVarChar(120), record.approvedBy)
      .input("approved_at", sql.DateTime2, nowDate)
      .input("version", sql.Int, nextVersion)
      .input("effective_from", sql.DateTime2, nowDate)
      .query(`
        INSERT INTO inventory.item_replenishment_settings (
          setting_id, item_id, item_kind, sku, item_label,
          supplier_id, supplier_name, is_active,
          order_point, safety_stock, target_cover_days,
          lead_time_days, lead_time_override_reason,
          reorder_quantity, min_order_qty, pack_multiple,
          supplier_preference, substitution_policy,
          approved_recommendation_id, approved_task_id,
          approved_by, approved_at, version, effective_from
        ) VALUES (
          @setting_id, @item_id, @item_kind, @sku, @item_label,
          @supplier_id, @supplier_name, 1,
          @order_point, @safety_stock, @target_cover_days,
          @lead_time_days, @lead_time_override_reason,
          @reorder_quantity, @min_order_qty, @pack_multiple,
          @supplier_preference, @substitution_policy,
          @approved_recommendation_id, @approved_task_id,
          @approved_by, @approved_at, @version, @effective_from
        );
      `);
  }

  await recordInventoryAudit({
    recommendationId,
    taskId,
    settingId,
    actor: approvedBy,
    action: "SETTINGS_WRITTEN",
    entityType: "ItemReplenishmentSettings",
    entityId: itemId,
    beforeState: current,
    afterState: record,
    reason: decisionReason || "Approved replenishment settings revision written to the app database.",
    tx
  });

  return { setting: record, isDuplicate: false };
}

/** Revision history for one item, newest first. */
async function getSettingHistory(itemId) {
  if (store.isTestMode()) {
    return store.mem.settings.filter((s) => s.itemId === itemId).map((s) => ({ ...s })).sort((a, b) => b.version - a.version);
  }
  const req = await store.request();
  const result = await req
    .input("item_id", sql.NVarChar(100), itemId)
    .query(`
      SELECT ${SETTING_COLUMNS}
      FROM inventory.item_replenishment_settings
      WHERE item_id = @item_id
      ORDER BY version DESC;
    `);
  return result.recordset.map(mapSettingRow);
}

function clearFallbackSettings() {
  store.mem.settings.length = 0;
}

module.exports = {
  validateSettingValues,
  getActiveSetting,
  listActiveSettings,
  writeApprovedSetting,
  getSettingHistory,
  clearFallbackSettings
};
