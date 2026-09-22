// Loads the attached Innova Training workspace as searchable assistant grounding.
// Relevant excerpts are selected per question, so the full folder is available
// without forcing every document into one model context window.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const DEFAULT_TRAINING_PATHS = [
  "C:\\Users\\Public\\Documents\\Ocuco\\Innovations\\Innova Training",
  "C:\\Users\\Administrator\\Documents\\GitHub\\Innova-Training"
];
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".sql", ".json", ".csv", ".js", ".mjs", ".ps1", ".py", ".bas", ".html", ".htm", ".docx", ".xlsx"]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "__pycache__"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const CHUNK_CHARS = 6000;
const CHUNK_OVERLAP = 700;
const MAX_CONTEXT_CHARS = 42000;
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = null;
let cacheTimestamp = 0;

function trainingPath() {
  if (process.env.INNOVA_TRAINING_PATH) return process.env.INNOVA_TRAINING_PATH;
  return DEFAULT_TRAINING_PATHS.find(isReadableDirectory) || DEFAULT_TRAINING_PATHS[0];
}

function isReadableDirectory(candidate) {
  try { return fs.statSync(candidate).isDirectory(); } catch (_) { return false; }
}

function relativeFiles(root, current = root, files = []) {
  let entries = [];
  try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { return files; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) relativeFiles(root, path.join(current, entry.name), files);
      continue;
    }
    if (!entry.isFile() || !TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const fullPath = path.join(current, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size <= MAX_FILE_BYTES) files.push({ fullPath, relativePath: path.relative(root, fullPath), sizeBytes: stat.size });
    } catch (_) {}
  }
  return files;
}

function zipEntry(buffer, name) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) return null;
  let offset = buffer.readUInt32LE(end + 16);
  const count = buffer.readUInt16LE(end + 10);
  for (let index = 0; index < count && offset + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const entryName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (entryName === name && localOffset + 30 <= buffer.length && buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const data = buffer.subarray(localOffset + 30 + localNameLength + localExtraLength, localOffset + 30 + localNameLength + localExtraLength + compressedSize);
      return method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function xmlText(xml) {
  return String(xml || "")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function xlsxText(buffer) {
  const sharedXml = zipEntry(buffer, "xl/sharedStrings.xml")?.toString("utf8") || "";
  const shared = [...sharedXml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)].map((match) => xmlText(match[1]).trim());
  const lines = [];
  for (let sheetNumber = 1; sheetNumber <= 100; sheetNumber += 1) {
    const sheet = zipEntry(buffer, `xl/worksheets/sheet${sheetNumber}.xml`);
    if (!sheet) continue;
    lines.push(`Sheet ${sheetNumber}`);
    const rows = sheet.toString("utf8").match(/<row\b[^>]*>[\s\S]*?<\/row>/g) || [];
    for (const row of rows.slice(0, 500)) {
      const values = [];
      for (const cell of row.match(/<c\b[^>]*>[\s\S]*?<\/c>/g) || []) {
        const type = cell.match(/\bt="([^"]+)"/)?.[1];
        const raw = cell.match(/<v>([\s\S]*?)<\/v>/)?.[1] || cell.match(/<is>([\s\S]*?)<\/is>/)?.[1] || "";
        const value = type === "s" ? (shared[Number(raw)] || "") : xmlText(raw).trim();
        if (value) values.push(value);
      }
      if (values.length) lines.push(values.join(" | "));
    }
  }
  return lines.join("\n");
}

function readTrainingFile(file) {
  try {
    const extension = path.extname(file.fullPath).toLowerCase();
    if (extension !== ".docx" && extension !== ".xlsx") return fs.readFileSync(file.fullPath, "utf8").replace(/\r\n/g, "\n");
    const buffer = fs.readFileSync(file.fullPath);
    if (extension === ".xlsx") return xlsxText(buffer);
    const documentXml = zipEntry(buffer, "word/document.xml");
    return documentXml ? xmlText(documentXml.toString("utf8")) : "";
  } catch (_) { return ""; }
}

function splitIntoChunks(file) {
  let text;
  try { text = readTrainingFile(file); } catch (_) { return []; }
  const chunks = [];
  for (let start = 0; start < text.length; start += CHUNK_CHARS - CHUNK_OVERLAP) {
    const end = Math.min(text.length, start + CHUNK_CHARS);
    chunks.push({ file: file.relativePath, text: text.slice(start, end), start });
    if (end === text.length) break;
  }
  return chunks;
}

function loadIndex() {
  const now = Date.now();
  if (cache && now - cacheTimestamp < CACHE_TTL_MS) return cache;
  const root = trainingPath();
  if (!isReadableDirectory(root)) {
    cache = { root, files: [], chunks: [], available: false };
    cacheTimestamp = now;
    return cache;
  }
  const files = relativeFiles(root);
  cache = { root, files, chunks: files.flatMap(splitIntoChunks), available: true };
  cacheTimestamp = now;
  return cache;
}

function keywords(question) {
  return [...new Set(String(question || "").toLowerCase().match(/[a-z0-9_]{3,}/g) || [])];
}

function scoreChunk(chunk, terms) {
  const haystack = `${chunk.file}\n${chunk.text}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 + Math.min(4, haystack.split(term).length - 1) : 0), 0);
}

function buildKnowledgeContext(question = "") {
  const index = loadIndex();
  if (!index.available) {
    return [
      "KNOWLEDGE BASE STATUS: attached Innova Training workspace is not accessible.",
      "The assistant may still use current data research or general knowledge, but must not claim training-document support."
    ].join("\n");
  }

  const terms = keywords(question);
  const ranked = index.chunks
    .map((chunk, indexPosition) => ({ chunk, score: scoreChunk(chunk, terms), indexPosition }))
    .sort((a, b) => b.score - a.score || a.indexPosition - b.indexPosition);
  const selected = (terms.length ? ranked.filter((item) => item.score > 0) : ranked).slice(0, 12);
  let used = 0;
  const sections = [];
  for (const { chunk } of selected) {
    const remaining = MAX_CONTEXT_CHARS - used;
    if (remaining <= 0) break;
    const text = chunk.text.slice(0, remaining);
    sections.push(`\n--- Innova Training: ${chunk.file}${chunk.start ? ` (offset ${chunk.start})` : ""} ---\n${text}`);
    used += text.length;
  }
  return [
    "INNOVA TRAINING KNOWLEDGE BASE",
    `Indexed ${index.files.length} supported files. The excerpts below were selected for this question; use them as operational grounding.`,
    ...sections
  ].join("\n");
}

function getKnowledgeStatus() {
  const index = loadIndex();
  return {
    trainingPath: index.root,
    pathAccessible: index.available,
    files: index.files.map(({ relativePath, sizeBytes }) => ({ file: relativePath, found: true, sizeBytes })),
    loadedFiles: index.files.length,
    totalKbOnDisk: Math.round(index.files.reduce((sum, file) => sum + file.sizeBytes, 0) / 1024),
    indexedChunks: index.chunks.length,
    cacheAge: cacheTimestamp ? Math.round((Date.now() - cacheTimestamp) / 1000) : null
  };
}

function clearKnowledgeCache() {
  cache = null;
  cacheTimestamp = 0;
}

module.exports = { buildKnowledgeContext, getKnowledgeStatus, clearKnowledgeCache, trainingPath };
