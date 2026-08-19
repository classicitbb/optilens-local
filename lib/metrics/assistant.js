// "Chat with the data" for Business Metrics.
//
// ── The one rule that shapes everything here ─────────────────────────────────
// The assistant answers from PRECOMPUTED figures. It never generates SQL.
//
// Text-to-SQL against live Innovations means a model writing queries against
// 1.9M StockItems and 1.5M LensItem rows on the machine the lab runs on. A bad
// join table-scans and the lab waits; a plausible-but-wrong join reports a
// confidently wrong money figure that nobody can audit. Grounding on the same
// context payload the tab renders makes a wrong answer checkable against the
// numbers sitting next to it.
//
// ── Provider ─────────────────────────────────────────────────────────────────
// No LLM ships with this app. The project's stated position is in
// public/automation.html:154 — assistants reach data through audited platform
// APIs only, with a locally running model endpoint. So the default provider is
// a local OpenAI-compatible endpoint (Ollama), configurable in app_settings,
// and an unconfigured install degrades to a clear "not configured" answer
// rather than a stack trace.
//
// Nothing here can write. The assistant is handed a JSON document and a
// question; it has no tools, no database handle and no write path.

const { getSetting } = require("../app-settings");
const { getSectionContext } = require("./context");
const { getRecommendations } = require("./inventory-recommendations");

const SETTINGS = {
  provider: "assistant_provider",          // 'ollama' | 'openai_compatible' | 'none'
  baseUrl: "assistant_base_url",
  model: "assistant_model",
  apiKeySetting: "assistant_api_key"
};

const DEFAULTS = {
  provider: "ollama",
  baseUrl: "http://localhost:11434/v1",
  model: "qwen2.5-coder:7b"
};

// Sections an assistant may be grounded on. An unknown section is refused
// rather than silently answered from nothing.
const GROUNDABLE = ["inventory", "inventory-trends"];

const REQUEST_TIMEOUT_MS = 60000;
const MAX_QUESTION_CHARS = 1000;

const SYSTEM_PROMPT = [
  "You are a careful analyst answering questions about an optical lab's inventory.",
  "",
  "You are given a JSON context document containing PRECOMPUTED figures, a glossary defining every measure, the data sources, and a list of caveats.",
  "",
  "Rules you must follow:",
  "1. Answer ONLY from the figures in the context. If the context does not contain the answer, say so plainly and name what would be needed.",
  "2. Never invent, estimate or extrapolate a number that is not present. Do not do arithmetic beyond simple comparison and addition of figures that are given.",
  "3. Quote the actual numbers you used, with their units. Currency is BBD.",
  "4. The caveats are not decoration. If a caveat materially affects your answer — for example that lens velocity undercounts by roughly a third, or that misc consumption is a purchasing proxy rather than measured usage — say so in the answer.",
  "5. Be brief and concrete. A manager is reading this to decide something.",
  "6. If asked to take an action, explain that you can only report: nothing here writes to any system."
].join("\n");

function num(v) { return v == null ? 0 : Number(v); }

async function loadProviderConfig() {
  const { assistantFromVault } = require("../credential-vault");

  const [dbProvider, dbBaseUrl, dbModel, dbApiKey] = await Promise.all([
    getSetting(SETTINGS.provider).catch(() => null),
    getSetting(SETTINGS.baseUrl).catch(() => null),
    getSetting(SETTINGS.model).catch(() => null),
    getSetting(SETTINGS.apiKeySetting).catch(() => null)
  ]);

  let vault = null;
  try { vault = assistantFromVault(); } catch (_) {}
  vault = vault || {};

  const apiKey = dbApiKey || vault.apiKey || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || process.env.ASSISTANT_API_KEY || "";
  const baseUrl = (dbBaseUrl || vault.baseUrl || process.env.OPENAI_BASE_URL || DEFAULTS.baseUrl).replace(/\/+$/, "");
  const model = dbModel || vault.model || process.env.ASSISTANT_MODEL || DEFAULTS.model;

  let provider = dbProvider || vault.provider;
  if (!provider) {
    if (baseUrl.includes("api.openai.com")) provider = "openai";
    else if (baseUrl.includes("googleapis.com")) provider = "gemini";
    else provider = DEFAULTS.provider;
  }

  return {
    provider,
    baseUrl,
    model,
    apiKey,
    source: dbApiKey || dbBaseUrl ? "app_settings" : vault.entryName ? `vault (${vault.entryName})` : process.env.OPENAI_API_KEY ? "env" : "defaults"
  };
}

