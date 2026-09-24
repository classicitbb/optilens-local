// Speech-to-text for RX Capture voice intake. Audio is held in memory only and
// never logged; the transcript is returned to the employee to check before any
// extraction happens.
const { loadRxAiConfig } = require("./openai-extractor");

// Pin a dated snapshot in production so a silent model update cannot change
// how signs and numbers are written; bump it only after the regression set passes.
const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-transcribe";
const REQUEST_TIMEOUT_MS = 90000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MIN_DURATION_MS = 1000;
const MAX_DURATION_MS = 3 * 60 * 1000 + 5000;
const MAX_PROMPT_CHARS = 1800;

const AUDIO_TYPES = new Map([
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["audio/mp4", "mp4"],
  ["audio/m4a", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/mpeg", "mp3"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"]
]);

const BASE_PROMPT = [
  "Optical lab prescription dictation.",
  "Write numbers as numerals (-2.50, +1.25, axis 180, PD 63, 1.67).",
  "Write a plus or minus sign only when the speaker says plus or minus. Never add a sign that was not spoken.",
  "Terms: right eye, left eye, OD, OS, OU, both eyes, plano, sphere, cyl, cylinder, axis, add, prism, base in, base out, base up, base down, PD, near PD, fitting height, seg height, OC height, single vision, progressive, varifocal, bifocal, flat top, poly, polycarbonate, Trivex, index, AR, anti-reflective, photochromic, Transitions, tint, frame to follow, uncut, own lenses, cut only.",
  "Local speech: 'tree' means three and 'tirty' means thirty when a number is meant."
].join(" ");

function loadTranscribeConfig(options = {}) {
  const env = options.env || process.env;
  const base = loadRxAiConfig(options);
  return { ...base, model: env.OPENAI_RX_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL };
}

// Lens names seen most recently, so they are spelled the way the catalogue
// resolver expects. The prompt is capped because long prompts hurt recognition.
function buildTranscriptionPrompt(vocabulary = []) {
  let prompt = BASE_PROMPT;
  const terms = [...new Set(vocabulary.map((term) => String(term || "").trim()).filter(Boolean))];
  if (terms.length) {
    let list = "";
    for (const term of terms) {
      const next = list ? `${list}, ${term}` : term;
      if (prompt.length + next.length + 20 > MAX_PROMPT_CHARS) break;
      list = next;
    }
    if (list) prompt += ` Lens names: ${list}.`;
  }
  return prompt;
}

function parseAudio(value, durationMs) {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(value || ""));
  const mimeType = String(match?.[1] || "").toLowerCase();
  if (!match || !AUDIO_TYPES.has(mimeType)) throw userError("Use a WebM, Ogg, MP4/M4A, MP3 or WAV recording.", 415);
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) throw userError("The recording is empty.", 400);
  if (buffer.length > MAX_AUDIO_BYTES) throw userError("Each recording must be 10 MB or smaller.", 413);
  const duration = Number(durationMs);
  if (Number.isFinite(duration) && duration > 0 && duration < MIN_DURATION_MS) throw userError("Nothing heard, the recording was under a second. Try again.", 400);
  if (Number.isFinite(duration) && duration > MAX_DURATION_MS) throw userError("Each recording can be at most 3 minutes.", 413);
  return { buffer, mimeType, extension: AUDIO_TYPES.get(mimeType) };
}

async function transcribeAudio(audio, options = {}) {
  const config = { ...loadTranscribeConfig(), ...(options.config || {}) };
  if (!config.apiKey) throw userError("RX Capture AI credentials are not configured.", 503);
  const form = new FormData();
  form.append("file", new Blob([audio.buffer], { type: audio.mimeType }), `dictation.${audio.extension}`);
  form.append("model", config.model);
  form.append("language", "en");
  form.append("response_format", "json");
  form.append("prompt", buildTranscriptionPrompt(options.vocabulary));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetch || fetch)(`${config.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: controller.signal
    });
    if (!response.ok) throw userError(`Transcription service returned HTTP ${response.status}.`, 502);
    const body = await response.json();
    return String(body?.text || "").trim();
  } catch (error) {
    if (error.name === "AbortError") throw userError("Transcription timed out. Retry the recording.", 504);
    if (error instanceof SyntaxError) throw userError("Transcription returned an invalid response.", 502);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function userError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

module.exports = { AUDIO_TYPES, buildTranscriptionPrompt, loadTranscribeConfig, parseAudio, transcribeAudio };
