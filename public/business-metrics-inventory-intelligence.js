/**
 * Business Metrics - Inventory Intelligence cockpit.
 *
 * Internal staff decision support. Everything here is a view of what the server
 * calculated and a way to record a human decision; the page calculates nothing.
 *
 * Structure: the shell (header, cards, navigation, toolbar) is built once and its
 * parts are updated in place, so typing in the search box never loses focus. The
 * drawer and the form modal are native <dialog> elements outside the shell.
 * Clicks are handled by one delegated listener keyed on data-action.
 *
 * Failure states are shown, never hidden: a failed request is an "unavailable"
 * message with a retry, not an empty queue or a zero.
 */
(function () {
  "use strict";

  var BASE = "/api/inventory-intelligence/";
  var PAGE_SIZE = 50;

  var QUEUES = [
    { key: "ALL", label: "All active" },
    { key: "ORDER_MORE", label: "Order More" },
    { key: "ORDER_LESS", label: "Order Less" },
    { key: "WRITE_OFF_REVIEW", label: "Write-Off Review" },
    { key: "SHELF_CHECK", label: "Shelf Check" },
    { key: "PENDING_APPROVAL", label: "Pending Approval" },
    { key: "ALREADY_COVERED_BY_PO", label: "Already Covered by PO" }
  ];
  var TYPE_LABELS = {
    ORDER_MORE: "Order more", ORDER_LESS: "Order less", WRITE_OFF_REVIEW: "Write-off review",
    SHELF_CHECK: "Shelf check", ALREADY_COVERED_BY_PO: "Covered by PO", DATA_REVIEW: "Data review"
  };
  var STATUS_LABELS = {
    OPEN: "Open", PENDING_APPROVAL: "Pending approval", APPROVED: "Approved", REJECTED: "Rejected",
    SUPERSEDED: "Superseded", APPLIED: "Reviewed", CANCELLED: "Cancelled"
  };
  var TASK_LABELS = {
    APPROVE_REPLENISHMENT_CHANGE: "Approve replenishment change", REVIEW_SUGGESTED_PO: "Review suggested PO",
    COUNT_SHELF: "Count shelf", REVIEW_WRITE_OFF: "Review write-off", REVIEW_OVERSTOCK: "Review overstock",
    RESOLVE_SUPPLIER_MAPPING: "Resolve supplier mapping", CORRECT_ITEM_DATA: "Correct item data"
  };
  var PRIORITY_LABELS = { CRITICAL: "Critical", HIGH: "High", MEDIUM: "Medium", LOW: "Low", INFO: "Info", NONE: "-" };
  var SETTINGS_TYPES = ["ORDER_MORE", "ORDER_LESS"];
  var REVIEW_TYPES = ["WRITE_OFF_REVIEW", "DATA_REVIEW", "SHELF_CHECK"];
  var UNDECIDED = ["OPEN", "PENDING_APPROVAL"];
  var AUDIT_ACTIONS = [
    "SCAN_STARTED", "SCAN_COMPLETED", "SCAN_FAILED", "RECOMMENDATION_GENERATED", "RECOMMENDATION_REVISED", "RECOMMENDATION_RETIRED",
    "RECOMMENDATION_APPROVED", "RECOMMENDATION_EDITED", "RECOMMENDATION_EDIT_APPROVED", "RECOMMENDATION_REJECTED",
    "RECOMMENDATION_REVIEW_COMPLETED", "SETTINGS_WRITTEN", "TASK_CREATED", "TASK_ASSIGNED", "TASK_STATUS_CHANGE",
    "STOCK_COUNT_RECORDED", "RECALCULATION_REQUESTED", "DRAFT_PO_GENERATED"
  ];

  var state = {
    root: null, started: false,
    view: "queue",               // queue | draft-po | audit
    queue: "ALL", status: "ACTIVE", search: "", sortBy: "onHand", sortDir: "ASC", offset: 0,
    canApprove: false,
    summary: null, summaryError: null,
    list: null, listError: null, listLoading: false,
    draft: null, draftError: null, draftLoading: false,
    audit: null, auditError: null, auditLoading: false, auditFilter: { action: "", entityType: "", scanRunId: "" },
    scans: null,
    selected: {},                // recommendationId -> true
    evidenceShare: 64,           // percentage of the queue table reserved for source evidence
    detail: null, detailError: null, detailId: null,
    pollTimer: null, pollCount: 0
  };

  var els = {};

  /* ───────────── helpers ───────────── */

  var BM = window.BM || {};
  var esc = BM.esc || function (value) {
    return value == null ? "" : String(value).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  };

  function num(value, digits) {
    if (value == null || value === "" || isNaN(Number(value))) return "-";
    return Number(value).toLocaleString("en-US", { maximumFractionDigits: digits == null ? 0 : digits });
  }
  function money(value) {
    if (value == null || isNaN(Number(value))) return "-";
    return "$" + Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function when(iso) {
    if (!iso) return "-";
    var d = new Date(iso);
    return isNaN(d.getTime()) ? "-" : d.toLocaleString();
  }
  function ago(iso) {
    if (!iso) return "";
    var minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + " min ago";
    var hours = Math.round(minutes / 60);
    if (hours < 48) return hours + " h ago";
    return Math.round(hours / 24) + " days ago";
  }
  function el(id) { return document.getElementById(id); }
  function label(map, key) { return map[key] || key || "-"; }

  function newKey() {
    var id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
    return "ii-" + id;
  }

  function apiError(message, status, code) {
    var error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
  }

  /** One place that talks to the server. Mutations carry an Idempotency-Key. */
  async function api(path, options) {
    options = options || {};
    var init = { method: options.method || "GET", cache: "no-store", headers: {}, credentials: "same-origin" };
    if (init.method !== "GET") {
      init.headers["Content-Type"] = "application/json";
      init.headers["Idempotency-Key"] = options.key || newKey();
      init.body = JSON.stringify(options.body || {});
    }
    var response;
    try {
      response = await fetch(BASE + path, init);
    } catch (networkError) {
      throw apiError("Could not reach the server. Check the connection and try again.", 0, "NETWORK");
    }
    var data = null;
    try { data = await response.json(); } catch (parseError) { data = null; }
    if (!response.ok) {
      var message = (data && data.error) || ("The request failed (HTTP " + response.status + ").");
      if (response.status === 401) message = "Your session has expired. Sign in again.";
      throw apiError(message, response.status, data && data.code);
    }
    return data;
  }

  var liveTimer = null;
  /** Announces a result politely to screen readers and shows it in the banner. */
  function notify(message, tone) {
    var region = el("iiNotice");
    if (!region) return;
    region.hidden = !message;
    region.dataset.tone = tone || "info";
    region.querySelector(".grow").textContent = message || "";
    clearTimeout(liveTimer);
    if (message && tone !== "error") liveTimer = setTimeout(function () { notify(""); }, 9000);
  }

  /* ───────────── data loading ───────────── */

  async function loadSummary() {
    try {
      state.summary = await api("summary");
      state.canApprove = Boolean(state.summary.capabilities && state.summary.capabilities.canApprove);
      state.summaryError = null;
    } catch (error) {
      state.summaryError = error.message;
    }
    renderHeader();
    renderCards();
    renderNav();
  }

  async function loadList() {
    state.listLoading = true;
    renderResults();
    var params = new URLSearchParams({
      queue: state.queue, status: state.status, search: state.search,
      sortBy: state.sortBy, sortDir: state.sortDir, limit: String(PAGE_SIZE), offset: String(state.offset)
    });
    try {
      state.list = await api("queue?" + params.toString());
      state.listError = null;
    } catch (error) {
      state.listError = error.message;
    }
    state.listLoading = false;
    pruneSelection();
    renderResults();
    renderBulk();
  }

  async function loadDraft() {
    state.draftLoading = true;
    renderDraft();
    try {
      state.draft = await api("draft-po");
      state.draftError = null;
    } catch (error) {
      state.draftError = error.message;
    }
    state.draftLoading = false;
    renderDraft();
  }

  async function loadAudit() {
    state.auditLoading = true;
    renderAudit();
    var params = new URLSearchParams({ limit: "100" });
    if (state.auditFilter.action) params.set("action", state.auditFilter.action);
    if (state.auditFilter.entityType) params.set("entityType", state.auditFilter.entityType);
    if (state.auditFilter.scanRunId) params.set("scanRunId", state.auditFilter.scanRunId);
    try {
      var results = await Promise.all([api("audit?" + params.toString()), api("scan/status?limit=10")]);
      state.audit = results[0].auditEvents;
      state.scans = results[1];
      state.auditError = null;
    } catch (error) {
      state.auditError = error.message;
    }
    state.auditLoading = false;
    renderAudit();
  }

  function refreshAll() {
    loadSummary();
    if (state.view === "queue") loadList();
    else if (state.view === "draft-po") loadDraft();
    else loadAudit();
  }

  function pruneSelection() {
    if (!state.list) return;
    var present = {};
    state.list.items.forEach(function (r) { present[r.recommendationId] = true; });
    Object.keys(state.selected).forEach(function (id) { if (!present[id]) delete state.selected[id]; });
  }

  /** After a scan is requested, watch until the queue drains, then refresh. */
  function watchScan() {
    clearTimeout(state.pollTimer);
    state.pollCount = 0;
    (function tick() {
      state.pollCount += 1;
      api("scan/status").then(function (status) {
        var running = (status.latestScan && status.latestScan.status === "RUNNING") || status.pendingRequests > 0;
        if (running && state.pollCount < 120) {
          state.pollTimer = setTimeout(tick, 3000);
          return;
        }
        refreshAll();
        if (status.latestScan && status.latestScan.status === "FAILED") {
          notify("The scan could not read the source data. The queues still show the last completed scan.", "error");
        } else {
          notify("Scan finished. Queues are up to date.", "info");
        }
      }).catch(function () {
        if (state.pollCount < 120) state.pollTimer = setTimeout(tick, 5000);
      });
    })();
  }

  /* ───────────── shell ───────────── */

  function buildShell() {
    state.root.innerHTML =
      '<div class="ii-header" id="iiHeader"></div>' +
      '<div class="ii-banner" id="iiNotice" role="status" aria-live="polite" hidden><span class="grow"></span>' +
        '<button type="button" class="ii-btn small" data-action="dismiss-notice">Dismiss</button></div>' +
      '<div id="iiScanBanner"></div>' +
      '<div class="ii-cards" id="iiCards" role="group" aria-label="Work queues"></div>' +
      '<div class="ii-nav" id="iiNav"></div>' +
      '<div id="iiQueueView">' +
        '<div class="ii-toolbar ii-queue-toolbar">' +
          '<div class="ii-toolbar-group">' +
            '<label class="ii-field">Search<input class="ii-input ii-search" id="iiSearch" type="search" placeholder="Item, SKU or supplier" autocomplete="off"></label>' +
            '<label class="ii-field">Show<select class="ii-select" id="iiStatus">' +
              '<option value="ACTIVE">Awaiting action</option><option value="DECIDED">Decided</option><option value="ALL">Everything</option></select></label>' +
          '</div>' +
          '<div class="ii-toolbar-group" id="iiBulk"></div>' +
        '</div>' +
        '<div id="iiResults"></div>' +
        '<div class="ii-pager" id="iiPager"></div>' +
      '</div>' +
      '<div id="iiPoView" hidden></div>' +
      '<div id="iiAuditView" hidden></div>';

    // Dialogs live outside the shell so re-rendering never closes them.
    ["iiDrawer", "iiModal"].forEach(function (id) {
      if (el(id)) return;
      var dialog = document.createElement("dialog");
      dialog.id = id;
      dialog.className = "ii-dialog " + (id === "iiDrawer" ? "drawer" : "modal");
      dialog.setAttribute("closedby", "any");
      dialog.setAttribute("aria-labelledby", id + "Title");
      document.body.appendChild(dialog);
      // Light dismiss for browsers without the closedby attribute.
      if (!("closedBy" in HTMLDialogElement.prototype)) {
        dialog.addEventListener("click", function (event) {
          if (event.target !== dialog) return;
          var r = dialog.getBoundingClientRect();
          var inside = r.top <= event.clientY && event.clientY <= r.top + r.height && r.left <= event.clientX && event.clientX <= r.left + r.width;
          if (!inside) dialog.close();
        });
      }
      dialog.addEventListener("click", onClick);
      dialog.addEventListener("submit", onSubmit);
    });
    el("iiDrawer").addEventListener("close", function () { state.detail = null; state.detailId = null; });

    state.root.addEventListener("click", onClick);
    state.root.addEventListener("change", onChange);

    var search = el("iiSearch");
    var timer;
    search.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        state.search = search.value.trim();
        state.offset = 0;
        loadList();
      }, 300);
    });
    el("iiStatus").addEventListener("change", function (event) {
      state.status = event.target.value;
      state.offset = 0;
      loadList();
    });
  }

  function renderHeader() {
    var s = state.summary;
    var scan = s && s.dataScan;
    var html = '<div><p>Deterministic replenishment recommendations from stock, usage and open purchase orders. Staff only. ' +
      'Nothing here orders, writes to Innovations or changes the lens table; approving a recommendation records an approved setting in this app.</p></div>' +
      '<div class="ii-scan">';
    if (scan) {
      html += '<span>Queues reflect the scan completed <strong>' + esc(when(scan.completedAt || scan.startedAt)) + '</strong> (' + esc(ago(scan.completedAt || scan.startedAt)) + ')</span>' +
        '<span>' + num(scan.itemsEvaluated) + ' items evaluated' + (scan.evidenceAsOf ? ' · source read ' + esc(when(scan.evidenceAsOf)) : '') + '</span>';
    } else if (!state.summaryError) {
      html += '<span><strong>No completed scan yet</strong></span>';
    }
    html += (state.canApprove
      ? '<button type="button" class="ii-btn" data-action="run-scan" id="iiRunScan">Run full scan</button>'
      : '<span class="ii-sub">View-only access: decisions are disabled.</span>');
    html += '</div>';
    el("iiHeader").innerHTML = html;

    var banner = el("iiScanBanner");
    if (state.summaryError) {
      banner.innerHTML = '<div class="ii-banner" data-tone="error" role="alert"><span class="grow"><strong>Inventory Intelligence is unavailable.</strong> ' + esc(state.summaryError) +
        ' No counts are shown because none can be trusted right now.</span><button type="button" class="ii-btn small" data-action="refresh">Retry</button></div>';
    } else if (s && s.message) {
      var tone = s.dataStatus === "scanning" || s.dataStatus === "never_scanned" ? "info" : (s.dataStatus === "stale" ? "warn" : "error");
      var caveats = (s.sourceCaveats || []).map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("");
      banner.innerHTML = '<div class="ii-banner" data-tone="' + tone + '"><span class="grow">' + esc(s.message) + '</span>' +
        (caveats ? '<details><summary>About this data</summary><ul>' + caveats + '</ul></details>' : '') + '</div>';
    } else if (s && (s.sourceCaveats || []).length) {
      banner.innerHTML = '<div class="ii-banner ii-about-banner"><details class="grow"><summary>About this data</summary><ul>' +
        s.sourceCaveats.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + '</ul></details></div>';
    } else {
      banner.innerHTML = "";
    }
  }

  function renderCards() {
    var host = el("iiCards");
    if (state.summaryError || !state.summary) {
      var placeholder = QUEUES.filter(function (q) { return q.key !== "ALL"; });
      host.innerHTML = placeholder.map(function (q) {
        return '<button type="button" class="ii-card" data-action="queue" data-queue="' + esc(q.key) + '" data-state="unavailable" aria-pressed="' + (state.queue === q.key) + '">' +
          '<span class="ii-card-top"><span class="ii-card-title">' + esc(q.label) + '</span></span>' +
          '<span class="ii-card-count na">' + (state.summaryError ? "Data unavailable" : "Loading...") + '</span>' +
          '<span class="ii-card-context">' + (state.summaryError ? "Could not load" : "") + '</span></button>';
      }).join("");
      return;
    }
    host.innerHTML = state.summary.cards.map(function (c) {
      var tone = c.priority === "CRITICAL" ? "critical" : (c.priority === "HIGH" ? "high" : (c.priority === "MEDIUM" ? "medium" : "muted"));
      var countHtml = c.status === "unavailable"
        ? '<span class="ii-card-count na">Data unavailable</span>'
        : '<span class="ii-card-count">' + num(c.count) + '</span>';
      return '<button type="button" class="ii-card" data-action="queue" data-queue="' + esc(c.cardKey) + '" data-state="' + esc(c.status) + '" aria-pressed="' + (state.queue === c.cardKey) + '" title="' + esc(c.queueMeaning) + '">' +
        '<span class="ii-card-top"><span class="ii-card-title">' + esc(c.title) + '</span>' +
          (c.status === "ready" ? '<span class="ii-badge" data-tone="' + tone + '">' + esc(label(PRIORITY_LABELS, c.priority)) + '</span>' : '') + '</span>' +
        countHtml +
        '<span class="ii-card-context">' + esc(c.unitContext) + '</span></button>';
    }).join("");
  }

  function renderNav() {
    var chips = QUEUES.map(function (q) {
      return '<button type="button" class="ii-chip" data-action="queue" data-queue="' + q.key + '" aria-pressed="' + (state.view === "queue" && state.queue === q.key) + '">' + esc(q.label) + '</button>';
    }).join("");
    var views = [["queue", "Work queue"], ["draft-po", "Draft PO preview"], ["audit", "Audit and scans"]].map(function (v) {
      return '<button type="button" class="ii-chip" data-action="view" data-view="' + v[0] + '" aria-current="' + (state.view === v[0]) + '">' + v[1] + '</button>';
    }).join("");
    el("iiNav").innerHTML = '<div class="ii-chips" role="group" aria-label="Queue filter">' + chips + '</div><div class="ii-views" role="group" aria-label="View">' + views + '</div>';
    el("iiQueueView").hidden = state.view !== "queue";
    el("iiPoView").hidden = state.view !== "draft-po";
    el("iiAuditView").hidden = state.view !== "audit";
  }

  /* ───────────── queue table ───────────── */

  var COLUMNS = [
    { key: "itemLabel", label: "Item", sort: true },
    { key: "supplierName", label: "Supplier", sort: true },
    { key: "onHand", label: "On hand", sort: true, num: true },
    { key: "openPoQuantity", label: "Open PO", sort: true, num: true },
    { key: "usage30", label: "30-day usage", shortLabel: "30d use", sort: true, num: true },
    { key: "usage90", label: "90-day usage", shortLabel: "90d use", sort: true, num: true },
    { key: "trend", label: "Trend" },
    { key: "daysRemaining", label: "Days of stock", shortLabel: "Stock days", sort: true, num: true },
    { key: "leadTimeDays", label: "Lead time", shortLabel: "Lead d", sort: true, num: true },
    { key: "confidenceScore", label: "Confidence", shortLabel: "Conf.", sort: true }
  ];

  function sortHeader(column) {
    if (!column.sort) return esc(column.label);
    var active = state.sortBy === column.key;
    return '<button type="button" class="ii-sort" data-action="sort" data-key="' + column.key + '"' + (active ? ' data-dir="' + state.sortDir + '"' : '') +
      ' aria-label="Sort by ' + esc(column.label) + '">' + esc(column.shortLabel || column.label) + '</button>';
  }
  function ariaSort(column) {
    if (!column.sort || state.sortBy !== column.key) return "";
    return ' aria-sort="' + (state.sortDir === "DESC" ? "descending" : "ascending") + '"';
  }

  function trendCell(trend) {
    var map = { UP: ["Rising", "&#9650;"], DOWN: ["Falling", "&#9660;"], STABLE: ["Steady", "&#9679;"], UNKNOWN: ["Unknown", "?"] };
    var t = map[trend] || map.UNKNOWN;
    return '<span class="ii-badge" data-tone="' + (trend === "UP" ? "high" : (trend === "DOWN" ? "medium" : "muted")) + '"><span aria-hidden="true">' + t[1] + '</span> ' + t[0] + '</span>';
  }
  function confidenceCell(r) {
    var tone = r.confidenceLevel === "HIGH" ? "good" : (r.confidenceLevel === "LOW" ? "critical" : "high");
    return '<span class="ii-badge" data-tone="' + tone + '">' + esc(r.confidenceLevel) + ' ' + num(r.confidenceScore) + '</span>';
  }
  function statusBadge(status) {
    var tone = status === "APPROVED" || status === "APPLIED" ? "good" : (status === "REJECTED" ? "critical" : (status === "PENDING_APPROVAL" ? "high" : "muted"));
    return '<span class="ii-badge" data-tone="' + tone + '">' + esc(label(STATUS_LABELS, status)) + '</span>';
  }
  function daysCell(ev) {
    return ev.daysRemaining === "UNKNOWN" || ev.daysRemaining == null ? '<span class="ii-sub">Unknown</span>' : num(ev.daysRemaining) + " d";
  }

  function evidenceSummary(r) {
    var ev = r.evidence || {};
    return '<details class="ii-evidence-summary"><summary>Evidence summary</summary><dl>' +
      '<dt>Weighted demand</dt><dd>' + num(ev.weightedDailyUsage, 2) + ' /day</dd>' +
      '<dt>Order point</dt><dd>' + num(ev.proposedOrderPoint) + '</dd>' +
      '<dt>Target cover</dt><dd>' + num(ev.targetCover, 1) + '</dd>' +
      '<dt>Coverage</dt><dd>' + num(ev.availableCoverage) + ' (stock + PO)</dd>' +
      '<dt>Rule</dt><dd>' + esc(String(ev.queueRule || "-").toLowerCase().replace(/_/g, " ")) + '</dd>' +
      '<dt>Signals</dt><dd>' + ((ev.confidenceSignals || []).length ? esc(ev.confidenceSignals.map(function (s) { return s.code; }).join(", ")) : "none") + '</dd>' +
      '</dl></details>';
  }

  function canDecide(r) { return state.canApprove && UNDECIDED.indexOf(r.status) >= 0; }

  function rowActions(r) {
    var id = esc(r.recommendationId);
    var html = '<div class="ii-actions">';
    html += '<button type="button" class="ii-btn small" data-action="open" data-id="' + id + '">Review</button>';
    if (canDecide(r)) {
      if (SETTINGS_TYPES.indexOf(r.recommendationType) >= 0 && r.confidenceLevel !== "LOW") {
        html += '<button type="button" class="ii-btn small primary" data-action="approve" data-id="' + id + '">Approve</button>' +
          '<button type="button" class="ii-btn small" data-action="edit" data-id="' + id + '">Edit</button>';
      }
      if (r.recommendationType === "SHELF_CHECK" || r.recommendationType === "DATA_REVIEW") {
        html += '<button type="button" class="ii-btn small" data-action="shelf" data-id="' + id + '">Assign count</button>';
      }
      html += '<button type="button" class="ii-btn small danger" data-action="reject" data-id="' + id + '">Reject</button>';
    }
    return html + '</div>';
  }

  function renderRow(r) {
    var ev = r.evidence || {};
    var p = r.proposedSettings || {};
    var checked = state.selected[r.recommendationId] ? " checked" : "";
    var qty = p.suggestedOrderQuantity || 0;
    var actionText = (p.recommendedActions && p.recommendedActions[0]) || p.rationale || "";
    return '<tr data-selected="' + Boolean(state.selected[r.recommendationId]) + '">' +
      '<td>' + (canDecide(r) ? '<input type="checkbox" data-action="select" data-id="' + esc(r.recommendationId) + '" aria-label="Select ' + esc(r.itemLabel || r.itemId) + '"' + checked + '>' : '') + '</td>' +
      '<td><div class="ii-item-name">' + esc(r.itemLabel || r.itemId) + '</div>' +
        '<div class="ii-sub ii-item-meta" title="' + esc((r.sku ? 'SKU ' + r.sku + ' · ' : '') + r.itemId) + '">' +
        (r.sku ? 'SKU ' + esc(r.sku) + ' · ' : '') + esc(r.itemId) + '</div>' + evidenceSummary(r) + '</td>' +
      '<td>' + (r.supplierName ? esc(r.supplierName) : '<span class="ii-sub">Unmapped</span>') + '</td>' +
      '<td class="num' + (ev.onHand < 0 ? ' ii-neg' : '') + '">' + num(ev.onHand) + '</td>' +
      '<td class="num">' + num(ev.openPoQuantity) + '</td>' +
      '<td class="num">' + num(ev.usage30) + '</td>' +
      '<td class="num">' + num(ev.usage90) + '</td>' +
      '<td>' + trendCell(ev.trend) + '</td>' +
      '<td class="num">' + daysCell(ev) + '</td>' +
      '<td class="num">' + num(ev.effectiveLeadTimeDays || p.leadTimeDays) + ' d</td>' +
      '<td>' + confidenceCell(r) + '</td>' +
      '<td class="ii-act first num">' + (qty > 0 ? '<span class="ii-qty">' + num(qty) + '</span> <span class="ii-sub">units</span>' : '<span class="ii-sub">None</span>') + '</td>' +
      '<td class="ii-act"><div class="ii-rec-text"><div>' + statusBadge(r.status) + ' <span class="ii-sub">' + esc(label(TYPE_LABELS, r.recommendationType)) + '</span></div>' +
        '<div class="ii-sub ii-rec-detail" title="' + esc(actionText) + '">' + esc(actionText) + '</div></div></td>' +
      '<td class="ii-act">' + rowActions(r) + '</td>' +
    '</tr>';
  }

  var EVIDENCE_COLUMNS = [.035, .215, .12, .07, .07, .075, .075, .085, .085, .08, .09];
  var ACTION_COLUMNS = [.17, .42, .41];
  function queueColumnWidths(table) {
    var shares = EVIDENCE_COLUMNS.map(function (fraction) { return state.evidenceShare * fraction; })
      .concat(ACTION_COLUMNS.map(function (fraction) { return (100 - state.evidenceShare) * fraction; }));
    table.querySelectorAll("col").forEach(function (col, index) {
      col.style.width = shares[index].toFixed(3) + "%";
    });
  }

  function wireQueueSplitter() {
    var wrap = el("iiResults").querySelector(".ii-table-wrap");
    var handle = wrap && wrap.querySelector(".ii-queue-splitter");
    if (!handle) return;
    var table = wrap.querySelector("table");
    function setShare(value) {
      state.evidenceShare = Math.max(54, Math.min(72, value));
      queueColumnWidths(table);
      handle.style.left = state.evidenceShare + "%";
      handle.setAttribute("aria-valuenow", String(Math.round(state.evidenceShare)));
    }
    function moveTo(clientX) {
      var rect = wrap.getBoundingClientRect();
      setShare((clientX - rect.left + wrap.scrollLeft) / table.offsetWidth * 100);
    }
    setShare(state.evidenceShare);
    handle.addEventListener("pointerdown", function (event) {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("dragging");
    });
    handle.addEventListener("pointermove", function (event) {
      if (handle.hasPointerCapture(event.pointerId)) moveTo(event.clientX);
    });
    handle.addEventListener("pointerup", function (event) {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    });
    handle.addEventListener("lostpointercapture", function () { handle.classList.remove("dragging"); });
    handle.addEventListener("keydown", function (event) {
      var step = event.shiftKey ? 5 : 1;
      if (event.key === "ArrowLeft") setShare(state.evidenceShare - step);
      else if (event.key === "ArrowRight") setShare(state.evidenceShare + step);
      else if (event.key === "Home") setShare(54);
      else if (event.key === "End") setShare(72);
      else return;
      event.preventDefault();
    });
    handle.addEventListener("dblclick", function () { setShare(64); });
  }

  function renderResults() {
    var host = el("iiResults");
    if (!host) return;
    if (state.listError) {
      host.innerHTML = '<div class="ii-table-wrap"><div class="ii-state error" role="alert"><strong>The work queue is unavailable.</strong><span>' + esc(state.listError) +
        '</span><button type="button" class="ii-btn" data-action="refresh">Try again</button></div></div>';
      el("iiPager").innerHTML = "";
      return;
    }
    if (!state.list) {
      host.innerHTML = '<div class="ii-table-wrap"><div class="ii-state">Loading the work queue...</div></div>';
      el("iiPager").innerHTML = "";
      return;
    }
    var items = state.list.items;
    var neverScanned = state.summary && state.summary.dataStatus === "never_scanned";
    var body;
    if (!items.length) {
      body = '<div class="ii-state">' + (neverScanned
        ? '<strong>No scan has completed yet.</strong><span>The queues are empty because nothing has been calculated, not because there is no work.</span>'
        : '<strong>Nothing to show here.</strong><span>No recommendations match this queue and filter.</span>') + '</div>';
      host.innerHTML = '<div class="ii-table-wrap">' + body + '</div>';
    } else {
      var head1 = '<tr class="ii-group"><th colspan="2">Item</th><th colspan="9">Evidence <span class="ii-sub">(read-only, from the source)</span></th>' +
        '<th class="ii-group-action first" colspan="3">Recommendation and actions <span class="ii-sub">(not an approved order)</span></th></tr>';
      var head2 = '<tr><th><input type="checkbox" data-action="select-all" aria-label="Select all rows on this page"' + (allSelected(items) ? " checked" : "") + '></th>' +
        COLUMNS.map(function (c, index) {
          return '<th scope="col"' + (index === 0 ? "" : "") + (c.num ? ' class="num"' : "") + ariaSort(c) + '>' + sortHeader(c) + '</th>';
        }).join("") +
        '<th scope="col" class="ii-group-action first num">' + sortHeaderAction() + '</th><th scope="col" class="ii-group-action">Recommendation</th><th scope="col" class="ii-group-action">Actions</th></tr>';
      body = '<table class="ii-table ii-queue-table"><caption class="ii-visually-hidden">Replenishment work queue</caption>' +
        '<colgroup>' + EVIDENCE_COLUMNS.concat(ACTION_COLUMNS).map(function () { return '<col>'; }).join("") + '</colgroup>' +
        '<thead>' + head1 + head2 + '</thead><tbody>' + items.map(renderRow).join("") + '</tbody></table>';
      host.innerHTML = '<div class="ii-table-wrap" tabindex="0" role="region" aria-label="Work queue table, scrolls sideways">' + body +
        '<div class="ii-queue-splitter" role="separator" tabindex="0" aria-orientation="vertical" aria-label="Evidence and recommendation width; use arrow keys to resize" aria-valuemin="54" aria-valuemax="72"></div></div>';
      wireQueueSplitter();
    }
    host.setAttribute("aria-busy", state.listLoading ? "true" : "false");

    var total = state.list.total, from = total ? state.offset + 1 : 0, to = Math.min(total, state.offset + items.length);
    el("iiPager").innerHTML = '<span>' + (state.listLoading ? "Updating... " : "") + 'Showing ' + num(from) + '-' + num(to) + ' of ' + num(total) + '</span>' +
      '<span class="ii-toolbar-group"><button type="button" class="ii-btn small" data-action="page" data-dir="-1"' + (state.offset <= 0 ? " disabled" : "") + '>Previous</button>' +
      '<button type="button" class="ii-btn small" data-action="page" data-dir="1"' + (to >= total ? " disabled" : "") + '>Next</button></span>';
  }

  function sortHeaderAction() {
    var active = state.sortBy === "suggestedOrderQuantity";
    return '<button type="button" class="ii-sort" data-action="sort" data-key="suggestedOrderQuantity"' + (active ? ' data-dir="' + state.sortDir + '"' : '') + ' aria-label="Sort by suggested order quantity">Order qty</button>';
  }

  function allSelected(items) {
    var selectable = items.filter(canDecide);
    return selectable.length > 0 && selectable.every(function (r) { return state.selected[r.recommendationId]; });
  }
  function selectedIds() { return Object.keys(state.selected).filter(function (id) { return state.selected[id]; }); }

  function renderBulk() {
    var host = el("iiBulk");
    if (!host) return;
    if (!state.canApprove) { host.innerHTML = ""; return; }
    var count = selectedIds().length;
    var queueApprovable = SETTINGS_TYPES.indexOf(state.queue) >= 0;
    host.innerHTML =
      '<button type="button" class="ii-btn" data-action="approve-all"' + (queueApprovable ? "" : " disabled") +
        ' title="' + (queueApprovable ? "Approves every high-confidence recommendation in this queue" : "Choose Order More or Order Less to approve a whole queue") + '">Approve all eligible</button>' +
      '<button type="button" class="ii-btn primary" data-action="approve-selected"' + (count ? "" : " disabled") + '>Approve selected' + (count ? " (" + count + ")" : "") + '</button>' +
      '<button type="button" class="ii-btn" data-action="shelf-selected"' + (count ? "" : " disabled") + '>Assign shelf count' + (count ? " (" + count + ")" : "") + '</button>';
  }

  /* ───────────── drawer ───────────── */

  async function openDrawer(id) {
    state.detailId = id;
    state.detail = null;
    state.detailError = null;
    var dialog = el("iiDrawer");
    renderDrawer();
    if (!dialog.open) dialog.showModal();
    try {
      state.detail = await api("recommendations/" + encodeURIComponent(id));
    } catch (error) {
      state.detailError = error.message;
    }
    renderDrawer();
  }

  function kv(rows) {
    return '<dl class="ii-kv">' + rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>'; }).join("") + '</dl>';
  }
  function stat(labelText, value, sub) {
    return '<div class="ii-stat"><span class="ii-stat-label">' + esc(labelText) + '</span><span class="ii-stat-value">' + value + '</span>' + (sub ? '<span class="ii-sub">' + sub + '</span>' : '') + '</div>';
  }

  function renderDrawer() {
    var dialog = el("iiDrawer");
    var title = "Recommendation";
    if (state.detailError) {
      dialog.innerHTML = '<div class="ii-dialog-head"><h3 id="iiDrawerTitle">Recommendation</h3><button type="button" class="ii-btn small" data-action="close-drawer">Close</button></div>' +
        '<div class="ii-dialog-body"><div class="ii-state error" role="alert"><strong>Could not load this recommendation.</strong><span>' + esc(state.detailError) + '</span></div></div>';
      return;
    }
    if (!state.detail) {
      dialog.innerHTML = '<div class="ii-dialog-head"><h3 id="iiDrawerTitle">' + title + '</h3><button type="button" class="ii-btn small" data-action="close-drawer">Close</button></div>' +
        '<div class="ii-dialog-body"><div class="ii-state">Loading...</div></div>';
      return;
    }
    var d = state.detail, r = d.recommendation, ev = r.evidence || {}, p = r.proposedSettings || {}, prov = ev.provenance || {};
    var active = d.activeSetting;
    var task = d.task;
    var decidable = canDecide(r);
    var settingsQueue = SETTINGS_TYPES.indexOf(r.recommendationType) >= 0;
    var thresholds = ev.thresholds || {};

    var left =
      '<section class="ii-pane" aria-labelledby="iiEvTitle"><div><span class="ii-tag">Read-only evidence</span><h4 id="iiEvTitle">Metrics and evidence</h4></div>' +
      '<div class="ii-stats">' +
        stat("On hand", '<span class="' + (ev.onHand < 0 ? "ii-neg" : "") + '">' + num(ev.onHand) + '</span>', "units") +
        stat("Open PO coverage", num(ev.openPoQuantity), "units on order") +
        stat("30-day usage", num(ev.usage30), num(ev.dailyUsage30, 2) + " /day") +
        stat("90-day usage", num(ev.usage90), num(ev.dailyUsage90, 2) + " /day") +
        stat("Weighted demand", num(ev.weightedDailyUsage, 2), "/day (" + num((ev.weightsUsed || {}).weight30 * 100) + "% 30d, " + num((ev.weightsUsed || {}).weight90 * 100) + "% 90d)") +
        stat("Trend", trendCell(ev.trend), "last 30 vs prior 60 days") +
        stat("Days of stock", ev.daysRemaining === "UNKNOWN" ? "Unknown" : num(ev.daysRemaining), "at weighted demand") +
        stat("Supplier lead time", num(ev.effectiveLeadTimeDays) + " d", ev.approvedSettingsVersion ? "approved setting v" + ev.approvedSettingsVersion : "policy default") +
      '</div>' +
      '<h5>Calculation inputs</h5>' + kv([
        ["Lead-time demand", num(ev.leadTimeDemand, 1)],
        ["Safety stock", num(ev.approvedSafetyStock)],
        ["Order point", num(ev.proposedOrderPoint)],
        ["Target cover (" + num(ev.targetCoverDays) + " d)", num(ev.targetCover, 1)],
        ["Requirement", num(ev.requirement, 1)],
        ["Available coverage", num(ev.availableCoverage) + " (stock + open PO)"],
        ["Shortfall", num(ev.rawOrderQuantity, 1)],
        ["MOQ / pack multiple", num(ev.moq) + " / " + num(ev.packMultiple)],
        ["Unit cost", money(ev.unitCost)],
        ["Value at risk", money(ev.valueAtRisk) + (ev.unitContext ? " - " + esc(ev.unitContext) : "")],
        ["Rule that fired", esc(String(ev.queueRule || "-").toLowerCase().replace(/_/g, " "))]
      ]) +
      '<h5>Confidence</h5><p>' + confidenceCell(r) + '</p>' +
      ((ev.confidenceSignals || []).length
        ? '<ul class="ii-signals">' + ev.confidenceSignals.map(function (s) {
            return '<li><span class="ii-badge" data-tone="' + (s.severity === "CRITICAL" ? "critical" : (s.severity === "WARNING" ? "high" : "muted")) + '">' + esc(s.severity) + '</span><span>' + esc(s.message) + '</span></li>';
          }).join("") + '</ul>'
        : '<p class="ii-small-print">No data-quality signals.</p>') +
      '<h5>Provenance and freshness</h5>' + kv([
        ["Evidence source", esc(prov.system || "-")],
        ["Evidence read", esc(when(prov.evidenceAsOf))],
        ["Last movement", esc(when(prov.lastMoved))],
        ["Last verified count", prov.lastVerifiedCount ? esc(num(prov.lastVerifiedCount.countedQuantity) + " on " + when(prov.lastVerifiedCount.countedAt)) : "Never counted in this app"],
        ["Recommendation created", esc(when(r.createdAt))],
        ["Evidence version", esc(r.evidenceVersion)],
        ["Calculation / policy", esc(r.calculationVersion + " / " + r.policyVersion)],
        ["Scan run", '<span class="ii-sub">' + esc(r.scanRunId || "-") + '</span>'],
        ["Thresholds used", esc("write-off " + num(thresholds.writeOffDaysThreshold) + " d; overstock " + num(thresholds.overstockCoverRatio, 1) + "x cover; confidence floor " + num(thresholds.confidenceThreshold))]
      ]) +
      '</section>';

    var right =
      '<section class="ii-pane actions" aria-labelledby="iiActTitle"><div><span class="ii-tag">Proposal, not an order</span><h4 id="iiActTitle">Recommended actions</h4></div>' +
      '<p class="ii-note">' + esc(p.rationale || "Deterministic recommendation.") + '</p>' +
      '<div class="ii-stats">' +
        stat("Suggested order now", '<span class="ii-qty">' + num(p.suggestedOrderQuantity || 0) + '</span>', "units, MOQ/pack rounded") +
        stat("Proposed order point", num(p.orderPoint), active ? "approved now: " + num(active.orderPoint) : "no approved setting yet") +
        stat("Proposed reorder quantity", num(p.reorderQuantity), active ? "approved now: " + num(active.reorderQuantity) : "") +
        stat("Proposed lead time", num(p.leadTimeDays) + " d", p.leadTimeOverrideReason ? esc(p.leadTimeOverrideReason) : (active ? "approved now: " + num(active.leadTimeDays) + " d" : "")) +
        stat("MOQ / pack multiple", num(p.minOrderQty) + " / " + num(p.packMultiple), active ? "approved now: " + num(active.minOrderQty) + " / " + num(active.packMultiple) : "") +
        stat("Supplier", p.supplierName ? esc(p.supplierName) : "Unmapped", active && active.supplierName && active.supplierName !== p.supplierName ? "approved: " + esc(active.supplierName) : "no change proposed") +
      '</div>' +
      (p.humanEdited ? '<p class="ii-small-print">Edited by ' + esc(p.editedBy) + ': ' + esc(p.editReason) + '</p>' : '') +
      '<h5>Status</h5><p>' + statusBadge(r.status) + ' <span class="ii-sub">' + esc(label(TYPE_LABELS, r.recommendationType)) + ' · revision ' + num(r.revisionNumber) + '</span></p>' +
      (r.decisionAt ? kv([["Decision", esc(r.decisionActor || "-") + " on " + esc(when(r.decisionAt))], ["Reason", esc(r.decisionReason || "-")]]) : '') +
      '<h5>Linked task</h5>' + (task
        ? kv([
            ["Type", esc(label(TASK_LABELS, task.taskType))], ["Status", esc(task.status)], ["Priority", esc(label(PRIORITY_LABELS, task.priority))],
            ["Assignee", esc(task.assignee || "Unassigned")], ["Due", esc(task.dueDate || "-")]
          ])
        : '<p class="ii-small-print">No task: this is informational.</p>') +
      (decidable && task && ["OPEN", "ASSIGNED", "IN_PROGRESS", "BLOCKED"].indexOf(task.status) >= 0
        ? '<div class="ii-actions"><button type="button" class="ii-btn small" data-action="assign-task" data-id="' + esc(r.recommendationId) + '">Assign task</button>' +
          (task.taskType === "COUNT_SHELF" && state.canApprove ? '<button type="button" class="ii-btn small primary" data-action="record-count" data-id="' + esc(r.recommendationId) + '">Record count result</button>' : '') + '</div>'
        : '') +
      (d.counts && d.counts.length
        ? '<h5>Recent counts</h5><ul class="ii-signals">' + d.counts.map(function (c) {
            return '<li><span>' + esc(when(c.countedAt)) + ': counted <strong>' + num(c.countedQuantity) + '</strong>' +
              (c.systemQuantity != null ? ' vs system ' + num(c.systemQuantity) + ' (variance ' + num(c.variance) + ')' : '') + ' by ' + esc(c.countedBy) + '</span></li>';
          }).join("") + '</ul>'
        : '') +
      '<h5>Approved settings history</h5>' + (d.settingHistory && d.settingHistory.length
        ? '<ul class="ii-signals">' + d.settingHistory.map(function (s) {
            return '<li><span><strong>v' + num(s.version) + '</strong> order point ' + num(s.orderPoint) + ', reorder ' + num(s.reorderQuantity) + ', lead ' + num(s.leadTimeDays) + ' d, MOQ ' + num(s.minOrderQty) + ', pack ' + num(s.packMultiple) +
              ' - ' + esc(s.approvedBy) + ' ' + esc(when(s.effectiveFrom)) + (s.effectiveTo ? ' (closed)' : ' (effective)') + '</span></li>';
          }).join("") + '</ul>'
        : '<p class="ii-small-print">No approved settings yet. A draft PO cannot include this item until one is approved.</p>') +
      '</section>';

    var history =
      '<section class="ii-pane" aria-labelledby="iiHistTitle"><h4 id="iiHistTitle">History</h4><div class="ii-split">' +
        '<div><h5>Audit trail</h5>' + timeline(d.audit, function (a) {
          return '<li><time datetime="' + esc(a.createdAt) + '">' + esc(when(a.createdAt)) + '</time><strong>' + esc(a.action.replace(/_/g, " ").toLowerCase()) + '</strong> by ' + esc(a.actor) +
            (a.reason ? '<div class="why">' + esc(a.reason) + '</div>' : '') + '</li>';
        }, "No audit events yet.") + '</div>' +
        '<div><h5>Task history</h5>' + timeline(d.taskHistory, function (h) {
          return '<li><time datetime="' + esc(h.createdAt) + '">' + esc(when(h.createdAt)) + '</time><strong>' + esc(h.eventType.replace(/_/g, " ").toLowerCase()) + '</strong>' +
            (h.toStatus ? ' (' + esc(h.toStatus) + ')' : '') + ' by ' + esc(h.actor) + (h.note ? '<div class="why">' + esc(h.note) + '</div>' : '') + '</li>';
        }, "No task history.") + '<h5>Revisions</h5>' + timeline(d.revisions, function (v) {
          return '<li><time>' + esc(when(v.createdAt)) + '</time>Revision ' + num(v.revisionNumber) + ': ' + esc(label(TYPE_LABELS, v.recommendationType)) + ', ' + esc(label(STATUS_LABELS, v.status)) +
            (v.decisionActor ? ' by ' + esc(v.decisionActor) : '') + '</li>';
        }, "No other revisions.") + '</div>' +
      '</div></section>';

    var foot = "";
    if (decidable) {
      if (r.recommendationType === "SHELF_CHECK" || r.recommendationType === "DATA_REVIEW") foot += '<button type="button" class="ii-btn" data-action="shelf" data-id="' + esc(r.recommendationId) + '">Assign shelf count</button>';
      foot += '<button type="button" class="ii-btn danger" data-action="reject" data-id="' + esc(r.recommendationId) + '">Reject</button>';
      if (REVIEW_TYPES.indexOf(r.recommendationType) >= 0) foot += '<button type="button" class="ii-btn primary" data-action="complete" data-id="' + esc(r.recommendationId) + '">Mark reviewed</button>';
      if (settingsQueue && r.confidenceLevel !== "LOW") {
        foot += '<button type="button" class="ii-btn" data-action="edit" data-id="' + esc(r.recommendationId) + '">Edit values</button>' +
          '<button type="button" class="ii-btn primary" data-action="approve" data-id="' + esc(r.recommendationId) + '">Approve</button>';
      } else if (settingsQueue) {
        foot += '<span class="ii-sub">Confidence is too low to approve. Resolve the data issue first.</span>';
      }
    } else if (!state.canApprove) {
      foot = '<span class="ii-sub">View-only access.</span>';
    }

    dialog.innerHTML =
      '<div class="ii-dialog-head"><div><h3 id="iiDrawerTitle">' + esc(r.itemLabel || r.itemId) + '</h3>' +
        '<div class="ii-sub">' + statusBadge(r.status) + ' <span>' + esc(label(TYPE_LABELS, r.recommendationType)) + '</span><span>' + (r.sku ? 'SKU ' + esc(r.sku) : '') + '</span><span>' + esc(r.itemId) + '</span></div></div>' +
        '<button type="button" class="ii-btn small" data-action="close-drawer">Close</button></div>' +
      '<div class="ii-dialog-body">' + supersededNotice(d, r) + '<div class="ii-split">' + left + right + '</div>' + history + '</div>' +
      '<div class="ii-dialog-foot">' + foot + '</div>';
  }

  /** A recalculation can replace the recommendation being viewed; say so and offer the current one. */
  function supersededNotice(detail, r) {
    if (r.status !== "SUPERSEDED") return "";
    var current = (detail.revisions || []).filter(function (v) { return v.recommendationId !== r.recommendationId; })[0];
    if (!current) return '<div class="ii-banner" data-tone="warn"><span class="grow">This recommendation was retired because no action is needed any more.</span></div>';
    return '<div class="ii-banner" data-tone="warn"><span class="grow">A newer revision replaced this one (' + esc(label(TYPE_LABELS, current.recommendationType)) + ', ' +
      esc(label(STATUS_LABELS, current.status)) + '). What you see below is the historical record.</span>' +
      '<button type="button" class="ii-btn small primary" data-action="open" data-id="' + esc(current.recommendationId) + '">Open current revision</button></div>';
  }

  function timeline(items, render, emptyText) {
    if (!items || !items.length) return '<p class="ii-small-print">' + esc(emptyText) + '</p>';
    return '<ol class="ii-timeline">' + items.map(render).join("") + '</ol>';
  }

  /* ───────────── draft PO and audit views ───────────── */

  function renderDraft() {
    var host = el("iiPoView");
    if (!host) return;
    if (state.draftLoading && !state.draft) { host.innerHTML = '<div class="ii-state">Building the draft from approved settings...</div>'; return; }
    if (state.draftError) {
      host.innerHTML = '<div class="ii-state error" role="alert"><strong>The draft PO could not be built.</strong><span>' + esc(state.draftError) +
        '</span><span class="ii-sub">It needs live stock figures; it will not guess them.</span><button type="button" class="ii-btn" data-action="refresh">Try again</button></div>';
      return;
    }
    var d = state.draft;
    if (!d) { host.innerHTML = ""; return; }
    var html = '<div class="ii-disclaimer">' + esc(d.disclaimer) + '</div>' +
      '<p class="ii-small-print">Built ' + esc(when(d.generatedAt)) + ' from ' + num(d.approvedSettingsCount) + ' approved setting(s); stock read ' + esc(when(d.evidenceAsOf)) +
      '. Pending recommendations are never used.' + (d.evidenceTruncated ? ' <strong>The stock read was truncated; some items may be missing.</strong>' : '') + '</p>' +
      '<p><strong>' + num(d.totalLines) + '</strong> line(s), <strong>' + num(d.totalUnits) + '</strong> units, estimated <strong>' + money(d.grandTotalCost) + '</strong></p>';
    if (!d.suppliers.length) {
      html += '<div class="ii-state"><strong>No ordering is indicated under the approved settings.</strong><span>Items appear here only once a recommendation has been approved and stock falls below its approved order point.</span></div>';
    }
    d.suppliers.forEach(function (sup) {
      html += '<section class="ii-po-supplier"><header><strong>' + esc(sup.supplierName || "Unassigned supplier") + '</strong><span>' + num(sup.totalUnits) + ' units · ' + money(sup.totalCost) + '</span></header>' +
        '<div class="ii-table-wrap" tabindex="0" role="region" aria-label="Draft lines for ' + esc(sup.supplierName || "unassigned supplier") + '"><table class="ii-table"><thead><tr>' +
        '<th scope="col">Item</th><th class="num" scope="col">On hand</th><th class="num" scope="col">Open PO</th><th class="num" scope="col">Order point</th><th class="num" scope="col">Reorder qty</th><th class="num" scope="col">MOQ / pack</th>' +
        '<th class="num" scope="col">Draft quantity</th><th class="num" scope="col">Unit cost</th><th class="num" scope="col">Line total</th><th scope="col">Lineage</th></tr></thead><tbody>' +
        sup.lines.map(function (l) {
          var lin = l.lineage || {};
          return '<tr><td><div class="ii-item-name">' + esc(l.itemLabel) + '</div><div class="ii-sub">' + (l.sku ? 'SKU ' + esc(l.sku) : esc(l.itemId)) + '</div></td>' +
            '<td class="num">' + num(l.currentOnHand) + '</td><td class="num">' + num(l.currentOpenPo) + '</td><td class="num">' + num(l.approvedOrderPoint) + '</td><td class="num">' + num(l.approvedReorderQty) + '</td>' +
            '<td class="num">' + num(l.minOrderQty) + ' / ' + num(l.packMultiple) + '</td><td class="num"><span class="ii-qty">' + num(l.quantity) + '</span></td>' +
            '<td class="num">' + money(l.unitCost) + '</td><td class="num">' + money(l.extendedCost) + '</td>' +
            '<td class="ii-sub">Settings v' + num(lin.version) + '<br>approved by ' + esc(lin.approvedBy) + ' ' + esc(when(lin.approvedAt)) +
              '<br><button type="button" class="ii-link" data-action="open" data-id="' + esc(lin.approvedRecommendationId) + '">Recommendation</button></td></tr>';
        }).join("") + '</tbody></table></div></section>';
    });
    if (d.notEvaluated && d.notEvaluated.length) {
      html += '<section class="ii-pane"><h4>Approved items not evaluated (' + num(d.notEvaluated.length) + ')</h4><ul class="ii-signals">' +
        d.notEvaluated.map(function (n) { return '<li><span><strong>' + esc(n.itemLabel) + '</strong> - ' + esc(n.reason) + '</span></li>'; }).join("") + '</ul></section>';
    }
    host.innerHTML = html;
  }

  function renderAudit() {
    var host = el("iiAuditView");
    if (!host) return;
    if (state.auditLoading && !state.audit) { host.innerHTML = '<div class="ii-state">Loading the audit trail...</div>'; return; }
    if (state.auditError) {
      host.innerHTML = '<div class="ii-state error" role="alert"><strong>The audit trail is unavailable.</strong><span>' + esc(state.auditError) + '</span><button type="button" class="ii-btn" data-action="refresh">Try again</button></div>';
      return;
    }
    var f = state.auditFilter;
    var scans = state.scans && state.scans.pastRuns || [];
    var html = '<section class="ii-pane"><h4>Scan history</h4>' +
      (scans.length
        ? '<div class="ii-table-wrap" tabindex="0" role="region" aria-label="Scan history"><table class="ii-table"><thead><tr><th scope="col">Started</th><th scope="col">Trigger</th><th scope="col">Status</th><th class="num" scope="col">Items</th><th class="num" scope="col">New</th><th class="num" scope="col">Tasks</th><th scope="col">Source read</th><th scope="col">Policy</th><th scope="col"></th></tr></thead><tbody>' +
          scans.map(function (s) {
            var wm = s.sourceWatermarks || {};
            return '<tr><td>' + esc(when(s.startedAt)) + '</td><td>' + esc(s.triggerType) + '</td>' +
              '<td><span class="ii-badge" data-tone="' + (s.status === "COMPLETED" ? "good" : (s.status === "FAILED" ? "critical" : "high")) + '">' + esc(s.status.replace(/_/g, " ").toLowerCase()) + '</span>' +
                (s.errors && s.errors.length ? '<div class="ii-sub">' + esc(s.errors[0].message) + '</div>' : '') + '</td>' +
              '<td class="num">' + num(s.itemsEvaluated) + '</td><td class="num">' + num(s.recommendationsCreated) + '</td><td class="num">' + num(s.tasksCreated) + '</td>' +
              '<td class="ii-sub">' + esc(when(wm.evidenceAsOf)) + (wm.truncated ? '<br>truncated' : '') + '</td><td class="ii-sub">' + esc(wm.policyVersion || "-") + '</td>' +
              '<td><button type="button" class="ii-link" data-action="audit-scan" data-id="' + esc(s.scanRunId) + '">Audit</button></td></tr>';
          }).join("") + '</tbody></table></div>'
        : '<p class="ii-small-print">No scans yet.</p>') + '</section>';

    html += '<section class="ii-pane"><h4>Audit trail</h4><p class="ii-small-print">Append-only. Records cannot be edited or removed, in the app or in the database.</p>' +
      '<div class="ii-toolbar-group"><label class="ii-field">Action<select class="ii-select" id="iiAuditAction"><option value="">All actions</option>' +
        AUDIT_ACTIONS.map(function (a) { return '<option value="' + a + '"' + (f.action === a ? " selected" : "") + '>' + a.replace(/_/g, " ").toLowerCase() + '</option>'; }).join("") + '</select></label>' +
      (f.scanRunId ? '<span class="ii-badge" data-tone="medium">Scan ' + esc(f.scanRunId.slice(0, 8)) + '</span><button type="button" class="ii-link" data-action="audit-clear-scan">Clear</button>' : '') + '</div>' +
      ((state.audit && state.audit.length)
        ? '<div class="ii-table-wrap" tabindex="0" role="region" aria-label="Audit events"><table class="ii-table"><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Entity</th><th scope="col">Reason</th><th scope="col">Correlation</th></tr></thead><tbody>' +
          state.audit.map(function (a) {
            var detail = (a.beforeState || a.afterState)
              ? '<details class="ii-audit-detail"><summary>Before / after</summary><pre>' + esc(JSON.stringify({ before: a.beforeState, after: a.afterState }, null, 2)) + '</pre></details>' : '';
            return '<tr><td class="ii-sub">' + esc(when(a.createdAt)) + '</td><td>' + esc(a.actor) + '</td><td><strong>' + esc(a.action.replace(/_/g, " ").toLowerCase()) + '</strong></td>' +
              '<td>' + esc(a.entityType) + '<div class="ii-sub">' + esc(a.entityId) + '</div></td><td>' + esc(a.reason || "-") + detail + '</td><td class="ii-sub">' + esc(a.correlationId || "-") + '</td></tr>';
          }).join("") + '</tbody></table></div>'
        : '<div class="ii-state">No audit events match.</div>') + '</section>';
    host.innerHTML = html;
    var select = el("iiAuditAction");
    if (select) select.addEventListener("change", function () { state.auditFilter.action = select.value; loadAudit(); });
  }

  /* ───────────── forms and decisions ───────────── */

  function findRecommendation(id) {
    if (state.detail && state.detail.recommendation.recommendationId === id) return state.detail.recommendation;
    if (state.list) {
      for (var i = 0; i < state.list.items.length; i += 1) if (state.list.items[i].recommendationId === id) return state.list.items[i];
    }
    return null;
  }

  function openModal(title, bodyHtml, submitLabel, tone, context) {
    var dialog = el("iiModal");
    dialog.dataset.context = JSON.stringify(context);
    dialog.innerHTML = '<div class="ii-dialog-head"><h3 id="iiModalTitle">' + esc(title) + '</h3><button type="button" class="ii-btn small" data-action="close-modal" aria-label="Close">Close</button></div>' +
      '<form class="ii-form" method="dialog" novalidate>' + bodyHtml +
      '<p class="ii-form-error" role="alert" id="iiFormError"></p>' +
      '<div class="ii-dialog-foot"><button type="button" class="ii-btn" data-action="close-modal">Cancel</button>' +
      '<button type="submit" class="ii-btn ' + (tone || "primary") + '" id="iiSubmit">' + esc(submitLabel) + '</button></div></form>';
    if (!dialog.open) dialog.showModal();
    var first = dialog.querySelector("input, textarea, select");
    if (first) first.focus();
  }

  function reasonField(labelText, required, hint) {
    return '<label class="ii-field">' + esc(labelText) + (required ? ' (required)' : '') +
      '<textarea class="ii-textarea" name="reason" maxlength="500"' + (required ? " required" : "") + '></textarea></label>' + (hint ? '<p class="ii-small-print">' + esc(hint) + '</p>' : '');
  }
  function numberField(name, labelText, value, min) {
    return '<label class="ii-field">' + esc(labelText) + '<input class="ii-input" type="number" name="' + name + '" value="' + esc(value) + '" min="' + (min == null ? 0 : min) + '" step="1" required></label>';
  }

  function openEdit(id) {
    var r = findRecommendation(id); if (!r) return;
    var p = r.proposedSettings;
    openModal("Edit values: " + (r.itemLabel || r.itemId),
      '<p class="ii-small-print">This records your values as a new proposed revision and approves them as the item\'s replenishment settings in this app. The original proposal is kept. The lens table and Innovations are not changed.</p>' +
      '<div class="ii-form-grid">' + numberField("orderPoint", "Order point", p.orderPoint) + numberField("reorderQuantity", "Reorder quantity", p.reorderQuantity) +
      numberField("leadTimeDays", "Lead time (days)", p.leadTimeDays, 1) + numberField("safetyStock", "Safety stock", p.safetyStock) +
      numberField("minOrderQty", "MOQ", p.minOrderQty, 1) + numberField("packMultiple", "Pack multiple", p.packMultiple, 1) + '</div>' +
      '<label class="ii-field">Lead-time override reason (if you changed the lead time)<input class="ii-input" name="leadTimeOverrideReason" maxlength="500"></label>' +
      reasonField("Reason for the change", true),
      "Save and approve", "primary", { kind: "edit", id: id, original: p });
  }
  function openReject(id) {
    var r = findRecommendation(id); if (!r) return;
    openModal("Reject: " + (r.itemLabel || r.itemId), '<p class="ii-small-print">The recommendation and its evidence are kept. It will not be raised again for the same situation for 30 days.</p>' + reasonField("Reason", true), "Reject", "danger", { kind: "reject", id: id });
  }
  function openComplete(id) {
    var r = findRecommendation(id); if (!r) return;
    openModal("Mark reviewed: " + (r.itemLabel || r.itemId), '<p class="ii-small-print">Records your review outcome. It does not write anything off in the books.</p>' + reasonField("Review outcome", true), "Mark reviewed", "primary", { kind: "complete", id: id });
  }
  function openShelf(ids) {
    var many = ids.length > 1;
    var first = findRecommendation(ids[0]);
    openModal(many ? "Assign shelf count to " + ids.length + " items" : "Assign shelf count: " + (first ? first.itemLabel || first.itemId : ""),
      '<p class="ii-small-print">Creates the shelf-count task, or assigns the one that already exists.</p>' +
      '<label class="ii-field">Assign to (required)<input class="ii-input" name="assignee" maxlength="120" required autocomplete="off"></label>' +
      '<label class="ii-field">Due date<input class="ii-input" type="date" name="dueDate"></label>' +
      '<label class="ii-field">Note<textarea class="ii-textarea" name="note" maxlength="500"></textarea></label>',
      "Assign", "primary", { kind: "shelf", ids: ids });
  }
  function openAssignTask(id) {
    var d = state.detail, task = d && d.task; if (!task) return;
    openModal("Assign task", '<label class="ii-field">Assign to<input class="ii-input" name="assignee" maxlength="120" value="' + esc(task.assignee || "") + '" required autocomplete="off"></label>' +
      '<label class="ii-field">Due date<input class="ii-input" type="date" name="dueDate" value="' + esc(task.dueDate || "") + '"></label>', "Save", "primary", { kind: "assign-task", taskId: task.taskId, id: id });
  }
  function openRecordCount(id) {
    var d = state.detail, task = d && d.task; if (!task) return;
    openModal("Record count result", '<p class="ii-small-print">Enter what you counted on the shelf. This completes the count task and triggers a recalculation. It does not change stock in Innovations; if the system figure is wrong, correct it there.</p>' +
      numberField("countedQuantity", "Counted quantity", "", 0) + '<label class="ii-field">Note<textarea class="ii-textarea" name="note" maxlength="500"></textarea></label>', "Record count", "primary", { kind: "count", taskId: task.taskId, id: id });
  }
  function openApproveAll() {
    openModal("Approve all eligible in " + label(TYPE_LABELS, state.queue),
      '<p>This approves every <strong>high-confidence</strong> recommendation in this queue as proposed. Lower-confidence rows are skipped and listed afterwards. Each approval writes an approved setting in this app; nothing is ordered.</p>',
      "Approve all eligible", "primary", { kind: "approve-all", queue: state.queue });
  }
  function openApproveSelected() {
    var ids = selectedIds();
    openModal("Approve " + ids.length + " selected", '<p>Each selected recommendation is approved as proposed. Any that cannot be approved (stale, low confidence, already decided) are skipped and listed afterwards.</p>', "Approve selected", "primary", { kind: "approve-selected", ids: ids });
  }

  function formValues(form) {
    var out = {};
    new FormData(form).forEach(function (value, key) { out[key] = typeof value === "string" ? value.trim() : value; });
    return out;
  }

  async function onSubmit(event) {
    var form = event.target;
    if (!form.classList || !form.classList.contains("ii-form")) return;
    event.preventDefault();
    var dialog = el("iiModal");
    var context = JSON.parse(dialog.dataset.context || "{}");
    var errorBox = el("iiFormError");
    var submit = el("iiSubmit");
    errorBox.textContent = "";
    if (!form.checkValidity()) {
      form.reportValidity();
      errorBox.textContent = "Please complete the required fields.";
      return;
    }
    var v = formValues(form);
    submit.disabled = true;
    submit.textContent = "Working...";
    try {
      var message = await runDecision(context, v);
      dialog.close();
      notify(message, "info");
      refreshAfterDecision();
    } catch (error) {
      errorBox.textContent = error.message;
      submit.disabled = false;
      submit.textContent = "Try again";
    }
  }

  function intOrUndefined(value) { return value === "" || value == null ? undefined : Number(value); }

  async function runDecision(context, v) {
    var id = context.id;
    if (context.kind === "edit") {
      var result = await api("recommendations/" + encodeURIComponent(id) + "/edit-and-approve", { method: "POST", body: {
        orderPoint: intOrUndefined(v.orderPoint), reorderQuantity: intOrUndefined(v.reorderQuantity), leadTimeDays: intOrUndefined(v.leadTimeDays),
        safetyStock: intOrUndefined(v.safetyStock), minOrderQty: intOrUndefined(v.minOrderQty), packMultiple: intOrUndefined(v.packMultiple),
        leadTimeOverrideReason: v.leadTimeOverrideReason || undefined, reason: v.reason
      } });
      // The edit created a new revision; an open drawer should follow it, not stay on the superseded original.
      if (el("iiDrawer").open) state.detailId = result.recommendation.recommendationId;
      return "Saved as revision " + result.recommendation.revisionNumber + " and approved (settings v" + result.setting.version + ").";
    }
    if (context.kind === "reject") {
      await api("recommendations/" + encodeURIComponent(id) + "/reject", { method: "POST", body: { reason: v.reason } });
      return "Rejected. The evidence and your reason are kept.";
    }
    if (context.kind === "complete") {
      await api("recommendations/" + encodeURIComponent(id) + "/complete", { method: "POST", body: { reason: v.reason } });
      return "Marked reviewed.";
    }
    if (context.kind === "shelf") {
      var done = 0, failed = [];
      for (var i = 0; i < context.ids.length; i += 1) {
        var rec = findRecommendation(context.ids[i]);
        if (!rec) continue;
        try {
          await api("tasks/assign-shelf-count", { method: "POST", body: { itemId: rec.itemId, recommendationId: rec.recommendationId, assignee: v.assignee, dueDate: v.dueDate || undefined, note: v.note || undefined } });
          done += 1;
        } catch (error) { failed.push((rec.itemLabel || rec.itemId) + ": " + error.message); }
      }
      if (failed.length && !done) throw new Error(failed[0]);
      return "Shelf count assigned for " + done + " item(s)." + (failed.length ? " " + failed.length + " failed: " + failed.join("; ") : "");
    }
    if (context.kind === "assign-task") {
      await api("tasks/" + encodeURIComponent(context.taskId) + "/assign", { method: "POST", body: { assignee: v.assignee, dueDate: v.dueDate || null } });
      return "Task assigned to " + v.assignee + ".";
    }
    if (context.kind === "count") {
      await api("tasks/" + encodeURIComponent(context.taskId) + "/count-result", { method: "POST", body: { countedQuantity: Number(v.countedQuantity), note: v.note || undefined } });
      return "Count recorded. The item will be re-evaluated shortly.";
    }
    if (context.kind === "approve-all") {
      var all = await api("recommendations/approve-all", { method: "POST", body: { queue: context.queue } });
      return bulkMessage(all);
    }
    if (context.kind === "approve-selected") {
      var sel = await api("recommendations/approve-selected", { method: "POST", body: { recommendationIds: context.ids } });
      return bulkMessage(sel);
    }
    throw new Error("Unknown action.");
  }

  function bulkMessage(result) {
    var text = "Approved " + result.approvedCount + ", skipped " + result.skippedCount + ".";
    if (result.skipped && result.skipped.length) {
      var reasons = {};
      result.skipped.forEach(function (s) { reasons[s.reason] = (reasons[s.reason] || 0) + 1; });
      text += " Skipped because: " + Object.keys(reasons).map(function (k) { return reasons[k] + " x " + k; }).join("; ");
    }
    if (result.notProcessed) text += " " + result.notProcessed + " more remain; run it again.";
    return text;
  }

  async function quickApprove(id) {
    var r = findRecommendation(id);
    try {
      var result = await api("recommendations/" + encodeURIComponent(id) + "/approve", { method: "POST", body: { reason: "Approved from the cockpit" } });
      notify("Approved " + (r ? r.itemLabel || r.itemId : "") + " (settings v" + (result.setting ? result.setting.version : "?") + ").", "info");
    } catch (error) {
      notify("Could not approve: " + error.message, "error");
    }
    refreshAfterDecision();
  }

  function refreshAfterDecision() {
    state.selected = {};
    loadSummary();
    loadList();
    if (state.view === "draft-po") loadDraft();
    if (state.view === "audit") loadAudit();
    if (el("iiDrawer").open && state.detailId) {
      api("recommendations/" + encodeURIComponent(state.detailId)).then(function (detail) { state.detail = detail; renderDrawer(); }).catch(function () {});
    }
  }

  /* ───────────── events ───────────── */

  function setQueue(queue) {
    state.queue = queue;
    state.view = "queue";
    state.offset = 0;
    state.selected = {};
    renderNav();
    renderCards();
    renderBulk();
    loadList();
  }

  function onChange(event) {
    var target = event.target;
    if (target.matches('[data-action="select"]')) {
      // Update in place: rebuilding the table here would drop keyboard focus.
      if (target.checked) state.selected[target.dataset.id] = true; else delete state.selected[target.dataset.id];
      var row = target.closest("tr");
      if (row) row.dataset.selected = String(target.checked);
      renderBulk();
    } else if (target.matches('[data-action="select-all"]')) {
      (state.list ? state.list.items : []).filter(canDecide).forEach(function (r) {
        if (target.checked) state.selected[r.recommendationId] = true; else delete state.selected[r.recommendationId];
      });
      renderBulk();
      renderResults();
      var again = state.root.querySelector('[data-action="select-all"]');
      if (again) again.focus();
    }
  }

  function onClick(event) {
    var node = event.target.closest("[data-action]");
    if (!node || node.matches("input")) return;
    var action = node.dataset.action, id = node.dataset.id;
    switch (action) {
      case "queue": setQueue(node.dataset.queue); break;
      case "view":
        state.view = node.dataset.view;
        renderNav();
        if (state.view === "queue") loadList(); else if (state.view === "draft-po") loadDraft(); else loadAudit();
        break;
      case "sort":
        if (state.sortBy === node.dataset.key) state.sortDir = state.sortDir === "ASC" ? "DESC" : "ASC";
        else { state.sortBy = node.dataset.key; state.sortDir = "ASC"; }
        state.offset = 0;
        loadList();
        break;
      case "page": state.offset = Math.max(0, state.offset + Number(node.dataset.dir) * PAGE_SIZE); loadList(); break;
      case "refresh": refreshAll(); break;
      case "dismiss-notice": notify(""); break;
      case "run-scan": runScan(); break;
      case "open": openDrawer(id); break;
      case "close-drawer": el("iiDrawer").close(); break;
      case "close-modal": el("iiModal").close(); break;
      case "approve": quickApprove(id); break;
      case "edit": openEdit(id); break;
      case "reject": openReject(id); break;
      case "complete": openComplete(id); break;
      case "shelf": openShelf([id]); break;
      case "shelf-selected": openShelf(selectedIds()); break;
      case "assign-task": openAssignTask(id); break;
      case "record-count": openRecordCount(id); break;
      case "approve-all": openApproveAll(); break;
      case "approve-selected": openApproveSelected(); break;
      case "audit-scan": state.auditFilter.scanRunId = id; loadAudit(); break;
      case "audit-clear-scan": state.auditFilter.scanRunId = ""; loadAudit(); break;
      default: break;
    }
  }

  async function runScan() {
    var button = el("iiRunScan");
    if (button) button.disabled = true;
    try {
      await api("scan/run", { method: "POST" });
      notify("Scan requested. It runs in the background; this page updates when it finishes.", "info");
      watchScan();
    } catch (error) {
      notify("Could not start a scan: " + error.message, "error");
    }
    if (button) button.disabled = false;
  }

  /* ───────────── init ───────────── */

  function start() {
    if (state.started) return;
    state.started = true;
    buildShell();
    renderHeader();
    renderCards();
    renderNav();
    renderBulk();
    renderResults();
    loadSummary();
    loadList();
  }

  function init() {
    state.root = document.getElementById("inventoryIntelligenceRoot");
    if (!state.root) return;
    start();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
