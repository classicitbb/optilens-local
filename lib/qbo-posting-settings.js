'use strict';

// The one setting the people running the sync can change from the screen: whether clean invoices are posted
// to QuickBooks automatically. It lives in a small file beside the app data so it survives restarts and
// needs no .env edit. The server-wide master switch (OPTILENS_QBO_PRODUCTION_APPLY_ENABLED) still decides
// whether anything may be posted at all.
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'data', 'qbo-posting.json');
const OFF = Object.freeze({ autoPost: false, changedAt: null, changedBy: null });

function readPostingSettings(file = FILE) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { autoPost: saved.autoPost === true, changedAt: saved.changedAt || null, changedBy: saved.changedBy ?? null };
  } catch { return { ...OFF }; }
}

function savePostingSettings({ autoPost, changedBy = null }, file = FILE) {
  const next = { autoPost: autoPost === true, changedAt: new Date().toISOString(), changedBy };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2));
  fs.renameSync(temp, file);
  return next;
}

module.exports = { readPostingSettings, savePostingSettings };