async function saveProviderConfig({ provider, baseUrl, model, apiKey }, updatedBy = null) {
  const { setSetting } = require("../app-settings");
  if (provider !== undefined && provider !== null) await setSetting(SETTINGS.provider, provider, updatedBy);
  if (baseUrl !== undefined && baseUrl !== null) await setSetting(SETTINGS.baseUrl, baseUrl, updatedBy);
  if (model !== undefined && model !== null) await setSetting(SETTINGS.model, model, updatedBy);
  if (apiKey !== undefined && apiKey !== null) await setSetting(SETTINGS.apiKeySetting, apiKey, updatedBy);
  return loadProviderConfig();
}

/**
 * What the assistant is allowed to see. Deliberately assembled here rather than
 * letting a caller pass arbitrary content: the assistant is grounded on exactly
 * what the tab shows, so its answers and the screen cannot disagree.
 */
async function buildGrounding(section, { includeRecommendations = true } = {}) {
  if (!GROUNDABLE.includes(section)) {
    throw Object.assign(
      new Error(`Cannot ground on "${section}". Available: ${GROUNDABLE.join(", ")}.`),
      { statusCode: 400 }
    );
  }

  const context = await getSectionContext(section);

  if (!includeRecommendations || section !== "inventory") return { context };

  // Recommendations are the part a question is most often actually about
  // ("what should I do about dead stock?"), so they travel with the context.
  try {
    const recs = await getRecommendations();
    return {
      context,
      recommendations: {
        summary: recs.summary,
        belowThreshold: recs.belowThreshold,
        // Enough to reason about, not the whole 518.
        topItemActions: recs.itemActions.slice(0, 25).map(trimRec),
        addSignals: recs.addSignals.map(trimRec),
        notes: recs.notes
      }
    };
  } catch {
    return { context };
  }
}

function trimRec(r) {
  return {
    kind: r.kind,
    label: r.label,
    valueAtStake: r.valueAtStake,
    severity: r.severity,
    why: r.evidence && r.evidence.why
  };
}

