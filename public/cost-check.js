/**
 * Cost Check — scan orders and lenses (USB/Bluetooth keyboard-wedge scanner or the phone
 * camera), see the costing for each, and fix what is wrong.
 *
 * Reads:  POST /api/costing/scan                 (pricing.read)
 * Fixes:  POST /api/costing/fix/prepare          (platform.admin) builds a guarded UPDATE and opens
 *         POST /api/admin/data-access/execute     the audited challenge; nothing writes until the
 *                                                 administrator confirms the exact statement.
 *         POST /api/business-metrics/exemptions   "zero by design" (pricing.write), app database.
 */
(function () {
  "use strict";

  var STORE_KEY = "costCheck.codes";
  var ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  var SEV_LABEL = { ok: "Costed", info: "Note", warning: "Check", critical: "Fix needed", none: "Not found" };
  var SEV_RANK = { none: 0, ok: 1, info: 2, warning: 3, critical: 4 };

  var state = { results: [], caps: { canFix: false, canExempt: false }, open: {}, problemsOnly: false, busy: 0 };
  var fix = null; // the correction being worked on in the dialog

  var els = {
    form: byId("ccForm"), input: byId("ccInput"), status: byId("ccStatus"), hint: byId("ccHint"),
    summary: byId("ccSummary"), toolbar: byId("ccToolbar"), list: byId("ccList"), empty: byId("ccEmpty"),
    problems: byId("ccProblems"), keyboard: byId("ccKeyboard"), camera: byId("ccCamera"),
    camDialog: byId("ccCameraDialog"), video: byId("ccVideo"), camMsg: byId("ccCameraMsg"),
    fixDialog: byId("ccFixDialog"), fixTitle: byId("ccFixTitle"), fixBody: byId("ccFixBody")
  };

  function byId(id) { return document.getElementById(id); }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return ESCAPES[c]; }); }
  function money(v) { return v == null ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pct(v) { return v == null ? "—" : v.toFixed(1) + "%"; }
  function when(v) { return v ? new Date(v).toLocaleDateString("en-GB") : "—"; }
  function sevOf(r) { return r.status === "found" ? r.severity : "none"; }

  /* ─────────── api ─────────── */

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

  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.className = "badge " + (kind || "planned");
  }

  /* ─────────── scanning ─────────── */

  function feedback() {
    try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) { /* optional */ }
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      var osc = ctx.createOscillator();
      osc.frequency.value = 880;
      osc.connect(ctx.destination);
      osc.start();
      setTimeout(function () { osc.stop(); ctx.close(); }, 80);
    } catch (e) { /* optional */ }
  }

  /** Scans one or more codes and folds the answers into the list, newest first. */
  async function scan(codes) {
    codes = codes.map(function (c) { return String(c).trim(); }).filter(Boolean);
    if (!codes.length) return;
    state.busy += 1;
    setStatus("Checking…", "planned");
    try {
      var data = await api("/api/costing/scan", { codes: codes });
      if (!data.online) throw new Error(data.error || "Innovations is not reachable.");
      state.caps = data.capabilities || state.caps;
      var fresh = data.results.map(function (r) { return r; });
      var seen = {};
      fresh.forEach(function (r) { seen[r.code.toUpperCase()] = true; });
      var kept = state.results.filter(function (r) { return !seen[r.code.toUpperCase()]; });
      // Newly scanned codes go on top, in the order they were scanned (last scanned first).
      state.results = fresh.slice().reverse().concat(kept);
      fresh.forEach(function (r) {
        // A single fresh scan opens itself so the answer is visible without another tap.
        if (codes.length === 1 || r.status !== "found") state.open[r.code.toUpperCase()] = true;
        if (r.status === "found" && SEV_RANK[r.severity] >= 3) state.open[r.code.toUpperCase()] = true;
      });
      persist();
      setStatus("Up to date", "open");
    } catch (err) {
      setStatus("Problem", "planned");
      els.hint.textContent = /Failed to fetch/i.test(err.message) ? "Could not reach the server." : err.message;
      els.hint.classList.add("cc-error");
    } finally {
      state.busy -= 1;
      render();
    }
  }

  function persist() {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(state.results.map(function (r) { return r.code; }).reverse())); } catch (e) { /* private mode */ }
  }

  function submitInput() {
    var raw = els.input.value;
    els.input.value = "";
    els.hint.classList.remove("cc-error");
    els.hint.textContent = "Scan as many orders and lenses as you like. Each one is checked against Innovations and added below.";
    var codes = raw.split(/[\r\n,;]+/);
    feedback();
    scan(codes).then(function () { els.input.focus(); });
  }

  /* ─────────── rendering ─────────── */

  function render() {
    var has = state.results.length > 0;
    els.empty.hidden = has;
    els.toolbar.hidden = !has;
    els.summary.hidden = !has;
    if (!has) { els.list.innerHTML = ""; return; }

    var shown = state.results.filter(function (r) {
      return !state.problemsOnly || (r.status !== "found" || SEV_RANK[r.severity] >= 3);
    });
    renderSummary();
    els.list.innerHTML = shown.length ? shown.map(card).join("") : '<p class="cc-empty">No problems in what you have scanned.</p>';
  }

  function renderSummary() {
    var found = state.results.filter(function (r) { return r.status === "found"; });
    var bad = found.filter(function (r) { return r.severity === "critical"; }).length;
    var warn = found.filter(function (r) { return r.severity === "warning"; }).length;
    var ok = found.length - bad - warn;
    var missing = state.results.length - found.length;
    var orders = found.filter(function (r) { return r.kind === "order" && !r.order.isCredit; });
    var rev = 0, cost = 0, provisional = false;
    orders.forEach(function (o) { rev += o.totals.revenue; cost += o.totals.cost; provisional = provisional || o.totals.provisional; });
    var m = rev > 0 ? ((rev - cost) / rev) * 100 : null;
    els.summary.innerHTML =
      stat(state.results.length, "scanned", "") +
      stat(ok, "costed", ok ? "is-good" : "") +
      stat(warn, "to check", warn ? "is-warn" : "") +
      stat(bad, "fix needed", bad ? "is-bad" : "") +
      (missing ? stat(missing, "not found", "is-warn") : "") +
      (orders.length ? stat(pct(m), "order margin" + (provisional ? " (provisional)" : ""), provisional ? "is-warn" : "") : "");
  }
  function stat(value, label, cls) { return '<div class="cc-stat ' + cls + '"><b>' + esc(value) + "</b><span>" + esc(label) + "</span></div>"; }

  function card(r) {
    var key = r.code.toUpperCase();
    var open = Boolean(state.open[key]);
    var sev = sevOf(r);
    var title, sub, fig = "";

    if (r.status === "not-found") { title = r.code; sub = "Not found as an order, lens or add-on item"; }
    else if (r.status === "error") { title = r.code; sub = r.error; }
    else if (r.kind === "order") {
      title = r.title + " · " + esc0(r.order.customer);
      sub = [r.order.type, r.order.status, r.order.patient].filter(Boolean).join(" · ");
      fig = '<b>' + pct(r.totals.marginPct) + "</b>margin" + (r.totals.provisional ? "*" : "");
    } else {
      title = r.title;
      sub = (r.kind === "lens" ? "Lens" : "Item") + " · " + (r.item.skus.join(", ") || "no SKU");
      fig = "<b>" + money(r.item.masterCost) + "</b>cost";
    }
    var pill = '<span class="cc-pill sev-' + sev + '">' + SEV_LABEL[sev] + (r.status === "found" && r.issueCount ? " · " + r.issueCount : "") + "</span>";
    var body = open && r.status === "found" ? (r.kind === "order" ? orderBody(r) : itemBody(r)) : "";
    var alt = r.matches && r.matches.length > 1
      ? '<p class="cc-note">Also matches: ' + r.matches.slice(1).map(function (m) { return esc(m.label); }).join(", ") + "</p>" : "";

    return '<article class="cc-card sev-' + sev + '" data-code="' + esc(r.code) + '">' +
      '<button type="button" class="cc-head" data-action="toggle" aria-expanded="' + open + '">' +
      '<span class="cc-head-main"><span class="cc-title">' + title + '</span><span class="cc-sub">' + esc(sub) + "</span></span>" +
      '<span class="cc-fig">' + fig + "</span>" + pill + "</button>" +
      (open ? '<div class="cc-body">' + alt + body +
        '<div class="cc-actions"><button type="button" class="button secondary" data-action="rescan">Re-check</button>' +
        '<button type="button" class="button secondary" data-action="remove">Remove</button></div></div>' : "") +
      "</article>";
  }
  function esc0(v) { return esc(v || "—"); }

  function issueList(issues) {
    var visible = issues.filter(function (i) { return i.severity; });
    if (!visible.length) return "";
    return '<ul class="cc-issues">' + visible.map(function (i) {
      return '<li class="cc-issue"><span class="cc-pill sev-' + i.severity + '">' + (SEV_LABEL[i.severity] || i.severity) + "</span><span>" + esc(i.message) + "</span></li>";
    }).join("") + "</ul>";
  }

  function orderBody(r) {
    var o = r.order, t = r.totals;
    var h = '<dl class="cc-kv">' +
      kv("Customer", o.customer) + kv("Patient", o.patient) + kv("Reference", o.reference) +
      kv("Received", when(o.received)) + kv("Shipped", o.shipped ? when(o.shippedTime) : "Not shipped") +
      kv("Revenue", money(t.revenue)) + kv("Cost" + (t.provisional ? " (incomplete)" : ""), money(t.cost)) +
      kv("Margin", money(t.margin) + " (" + pct(t.marginPct) + ")") +
      (o.remakeOf ? kv("Remake of", "Order " + o.remakeOf) : "") + "</dl>";

    if (r.suppliers.length) {
      h += '<h3 class="cc-h">Supplier</h3><ul class="cc-issues">' + r.suppliers.map(function (s) {
        var lists = s.costLists.filter(function (l) { return l.active; });
        return '<li class="cc-issue"><span>' + esc(s.labId === 1 ? "No lab selected" : s.labName) +
          (lists.length ? " · cost list: " + lists.map(function (l) { return esc(l.name) + " (" + l.pricedCells + " prices)"; }).join(", ") : s.labId === 1 ? "" : " · no cost list found") + "</span></li>";
      }).join("") + "</ul>";
    }
    if (r.supplierCost && r.supplierCost.right && r.supplierCost.right.tupleKnown) {
      var eye = r.supplierCost.right;
      h += '<p class="cc-note">Cost list check for this lens: ' + (eye.options.length
        ? eye.options.map(function (p) { return esc(p.listName) + " " + money(p.price) + " " + esc(p.currencyName || "") + " ÷ " + p.rate + " = <b>" + money(p.costBase) + "</b>"; }).join("; ")
        : "the lab's list has no price for it" + (eye.others.length ? "; " + eye.others.length + " other list(s) do, from " + money(eye.others[0].costBase) : "")) + ".</p>";
    }

    h += issueList(r.orderIssues);
    h += '<h3 class="cc-h">Invoice lines</h3><div class="cc-lines">' + r.lines.filter(function (l) { return l.type === 1; }).map(function (l) { return lineRow(r, l); }).join("") + "</div>";
    return h;
  }

  function kv(k, v) { return "<div><dt>" + esc(k) + "</dt><dd>" + esc(v == null || v === "" ? "—" : v) + "</dd></div>"; }

  function lineRow(order, l) {
    var neg = l.margin < 0 ? " cc-neg" : "";
    var src = l.costSource === "supplier-list" ? " · matches supplier list" : l.costSource === "item-master" ? " · item master" : "";
    return '<div class="cc-line' + (l.isPackage ? " is-package" : "") + '">' +
      '<div class="cc-line-top"><div class="cc-line-desc">' + esc(l.description || "—") +
      "<small>" + esc([l.categoryName, l.sku].filter(Boolean).join(" · ")) + (l.isPackage ? " · costed through its components" : "") + esc(src) + "</small></div></div>" +
      '<div class="cc-line-nums"><span><em>Qty</em>' + l.quantity + "</span><span><em>Cost</em>" + money(l.cost) + "</span><span><em>Price</em>" + money(l.price) +
      '</span><span class="' + neg.trim() + '"><em>Margin</em>' + (l.marginPct == null ? "—" : pct(l.marginPct)) + "</span></div>" +
      issueList(l.issues) + lineActions(order, l) + "</div>";
  }

  /** The fixes that make sense for the problems found on a line. */
  function lineActions(order, l) {
    var codes = l.issues.map(function (i) { return i.code; });
    var costProblem = codes.some(function (c) { return c === "no-cost" || c === "rx-lens-uncosted" || c === "cost-differs-master" || c === "cost-differs-list" || c === "cost-ge-price"; });
    if (!costProblem && codes.indexOf("zero-price") < 0) return "";
    var b = [];
    var base = ' data-line="' + l.lineId + '" data-desc="' + esc(l.description || "") + '" data-cost="' + l.cost + '"';
    if (state.caps.canFix) {
      if (l.suggestedCost && Math.abs(l.suggestedCost - l.cost) > 0.005) {
        b.push('<button type="button" class="button primary" data-action="fix-line" data-amount="' + l.suggestedCost + '"' + base + ">Use supplier list " + money(l.suggestedCost) + "</button>");
      }
      if (l.master && l.master.cost > 0 && Math.abs(l.master.cost - l.cost) > 0.005) {
        b.push('<button type="button" class="button ' + (l.suggestedCost ? "secondary" : "primary") + '" data-action="fix-line" data-amount="' + l.master.cost + '"' + base + ">Use item master " + money(l.master.cost) + "</button>");
      }
      if (l.master && l.master.cost === 0 && l.cost > 0) {
        b.push('<button type="button" class="button secondary" data-action="fix-item" data-kind="' + l.master.kind + '" data-ids="' + l.master.ids.join(",") + '" data-amount="' + l.cost + '" data-label="' + esc(l.description || l.sku || "") + '" data-current="0">Set item master to ' + money(l.cost) + "</button>");
      }
      b.push('<button type="button" class="button secondary" data-action="fix-line"' + base + ">Enter cost…</button>");
    }
    if (state.caps.canExempt && l.sku && (codes.indexOf("no-cost") >= 0)) {
      b.push('<button type="button" class="button secondary" data-action="exempt" data-sku="' + esc(l.sku) + '" data-desc="' + esc(l.description || "") + '">Zero cost is correct</button>');
    }
    return b.length ? '<div class="cc-actions">' + b.join("") + "</div>" : '<p class="cc-note">Ask an administrator to apply a correction.</p>';
  }

  function itemBody(r) {
    var it = r.item;
    var h = '<dl class="cc-kv">' + kv("Master cost", money(it.masterCost)) + kv("List price", it.listPrice ? money(it.listPrice) : "—") +
      kv("Margin at list", pct(it.marginAtList)) + kv("Margin at avg price", pct(it.marginAtAverage)) +
      (it.reorderCost ? kv("Reorder cost", money(it.reorderCost)) : "") + "</dl>";
    h += issueList(r.issues);

    var b = [];
    if (state.caps.canFix) {
      b.push('<button type="button" class="button primary" data-action="fix-item" data-kind="' + r.kind + '" data-ids="' + it.id + '" data-label="' + esc(r.title) + '" data-current="' + it.masterCost + '">Set master cost…</button>');
    }
    if (state.caps.canExempt && it.skus.length && !it.exempt && it.masterCost === 0) {
      b.push('<button type="button" class="button secondary" data-action="exempt" data-sku="' + esc(it.skus[0]) + '" data-desc="' + esc(r.title) + '">Zero cost is correct</button>');
    }
    if (b.length) h += '<div class="cc-actions">' + b.join("") + "</div>";

    if (r.history.length) {
      h += '<h3 class="cc-h">Sold in the last year</h3><div class="cc-scroll"><table class="cc-table"><thead><tr><th>As</th><th class="num">Lines</th><th class="num">Avg price</th><th class="num">Cost range</th><th class="num">No cost</th><th>Last</th></tr></thead><tbody>' +
        r.history.map(function (x) {
          return "<tr><td>" + esc(x.categoryName || x.category) + '</td><td class="num">' + x.lines + '</td><td class="num">' + money(x.avgPrice) + '</td><td class="num">' +
            money(x.minCost) + (x.maxCost !== x.minCost ? "–" + money(x.maxCost) : "") + '</td><td class="num">' + x.zeroCostLines + "</td><td>" + when(x.lastSold) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
    if (r.staleLines.length) {
      h += '<h3 class="cc-h">Recent lines not costed at the master</h3><div class="cc-scroll"><table class="cc-table"><thead><tr><th>Order</th><th class="num">Cost</th><th class="num">Price</th><th>Invoiced</th></tr></thead><tbody>' +
        r.staleLines.map(function (x) {
          return '<tr><td><button type="button" class="cc-link" data-action="open-order" data-order="' + x.orderId + '">' + x.orderId + '</button></td><td class="num">' + money(x.cost) + '</td><td class="num">' + money(x.price) + "</td><td>" + when(x.invoiced) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
    if (r.labs.length) {
      h += '<h3 class="cc-h">Labs used</h3><ul class="cc-issues">' + r.labs.map(function (l) {
        return '<li class="cc-issue"><span>' + esc(l.labName) + " · " + l.orders + " order(s) · " + (l.hasUsableCostList ? "cost list found" : "no cost list with prices") + "</span></li>";
      }).join("") + "</ul>";
    }
    return h;
  }

  /* ─────────── fix dialog ─────────── */

  function openFix(config) {
    fix = config;
    els.fixTitle.textContent = config.title;
    els.fixBody.innerHTML = config.html;
    if (!els.fixDialog.open) els.fixDialog.showModal();
    var first = els.fixBody.querySelector("input, textarea");
    if (first) first.focus();
  }
  function closeFix() { if (els.fixDialog.open) els.fixDialog.close(); fix = null; }
  function fixMessage(text, ok) { return '<div class="cc-result ' + (ok ? "ok" : "bad") + '">' + esc(text) + "</div>"; }

  function costForm(config) {
    var label = config.label;
    openFix({
      title: config.title, type: config.type, payload: config.payload, rescan: config.rescan,
      html: '<p class="cc-note">' + esc(label) + "</p>" +
        '<div class="cc-field"><label for="ccFixCost">New cost (' + 'base currency, per eye / per unit)</label>' +
        '<input id="ccFixCost" type="number" inputmode="decimal" step="0.01" min="0" value="' + (config.amount || "") + '"></div>' +
        '<p class="cc-note">Currently ' + money(config.current) + ". You will review the exact change before anything is written.</p>" +
        '<div class="cc-actions"><button type="button" class="button primary" data-fix="review">Review change</button></div><div id="ccFixOut"></div>'
    });
  }

  async function reviewFix() {
    var out = byId("ccFixOut");
    var cost = parseFloat(byId("ccFixCost").value);
    if (!(cost > 0)) { out.innerHTML = fixMessage("Enter a cost greater than zero.", false); return; }
    out.innerHTML = '<p class="cc-note">Preparing…</p>';
    try {
      var body = Object.assign({ type: fix.type, newCost: cost }, fix.payload);
      var prepared = await api("/api/costing/fix/prepare", body);
      fix.challenge = prepared.challenge;
      var p = prepared.preview;
      out.innerHTML =
        '<h3 class="cc-h">' + esc(p.target) + "</h3><p class=\"cc-note\">" + esc(p.what) + "</p>" +
        '<table class="cc-table"><thead><tr><th></th><th class="num">Before</th><th class="num">After</th></tr></thead><tbody>' +
        p.changes.map(function (c) { return "<tr><td>" + esc(c.label) + '</td><td class="num">' + money(c.before) + '</td><td class="num">' + money(c.after) + "</td></tr>"; }).join("") + "</tbody></table>" +
        (p.note ? '<p class="cc-note">' + esc(p.note) + "</p>" : "") +
        '<pre class="cc-sql">' + esc(prepared.challenge.sql) + "</pre>" +
        '<label class="cc-confirm"><input type="checkbox" id="ccFixSure"> I have checked this change and want it written to Innovations (' + esc(prepared.challenge.challengeId.slice(0, 8)) + ").</label>" +
        '<div class="cc-actions"><button type="button" class="button primary" data-fix="apply">Write to Innovations</button></div><div id="ccFixResult"></div>';
    } catch (err) {
      out.innerHTML = fixMessage(err.message, false);
    }
  }

  async function applyFix() {
    var res = byId("ccFixResult");
    if (!byId("ccFixSure").checked) { res.innerHTML = fixMessage("Tick the box to confirm.", false); return; }
    var c = fix.challenge;
    res.innerHTML = '<p class="cc-note">Writing…</p>';
    try {
      var result = await api("/api/admin/data-access/execute", {
        challengeId: c.challengeId, confirmation: c.confirmation, writeConfirmation: c.writeConfirmation
      });
      var affected = (result.recordsAffected || []).reduce(function (a, b) { return a + (b || 0); }, 0);
      if (!affected) {
        res.innerHTML = fixMessage("Nothing was changed: the value was changed by someone else since you looked. Re-check and try again.", false);
        return;
      }
      res.innerHTML = fixMessage("Done. " + affected + " row(s) updated.", true);
      var codes = fix.rescan;
      setTimeout(function () { closeFix(); scan(codes); }, 900);
    } catch (err) {
      res.innerHTML = fixMessage(err.message, false);
    }
  }

  function exemptForm(sku, desc, code) {
    openFix({
      title: "Zero cost is correct", type: "exempt", payload: { sku: sku, desc: desc }, rescan: [code],
      html: '<p class="cc-note">' + esc(desc || sku) + " (" + esc(sku) + ")</p>" +
        '<div class="cc-field"><label for="ccFixReason">Why is zero correct for this item?</label><textarea id="ccFixReason" placeholder="e.g. workflow trigger, not a real cost"></textarea></div>' +
        '<p class="cc-note">Recorded in OptiLens only. Innovations is not changed, and the exemption can be revoked.</p>' +
        '<div class="cc-actions"><button type="button" class="button primary" data-fix="exempt">Save</button></div><div id="ccFixOut"></div>'
    });
  }

  async function saveExemption() {
    var out = byId("ccFixOut");
    var reason = byId("ccFixReason").value.trim();
    if (!reason) { out.innerHTML = fixMessage("A reason is required.", false); return; }
    try {
      await api("/api/business-metrics/exemptions", { itemKey: fix.payload.sku, checkCode: "zero-cost", description: fix.payload.desc, reason: reason });
      var codes = fix.rescan;
      closeFix();
      scan(codes);
    } catch (err) {
      out.innerHTML = fixMessage(err.message, false);
    }
  }

  /* ─────────── events ─────────── */

  els.form.addEventListener("submit", function (e) { e.preventDefault(); if (els.input.value.trim()) submitInput(); });
  // Many scanners finish with Tab instead of Enter.
  els.input.addEventListener("keydown", function (e) {
    if (e.key === "Tab" && els.input.value.trim()) { e.preventDefault(); submitInput(); }
  });
  // Keep the field ready for the next scan unless the user is working in a dialog.
  document.addEventListener("click", function (e) {
    if (e.target.closest("dialog, input, textarea, button, a")) return;
    els.input.focus();
  });

  els.keyboard.addEventListener("click", function () {
    var on = els.input.getAttribute("inputmode") === "none";
    els.input.setAttribute("inputmode", on ? "text" : "none");
    els.keyboard.setAttribute("aria-pressed", String(on));
    els.input.blur();
    els.input.focus();
  });

  els.problems.addEventListener("change", function () { state.problemsOnly = els.problems.checked; render(); });
  byId("ccRefresh").addEventListener("click", function () { scan(state.results.map(function (r) { return r.code; }).reverse()); });
  byId("ccClear").addEventListener("click", function () { state.results = []; state.open = {}; persist(); render(); els.input.focus(); });

  els.list.addEventListener("click", function (e) {
    var target = e.target.closest("[data-action]");
    if (!target) return;
    var cardEl = target.closest(".cc-card");
    var code = cardEl ? cardEl.getAttribute("data-code") : null;
    var key = code ? code.toUpperCase() : null;
    var d = target.dataset;

    switch (d.action) {
      case "toggle": state.open[key] = !state.open[key]; render(); break;
      case "rescan": scan([code]); break;
      case "remove":
        state.results = state.results.filter(function (r) { return r.code.toUpperCase() !== key; });
        persist(); render(); break;
      case "open-order": scan([d.order]); break;
      case "fix-line":
        costForm({
          title: "Fix line cost", type: "line-cost", label: d.desc, current: parseFloat(d.cost), amount: d.amount || "",
          payload: { lineId: Number(d.line) }, rescan: [code]
        });
        break;
      case "fix-item":
        costForm({
          title: "Set item master cost", type: "item-cost", label: d.label, current: parseFloat(d.current), amount: d.amount || "",
          payload: { kind: d.kind, ids: d.ids.split(",").map(Number), label: d.label }, rescan: [code]
        });
        break;
      case "exempt": exemptForm(d.sku, d.desc, code); break;
    }
  });

  els.fixBody.addEventListener("click", function (e) {
    var t = e.target.closest("[data-fix]");
    if (!t) return;
    if (t.dataset.fix === "review") reviewFix();
    else if (t.dataset.fix === "apply") applyFix();
    else if (t.dataset.fix === "exempt") saveExemption();
  });
  byId("ccFixClose").addEventListener("click", closeFix);
  els.fixDialog.addEventListener("close", function () { fix = null; els.input.focus(); });

  /* ─────────── camera ─────────── */

  var stream = null, detecting = false, lastCode = "", lastAt = 0;

  async function openCamera() {
    if (!("BarcodeDetector" in window) || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      els.hint.textContent = "This browser cannot read barcodes with the camera. Use the scanner (it types the code), or type it in.";
      els.hint.classList.add("cc-error");
      return;
    }
    els.camDialog.showModal();
    try {
      var formats = ["code_128", "code_39", "code_93", "ean_13", "ean_8", "upc_a", "upc_e", "itf", "codabar", "qr_code", "data_matrix"];
      var supported = await BarcodeDetector.getSupportedFormats();
      var detector = new BarcodeDetector({ formats: formats.filter(function (f) { return supported.indexOf(f) >= 0; }) });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      els.video.srcObject = stream;
      await els.video.play();
      detecting = true;
      els.camMsg.textContent = "Point at a barcode. Each code is added as it is read.";
      loop(detector);
    } catch (err) {
      els.camMsg.textContent = err && err.name === "NotAllowedError"
        ? "Camera permission was refused. Allow it for this site in the browser settings."
        : "Could not start the camera: " + (err && err.message ? err.message : err);
    }
  }

  async function loop(detector) {
    while (detecting) {
      try {
        var found = await detector.detect(els.video);
        if (found.length) {
          var code = found[0].rawValue;
          var now = Date.now();
          // The same label stays in frame for a while; read it once.
          if (code && (code !== lastCode || now - lastAt > 3000)) {
            lastCode = code; lastAt = now;
            feedback();
            els.camMsg.textContent = "Read " + code;
            scan([code]);
          }
        }
      } catch (e) { /* a frame that cannot be read is just skipped */ }
      await new Promise(function (r) { setTimeout(r, 200); });
    }
  }

  function closeCamera() {
    detecting = false;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    els.video.srcObject = null;
    if (els.camDialog.open) els.camDialog.close();
  }
  els.camera.addEventListener("click", openCamera);
  byId("ccCameraClose").addEventListener("click", closeCamera);
  els.camDialog.addEventListener("close", closeCamera);

  /* ─────────── start ─────────── */

  var saved = [];
  try { saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || "[]"); } catch (e) { saved = []; }
  render();
  if (saved.length) scan(saved);
  els.input.focus();
})();
