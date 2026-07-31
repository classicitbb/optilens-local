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
  const [provider, baseUrl, model] = await Promise.all([
    getSetting(SETTINGS.provider).catch(() => null),
    getSetting(SETTINGS.baseUrl).catch(() => null),
    getSetting(SETTINGS.model).catch(() => null)
  ]);

  return {
    provider: provider || DEFAULTS.provider,
    baseUrl: (baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, ""),
    model: model || DEFAULTS.model
  };
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
async function callOpenAICompatible({ baseUrl, model }, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
        new Error(`No model endpoint reachable at ${baseUrl}. Start a local model (e.g. Ollama) or set ${SETTINGS.baseUrl} in app settings.`),
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
      note: `No assistant provider is configured. The grounding context is returned so any AI reading this API can answer from it. To enable in-app answers, set "${SETTINGS.provider}" and "${SETTINGS.baseUrl}" in app settings.`
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

/** Whether in-app answering is available, for the UI to show honest state. */
async function getAssistantStatus() {
  const config = await loadProviderConfig();
  if (config.provider === "none") {
    return { configured: false, provider: "none", detail: "No assistant provider configured." };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${config.baseUrl}/models`, { signal: controller.signal });
    clearTimeout(timer);
    return {
      configured: res.ok,
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
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
      detail: `No model endpoint reachable at ${config.baseUrl}. The context API still works for external assistants.`
    };
  }
}

module.exports = { ask, getAssistantStatus, buildGrounding, GROUNDABLE, SETTINGS };
