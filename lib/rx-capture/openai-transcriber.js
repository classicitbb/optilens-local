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
const MAX_DURATION_DRIFT_MS = 5000;

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
  const declaredDuration = Number(durationMs);
  const detectedDuration = detectAudioDurationMs(buffer, mimeType);
  if (!Number.isFinite(detectedDuration)) {
    throw userError("RX Capture could not verify this recording's duration. Record it in the browser again or use a standard WAV, MP3, Ogg, WebM, or M4A file.", 415);
  }
  if (Number.isFinite(declaredDuration) && Math.abs(declaredDuration - detectedDuration) > MAX_DURATION_DRIFT_MS) {
    throw userError("The recording duration could not be verified. Record it again before transcription.", 400);
  }
  if (detectedDuration < MIN_DURATION_MS) throw userError("Nothing heard, the recording was under a second. Try again.", 400);
  if (detectedDuration > MAX_DURATION_MS) throw userError("Each recording can be at most 3 minutes.", 413);
  return { buffer, mimeType, extension: AUDIO_TYPES.get(mimeType), durationMs: detectedDuration };
}

function detectAudioDurationMs(buffer, mimeType) {
  if (mimeType === "audio/wav" || mimeType === "audio/x-wav") return wavDurationMs(buffer);
  if (mimeType === "audio/ogg") return oggDurationMs(buffer);
  if (mimeType === "audio/webm") return webmDurationMs(buffer);
  if (["audio/mp4", "audio/m4a", "audio/x-m4a"].includes(mimeType)) return mp4DurationMs(buffer);
  if (mimeType === "audio/mpeg") return mp3DurationMs(buffer);
  return null;
}

function wavDurationMs(buffer) {
  if (buffer.length < 44 || buffer.subarray(0, 4).toString("ascii") !== "RIFF" || buffer.subarray(8, 12).toString("ascii") !== "WAVE") return null;
  let offset = 12;
  let byteRate = null;
  let dataBytes = null;
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const size = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + size > buffer.length) return null;
    if (type === "fmt " && size >= 12) byteRate = buffer.readUInt32LE(dataOffset + 8);
    if (type === "data") dataBytes = size;
    offset = dataOffset + size + (size % 2);
  }
  return byteRate && dataBytes !== null ? dataBytes / byteRate * 1000 : null;
}

function oggDurationMs(buffer) {
  let offset = 0;
  let sampleRate = null;
  let finalGranule = null;
  while (offset + 27 <= buffer.length) {
    const marker = buffer.indexOf("OggS", offset, "ascii");
    if (marker < 0 || marker + 27 > buffer.length) break;
    const segments = buffer[marker + 26];
    const headerEnd = marker + 27 + segments;
    if (headerEnd > buffer.length) return null;
    const payloadSize = [...buffer.subarray(marker + 27, headerEnd)].reduce((total, size) => total + size, 0);
    if (headerEnd + payloadSize > buffer.length) return null;
    const payload = buffer.subarray(headerEnd, headerEnd + payloadSize);
    if (payload.subarray(0, 8).toString("ascii") === "OpusHead") sampleRate = 48000;
    if (payload.subarray(0, 7).toString("ascii") === "\u0001vorbis" && payload.length >= 16) sampleRate = payload.readUInt32LE(12);
    const granule = buffer.readBigUInt64LE(marker + 6);
    if (granule > 0n) finalGranule = granule;
    offset = headerEnd + payloadSize;
  }
  return sampleRate && finalGranule !== null ? Number(finalGranule) / sampleRate * 1000 : null;
}

function webmDurationMs(buffer) {
  const scaleMarker = Buffer.from([0x2a, 0xd7, 0xb1]);
  const durationMarker = Buffer.from([0x44, 0x89]);
  const scaleAt = buffer.indexOf(scaleMarker);
  const durationAt = buffer.indexOf(durationMarker);
  const scale = scaleAt >= 0 ? readEbmlUnsigned(buffer, scaleAt + scaleMarker.length) : 1000000;
  const duration = durationAt >= 0 ? readEbmlFloat(buffer, durationAt + durationMarker.length) : null;
  return Number.isFinite(scale) && Number.isFinite(duration) && duration > 0 ? duration * scale / 1000000 : null;
}

