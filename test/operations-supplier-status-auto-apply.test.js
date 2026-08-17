const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  eligibilityFromContext,
  shouldAutoApplySupplierStatus,
  tryAutoApplyHighConfidenceSupplierStatus
} = require("../lib/operations/supplier-status-auto-apply");

const ALLOWLIST = [190, 196, 210, 212];

function highConfidenceEligibility(overrides = {}) {
  return {
    autoApplyEnabled: true,
    writeBackEnabled: true,
    ruleEnabled: true,
    mappingState: "CONFIRMED",
    targetStatusItemId: 190,
    allowlistedStatusIds: ALLOWLIST,
    matchResult: "Matched",
    matches: [{ internal_order_id: 42, current_status_id: 12 }],
    ...overrides
  };
}

function waitingActionState(overrides = {}) {
  return {
    status: "WAITING_APPROVAL",
    target_type: "innovations-order",
    target_reference: "42",
    proposed: {
      targetStatusItemId: 190,
      expectedCurrentStatusId: 12,
      recordId: "record-1"
    },
    ...overrides
  };
}

test("happy path auto-applies one confirmed, allowlisted, uniquely matched order", async () => {
  const calls = [];
  const persisted = [];
  const result = await tryAutoApplyHighConfidenceSupplierStatus({
    action: { action_id: "action-1" },
    eligibility: highConfidenceEligibility(),
    actionState: waitingActionState(),
    writable: true,
    applyUpdate: async (payload) => {
      calls.push(payload);
      return { orderId: 42, targetStatusId: 190, verifiedStatusId: 190, alreadyApplied: false };
    },
    persistApplied: async (payload) => { persisted.push(payload); }
  });
  assert.equal(result.applied, true);
  assert.equal(result.reason, "high_confidence");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { orderId: "42", targetStatusId: 190, expectedCurrentStatusId: 12 });
  assert.equal(persisted.length, 1);
  assert.equal(result.result.verifiedStatusId, 190);
});

test("skip when mapping is still pending confirmation", async () => {
  const calls = [];
  const result = await tryAutoApplyHighConfidenceSupplierStatus({
    action: { action_id: "action-1" },
    eligibility: highConfidenceEligibility({ mappingState: "PENDING_CONFIRMATION", targetStatusItemId: null }),
    actionState: waitingActionState(),
    applyUpdate: async (payload) => { calls.push(payload); return payload; }
  });
  assert.deepEqual(result, { applied: false, reason: "mapping_pending" });
  assert.equal(calls.length, 0);
  assert.equal(shouldAutoApplySupplierStatus(highConfidenceEligibility({ mappingState: "PENDING_CONFIRMATION" })).reason, "mapping_pending");
});

test("skip when there is no match or a duplicate active match", async () => {
  const calls = [];
  const applyUpdate = async (payload) => { calls.push(payload); return payload; };
  const missing = await tryAutoApplyHighConfidenceSupplierStatus({
    action: { action_id: "action-1" },
    eligibility: highConfidenceEligibility({ matchResult: "Not Found", matches: [] }),
    actionState: waitingActionState(),
    applyUpdate
  });
  const duplicate = await tryAutoApplyHighConfidenceSupplierStatus({
    action: { action_id: "action-2" },
    eligibility: highConfidenceEligibility({
      matchResult: "Duplicate Active Match",
      matches: [{ internal_order_id: 1 }, { internal_order_id: 2 }]
    }),
    actionState: waitingActionState(),
    applyUpdate
  });
  assert.equal(missing.reason, "no_match");
  assert.equal(duplicate.reason, "duplicate");
  assert.equal(missing.applied, false);
  assert.equal(duplicate.applied, false);
  assert.equal(calls.length, 0);
});

test("skip when auto-apply flag is off", async () => {
  const calls = [];
  const result = await tryAutoApplyHighConfidenceSupplierStatus({
    action: { action_id: "action-1" },
    eligibility: highConfidenceEligibility({ autoApplyEnabled: false }),
    actionState: waitingActionState(),
    applyUpdate: async (payload) => { calls.push(payload); return payload; }
  });
  assert.deepEqual(result, { applied: false, reason: "auto_apply_disabled" });
  assert.equal(calls.length, 0);
  assert.equal(shouldAutoApplySupplierStatus({}).apply, false);
});

