/**
 * Job Floor — update an order's status or stage a job in Innovations through
 * /api/job-floor. Every action previews first (dryRun) unless the operator
 * turns Preview only off; the server additionally refuses live writes unless
 * the job-floor writes setting is enabled.
 */
(function () {
  "use strict";

  var ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  var els = {};

  function byId(id) { return document.getElementById(id); }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return ESCAPES[c]; }); }

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

  function fillSelect(select, rows, valueKey, labelFn, placeholder) {
    var options = ['<option value="">' + esc(placeholder) + "</option>"];
    rows.forEach(function (r) {
      options.push('<option value="' + esc(r[valueKey]) + '">' + esc(labelFn(r)) + "</option>");
    });
    select.innerHTML = options.join("");
  }

  function showResult(message, payload, isError) {
    els.resultMsg.textContent = message;
    els.resultMsg.className = "jf-hint" + (isError ? " jf-error" : "");
    els.result.hidden = payload == null;
    els.result.textContent = payload == null ? "" : JSON.stringify(payload, null, 2);
  }

  function syncButtons() {
    var label = els.dryRun.checked ? "Preview" : "Send to Innovations";
    els.statusGo.textContent = label;
    els.stageGo.textContent = label;
  }

  async function run(path, body, button) {
    body.dryRun = els.dryRun.checked;
    button.disabled = true;
    try {
      var out = await api("/api/job-floor" + path, body);
      showResult(out.dryRun ? "Preview only — nothing was sent." : "Sent to Innovations.", out, false);
    } catch (e) {
      showResult(e.message, null, true);
    } finally {
      button.disabled = false;
    }
  }

  function onStatusSubmit(e) {
    e.preventDefault();
    var body = { statusItemId: Number(els.statusItem.value), note: els.statusNote.value.trim() || undefined };
    body[els.statusBy.value] = els.statusValue.value.trim();
    run("/status-update", body, els.statusGo);
  }

  function onStageSubmit(e) {
    e.preventDefault();
    var body = { actionId: els.stageAction.value ? Number(els.stageAction.value) : undefined };
    body[els.stageBy.value] = els.stageValue.value.trim();
    run("/stage", body, els.stageGo);
  }

  function renderQueues(rows) {
    if (!rows.length) { els.queues.innerHTML = '<p class="jf-hint">No job queues returned.</p>'; return; }
    var cols = ["ID", "name", "priority", "inQueueStatus", "outQueueStatus", "trayRangeLow", "trayRangeHigh"].filter(function (k) { return k in rows[0]; });
    els.queues.innerHTML = "<table><thead><tr>" + cols.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") +
      "</tr></thead><tbody>" + rows.map(function (r) {
        return "<tr>" + cols.map(function (c) { return "<td>" + esc(r[c]) + "</td>"; }).join("") + "</tr>";
      }).join("") + "</tbody></table>";
  }

  async function loadLists() {
    els.mode.textContent = "Checking…";
    els.mode.className = "badge planned";
    try {
      var results = await Promise.all([
        api("/api/job-floor/status"),
        api("/api/job-floor/status-items"),
        api("/api/job-floor/staging-actions"),
        api("/api/job-floor/job-queues")
      ]);
      els.mode.textContent = results[0].writesEnabled ? "Live writes enabled" : "Writes disabled";
      els.mode.className = "badge " + (results[0].writesEnabled ? "ready" : "planned");
      var statuses = results[1].rows.filter(function (r) { return !r.inactive && (r.showInMobileApp || r.showInQuickUpdate); });
      fillSelect(els.statusItem, statuses.length ? statuses : results[1].rows, "ID", function (r) { return r.name || r.ID; }, "Choose a status");
      fillSelect(els.stageAction, results[2].rows, "ID", function (r) { return r.description || r.ID; }, "Default action");
      renderQueues(results[3].rows);
    } catch (e) {
      els.mode.textContent = "Innovations unavailable";
      els.mode.className = "badge blocked";
      showResult(e.message, null, true);
    }
  }

  function init() {
    ["mode", "reload", "dryRun", "statusForm", "statusBy", "statusValue", "statusItem", "statusNote", "statusGo",
      "stageForm", "stageBy", "stageValue", "stageAction", "stageGo", "resultMsg", "result", "queues"].forEach(function (k) {
      els[k] = byId("jf" + k.charAt(0).toUpperCase() + k.slice(1));
    });
    els.statusForm.addEventListener("submit", onStatusSubmit);
    els.stageForm.addEventListener("submit", onStageSubmit);
    els.dryRun.addEventListener("change", syncButtons);
    els.reload.addEventListener("click", loadLists);
    syncButtons();
    loadLists();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
