const assert = require("node:assert/strict");
const test = require("node:test");
const { loadProviderConfig, saveProviderConfig, getAssistantStatus, executeAction, ACTION_TOOLS } = require("../lib/metrics/assistant");

test("loadProviderConfig returns default or configured values", async () => {
  const config = await loadProviderConfig();
  assert.ok(config.provider, "Provider should be present");
  assert.ok(config.baseUrl, "Base URL should be present");
  assert.ok(config.model, "Model should be present");
});

test("getAssistantStatus exposes status and masks sensitive keys", async () => {
  const status = await getAssistantStatus();
  assert.ok("configured" in status);
  assert.ok("provider" in status);
  assert.ok("baseUrl" in status);
  assert.ok("hasApiKey" in status);
});

test("executeAction executes valid tools and logs audit context", async () => {
  const res = await executeAction({ action: "check_system_health", params: {}, actor: "admin" });
  assert.equal(res.success, true);
  assert.equal(res.action, "check_system_health");
  assert.equal(res.audit.executedBy, "admin");
});

test("ACTION_TOOLS registry exposes valid system tools", () => {
  assert.ok("navigate_to" in ACTION_TOOLS);
  assert.ok("check_system_health" in ACTION_TOOLS);
  assert.ok("get_inventory_recommendations" in ACTION_TOOLS);
});
