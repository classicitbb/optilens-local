#!/usr/bin/env node
/**
 * rx-order-trace.js — follow one released Rx web order through the host.
 *
 *   node scripts/rx-order-trace.js <submission-id | quote-id | file-name fragment>
 *
 * Reports, from this machine: the "OptiLens Rx Submissions" poll task, every
 * rx_submission.* event in the sync log for that order (claimed / finished /
 * failed), the .rx file it names, and whether that file is still waiting in
 * the Innovations Incoming folder (not yet consumed) or has been picked up.
 * Read-only. The website half (rx_order_submissions + rx_order_events) is in
 * the CVWeb repo's docs/RX_ORDER_TRACE.md.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const needle = (process.argv[2] || '').toLowerCase();
if (!needle) { console.error('Usage: node scripts/rx-order-trace.js <submission-id | quote-id | file-name fragment>'); process.exit(2); }

const root = path.join(__dirname, '..');
const logDir = process.env.OPTILENS_SYNC_LOG_DIR || path.join(root, 'data', 'logs');
const incoming = JSON.parse(fs.readFileSync(path.join(root, 'data', 'rx', 'config.json'), 'utf8')).folders.incoming;

const events = [];
for (const f of ['innovations-sync.jsonl.1', 'innovations-sync.jsonl']) {
  const p = path.join(logDir, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.includes('rx_submission') || !line.toLowerCase().includes(needle)) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
}
// A file-name needle matches only the "finished" line; pull in the claim for the same id.
const ids = new Set(events.map((e) => e.id));
for (const f of ['innovations-sync.jsonl.1', 'innovations-sync.jsonl']) {
  const p = path.join(logDir, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.includes('rx_submission')) continue;
    try { const e = JSON.parse(line); if (ids.has(e.id) && !events.some((x) => x.at === e.at && x.event === e.event)) events.push(e); } catch { /* ignore */ }
  }
}
events.sort((a, b) => a.at.localeCompare(b.at));

const task = spawnSync('powershell', ['-NoProfile', '-Command',
  "$i = Get-ScheduledTaskInfo -TaskName 'OptiLens Rx Submissions'; \"$($i.LastRunTime) result=$($i.LastTaskResult) next=$($i.NextRunTime)\""], { encoding: 'utf8' });
console.log(`Poll task   : ${(task.stdout || task.stderr || 'unavailable').trim()}`);
console.log(`Incoming    : ${incoming} (${fs.existsSync(incoming) ? 'reachable' : 'NOT REACHABLE — drops will fail'})`);
if (!events.length) { console.log(`\nNo rx_submission events matching "${needle}" in the sync log: not claimed yet (is it Released/approved on the website?), or the log has rotated.`); process.exit(1); }
console.log('\nHost events :');
for (const e of events) console.log(`  ${e.at}  ${e.event}${e.transport ? ` [${e.transport}]` : ''}${e.ok === false ? ' FAILED' : ''}${e.file ? ` ${e.file}` : ''}${e.error ? ` — ${e.error}` : ''}`);
const file = events.map((e) => e.file).filter(Boolean).pop();
if (file && fs.existsSync(incoming)) {
  const stem = file.toLowerCase();
  const here = fs.readdirSync(incoming).filter((n) => n.toLowerCase().startsWith(stem.replace(/\.rx$/, '')));
  console.log(`\nFile        : ${file}`);
  console.log(here.length ? `  still in Incoming: ${here.join(', ')} (Innovations has not consumed it yet)` : '  no longer in Incoming: consumed by Innovations (or moved)');
}
