/**
 * Configured calculation policy for Inventory Intelligence.
 *
 * Weights, cover days, lead-time and safety-stock defaults and the review
 * thresholds are rows in core.app_settings (seeded by migration 053), not
 * constants buried in code. The effective values are hashed into a policy
 * version that is stored on every recommendation, so any result can be traced
 * to the exact thresholds that produced it.
 */

const { createHash } = require("node:crypto");
const sql = require("mssql");
const store = require("./store");
const { DEFAULT_POLICY, normaliseWeights } = require("./calculator");

const SETTING_KEYS = Object.freeze({
  inventory_weight_30: { field: "weight30", min: 0 },
  inventory_weight_90: { field: "weight90", min: 0 },
  inventory_target_cover_days: { field: "targetCoverDays", min: 1 },
  inventory_default_lead_time_days: { field: "defaultLeadTimeDays", min: 1 },
  inventory_default_safety_stock: { field: "defaultSafetyStock", min: 0 },
  inventory_write_off_days: { field: "writeOffDaysThreshold", min: 1 },
  inventory_overstock_cover_ratio: { field: "overstockCoverRatio", min: 1 },
  inventory_order_less_tolerance: { field: "orderLessTolerance", min: 0 },
  inventory_confidence_threshold: { field: "confidenceThreshold", min: 0, max: 100 }
});

function versionFor(values) {
  const material = Object.keys(values).sort().map((k) => `${k}=${values[k]}`).join("|");
  return `pol-${createHash("sha1").update(material).digest("hex").slice(0, 10)}`;
}

/**
 * Builds the effective policy from raw `{ key: value }` settings. Invalid values
 * are ignored (the default applies) and listed in `invalidKeys`.
 */
function buildPolicy(rawSettings = {}, overrides = {}) {
  const policy = { ...DEFAULT_POLICY };
  const invalidKeys = [];

  for (const [key, spec] of Object.entries(SETTING_KEYS)) {
    const raw = rawSettings[key];
    if (raw == null || raw === "") continue;
    const value = Number(raw);
    const outOfRange = !Number.isFinite(value) || value < spec.min || (spec.max != null && value > spec.max);
    if (outOfRange) {
      invalidKeys.push(key);
      continue;
    }
    policy[spec.field] = value;
  }

  Object.assign(policy, overrides);

  const weights = normaliseWeights(policy.weight30, policy.weight90);
  policy.weight30 = weights.weight30;
  policy.weight90 = weights.weight90;

  const material = {};
  for (const spec of Object.values(SETTING_KEYS)) material[spec.field] = policy[spec.field];
  policy.policyVersion = `${DEFAULT_POLICY.policyVersion}+${versionFor(material)}`;
  policy.invalidKeys = invalidKeys;
  return policy;
}

async function loadPolicy(overrides = {}) {
  if (store.isTestMode()) return buildPolicy({}, overrides);

  const req = await store.request();
  const result = await req.query(`
    SELECT setting_key AS settingKey, setting_value AS settingValue
    FROM core.app_settings
    WHERE setting_key LIKE N'inventory[_]%';
  `);
  const raw = {};
  for (const row of result.recordset) raw[row.settingKey] = row.settingValue;
  return buildPolicy(raw, overrides);
}

module.exports = {
  SETTING_KEYS,
  buildPolicy,
  loadPolicy
};
