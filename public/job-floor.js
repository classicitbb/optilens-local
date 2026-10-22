/**
 * Status Update — the Innovations Mobile app's Status Update screen, for any browser or
 * scanner: pick a status, scan or type a tray ID, press Enter (scanners send it). There is no
 * submit button. Each entry is queued so a fast scanner never loses a tray, and the field
 * clears and keeps focus. Calls /api/job-floor/status-update; the server decides whether
 * a write is live or a preview.
 */
(function () {
  "use strict";

  var ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  var STATUS_KEY = "jobFloor.statusItemId";
  var MAX_LOG = 200;
  var els = {};
  var state = { writesEnabled: false };
  var queue = Promise.resolve();

  function byId(id) { return document.getElementById(id); }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return ESCAPES[c]; }); }

  function remember(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } }
  function recall(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

  async function api(url, body) {
    var res = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store"
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ("Request failed (HTTP " + res.status + ")"));
    return data;
  }

  function fillStatuses(rows) {
    var keep = els.statusItem.value;
    var options = ['<option value="">Choose a status</option>'];
    rows.forEach(function (r) {
      var off = r.writable === false;
      options.push('<option value="' + esc(r.ID) + '"' + (off ? " disabled" : "") + ">" +
        esc(r.name + (off && r.reason ? " (" + r.reason + ")" : "")) + "</option>");
    });
    els.statusItem.innerHTML = options.join("");
    var writable = rows.filter(function (r) { return r.writable !== false; });
    var wanted = keep || recall(STATUS_KEY);
    var pick = writable.filter(function (r) { return String(r.ID) === wanted; })[0] || writable[0];
    if (pick) els.statusItem.value = String(pick.ID);
  }

  function setIcon(stateName) {
    els.icon.className = "jf-icon" + (stateName ? " is-" + stateName : "");
  }

  function logLine(ok, text) {
    var first = els.log.firstElementChild;
    if (first && first.className === "jf-log-empty") els.log.removeChild(first);
    var li = document.createElement("li");
    if (!ok) li.className = "jf-log-fail";
    li.textContent = text;
    els.log.insertBefore(li, els.log.firstChild);
    els.log.scrollTop = 0;
    while (els.log.children.length > MAX_LOG) els.log.removeChild(els.log.lastChild);
    setIcon(ok ? "ok" : "fail");
  }

  function describe(out, statusName, value) {
    var plan = out.dryRun ? out.plan : out.result;
    var where = "Tray ID: " + value + (plan && plan.holdsNotEvaluated ? " (hold rules not evaluated)" : "");
    if (out.dryRun) return "Preview: " + statusName + " would apply to " + where + (plan && plan.alreadyApplied ? " (already at this status)" : "");
    if (plan && plan.alreadyApplied) return statusName + " already set on " + where;
    return statusName + " applied to " + where;
  }

  async function processEntry(statusItemId, statusName, value, dryRun) {
    try {
      var out = await api("/api/job-floor/status-update", { trayId: value, statusItemId: statusItemId, dryRun: dryRun });
      logLine(true, describe(out, statusName, value));
    } catch (err) {
      logLine(false, "Tray ID: " + value + " — " + err.message);
    }
  }

  // Capture the entry synchronously, clear the field at once, and process in order.
  function submit() {
    var value = els.statusValue.value.trim();
    if (!value) return;
    if (!els.statusItem.value) { logLine(false, "Choose a status first."); return; }
    var statusItemId = Number(els.statusItem.value);
    var statusName = els.statusItem.options[els.statusItem.selectedIndex].text;
    var dryRun = !state.writesEnabled;
    els.statusValue.value = "";
    queue = queue.then(function () { return processEntry(statusItemId, statusName, value, dryRun); });
  }

  async function loadStatuses() {
    try {
      var results = await Promise.all([api("/api/job-floor/status"), api("/api/job-floor/status-items")]);
      state.writesEnabled = Boolean(results[0].writesEnabled);
      // Keep the existing default: live only when the server allows writes.
      fillStatuses(results[1].rows);
    } catch (e) {
      state.writesEnabled = false;
      logLine(false, e.message);
    }
  }

  function init() {
    ["statusForm", "statusItem", "statusValue", "log", "icon"].forEach(function (k) {
      els[k] = byId("jf" + k.charAt(0).toUpperCase() + k.slice(1));
    });
    els.statusForm.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
    els.statusValue.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });
    els.statusItem.addEventListener("change", function () {
      remember(STATUS_KEY, els.statusItem.value);
      els.statusValue.focus();
    });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) loadStatuses(); });
    loadStatuses();
    els.statusValue.focus();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