test("skip when write-back flag is off", async () => {
  const calls = [];
  const result = await tryAutoApplyHighConfidenceSupplierStatus({
    action: { action_id: "action-1" },
    eligibility: highConfidenceEligibility({ writeBackEnabled: false }),
    actionState: waitingActionState(),
    applyUpdate: async (payload) => { calls.push(payload); return payload; }
  });
  assert.deepEqual(result, { applied: false, reason: "writeback_disabled" });
  assert.equal(calls.length, 0);
});

test("skip when target CurrentStatusID is not allowlisted", async () => {
  const calls = [];
  const result = await tryAutoApplyHighConfidenceSupplierStatus({
    action: { action_id: "action-1" },
    eligibility: highConfidenceEligibility({ targetStatusItemId: 999 }),
    actionState: waitingActionState({ proposed: { targetStatusItemId: 999, expectedCurrentStatusId: 12 } }),
    applyUpdate: async (payload) => { calls.push(payload); return payload; }
  });
  assert.deepEqual(result, { applied: false, reason: "target_not_allowlisted" });
  assert.equal(calls.length, 0);
});

test("idempotent re-run does not double-write after the action is already applied", async () => {
  const calls = [];
  const persisted = [];
  const applyUpdate = async (payload) => {
    calls.push(payload);
    return { orderId: 42, targetStatusId: 190, verifiedStatusId: 190, alreadyApplied: calls.length > 1 };
  };
  const persistApplied = async (payload) => { persisted.push(payload); };
  const first = await tryAutoApplyHighConfidenceSupplierStatus({
    action: { action_id: "action-1" },
    eligibility: highConfidenceEligibility(),
    actionState: waitingActionState(),
    applyUpdate,
    persistApplied
  });
  const second = await tryAutoApplyHighConfidenceSupplierStatus({
    action: { action_id: "action-1" },
    eligibility: highConfidenceEligibility(),
    actionState: waitingActionState({ status: "APPLIED" }),
    applyUpdate,
    persistApplied
  });
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(second.reason, "already_applied");
  assert.equal(second.duplicate, true);
  assert.equal(calls.length, 1);
  assert.equal(persisted.length, 1);
});

test("write-back helper failures leave the row unapplied so a person can still approve", async () => {
  const persisted = [];
  const result = await tryAutoApplyHighConfidenceSupplierStatus({
    action: { action_id: "action-1" },
    eligibility: highConfidenceEligibility(),
    actionState: waitingActionState(),
    applyUpdate: async () => {
      throw Object.assign(new Error("Source status write-back is disabled."), { code: "writeback_disabled" });
    },
    persistApplied: async (payload) => { persisted.push(payload); }
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "writeback_failed");
  assert.equal(persisted.length, 0);
});

test("eligibilityFromContext reads the dedicated auto-apply flag and confirmed mapping", () => {
  const eligibility = eligibilityFromContext({
    rule: { is_enabled: 1 },
    mapping: { mapping_state: "CONFIRMED", target_status_item_id: 196 },
    sourceResult: { matchResult: "Matched", matches: [{ internal_order_id: 9 }] },
    config: { supplierStatusAutoApply: true, writeBackEnabled: true, writeBackStatusIds: ALLOWLIST }
  });
  assert.equal(shouldAutoApplySupplierStatus(eligibility).apply, true);
  assert.equal(eligibility.targetStatusItemId, 196);
});

test("config defaults OPTILENS_SUPPLIER_STATUS_AUTO_APPLY to false", () => {
  const prior = process.env.OPTILENS_SUPPLIER_STATUS_AUTO_APPLY;
  delete process.env.OPTILENS_SUPPLIER_STATUS_AUTO_APPLY;
  try {
    const { getConfig } = require("../lib/config");
    assert.equal(getConfig().supplierStatusAutoApply, false);
  } finally {
    if (prior === undefined) delete process.env.OPTILENS_SUPPLIER_STATUS_AUTO_APPLY;
    else process.env.OPTILENS_SUPPLIER_STATUS_AUTO_APPLY = prior;
  }
});

test("mailbox ingest and mapping confirmation auto-apply through applyCurrentStatusUpdate", () => {
  const service = fs.readFileSync(path.join(__dirname, "..", "lib", "operations", "service.js"), "utf8");
  assert.match(service, /tryAutoApplyHighConfidenceSupplierStatus/);
  assert.match(service, /autoApplyCreatedSupplierAction/);
  assert.match(service, /applyCurrentStatusUpdate/);
  assert.doesNotMatch(service, /UPDATE dbo\.Orders/);
});
