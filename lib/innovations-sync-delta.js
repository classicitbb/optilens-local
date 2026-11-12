/**
 * innovations-sync-delta.js — "send only what changed" for the Innovations cloud sync.
 *
 * For each entity we remember a short fingerprint of every row we last delivered,
 * keyed on the entity's immutable Innovations id. A run sends only rows that are
 * new or whose fingerprint changed. Fingerprints are committed only after the whole
 * entity was delivered without a failure, so anything not acknowledged is resent.
 *
 * The receiver never deletes rows it did not receive, so skipping unchanged rows
 * is safe. A full run (opts.full) ignores fingerprints and resends everything,
 * which self-heals any drift on the website side.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DIR = process.env.OPTILENS_SYNC_FINGERPRINT_DIR
  || path.join(__dirname, '..', 'data', 'sync-fingerprints');

// Stamped with "now" on every read, so they must not count as a change.
const VOLATILE_FIELDS = new Set(['synced_at', 'last_synced_at']);

function fingerprint(record) {
  const stable = {};
  for (const key of Object.keys(record).sort()) {
    if (!VOLATILE_FIELDS.has(key)) stable[key] = record[key];
  }
  return crypto.createHash('sha1').update(JSON.stringify(stable)).digest('base64').slice(0, 16);
}

function fileFor(entity, dir = DEFAULT_DIR) {
  return path.join(dir, `${entity}.json`);
}

function load(entity, dir = DEFAULT_DIR) {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(entity, dir), 'utf8'));
    return parsed && typeof parsed.rows === 'object' && parsed.rows ? parsed.rows : {};
  } catch {
    return {};
  }
}

function save(entity, rows, dir = DEFAULT_DIR) {
  const file = fileFor(entity, dir);
  const temporary = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify({ updatedAt: new Date().toISOString(), rows }), 'utf8');
  fs.renameSync(temporary, file);
}

/**
 * @returns {{ changed: object[], unchanged: number, next: Record<string,string> }}
 * `next` holds fingerprints for every current row; pass it to save() once delivered.
 */
function filterChanged(records, key, previous = {}, { full = false } = {}) {
  const next = {};
  const changed = [];
  let unchanged = 0;
  for (const record of records) {
    const id = String(record[key]);
    const print = fingerprint(record);
    next[id] = print;
    if (!full && previous[id] === print) unchanged++;
    else changed.push(record);
  }
  return { changed, unchanged, next };
}

module.exports = { fingerprint, filterChanged, load, save, fileFor, VOLATILE_FIELDS };
