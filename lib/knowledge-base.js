// lib/knowledge-base.js
//
// Loads the Innova-Training documentation as structured grounding context
// for the OptiLens System Assistant.
//
// The training docs live at INNOVA_TRAINING_PATH (env or default).
// They are read once on first call and cached in memory — the server does not
// need to restart when docs are updated; cache is cleared on next restart.
//
// None of this code writes to any database or calls any external API.

const fs = require("fs");
const path = require("path");

// ── Config ────────────────────────────────────────────────────────────────────

const INNOVA_TRAINING_PATH =
  process.env.INNOVA_TRAINING_PATH ||
  "C:\\Users\\Administrator\\Documents\\GitHub\\Innova-Training";

// Ordered list of doc files to load, with short labels used in the prompt.
// Files are read in this order and concatenated into the knowledge context.
const KNOWLEDGE_FILES = [
  {
    file: "01-system-overview.md",
    label: "System Overview & Company Profile",
    maxChars: 14000
  },
  {
    file: "02-sql-guide.md",
    label: "PSQL SQL Guide & Core Table Reference",
    maxChars: 21000
  },
  {
    file: "04-constraints-guide.md",
    label: "Report Constraints & Parameter Syntax",
    maxChars: 7000
  },
  {
    file: "05-tam-reports.md",
    label: "TAM Report Series",
    maxChars: 8000
  },
  {
    file: "06-api-reference.md",
    label: "Innovations REST API Reference",
    maxChars: 7000
  },
  {
    file: "07-how-to-operate.md",
    label: "How to Operate Innovations",
    maxChars: 7000
  },
  {
    file: "source-context/innovations-knowledge.md",
    label: "Additional Innovations Knowledge",
    maxChars: 8500
  }
];

// Report queries file is large (190 KB). Load a representative excerpt only.
const REPORT_QUERIES_EXCERPT_CHARS = 8000;

// ── Cache ─────────────────────────────────────────────────────────────────────

let _cache = null;
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — refreshes if server is long-running

// ── Internal helpers ──────────────────────────────────────────────────────────

function readFileSafe(filePath, maxChars = Infinity) {
  try {
    let content = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + "\n\n[... content truncated for context window ...]";
    }
    return content;
  } catch (_) {
    return null;
  }
}

function trainingFilePath(relativePath) {
  return path.join(INNOVA_TRAINING_PATH, relativePath);
}

function isTrainingPathAvailable() {
  try {
    fs.accessSync(INNOVA_TRAINING_PATH, fs.constants.R_OK);
    return true;
  } catch (_) {
    return false;
  }
}

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * Returns the full knowledge context string to inject into the assistant system prompt.
 * Cached for CACHE_TTL_MS.
 */
function buildKnowledgeContext() {
  const now = Date.now();
  if (_cache && now - _cacheTimestamp < CACHE_TTL_MS) {
    return _cache;
  }

  if (!isTrainingPathAvailable()) {
    const fallback = [
      "KNOWLEDGE BASE STATUS: Innova-Training documentation path is not accessible.",
      `Expected path: ${INNOVA_TRAINING_PATH}`,
      "The assistant will answer from general knowledge only — without specific Classic Visions / Innovations grounding."
    ].join("\n");
    _cache = fallback;
    _cacheTimestamp = now;
    return _cache;
  }

  const sections = [];

  sections.push("═══════════════════════════════════════════════════════════════");
  sections.push("  CLASSIC VISIONS / INNOVATIONS KNOWLEDGE BASE");
  sections.push("  Source: Innova-Training documentation repository");
  sections.push("═══════════════════════════════════════════════════════════════\n");

  // Load each knowledge file
  for (const { file, label, maxChars } of KNOWLEDGE_FILES) {
    const fullPath = trainingFilePath(file);
    const content = readFileSafe(fullPath, maxChars);
    if (content) {
      sections.push(`\n${"─".repeat(64)}`);
      sections.push(`## ${label}`);
      sections.push(`${"─".repeat(64)}\n`);
      sections.push(content);
    }
  }

  // Load a representative excerpt from the large report queries file
  const reportQueriesPath = trainingFilePath("03-report-queries.md");
  const reportQueriesContent = readFileSafe(reportQueriesPath, REPORT_QUERIES_EXCERPT_CHARS);
  if (reportQueriesContent) {
    sections.push(`\n${"─".repeat(64)}`);
    sections.push(`## Report SQL Queries (excerpt — first ${REPORT_QUERIES_EXCERPT_CHARS} chars)`);
    sections.push(`${"─".repeat(64)}\n`);
    sections.push(reportQueriesContent);
  }

  _cache = sections.join("\n");
  _cacheTimestamp = now;
  return _cache;
}

/**
 * Returns metadata about the knowledge base: which files were found,
 * their sizes, and whether the path is accessible.
 */
function getKnowledgeStatus() {
  const available = isTrainingPathAvailable();
  const files = KNOWLEDGE_FILES.map(({ file, label }) => {
    const fullPath = trainingFilePath(file);
    let sizeBytes = null;
    let found = false;
    try {
      sizeBytes = fs.statSync(fullPath).size;
      found = true;
    } catch (_) {}
    return { file, label, found, sizeBytes };
  });

  // Also check the large report queries file
  try {
    const rqStat = fs.statSync(trainingFilePath("03-report-queries.md"));
    files.push({
      file: "03-report-queries.md",
      label: "Report SQL Queries (large, excerpt loaded)",
      found: true,
      sizeBytes: rqStat.size
    });
  } catch (_) {}

  const loadedFiles = files.filter(f => f.found).length;
  const totalBytes = files.filter(f => f.found).reduce((s, f) => s + (f.sizeBytes || 0), 0);

  return {
    trainingPath: INNOVA_TRAINING_PATH,
    pathAccessible: available,
    files,
    loadedFiles,
    totalKbOnDisk: Math.round(totalBytes / 1024),
    cacheAge: _cacheTimestamp ? Math.round((Date.now() - _cacheTimestamp) / 1000) : null
  };
}

/**
 * Clears the in-memory cache, forcing a reload on the next call.
 */
function clearKnowledgeCache() {
  _cache = null;
  _cacheTimestamp = 0;
}

module.exports = { buildKnowledgeContext, getKnowledgeStatus, clearKnowledgeCache };
