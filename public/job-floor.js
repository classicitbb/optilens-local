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

  var LABELS = { trayId: "Tray ID", rxNumber: "RX number", orderId: "Order ID" };
  var MAX_LOG = 200;

  function logLine(ok, text) {
    var first = els.log.firstElementChild;
    if (first && first.className === "jf-log-empty") els.log.removeChild(first);
    var li = document.createElement("li");
    li.className = ok ? "jf-log-ok" : "jf-log-fail";
    li.textContent = (ok ? "✓ " : "✗ ") + text;
    els.log.insertBefore(li, els.log.firstChild);
    while (els.log.children.length > MAX_LOG) els.log.removeChild(els.log.lastChild);
  }

  function showDetail(payload) {
    els.details.hidden = payload == null;
    els.result.textContent = payload == null ? "" : JSON.stringify(payload, null, 2);
  }

  function syncButtons() {
    var label = els.dryRun.checked ? "Preview" : "Send to Innovations";
    els.statusGo.textContent = label;
  }

  function describe(out, statusName, label, value) {
    var plan = out.dryRun ? out.plan : out.result;
    var where = label + ": " + value;
    if (out.dryRun) return "Preview: " + statusName + " would apply to " + where + (plan && plan.alreadyApplied ? " (already at this status)" : "");
    if (plan && plan.alreadyApplied) return statusName + " already set on " + where;
    return statusName + " applied to " + where;
  }

  async function onStatusSubmit(e) {
    e.preventDefault();
    var by = els.statusBy.value;
    var value = els.statusValue.value.trim();
    var statusName = els.statusItem.options[els.statusItem.selectedIndex].text;
    if (!value || !els.statusItem.value) return;
    var body = { statusItemId: Number(els.statusItem.value), dryRun: els.dryRun.checked };
    body[by] = value;
    els.statusGo.disabled = true;
    try {
      var out = await api("/api/job-floor/status-update", body);
      logLine(true, describe(out, statusName, LABELS[by], value));
      showDetail(out);
    } catch (err) {
      logLine(false, LABELS[by] + ": " + value + " — " + err.message);
      showDetail(null);
    } finally {
      els.statusGo.disabled = false;
      els.statusValue.value = "";
      els.statusValue.focus();
    }
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
      logLine(false, e.message);
    }
  }

  function init() {
    ["mode", "reload", "dryRun", "statusForm", "statusBy", "statusValue", "statusItem", "statusGo",
      "valueLabel", "log", "details", "result"].forEach(function (k) {
      els[k] = byId("jf" + k.charAt(0).toUpperCase() + k.slice(1));
    });
    els.statusForm.addEventListener("submit", onStatusSubmit);
    els.dryRun.addEventListener("change", syncButtons);
    els.statusBy.addEventListener("change", function () {
      els.valueLabel.textContent = LABELS[els.statusBy.value];
      els.statusValue.inputMode = els.statusBy.value === "rxNumber" ? "text" : "numeric";
      els.statusValue.focus();
    });
    els.reload.addEventListener("click", loadLists);
    syncButtons();
    loadLists();
    els.statusValue.focus();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
