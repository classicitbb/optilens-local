const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR = process.env.OPTILENS_SYNC_LOG_DIR || path.join(__dirname, '..', 'data', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'innovations-sync.jsonl');
const ROTATED_FILE = `${LOG_FILE}.1`;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_EVENTS = 100;

function trim(value, length = 500) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, length);
}

function rotateIfNeeded() {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size >= MAX_BYTES) {
      fs.rmSync(ROTATED_FILE, { force: true });
      fs.renameSync(LOG_FILE, ROTATED_FILE);
    }
  } catch {
    // Logging must never turn a read-only source sync into a failed run.
  }
}

function write(event, details = {}) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateIfNeeded();
    // Deliberately accept only run metadata. Never write credentials or source
    // payloads to this operator log.
    fs.appendFileSync(LOG_FILE, `${JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...details,
    })}\n`, 'utf8');
  } catch {
    // Best effort only; the caller still has the cloud run/dead-letter record.
  }
}

function readRecent(limit = 50) {
  const max = Math.min(Math.max(Number(limit) || 50, 1), MAX_EVENTS);
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    return fs.readFileSync(LOG_FILE, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-max)
      .map((line) => {
        try { return JSON.parse(line); } catch { return { event: 'log.parse_error' }; }
      });
  } catch {
    return [];
  }
}

function summarizeEntities(entities) {
  return Object.fromEntries(Object.entries(entities || {}).map(([name, entity]) => [name, {
    ok: !!entity.ok,
    read: Number(entity.read || 0),
    received: Number(entity.received || 0),
    upserted: Number(entity.upserted || 0),
    failed: Number(entity.failed || 0),
    batches: Number(entity.batches || 0),
    error: entity.error ? trim(entity.error) : undefined,
  }]));
}

module.exports = { LOG_FILE, write, readRecent, summarizeEntities, trim };
