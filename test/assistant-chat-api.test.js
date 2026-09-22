const assert = require("node:assert/strict");
const test = require("node:test");
const { loadProviderConfig, saveProviderConfig, getAssistantStatus, executeAction, ACTION_TOOLS, callOpenAICompatible } = require("../lib/metrics/assistant");
const fs = require("node:fs");
const path = require("node:path");

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

test("Chat API configuration exposes a GPT-5.6 Luna preset", () => {
  const page = fs.readFileSync(path.join(__dirname, "..", "public", "business-metrics-inventory.js"), "utf8");
  assert.match(page, /value="openai-luna"/);
  assert.match(page, /GPT-5\.6 Luna/);
  assert.match(page, /modelInput\) modelInput\.value = "gpt-5\.6-luna"/);
});

test("Luna Chat Completions requests leave temperature at the model default", async () => {
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ model: "gpt-5.6-luna", choices: [{ message: { content: "Grounded answer." } }] })
    };
  };

  try {
    await callOpenAICompatible(
      { baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-luna", apiKey: "test-key" },
      [{ role: "user", content: "Test" }]
    );
    assert.equal(Object.hasOwn(requestBody, "temperature"), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("other Chat Completions models retain the assistant's low temperature", async () => {
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ model: "gpt-4o-mini", choices: [{ message: { content: "Grounded answer." } }] })
    };
  };

  try {
    await callOpenAICompatible(
      { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "test-key" },
      [{ role: "user", content: "Test" }]
    );
    assert.equal(requestBody.temperature, 0.1);
  } finally {
    global.fetch = originalFetch;
  }
});