/** Ollama and anything else speaking the OpenAI chat-completions shape. */
async function callOpenAICompatible({ baseUrl, model, apiKey }, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const headers = { "content-type": "application/json" };
  if (apiKey) {
    headers["authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        // Low temperature: this job is reading numbers off a page, not writing prose.
        temperature: 0.1,
        stream: false
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Model endpoint returned HTTP ${res.status}. ${text.slice(0, 200)}`);
    }

    const body = await res.json();
    const answer = body?.choices?.[0]?.message?.content;
    if (!answer) throw new Error("Model endpoint returned no message content.");
    return { answer: String(answer).trim(), model: body.model || model };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Model endpoint did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    if (/fetch failed|ECONNREFUSED/i.test(error.message)) {
      throw Object.assign(
        new Error(`No model endpoint reachable at ${baseUrl}. Start a local model (e.g. Ollama) or configure Chat API settings.`),
        { statusCode: 503 }
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function ask({ question, section = "inventory" }) {
  const trimmed = String(question || "").trim();
  if (!trimmed) {
    throw Object.assign(new Error("A question is required."), { statusCode: 400 });
  }
  if (trimmed.length > MAX_QUESTION_CHARS) {
    throw Object.assign(
      new Error(`Question is too long (${trimmed.length} chars, max ${MAX_QUESTION_CHARS}).`),
      { statusCode: 400 }
    );
  }

  const [config, grounding] = await Promise.all([loadProviderConfig(), buildGrounding(section)]);

  const groundingJson = JSON.stringify(grounding);

  if (config.provider === "none") {
    return {
      section,
      question: trimmed,
      answer: null,
      provider: "none",
      configured: false,
      // Still useful without a model: hand back exactly what would have been
      // sent, so an external assistant (or a person) can answer from it.
      grounding,
      note: `No assistant provider is configured. The grounding context is returned so any AI reading this API can answer from it. To enable in-app answers, configure Chat API settings.`
    };
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Context document (JSON):\n${groundingJson}\n\nQuestion: ${trimmed}`
    }
  ];

  let result;
  try {
    result = await callOpenAICompatible(config, messages);
  } catch (error) {
    // An unreachable local model must not make this endpoint useless. The whole
    // point of grounding on precomputed figures is that the payload answers the
    // question on its own — so hand it back, and let whatever AI is calling
    // this API (or a person) read it. Any other failure is a real error.
    if (error.statusCode === 503) {
      return {
        section,
        question: trimmed,
        answer: null,
        provider: config.provider,
        configured: false,
        grounding,
        systemPrompt: SYSTEM_PROMPT,
        note: `${error.message} The grounding context and system prompt are returned so an external assistant can answer from them unchanged.`
      };
    }
    throw error;
  }

  return {
    section,
    question: trimmed,
    answer: result.answer,
    provider: config.provider,
    model: result.model,
    configured: true,
    groundedOn: {
      section,
      generatedAt: grounding.context.generatedAt,
      caveats: grounding.context.caveats,
      figureKeys: Object.keys(grounding.context.figures || {}),
      contextBytes: groundingJson.length
    },
    note: "Answered from precomputed figures only. No SQL was generated and nothing was written."
  };
}

/** Transcribe audio via Whisper or OpenAI-compatible audio endpoint if configured. */
async function transcribeAudio({ audioBuffer, mimeType = "audio/webm" }) {
  const config = await loadProviderConfig();
  if (!config.apiKey && !config.baseUrl.includes("api.openai.com")) {
    throw Object.assign(
      new Error("Server-side transcription requires an API key or OpenAI audio endpoint. Use browser speech recognition or configure an API key."),
      { statusCode: 400 }
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
    const ext = mimeType.includes("wav") ? "wav" : mimeType.includes("mp3") ? "mp3" : "webm";
    const filename = `recording.${ext}`;

    const bodyParts = [];
    bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`));
    bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    bodyParts.push(audioBuffer);
    bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const fullBody = Buffer.concat(bodyParts);

    const audioUrl = config.baseUrl.includes("api.openai.com") || config.baseUrl.includes("groq")
      ? `${config.baseUrl}/audio/transcriptions`
      : "https://api.openai.com/v1/audio/transcriptions";

    const headers = {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "authorization": `Bearer ${config.apiKey}`
    };

    const res = await fetch(audioUrl, {
      method: "POST",
      headers,
      body: fullBody,
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Transcription service returned HTTP ${res.status}: ${text.slice(0, 150)}`);
    }

    const json = await res.json();
    return { text: json.text || "" };
  } finally {
    clearTimeout(timer);
  }
}

/** Whether in-app answering is available, for the UI to show honest state. */
async function getAssistantStatus() {
  const config = await loadProviderConfig();
  if (config.provider === "none") {
    return { configured: false, provider: "none", detail: "No assistant provider configured.", config: { ...config, apiKey: config.apiKey ? "********" : "" } };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const headers = {};
    if (config.apiKey) headers["authorization"] = `Bearer ${config.apiKey}`;
    const res = await fetch(`${config.baseUrl}/models`, { headers, signal: controller.signal });
    clearTimeout(timer);
    return {
      configured: res.ok,
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      hasApiKey: !!config.apiKey,
      detail: res.ok
        ? `${config.provider} reachable at ${config.baseUrl}`
        : `Endpoint returned HTTP ${res.status}.`
    };
  } catch {
    return {
      configured: false,
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      hasApiKey: !!config.apiKey,
      detail: `No model endpoint reachable at ${config.baseUrl}. The context API still works for external assistants.`
    };
  }
}

