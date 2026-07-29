/**
 * Business Metrics — Overview tab (tab 1).
 *
 * Owns everything inside #overview: the command bar, the exceptions rail, the headline
 * tiles, the trend and aging panels, the customer list, and the drill drawer.
 *
 * Reads /api/business-metrics/summary and /api/business-metrics/drill/:kind — the slim
 * live-MSSQL endpoints, not the 200 KB /api/business-metrics monolith the other tabs use.
 *
 * Refresh rules that matter:
 *  - a background refresh never blanks the tab; values dim and swap in place
 *  - auto-refresh pauses while the document is hidden, so a forgotten wall display
 *    stops polling MSSQL
 *  - the fetch sends If-None-Match, so an unchanged poll costs a 304 with no body
 */
(function () {
  "use strict";

  var CURRENCY = "BBD";
  var STALE_AFTER_MS = 5 * 60 * 1000;
  var AUTO_OPTIONS = [
    { ms: 0, label: "Auto off" },
    { ms: 60000, label: "Auto 1m" },
    { ms: 300000, label: "Auto 5m" }
  ];

  var state = {
    period: "ytd",
    data: null,
    error: null,
    loading: false,
    autoIndex: 0,
    etag: null,
    loadedAt: null,
    drill: []          // breadcrumb stack of { kind, params, data, loading, error }
  };

  var root = null;
  var autoTimer = null;
  var tickTimer = null;

  /* ─────────── formatting ─────────── */

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function money(n, digits) {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: CURRENCY,
      maximumFractionDigits: digits == null ? 0 : digits
    }).format(Number(n) || 0);
  }

  function intf(n) { return new Intl.NumberFormat().format(Number(n) || 0); }

  function dateLabel(v) {
    if (!v) return "—";
    var d = new Date(v);
    return isNaN(d) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function monthLabel(ym) {
    if (!ym) return "";
    var parts = String(ym).split("-");
    return new Date(Number(parts[0]), Number(parts[1]) - 1, 1)
      .toLocaleString(undefined, { month: "short" }) + " " + parts[0].slice(2);
  }

  function relTime(iso) {
    if (!iso) return "never";
    var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    return Math.floor(s / 3600) + "h ago";
  }

  function formatCell(value, format) {
    switch (format) {
      case "money": return value == null ? "—" : money(value, 2);
      case "int": return value == null ? "—" : intf(value);
      case "pct": return value == null ? "—" : (Number(value).toFixed(1) + "%");
      case "days": return value == null ? "—" : intf(value) + "d";
      case "date": return dateLabel(value);
      default: return value == null || value === "" ? "—" : String(value);
    }
  }

  /* ─────────── data ─────────── */

  function summaryUrl() {
    return "/api/business-metrics/summary?period=" + encodeURIComponent(state.period);
  }

  async function loadSummary(opts) {
    opts = opts || {};
    if (state.loading) return;
    state.loading = true;
    render();

    var headers = {};
    // Only send the validator on a background poll — an explicit refresh should always
    // come back with a body so the user sees the timestamp move.
    if (state.etag && opts.background) headers["If-None-Match"] = state.etag;

    try {
      var res = await fetch(summaryUrl(), { cache: "no-store", headers: headers });

      if (res.status === 304) {
        state.loadedAt = new Date().toISOString();
        state.error = null;
        return;
      }

      var body = await res.json();
      if (!res.ok) throw new Error(body.error || ("Request failed (HTTP " + res.status + ")"));

      state.etag = res.headers.get("ETag");
      state.data = body;
      state.error = body.online === false ? (body.error || "Innovations source unavailable.") : null;
      state.loadedAt = new Date().toISOString();
    } catch (err) {
      state.error = describeError(err);
    } finally {
      state.loading = false;
      render();
    }
  }

  function describeError(err) {
    var msg = err && err.message ? err.message : String(err);
    if (/permission|denied|403/i.test(msg)) return "You need delivery read access to view business metrics.";
    if (/auth|401|sign/i.test(msg)) return "Please sign in to view business metrics.";
    if (/Failed to fetch|NetworkError/i.test(msg)) return "Could not reach the server. Is OptiLens Local running?";
    return msg;
  }

  /* ─────────── auto refresh ─────────── */

  function applyAuto() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    var ms = AUTO_OPTIONS[state.autoIndex].ms;
    if (!ms) return;
    autoTimer = setInterval(function () {
      // Never poll a hidden tab — this is what keeps a forgotten dashboard from
      // hammering MSSQL all night.
      if (document.hidden) return;
      loadSummary({ background: true });
    }, ms);
  }

  /* ─────────── render ─────────── */

  function render() {
    if (!root) return;
    var d = state.data;

    // The page-level badge is shared with the other tabs, which do not load until one
    // of them is opened — so while Overview is showing, this module owns it.
    var badge = document.getElementById("statusBadge");
    if (badge && document.querySelector('.workflow-panel.active') &&
        document.querySelector('.workflow-panel.active').id === "overview") {
      if (state.loading && !d) { badge.textContent = "Loading…"; badge.className = "badge planned"; }
      else if (state.error) { badge.textContent = "Error"; badge.className = "badge credentials-needed"; }
      else if (d && d.online) { badge.textContent = "Live"; badge.className = "badge ready-for-import"; }
      else { badge.textContent = "Offline"; badge.className = "badge credentials-needed"; }
    }

    root.setAttribute("data-refreshing", state.loading && d ? "1" : "0");
    root.innerHTML =
      renderBar() +
      (state.error ? '<div class="ov-error">' + esc(state.error) + "</div>" : "") +
      (d && d.online ? renderBody(d) : (state.error ? "" : renderSkeleton()));

    wire();
  }

  function renderBar() {
    var d = state.data;
    var online = d && d.online;
    var stale = state.loadedAt && (Date.now() - new Date(state.loadedAt).getTime()) > STALE_AFTER_MS;
    var auto = AUTO_OPTIONS[state.autoIndex];

    var periods = [["mtd", "MTD"], ["qtd", "QTD"], ["ytd", "YTD"], ["r12", "12M"]].map(function (p) {
      return '<button type="button" data-period="' + p[0] + '"' +
        (state.period === p[0] ? ' class="active"' : "") + ">" + p[1] + "</button>";
    }).join("");

    return '<div class="ov-bar">' +
      '<div class="ov-periods" role="group" aria-label="Reporting period">' + periods + "</div>" +
      '<span class="ov-fresh' + (stale ? " stale" : "") + '" id="ovFresh">' +
        (state.loading ? '<span class="ov-spin"></span> refreshing…' : "updated " + esc(relTime(state.loadedAt))) +
      "</span>" +
      '<span class="ov-bar-spacer"></span>' +
      '<button type="button" class="ov-btn" id="ovRefresh"' + (state.loading ? " disabled" : "") + '>' +
        '<span class="material-symbols-outlined" aria-hidden="true" style="font-size:15px">refresh</span> Refresh</button>' +
      '<button type="button" class="ov-btn" id="ovAuto" aria-pressed="' + (auto.ms ? "true" : "false") + '">' + esc(auto.label) + "</button>" +
      '<span class="ov-fresh" title="' + esc(d && d.source ? (d.source.name + ": " + d.source.detail) : "Innovations MSSQL") + '">' +
        '<span class="ov-dot ' + (online ? "online" : "offline") + '"></span> Innovations</span>' +
      '<button type="button" class="ov-btn" id="ovExport"' + (online ? "" : " disabled") + '>' +
        '<span class="material-symbols-outlined" aria-hidden="true" style="font-size:15px">download</span> CSV</button>' +
      "</div>";
  }

  function renderSkeleton() {
    var tile = '<div class="ov-tile"><div class="ov-tile-label ov-skel">Loading</div>' +
      '<div class="ov-tile-value ov-skel">0,000,000</div>' +
      '<div class="ov-tile-foot ov-skel">loading</div></div>';
    return '<div class="ov-tiles ov-fade">' + tile + tile + tile + "</div>";
  }

  function renderBody(d) {
    return renderRail(d) + renderTiles(d) + renderPanels(d) + renderDataQuality(d);
  }

  function renderRail(d) {
    var items = d.exceptions || [];
    if (!items.length) {
      return '<div class="ov-fade"><div class="ov-allclear">' +
        "All clear — no zero-cost invoices, overdue receivables or stalled work in progress." +
        "</div></div>";
    }
    return '<div class="ov-fade">' +
      '<div class="ov-rail-label">Needs attention · ' + items.length + " open</div>" +
      '<div class="ov-rail">' + items.map(function (x) {
        var aria = intf(x.count) + " " + x.label + ", " + (x.detail || "") +
          (x.value != null ? ", " + money(x.value) + " exposed" : "") + ". Open details.";
        return '<button type="button" class="ov-exc ' + esc(x.severity) + '" data-drill="' + esc(x.drill) + '"' +
          ' aria-label="' + esc(aria) + '">' +
          '<span class="ov-exc-top">' +
            '<span class="ov-exc-n">' + intf(x.count) + "</span>" +
            '<span class="ov-exc-label">' + esc(x.label) + "</span>" +
            '<span class="ov-exc-arrow material-symbols-outlined" aria-hidden="true">arrow_forward</span>' +
          "</span>" +
          '<span class="ov-exc-detail">' + esc(x.detail || "") +
            (x.value != null ? " · " + money(x.value) + " exposed" : "") + "</span>" +
        "</button>";
      }).join("") + "</div></div>";
  }

  function renderTiles(d) {
    var h = d.headline;
    var s = h.sales;
    var w = h.wip;
    var r = h.receivables;

    var deltaClass = s.deltaPct == null ? "" : (s.deltaPct >= 0 ? "ov-up" : "ov-down");
    var deltaText = s.deltaPct == null
      ? "no prior-period data"
      : (s.deltaPct >= 0 ? "▲ " : "▼ ") + Math.abs(s.deltaPct).toFixed(1) + "% vs " + s.priorLabel;

    var months = (d.trend && d.trend.months) || [];
    var overduePct = r.currentPct == null ? 0 : (100 - r.currentPct);

    return '<div class="ov-tiles ov-fade">' +
      tile({
        drill: "sales-months",
        label: "Sales " + esc(d.periodLabel),
        value: money(s.value),
        delta: '<span class="ov-tile-delta ' + deltaClass + '">' + esc(deltaText) + "</span>",
        extra: sparkline(months),
        foot: intf(s.invoices) + " invoices · tax-exclusive"
      }) +
      tile({
        drill: "wip-customers",
        label: "Work in progress",
        value: money(w.value),
        delta: '<span class="ov-tile-delta">' + intf(w.openOrders) + " open orders</span>",
        extra: "",
        foot: w.staleOrders > 0
          ? '<span class="ov-down">' + intf(w.staleOrders) + " over " + w.staleAfterDays + " days</span> · avg age " + w.avgAgeDays + "d"
          : "avg age " + w.avgAgeDays + " days"
      }) +
      tile({
        drill: "aging-bucket:0",
        label: "Receivables",
        value: money(r.value),
        delta: '<span class="ov-tile-delta">' + intf(r.customers) + " customers</span>",
        extra: '<div class="ov-split" role="img" aria-label="' + (r.currentPct || 0) + '% current">' +
          '<i style="width:' + (r.currentPct || 0) + '%;background:var(--green)"></i>' +
          '<i style="width:' + overduePct + '%;background:var(--red)"></i></div>',
        foot: (r.currentPct == null ? "—" : r.currentPct + "% current") +
          (r.dsoDays != null ? " · " + r.dsoDays + " days sales outstanding" : "")
      }) +
      "</div>";
  }

  function tile(o) {
    // Strip markup from the pre-rendered fragments so the label reads cleanly aloud.
    var plain = function (html) { return String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); };
    var aria = plain(o.label) + ": " + plain(o.value) + ". " + plain(o.delta) + ". " + plain(o.foot) + ". Open details.";
    return '<button type="button" class="ov-tile" data-drill="' + esc(o.drill) + '" aria-label="' + esc(aria) + '">' +
      '<span class="ov-tile-label" aria-hidden="true">' + o.label + "</span>" +
      '<span class="ov-tile-value">' + o.value + "</span>" +
      o.delta + o.extra +
      '<span class="ov-tile-foot">' + o.foot + "</span>" +
      "</button>";
  }

  function sparkline(months) {
    var pts = months.filter(function (m) { return !m.partial; }).slice(-12);
    if (pts.length < 2) return "";
    var vals = pts.map(function (m) { return Number(m.value) || 0; });
    var min = Math.min.apply(null, vals);
    var max = Math.max.apply(null, vals);
    var span = (max - min) || 1;
    var coords = vals.map(function (v, i) {
      var x = (i / (vals.length - 1)) * 100;
      var y = 26 - ((v - min) / span) * 22;
      return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
    return '<svg class="ov-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">' +
      '<polyline points="' + coords + '" fill="none" stroke="var(--blue)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>' +
      "</svg>";
  }

  function renderPanels(d) {
    return '<div class="ov-cols ov-fade">' + renderTrend(d) + renderAging(d) + "</div>" +
      '<div class="ov-fade">' + renderCustomers(d) + "</div>";
  }

  function renderTrend(d) {
    var months = (d.trend && d.trend.months) || [];
    if (!months.length) return '<div class="ov-panel"><h3>Revenue trend</h3><div class="ov-empty">No data.</div></div>';

    var W = 300, H = 110, PAD = 4;
    var all = [];
    months.forEach(function (m) {
      all.push(Number(m.value) || 0);
      if (m.priorValue != null) all.push(Number(m.priorValue));
    });
    var max = Math.max.apply(null, all) || 1;
    var step = W / months.length;

    function y(v) { return H - PAD - ((Number(v) || 0) / max) * (H - PAD * 2); }
    function x(i) { return i * step + step / 2; }

    var cur = months.map(function (m, i) { return x(i).toFixed(1) + "," + y(m.value).toFixed(1); }).join(" ");
    var prior = months
      .map(function (m, i) { return m.priorValue == null ? null : x(i).toFixed(1) + "," + y(m.priorValue).toFixed(1); })
      .filter(Boolean).join(" ");

    var hits = months.map(function (m, i) {
      return '<g class="hit" data-drill="month-invoices:' + esc(m.month) + '">' +
        '<rect x="' + (i * step).toFixed(1) + '" y="0" width="' + step.toFixed(1) + '" height="' + H + '" fill="transparent"></rect>' +
        "<title>" + esc(monthLabel(m.month)) + ": " + esc(money(m.value)) +
          (m.priorValue != null ? " (prior year " + esc(money(m.priorValue)) + ")" : "") +
          (m.partial ? " — month in progress" : "") + "</title>" +
        "</g>";
    }).join("");

    var labels = months.map(function (m, i) {
      return (i % 4 === 0 || i === months.length - 1)
        ? '<text x="' + x(i).toFixed(1) + '" y="' + (H - 1) + '" font-size="7" fill="var(--muted)" text-anchor="middle">' + esc(monthLabel(m.month)) + "</text>"
        : "";
    }).join("");

    return '<div class="ov-panel"><h3>Revenue trend <span>· ' + months.length + " months, live</span></h3>" +
      '<svg class="ov-trend" viewBox="0 0 ' + W + " " + (H + 10) + '" preserveAspectRatio="none">' +
        (prior ? '<polyline points="' + prior + '" fill="none" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>' : "") +
        '<polyline points="' + cur + '" fill="none" stroke="var(--blue)" stroke-width="2" vector-effect="non-scaling-stroke"/>' +
        labels + hits +
      "</svg>" +
      '<div class="ov-legend"><span><b></b>this year</span><span><i></i>prior year</span>' +
        "<span>click a month to drill</span></div>" +
      "</div>";
  }

  function renderAging(d) {
    var buckets = (d.aging && d.aging.buckets) || [];
    var total = (d.aging && d.aging.total) || 0;
    var withValue = buckets.filter(function (b) { return b.amountDue > 0; });
    var empty = buckets.filter(function (b) { return b.amountDue <= 0; });

    var bar = withValue.map(function (b) {
      var pct = total > 0 ? (b.amountDue / total) * 100 : 0;
      return '<i style="width:' + pct.toFixed(2) + '%;background:' + (b.bucket === 0 ? "var(--green)" : "var(--red)") + '"></i>';
    }).join("");

    var rows = withValue.map(function (b) {
      return '<button type="button" class="ov-row" data-drill="aging-bucket:' + b.bucket + '"' +
        ' aria-label="' + esc(b.label + ": " + money(b.amountDue) + " across " + intf(b.items) + " items. Open details.") + '">' +
        '<span class="ov-swatch" style="background:' + (b.bucket === 0 ? "var(--green)" : "var(--red)") + '"></span>' +
        '<span class="grow">' + esc(b.label) + "</span>" +
        '<span class="num muted" style="width:46px">' + intf(b.items) + "</span>" +
        '<span class="num" style="width:88px">' + money(b.amountDue) + "</span>" +
        '<span class="material-symbols-outlined" aria-hidden="true" style="font-size:15px;color:var(--muted)">chevron_right</span>' +
        "</button>";
    }).join("");

    var emptyNote = empty.length
      ? '<div class="ov-row" data-empty="1">' + esc(empty.map(function (b) { return b.label; }).join(", ")) +
        (empty.length > 1 ? " buckets are" : " bucket is") + " empty</div>"
      : "";

    return '<div class="ov-panel"><h3>Receivables aging</h3>' +
      '<div class="ov-split" style="height:10px;margin:0 0 10px">' + bar + "</div>" +
      '<div class="ov-rows">' + rows + emptyNote + "</div></div>";
  }

  function renderCustomers(d) {
    var list = d.topCustomers || [];
    if (!list.length) return "";
    var max = Math.max.apply(null, list.map(function (c) { return Number(c.salesYTD) || 0; })) || 1;
    var totalSales = list.reduce(function (s, c) { return s + (Number(c.salesYTD) || 0); }, 0);

    return '<div class="ov-panel"><h3>Top customers <span>· sales year to date</span></h3><div class="ov-rows">' +
      list.map(function (c, i) {
        var pct = totalSales > 0 ? (c.salesYTD / totalSales) * 100 : 0;
        return '<button type="button" class="ov-row" data-drill="customer:' + c.customerId + '"' +
          ' aria-label="' + esc((i + 1) + ". " + c.name + ", sales " + money(c.salesYTD) +
            ", balance " + money(c.balance) + ". Open details.") + '">' +
          '<span class="muted num" style="width:16px">' + (i + 1) + "</span>" +
          '<span class="grow">' + esc(c.name) + "</span>" +
          '<span class="muted" style="width:52px">' + esc(c.accountNumber || "—") + "</span>" +
          '<span class="ov-minibar"><i style="width:' + ((c.salesYTD / max) * 100).toFixed(1) + '%"></i></span>' +
          '<span class="num muted" style="width:44px">' + pct.toFixed(1) + "%</span>" +
          '<span class="num" style="width:88px">' + money(c.salesYTD) + "</span>" +
          '<span class="num muted" style="width:78px" title="Outstanding balance">' + money(c.balance) + "</span>" +
          '<span class="material-symbols-outlined" aria-hidden="true" style="font-size:15px;color:var(--muted)">chevron_right</span>' +
          "</button>";
      }).join("") + "</div></div>";
  }

  function renderDataQuality(d) {
    var items = d.dataQuality || [];
    if (!items.length) return "";
    return '<div class="ov-note ov-fade">' +
      '<span class="material-symbols-outlined" aria-hidden="true" style="font-size:16px">info</span>' +
      "<span>" + items.map(function (x) { return esc(x.text); }).join("<br>") + "</span></div>";
  }

  /* ─────────── events ─────────── */

  function wire() {
    root.querySelectorAll("[data-period]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (state.period === b.dataset.period) return;
        state.period = b.dataset.period;
        state.etag = null;
        loadSummary();
      });
    });

    var refresh = root.querySelector("#ovRefresh");
    if (refresh) refresh.addEventListener("click", function () { loadSummary(); });

    var auto = root.querySelector("#ovAuto");
    if (auto) auto.addEventListener("click", function () {
      state.autoIndex = (state.autoIndex + 1) % AUTO_OPTIONS.length;
      applyAuto();
      render();
    });

    var exp = root.querySelector("#ovExport");
    if (exp) exp.addEventListener("click", exportSummaryCsv);

    root.querySelectorAll("[data-drill]").forEach(function (el) {
      el.addEventListener("click", function () { openDrill(el.dataset.drill); });
    });
  }

  /* ─────────── drill drawer ─────────── */

  function parseDrill(spec) {
    var idx = String(spec).indexOf(":");
    var kind = idx === -1 ? spec : spec.slice(0, idx);
    var arg = idx === -1 ? null : spec.slice(idx + 1);
    var params = {};
    if (arg != null) {
      if (kind === "aging-bucket") params.bucket = arg;
      else if (kind === "month-invoices") params.month = arg;
      else if (kind === "customer" || kind === "wip-customer") params.customerId = arg;
      else if (kind === "aging-customer") {
        var bits = arg.split(":");
        params.bucket = bits[0];
        params.customerId = bits[1];
      }
    }
    return { kind: kind, params: params };
  }

  function drillSpec(kind, params) {
    if (kind === "aging-bucket") return "aging-bucket:" + params.bucket;
    if (kind === "month-invoices") return "month-invoices:" + params.month;
    if (kind === "customer") return "customer:" + params.customerId;
    if (kind === "wip-customer") return "wip-customer:" + params.customerId;
    if (kind === "aging-customer") return "aging-customer:" + params.bucket + ":" + params.customerId;
    return kind;
  }

  async function openDrill(spec, opts) {
    opts = opts || {};
    var parsed = parseDrill(spec);

    // "sales-months" is served straight from the trend already in memory — level-one
    // drills must not cost a round trip.
    if (parsed.kind === "sales-months") {
      pushDrill({ kind: parsed.kind, params: {}, data: monthsAsDrill(), loading: false, error: null }, opts);
      return;
    }

    var entry = { kind: parsed.kind, params: parsed.params, data: null, loading: true, error: null };
    pushDrill(entry, opts);

    try {
      var qs = new URLSearchParams(parsed.params).toString();
      var res = await fetch("/api/business-metrics/drill/" + encodeURIComponent(parsed.kind) + (qs ? "?" + qs : ""),
        { cache: "no-store" });
      var body = await res.json();
      if (!res.ok) throw new Error(body.error || ("Request failed (HTTP " + res.status + ")"));
      entry.data = body;
    } catch (err) {
      entry.error = describeError(err);
    } finally {
      entry.loading = false;
      renderDrawer();
    }
  }

  function monthsAsDrill() {
    var months = ((state.data && state.data.trend && state.data.trend.months) || []).slice().reverse();
    return {
      title: "Sales by month",
      subtitle: state.data.trend.basis,
      summary: [
        { label: "Months", value: months.length, format: "int" },
        { label: "Latest", value: months.length ? months[0].value : 0, format: "money" }
      ],
      columns: [
        { key: "monthLabel", label: "Month", format: "text" },
        { key: "value", label: "Net sales", format: "money", align: "right" },
        { key: "invoices", label: "Invoices", format: "int", align: "right" },
        { key: "priorValue", label: "Prior year", format: "money", align: "right" },
        { key: "deltaPct", label: "Change", format: "pct", align: "right" }
      ],
      rows: months.map(function (m) {
        return {
          month: m.month,
          monthLabel: monthLabel(m.month) + (m.partial ? " (partial)" : ""),
          value: m.value,
          invoices: m.invoices,
          priorValue: m.priorValue,
          deltaPct: m.priorValue ? ((m.value / m.priorValue) - 1) * 100 : null
        };
      }),
      next: { kind: "month-invoices", carry: ["month"] }
    };
  }

  function pushDrill(entry, opts) {
    if (opts && opts.replaceStack) state.drill = [entry];
    else state.drill.push(entry);
    renderDrawer();
  }

  function closeDrawer() {
    state.drill = [];
    renderDrawer();
  }

  function popTo(index) {
    state.drill = state.drill.slice(0, index + 1);
    renderDrawer();
  }

  function renderDrawer() {
    var host = document.getElementById("ovDrawerHost");
    if (!host) return;

    if (!state.drill.length) {
      host.innerHTML = "";
      document.body.style.overflow = "";
      if (location.hash.indexOf("#drill=") === 0) {
        history.replaceState(null, "", location.pathname + location.search);
      }
      return;
    }

    document.body.style.overflow = "hidden";
    var top = state.drill[state.drill.length - 1];
    history.replaceState(null, "", "#drill=" + drillSpec(top.kind, top.params));

    var crumb = state.drill.length > 1
      ? '<div class="ov-crumb">' + state.drill.map(function (e, i) {
          var label = esc((e.data && e.data.title) || e.kind);
          return i === state.drill.length - 1
            ? "<span>" + label + "</span>"
            : '<button type="button" data-crumb="' + i + '">' + label + "</button>" +
              '<span aria-hidden="true">›</span>';
        }).join("") + "</div>"
      : "";

    var body;
    if (top.loading) body = '<div class="ov-empty"><span class="ov-spin"></span> Loading…</div>';
    else if (top.error) body = '<div class="ov-error" style="margin-top:12px">' + esc(top.error) + "</div>";
    else body = renderDrillTable(top.data);

    host.innerHTML =
      '<div class="ov-scrim" id="ovScrim"></div>' +
      '<aside class="ov-drawer" role="dialog" aria-modal="true" aria-label="' +
        esc((top.data && top.data.title) || "Detail") + '">' +
        '<div class="ov-drawer-head">' + crumb +
          '<div class="ov-drawer-title"><div>' +
            "<h2>" + esc((top.data && top.data.title) || "Loading…") + "</h2>" +
            '<div class="ov-drawer-sub">' + esc((top.data && top.data.subtitle) || "") + "</div>" +
          "</div>" +
          '<div class="ov-drawer-actions">' +
            '<button type="button" class="ov-btn" id="ovDrillRefresh">' +
              '<span class="material-symbols-outlined" aria-hidden="true" style="font-size:15px">refresh</span></button>' +
            '<button type="button" class="ov-btn" id="ovDrillCsv">CSV</button>' +
            '<button type="button" class="ov-btn" id="ovDrillClose" aria-label="Close">' +
              '<span class="material-symbols-outlined" aria-hidden="true" style="font-size:15px">close</span></button>' +
          "</div></div>" +
          renderDrillSummary(top.data) +
        "</div>" +
        '<div class="ov-drawer-body">' + body + "</div>" +
      "</aside>";

    wireDrawer();
  }

  function renderDrillSummary(data) {
    if (!data || !data.summary || !data.summary.length) return "";
    return '<div class="ov-drawer-sum">' + data.summary.map(function (s) {
      return "<div>" + esc(s.label) + "<strong>" + formatCell(s.value, s.format) + "</strong></div>";
    }).join("") + "</div>" +
    (data.generatedAt ? '<div class="ov-drawer-sub" style="margin-top:6px">as of ' + esc(dateLabel(data.generatedAt)) +
      " " + esc(new Date(data.generatedAt).toLocaleTimeString()) + "</div>" : "");
  }

  function renderDrillTable(data) {
    if (!data || !data.rows || !data.rows.length) {
      return '<div class="ov-empty">Nothing to show — this drill returned no rows.</div>';
    }
    var cols = data.columns || [];
    var clickable = Boolean(data.next);

    return '<table class="bm-table"><thead><tr>' +
      cols.map(function (c) {
        return '<th class="' + (c.align === "right" ? "num" : "") + '">' + esc(c.label) + "</th>";
      }).join("") +
      "</tr></thead><tbody>" +
      data.rows.map(function (row, i) {
        return '<tr class="' + (clickable ? "clickable" : "") + '" data-row="' + i + '">' +
          cols.map(function (c) {
            return '<td class="' + (c.align === "right" ? "num" : "") + '">' + esc(formatCell(row[c.key], c.format)) + "</td>";
          }).join("") + "</tr>";
      }).join("") +
      "</tbody></table>";
  }

  function wireDrawer() {
    var host = document.getElementById("ovDrawerHost");
    var top = state.drill[state.drill.length - 1];

    var scrim = host.querySelector("#ovScrim");
    if (scrim) scrim.addEventListener("click", closeDrawer);

    var close = host.querySelector("#ovDrillClose");
    if (close) close.addEventListener("click", closeDrawer);

    var refresh = host.querySelector("#ovDrillRefresh");
    if (refresh) refresh.addEventListener("click", function () {
      state.drill.pop();
      openDrill(drillSpec(top.kind, top.params));
    });

    var csv = host.querySelector("#ovDrillCsv");
    if (csv) csv.addEventListener("click", function () { exportDrillCsv(top.data); });

    host.querySelectorAll("[data-crumb]").forEach(function (b) {
      b.addEventListener("click", function () { popTo(Number(b.dataset.crumb)); });
    });

    if (top.data && top.data.next) {
      host.querySelectorAll("tr[data-row]").forEach(function (tr) {
        tr.addEventListener("click", function () {
          var row = top.data.rows[Number(tr.dataset.row)];
          var next = top.data.next;
          var params = Object.assign({}, next.fixed || {});
          (next.carry || []).forEach(function (k) { params[k] = row[k]; });
          openDrill(drillSpec(next.kind, params));
        });
      });
    }
  }

  /* ─────────── CSV ─────────── */

  function downloadCsv(name, rows) {
    var body = rows.map(function (r) {
      return r.map(function (cell) {
        var v = cell == null ? "" : String(cell);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(",");
    }).join("\r\n");

    var url = URL.createObjectURL(new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" }));
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportSummaryCsv() {
    var d = state.data;
    if (!d || !d.online) return;
    var rows = [["Metric", "Value", "Detail"]];
    var h = d.headline;
    rows.push(["Sales " + d.periodLabel, h.sales.value, h.sales.deltaPct == null ? "" : h.sales.deltaPct + "% vs " + h.sales.priorLabel]);
    rows.push(["Work in progress", h.wip.value, h.wip.openOrders + " open orders, " + h.wip.staleOrders + " stale"]);
    rows.push(["Receivables", h.receivables.value, h.receivables.currentPct + "% current, DSO " + h.receivables.dsoDays]);
    (d.exceptions || []).forEach(function (x) { rows.push([x.label, x.count, x.detail]); });
    rows.push([]);
    rows.push(["Month", "Net sales", "Invoices", "Prior year"]);
    ((d.trend && d.trend.months) || []).forEach(function (m) {
      rows.push([m.month, m.value, m.invoices, m.priorValue == null ? "" : m.priorValue]);
    });
    downloadCsv("business-metrics-overview-" + state.period + ".csv", rows);
  }

  function exportDrillCsv(data) {
    if (!data || !data.rows) return;
    var cols = data.columns || [];
    var rows = [cols.map(function (c) { return c.label; })];
    data.rows.forEach(function (r) {
      rows.push(cols.map(function (c) { return r[c.key] == null ? "" : r[c.key]; }));
    });
    downloadCsv((data.kind || "drill") + ".csv", rows);
  }

  /* ─────────── init ─────────── */

  function init() {
    root = document.getElementById("ovRoot");
    if (!root) return;

    if (!document.getElementById("ovDrawerHost")) {
      var host = document.createElement("div");
      host.id = "ovDrawerHost";
      document.body.appendChild(host);
    }

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && state.drill.length) closeDrawer();
    });

    // Repaint the "updated Ns ago" label without refetching.
    tickTimer = setInterval(function () {
      var el = root.querySelector("#ovFresh");
      if (!el || state.loading) return;
      var stale = state.loadedAt && (Date.now() - new Date(state.loadedAt).getTime()) > STALE_AFTER_MS;
      el.className = "ov-fresh" + (stale ? " stale" : "");
      el.textContent = "updated " + relTime(state.loadedAt);
    }, 1000);

    // A hidden tab skips its polls; catch up as soon as it comes back.
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && AUTO_OPTIONS[state.autoIndex].ms) loadSummary({ background: true });
    });

    render();
    loadSummary().then(function () {
      if (location.hash.indexOf("#drill=") === 0) {
        openDrill(decodeURIComponent(location.hash.slice("#drill=".length)), { replaceStack: true });
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
