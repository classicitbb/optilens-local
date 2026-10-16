// Keeps a licensed site's signed manifest current from the vendor.
//
// A manifest may carry a `renewUrl`: an HTTPS address where the vendor publishes
// the licensee's latest signed manifest. The site fetches it at start-up and
// every few hours. A newer manifest replaces data/edition.json only when it
//   - is signed with the vendor key (lib/edition-public-key.pem),
//   - names the same licence id and edition, and
//   - was issued later than the one on disk.
// That one channel carries every change the vendor makes after the sale: a trial
// becoming a paid licence (publish trial:false with a later expiry), a trial
// being extended, or a licence being withdrawn (publish revoked:true). If the
// vendor cannot be reached, the manifest on disk keeps its own expiry, so a
// trial still ends on time with no network.
const fs = require("node:fs");
const path = require("node:path");
const { MANIFEST_FILE, resetEdition, verifyManifest } = require("./edition");

const PUBLIC_KEY_FILE = path.join(__dirname, "edition-public-key.pem");
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

let lastRefresh = { at: null, status: "never", message: "Not checked yet." };

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function allowedUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url;
  return null;
}

async function readLimited(response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new Error("The renewal response is too large.");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error("The renewal response is too large.");
  return text;
}

function remember(result) {
  lastRefresh = { at: new Date().toISOString(), status: result.status, message: result.message };
  return result;
}

// One check. Never throws: the result says what happened.
async function refreshManifest(options = {}) {
  const manifestFile = options.manifestFile || MANIFEST_FILE;
  const fetchImpl = options.fetchImpl || fetch;
  const publicKey = "publicKey" in options ? options.publicKey : (fs.existsSync(PUBLIC_KEY_FILE) ? fs.readFileSync(PUBLIC_KEY_FILE, "utf8") : null);
  const onChange = options.onChange || resetEdition;

  const current = readJson(manifestFile);
  if (!current || !verifyManifest(current, publicKey)) {
    return remember({ status: "skipped", message: "There is no valid manifest on this site to renew." });
  }
  const payload = current.payload;
  if (!payload.renewUrl) return remember({ status: "skipped", message: "This licence does not renew remotely." });
  if (!payload.licenceId) return remember({ status: "skipped", message: "This manifest has no licence id, so it cannot be renewed remotely." });
  const url = allowedUrl(payload.renewUrl);
  if (!url) return remember({ status: "skipped", message: "The renewal address is not HTTPS." });

  let candidate;
  try {
    const response = await fetchImpl(url.href, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs || 15000)
    });
    if (!response.ok) return remember({ status: "unreachable", message: `The licence server answered ${response.status}.` });
    candidate = JSON.parse(await readLimited(response));
  } catch (error) {
    return remember({ status: "unreachable", message: `Could not reach the licence server: ${error.message}` });
  }

  if (!verifyManifest(candidate, publicKey)) return remember({ status: "rejected", message: "The renewal manifest is not signed with the vendor key." });
  const next = candidate.payload;
  if (next.licenceId !== payload.licenceId || next.edition !== payload.edition) {
    return remember({ status: "rejected", message: "The renewal manifest is for a different licence." });
  }
  const currentIssued = Date.parse(payload.issuedAt || "") || 0;
  const nextIssued = Date.parse(next.issuedAt || "") || 0;
  if (nextIssued < currentIssued) return remember({ status: "rejected", message: "The renewal manifest is older than the one on this site." });
  if (nextIssued === currentIssued) return remember({ status: "unchanged", message: "The licence is up to date." });

  // Write beside the target and rename, so a crash cannot leave half a manifest.
  const temp = `${manifestFile}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(candidate, null, 2)}\n`);
  fs.renameSync(temp, manifestFile);
  onChange();
  return remember({ status: "updated", message: next.revoked ? "The licence was withdrawn." : "The licence was renewed." });
}

function renewalStatus() {
  return { ...lastRefresh };
}

// Checks now and then on a timer. `onUpdate` runs after a changed manifest is saved.
function startEditionRenewal(options = {}) {
  const intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
  const run = () => refreshManifest(options)
    .then((result) => { if (result.status === "updated" && options.onUpdate) options.onUpdate(result); })
    .catch(() => {});
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

// The page a blocked module shows when the licence has ended, instead of a bare 404.
function inactivePageHtml(edition) {
  const reason = escapeHtml(edition.reason || "This feature is not available.");
  const who = edition.licensee ? ` for ${escapeHtml(edition.licensee)}` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Licence inactive</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f2;--fg:#1d1d1b;--muted:#5d5c57;--card:#fff;--line:#d9d6cf}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#f1efe9;--muted:#a9a69d;--card:#21211e;--line:#3a3935}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;padding:16px}
main{max-width:30rem;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{margin:0 0 8px;font-size:1.25rem}p{margin:0 0 12px;color:var(--muted)}a{color:inherit}
</style></head><body><main>
<h1>This licence is not active</h1>
<p>${reason}</p>
<p>OptiLens${who} is still running, but this feature is paused. Contact your OptiLens representative to continue. Your data has not been changed.</p>
<p><a href="/">Back to the dashboard</a></p>
</main></body></html>`;
}

module.exports = { inactivePageHtml, refreshManifest, renewalStatus, startEditionRenewal };