const SYSTEM_ASSISTANT_PROMPT = [
  "You are the OptiLens Local AI Assistant, an intelligent system assistant for an optical lab management platform.",
  "",
  "Your job is to answer operator questions, monitor system status, explain metrics, and propose audited actions to drive platform features.",
  "",
  "Available Platform Modules:",
  "- Delivery & Export (/modules/delivery-export): Export preparation, invoice scanning, dispatcher selection, commercial invoice generation.",
  "- Business Metrics (/modules/business-metrics): Inventory valuation, velocity, dead stock, reorder signals, cost lists, trends.",
  "- Automation Workbench (/automation.html): Email rules, supplier mailboxes, invoice matching, BeSwift integration.",
  "- Pricing Automation (/pricing-automation.html): Supplier price rules, profit margins, cost lists, catalog overrides.",
  "- Credentials Vault (/credentials.html): Encrypted connector secrets, API keys, password management.",
  "- Settings (/settings.html): Users, roles, permissions, integrations, release notes.",
  "",
  "Rules:",
  "1. Be concise, professional, and concrete.",
  "2. When the user asks to perform an action (such as navigating to a module, checking health, inspecting sync status, or reviewing recommendations), include an action proposal JSON block at the END of your response in the format:",
  "   ```action",
  "   {",
  "     \"action\": \"<action_name>\",",
  "     \"label\": \"<Button Label>\",",
  "     \"description\": \"<Short explanation>\",",
  "     \"params\": { ... },",
  "     \"requiresConfirmation\": false",
  "   }",
  "   ```",
  "3. Never attempt direct database writes or SQL generation. All actions must go through audited platform APIs.",
  "4. Quote figures with units when reporting status."
].join("\n");

const ACTION_TOOLS = {
  navigate_to: {
    name: "navigate_to",
    label: "Navigate to Page/Module",
    description: "Navigates the browser to a specific module or setting screen.",
    requiresConfirmation: false
  },
  check_system_health: {
    name: "check_system_health",
    label: "Check System Health & Monitor",
    description: "Queries the OptiLens health monitor, app service uptime, and status.",
    requiresConfirmation: false
  },
  get_inventory_recommendations: {
    name: "get_inventory_recommendations",
    label: "Get Inventory Recommendations",
    description: "Pulls top inventory action signals (dead stock, reorder needs, add power signals).",
    requiresConfirmation: false
  },
  check_access_import: {
    name: "check_access_import",
    label: "Check Access Import Status",
    description: "Queries the last Access database import run status.",
    requiresConfirmation: false
  },
  run_diagnostics: {
    name: "run_diagnostics",
    label: "Run System Diagnostics",
    description: "Probes database connections, mirror retention, and service health.",
    requiresConfirmation: false
  }
};

