#!/usr/bin/env node
// Runs recorded synthetic dictations through the live transcription model and
// checks the rules the voice intake depends on. Run it before changing
// OPENAI_RX_TRANSCRIBE_MODEL or the transcription prompt:
//
//   node scripts/rx-voice-regression.js
//
// Each recording in test/fixtures/rx-voice-audio/ has a JSON file of the same
// name: { "mustContain": ["axis 180"], "unsigned": ["2.25"], "signed": ["-1.50"] }.
// "unsigned" values were spoken without plus or minus and must come back without
// a sign. Recordings are made-up prescriptions only, recorded with consent.
const fs = require("node:fs");
const path = require("node:path");
const { AUDIO_TYPES, transcribeAudio } = require("../lib/rx-capture/openai-transcriber");

const DIR = path.join(__dirname, "..", "test", "fixtures", "rx-voice-audio");
const EXTENSION_TYPES = new Map([...AUDIO_TYPES].map(([type, extension]) => [`.${extension}`, type]));

async function main() {
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((file) => EXTENSION_TYPES.has(path.extname(file).toLowerCase())) : [];
  if (!files.length) {
    console.log(`No recordings in ${path.relative(process.cwd(), DIR)}. Add made-up dictations and their .json expectations first.`);
    return;
  }
  let failures = 0;
  for (const file of files) {
    const expectPath = path.join(DIR, `${path.basename(file, path.extname(file))}.json`);
    const expected = fs.existsSync(expectPath) ? JSON.parse(fs.readFileSync(expectPath, "utf8")) : {};
    const buffer = fs.readFileSync(path.join(DIR, file));
    const extension = path.extname(file).toLowerCase();
    const text = await transcribeAudio({ buffer, mimeType: EXTENSION_TYPES.get(extension), extension: extension.slice(1) });
    const problems = [];
    for (const phrase of expected.mustContain || []) if (!text.toLowerCase().includes(phrase.toLowerCase())) problems.push(`missing "${phrase}"`);
    for (const value of expected.unsigned || []) {
      if (new RegExp(`[+\\-\\u2212]\\s*${escape(value)}\\b`).test(text)) problems.push(`added a sign to "${value}"`);
      else if (!new RegExp(`\\b${escape(value)}\\b`).test(text)) problems.push(`did not return "${value}"`);
    }
    for (const value of expected.signed || []) if (!text.includes(value)) problems.push(`did not return "${value}" with its sign`);
    failures += problems.length ? 1 : 0;
    console.log(`${problems.length ? "FAIL" : "ok  "} ${file}${problems.length ? `: ${problems.join("; ")}` : ""}`);
  }
  console.log(`${files.length - failures}/${files.length} recordings passed.`);
  if (failures) process.exitCode = 1;
}

function escape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
