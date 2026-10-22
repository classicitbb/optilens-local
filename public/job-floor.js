/**
 * Job Floor — update an order's status in Innovations, found by tray number,
 * RX number or order ID, through /api/job-floor. Every update previews first (dryRun) unless the operator
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
  }

  async function run(path, body, button) {
    body.dryRun = els.dryRun.checked;
    button.disabled = true;
    try {
      var out = await api("/api/job-floor" + path, body);
      showResult(out.dryRun ? "Preview only — nothing was sent." : "Status updated in Innovations.", out, false);
    } catch (e) {
      showResult(e.message, null, true);
    } finally {
      button.disabled = false;
    }
  }

  function onStatusSubmit(e) {
    e.preventDefault();
    var body = { statusItemId: Number(els.statusItem.value) };
    body[els.statusBy.value] = els.statusValue.value.trim();
    run("/status-update", body, els.statusGo);
  }

  async function loadLists() {
    els.mode.textContent = "Checking…";
    els.mode.className = "badge planned";
    try {
      var results = await Promise.all([
        api("/api/job-floor/status"),
        api("/api/job-floor/status-items")
      ]);
      els.mode.textContent = results[0].writesEnabled ? "Live writes enabled" : "Writes disabled";
      els.mode.className = "badge " + (results[0].writesEnabled ? "ready" : "planned");
      fillSelect(els.statusItem, results[1].rows, "ID", function (r) { return r.name || r.ID; }, "Choose a status");
    } catch (e) {
      els.mode.textContent = "Innovations unavailable";
      els.mode.className = "badge blocked";
      showResult(e.message, null, true);
    }
  }

  function init() {
    ["mode", "reload", "dryRun", "statusForm", "statusBy", "statusValue", "statusItem", "statusGo",
      "resultMsg", "result"].forEach(function (k) {
      els[k] = byId("jf" + k.charAt(0).toUpperCase() + k.slice(1));
    });
    els.statusForm.addEventListener("submit", onStatusSubmit);
    els.dryRun.addEventListener("change", syncButtons);
    els.reload.addEventListener("click", loadLists);
    syncButtons();
    loadLists();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