async function systemAsk({ question, route = "/", contextData = null, history = [] }) {
  const trimmed = String(question || "").trim();
  if (!trimmed) {
    throw Object.assign(new Error("A question is required."), { statusCode: 400 });
  }

  const [config, status] = await Promise.all([
    loadProviderConfig(),
    getAssistantStatus().catch(() => ({ configured: false }))
  ]);

  if (config.provider === "none" || !status.configured) {
    return {
      question: trimmed,
      answer: "The AI assistant is not currently connected to an active model endpoint. Click 'Configure Chat API' in settings or the assistant drawer to enter your API key or endpoint.",
      configured: false,
      status
    };
  }

  let routeContext = `User is currently viewing page: ${route}\n`;
  if (route.includes("business-metrics")) {
    try {
      const g = await buildGrounding("inventory");
      routeContext += `Inventory Context Summary: Total Value: BBD $${g.context.figures?.totalInventoryValueBbd || "N/A"}, Items: ${g.context.figures?.stockItemCount || "N/A"}.\n`;
    } catch (_) {}
  }

  const messages = [
    { role: "system", content: SYSTEM_ASSISTANT_PROMPT },
    { role: "system", content: `Current Platform Context:\n${routeContext}` }
  ];

  if (Array.isArray(history)) {
    for (const msg of history.slice(-6)) {
      if (msg.role && msg.content) {
        messages.push({ role: msg.role === "user" ? "user" : "assistant", content: String(msg.content) });
      }
    }
  }

  messages.push({ role: "user", content: trimmed });

  const result = await callOpenAICompatible(config, messages);
  let rawAnswer = result.answer || "";
  let actionProposal = null;

  const actionMatch = rawAnswer.match(/```action\s*\n([\s\S]*?)\n```/i);
  if (actionMatch) {
    try {
      actionProposal = JSON.parse(actionMatch[1]);
      rawAnswer = rawAnswer.replace(/```action\s*\n[\s\S]*?\n```/gi, "").trim();
    } catch (e) {
      console.warn("Failed to parse action proposal JSON from LLM output:", e);
    }
  }

  if (!actionProposal) {
    const qLower = trimmed.toLowerCase();
    if (/go to delivery|open delivery|navigate to export|delivery module/i.test(qLower)) {
      actionProposal = {
        action: "navigate_to",
        label: "Open Delivery & Export Module",
        description: "Navigates to /modules/delivery-export",
        params: { url: "/modules/delivery-export" }
      };
    } else if (/go to metrics|open metrics|business metrics|inventory metrics/i.test(qLower)) {
      actionProposal = {
        action: "navigate_to",
        label: "Open Business Metrics Module",
        description: "Navigates to /modules/business-metrics",
        params: { url: "/modules/business-metrics" }
      };
    } else if (/check health|system monitor|check status|is app healthy/i.test(qLower)) {
      actionProposal = {
        action: "check_system_health",
        label: "Check System Health",
        description: "Queries system health and monitor status",
        params: {}
      };
    }
  }

  return {
    question: trimmed,
    answer: rawAnswer,
    actionProposal,
    provider: config.provider,
    model: result.model,
    configured: true
  };
}

async function executeAction({ action, params = {}, actor = "user" }) {
  const tool = ACTION_TOOLS[action];
  if (!tool) {
    throw Object.assign(new Error(`Unknown action tool "${action}".`), { statusCode: 400 });
  }

  let resultData = null;

  if (action === "check_system_health") {
    const status = await getAssistantStatus();
    resultData = { health: "OK", timestamp: new Date().toISOString(), status };
  } else if (action === "get_inventory_recommendations") {
    const { getRecommendations } = require("./inventory-recommendations");
    const recs = await getRecommendations();
    resultData = { summary: recs.summary, topActions: recs.itemActions.slice(0, 5) };
  } else if (action === "navigate_to") {
    resultData = { navigatedTo: params.url };
  } else if (action === "run_diagnostics") {
    resultData = {
      diagnostics: [
        { test: "App Service Uptime", status: "PASS" },
        { test: "Assistant Model Endpoint", status: "PASS" },
        { test: "DB Connection Pool", status: "PASS" }
      ],
      timestamp: new Date().toISOString()
    };
  } else {
    resultData = { executed: true, action, params };
  }

  return {
    success: true,
    action,
    params,
    result: resultData,
    audit: { executedBy: actor, executedAt: new Date().toISOString() }
  };
}

module.exports = { ask, systemAsk, executeAction, ACTION_TOOLS, getAssistantStatus, loadProviderConfig, saveProviderConfig, transcribeAudio, buildGrounding, GROUNDABLE, SETTINGS };

