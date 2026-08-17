const AUTO_APPLY_NOTE = "Auto-applied high-confidence supplier status match.";

function flagEnabled(value) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function shouldAutoApplySupplierStatus({
  autoApplyEnabled,
  writeBackEnabled,
  ruleEnabled,
  mappingState,
  targetStatusItemId,
  allowlistedStatusIds,
  matchResult,
  matches
} = {}) {
  if (!flagEnabled(autoApplyEnabled)) return { apply: false, reason: "auto_apply_disabled" };
  if (!flagEnabled(writeBackEnabled)) return { apply: false, reason: "writeback_disabled" };
  if (!flagEnabled(ruleEnabled)) return { apply: false, reason: "rule_disabled" };
  if (String(mappingState || "").toUpperCase() !== "CONFIRMED") return { apply: false, reason: "mapping_pending" };
  const target = positiveInteger(targetStatusItemId);
  if (!target) return { apply: false, reason: "mapping_pending" };
  const allowlist = Array.isArray(allowlistedStatusIds) ? allowlistedStatusIds.map(Number) : [];
  if (!allowlist.includes(target)) return { apply: false, reason: "target_not_allowlisted" };

  const list = Array.isArray(matches) ? matches : [];
  const result = String(matchResult || "");
  if (result === "Not Found" || list.length === 0) return { apply: false, reason: "no_match" };
  if (result === "Inactive Order") return { apply: false, reason: "inactive" };
  if (result === "Duplicate Active Match" || list.length > 1) return { apply: false, reason: "duplicate" };
  if (result !== "Matched" || list.length !== 1) return { apply: false, reason: "no_match" };
  return { apply: true, reason: "high_confidence" };
}

function eligibilityFromContext({ rule, mapping, sourceResult, config } = {}) {
  return {
    autoApplyEnabled: Boolean(config?.supplierStatusAutoApply),
    writeBackEnabled: Boolean(config?.writeBackEnabled),
    ruleEnabled: flagEnabled(rule?.is_enabled),
    mappingState: mapping?.mapping_state,
    targetStatusItemId: mapping?.target_status_item_id,
    allowlistedStatusIds: config?.writeBackStatusIds || [],
    matchResult: sourceResult?.matchResult,
    matches: Array.isArray(sourceResult?.matches) ? sourceResult.matches : []
  };
}

async function tryAutoApplyHighConfidenceSupplierStatus({
  action,
  eligibility,
  actionState,
  writable = true,
  applyUpdate,
  persistApplied
} = {}) {
  const decision = shouldAutoApplySupplierStatus(eligibility);
  if (!decision.apply) return { applied: false, reason: decision.reason };
  if (!action?.action_id) return { applied: false, reason: "no_action" };
  if (actionState?.status === "APPLIED") return { applied: false, reason: "already_applied", duplicate: true };
  if (actionState && actionState.status !== "WAITING_APPROVAL") return { applied: false, reason: "not_waiting" };
  if (actionState?.target_type && actionState.target_type !== "innovations-order") {
    return { applied: false, reason: "not_source_order" };
  }
  if (writable === false) return { applied: false, reason: "writeback_not_ready" };
  if (typeof applyUpdate !== "function") return { applied: false, reason: "writeback_unavailable" };

  const proposed = actionState?.proposed || {};
  try {
    const result = await applyUpdate({
      orderId: actionState?.target_reference,
      targetStatusId: proposed.targetStatusItemId ?? eligibility.targetStatusItemId,
      expectedCurrentStatusId: proposed.expectedCurrentStatusId ?? null
    });
    if (typeof persistApplied === "function") await persistApplied({ action, result });
    return { applied: true, reason: "high_confidence", result };
  } catch (error) {
    return { applied: false, reason: "writeback_failed", error: error.message };
  }
}

module.exports = {
  AUTO_APPLY_NOTE,
  eligibilityFromContext,
  shouldAutoApplySupplierStatus,
  tryAutoApplyHighConfidenceSupplierStatus
};