function readEbmlUnsigned(buffer, offset) {
  const size = ebmlSize(buffer, offset);
  if (!size || size.length > 6 || offset + size.length + size.value > buffer.length) return null;
  let value = 0;
  for (let index = 0; index < size.value; index += 1) value = value * 256 + buffer[offset + size.length + index];
  return value;
}

function readEbmlFloat(buffer, offset) {
  const size = ebmlSize(buffer, offset);
  if (!size || ![4, 8].includes(size.value) || offset + size.length + size.value > buffer.length) return null;
  return size.value === 4 ? buffer.readFloatBE(offset + size.length) : buffer.readDoubleBE(offset + size.length);
}

function ebmlSize(buffer, offset) {
  const first = buffer[offset];
  if (!first) return null;
  let length = 1;
  while (length <= 8 && !(first & (1 << (8 - length)))) length += 1;
  if (length > 8 || offset + length > buffer.length) return null;
  let value = first & ((1 << (8 - length)) - 1);
  for (let index = 1; index < length; index += 1) value = value * 256 + buffer[offset + index];
  return { length, value };
}

function mp4DurationMs(buffer) {
  const marker = Buffer.from("mvhd");
  const at = buffer.indexOf(marker);
  if (at < 4 || at + 24 > buffer.length) return null;
  const version = buffer[at + 4];
  if (version === 0 && at + 24 <= buffer.length) {
    const scale = buffer.readUInt32BE(at + 16);
    const duration = buffer.readUInt32BE(at + 20);
    return scale && duration ? duration / scale * 1000 : null;
  }
  if (version === 1 && at + 36 <= buffer.length) {
    const scale = buffer.readUInt32BE(at + 28);
    const duration = buffer.readBigUInt64BE(at + 32);
    return scale && duration > 0n ? Number(duration) / scale * 1000 : null;
  }
  return null;
}

function mp3DurationMs(buffer) {
  let offset = buffer.subarray(0, 3).toString("ascii") === "ID3" && buffer.length >= 10
    ? 10 + ((buffer[6] & 0x7f) << 21) + ((buffer[7] & 0x7f) << 14) + ((buffer[8] & 0x7f) << 7) + (buffer[9] & 0x7f)
    : 0;
  let samples = 0;
  let sampleRate = null;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) { offset += 1; continue; }
    const versionBits = (buffer[offset + 1] >> 3) & 0x03;
    const layerBits = (buffer[offset + 1] >> 1) & 0x03;
    const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
    const rateIndex = (buffer[offset + 2] >> 2) & 0x03;
    const padding = (buffer[offset + 2] >> 1) & 0x01;
    const frame = mpegFrameInfo(versionBits, layerBits, bitrateIndex, rateIndex, padding);
    if (!frame) { offset += 1; continue; }
    if (offset + frame.length > buffer.length) return null;
    samples += frame.samples;
    sampleRate ||= frame.sampleRate;
    if (sampleRate !== frame.sampleRate) return null;
    offset += frame.length;
  }
  return samples && sampleRate ? samples / sampleRate * 1000 : null;
}

function mpegFrameInfo(versionBits, layerBits, bitrateIndex, rateIndex, padding) {
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const layer = 4 - layerBits;
  const rates = version === 1 ? [44100, 48000, 32000] : version === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
  const bitrates = layer === 1
    ? (version === 1 ? [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448] : [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256])
    : layer === 2
      ? (version === 1 ? [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384] : [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])
      : (version === 1 ? [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]);
  const sampleRate = rates[rateIndex];
  const bitrate = bitrates[bitrateIndex - 1] * 1000;
  const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
  const length = layer === 1
    ? (Math.floor((12 * bitrate / sampleRate) + padding) * 4)
    : Math.floor(((layer === 3 && version !== 1 ? 72 : 144) * bitrate / sampleRate) + padding);
  return length > 4 ? { length, samples, sampleRate } : null;
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

module.exports = { AUDIO_TYPES, buildTranscriptionPrompt, detectAudioDurationMs, loadTranscribeConfig, parseAudio, transcribeAudio };
