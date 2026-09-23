const { assistantFromVault } = require("../credential-vault");
const { extractionJsonSchema, normalizeOpticalOrder } = require("./normalized-order");

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4.1-mini";
const REQUEST_TIMEOUT_MS = 90000;

const EXTRACTION_INSTRUCTIONS = [
  "Extract only optical prescription and order information visibly present in the supplied images.",
  "Never guess, calculate, transpose, or infer missing prescription powers.",
  "Preserve plus and minus signs and return cylinder exactly as written. Do not convert cylinder notation.",
  "Distinguish OD from OS carefully. Axis must be an integer from 1 through 180 when present.",
  "Do not invent PD, ADD, lens type, frame information, or patient identity.",
  "Printed labels and column headings are not values. A visible ADD, Prism, or Base heading with a blank cell means the value is absent, not unreadable.",
  "ADD is optional for single-vision prescriptions. If the document says single vision, or the ADD cells are clearly blank, return null and do not add ADD paths to missingFields.",
  "Prism and base are optional. When their cells are clearly blank, return null and do not add prism or base paths to missingFields.",
  "For frame.status use TO_BE_TRACED when a physical frame will be supplied or traced later, MEASURED only when actual frame measurements are visible, and UNCUT only when explicitly stated.",
  "Copy the frame model and frame color exactly when they are written or printed (for example on an order sheet, envelope, or frame label). Otherwise return null.",
  "Never invent frame model, color, A, B, DBL, ED, or segment heights. Blank frame fields are optional and must not be added to missingFields.",
  "Extract any visible lens type, design, material, option, and coating text. Blank lens detail fields are optional at capture and must not be added to missingFields.",
  "If a mark or value appears to be present but cannot be read reliably, return null and add that exact field path to uncertainFields instead.",
  "Use null for absent values. Add every illegible or ambiguous field path to uncertainFields.",
  "Add absent required fields to missingFields, but never treat an intentionally blank optional field as missing.",
  "Return only the requested structured result."
].join("\n");

function loadRxAiConfig(options = {}) {
  const env = options.env || process.env;
  let vault = options.vault;
  if (vault === undefined) {
    try { vault = assistantFromVault(); } catch { vault = null; }
  }
  vault = vault || {};
  // The Credentials Vault is operator-managed and must win over stale machine
  // environment values left by an earlier installation.
  const apiKey = vault.apiKey || env.OPENAI_API_KEY || "";
  const baseUrl = (env.OPENAI_RX_BASE_URL || vault.baseUrl || env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = env.OPENAI_RX_MODEL || vault.model || env.ASSISTANT_MODEL || DEFAULT_MODEL;
  return { apiKey, baseUrl, model };
}

async function extractPrescriptionFromImages(images, options = {}) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 2) {
    throw userError("One or two prescription images are required.", 400);
  }
  const config = { ...loadRxAiConfig(), ...(options.config || {}) };
  if (!config.apiKey) throw userError("RX Capture AI credentials are not configured.", 503);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);
  const content = [{ type: "input_text", text: "Extract the prescription/order data from these employee-supplied images." }];
  for (const image of images) {
    content.push({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.buffer.toString("base64")}`, detail: "high" });
  }

  try {
    const response = await (options.fetch || fetch)(`${config.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        store: false,
        instructions: EXTRACTION_INSTRUCTIONS,
        input: [{ role: "user", content }],
        text: {
          format: {
            type: "json_schema",
            name: "rx_capture_extraction",
            strict: true,
            schema: extractionJsonSchema()
          }
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw userError(`Prescription extraction service returned HTTP ${response.status}.`, 502);
    }
    const body = await response.json();
    const outputText = responseOutputText(body);
    if (!outputText) throw userError("Prescription extraction returned no structured result.", 502);
    return normalizeOpticalOrder(JSON.parse(outputText));
  } catch (error) {
    if (error.name === "AbortError") throw userError("Prescription extraction timed out.", 504);
    if (error instanceof SyntaxError) throw userError("Prescription extraction returned invalid structured data.", 502);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function responseOutputText(body) {
  if (typeof body?.output_text === "string") return body.output_text;
  for (const item of body?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

function userError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

module.exports = { extractPrescriptionFromImages, loadRxAiConfig, responseOutputText };
