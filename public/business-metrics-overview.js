/**
 * Business Metrics — Overview tab (tab 1).
 *
 * Owns everything inside #overview: command bar, exceptions rail, headline tiles, trend
 * and aging panels, and the customer list. Reads /api/business-metrics/summary — the
 * slim live-MSSQL endpoint, not the 200 KB monolith the other tabs use.
 *
 * Drawer, formatters, CSV and the refresh/auto-refresh plumbing come from window.BM
 * (business-metrics-shared.js), which tabs 2-6 share.
 */
(function () {
  "use strict";

  var BM = window.BM;
  var esc = BM.esc, money = BM.money, intf = BM.intf;
  var dateLabel = BM.dateLabel, monthLabel = BM.monthLabel;

  var state = {
    period: "ytd",
    data: null,
    error: null,
    loading: false,
    autoIndex: 0,
    etag: null,
    loadedAt: null
  };

  var root = null;
  var applyAuto = null;

  /* ─────────── data ─────────── */

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
      var res = await fetch("/api/business-metrics/summary?period=" + encodeURIComponent(state.period),
        { cache: "no-store", headers: headers });

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
      state.error = BM.describeError(err);
    } finally {
      state.loading = false;
      render();
    }
  }

  /* ─────────── render ─────────── */

  function render() {
    if (!root) return;
    var d = state.data;

    // The page-level badge is shared with the other tabs, which do not load until one
    // of them is opened — so while Overview is showing, this module owns it.
    var badge = document.getElementById("statusBadge");
    var active = document.querySelector(".workflow-panel.active");
    if (badge && active && active.id === "overview") {
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
    var online = Boolean(d && d.online);

    var periods = [["mtd", "MTD"], ["qtd", "QTD"], ["ytd", "YTD"], ["r12", "12M"]].map(function (p) {
      return '<button type="button" data-period="' + p[0] + '"' +
        (state.period === p[0] ? ' class="active"' : "") + ">" + p[1] + "</button>";
    }).join("");

    return BM.commandBar({
      leading: '<div class="ov-periods" role="group" aria-label="Reporting period">' + periods + "</div>",
      loading: state.loading,
      loadedAt: state.loadedAt,
      autoIndex: state.autoIndex,
      canExport: online,
      sources: [{
        label: "Innovations",
        online: online,
        title: d && d.source ? (d.source.name + ": " + d.source.detail) : "Innovations MSSQL"
      }]
    });
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
    var s = h.sales, w = h.wip, r = h.receivables;

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
      return ((i / (vals.length - 1)) * 100).toFixed(1) + "," + (26 - ((v - min) / span) * 22).toFixed(1);
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
          (m.partial ? " — month in progress" : "") + "</title></g>";
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
        "<span>click a month to drill</span></div></div>";
  }

  function renderAging(d) {
    var buckets = (d.aging && d.aging.buckets) || [];
    var total = (d.aging && d.aging.total) || 0;
    var withValue = buckets.filter(function (b) { return b.amountDue > 0; });
    var empty = buckets.filter(function (b) { return b.amountDue <= 0; });

    var bar = withValue.map(function (b) {
      var p = total > 0 ? (b.amountDue / total) * 100 : 0;
      return '<i style="width:' + p.toFixed(2) + '%;background:' + (b.bucket === 0 ? "var(--green)" : "var(--red)") + '"></i>';
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
        var share = totalSales > 0 ? (c.salesYTD / totalSales) * 100 : 0;
        return '<button type="button" class="ov-row" data-drill="customer:' + c.customerId + '"' +
          ' aria-label="' + esc((i + 1) + ". " + c.name + ", sales " + money(c.salesYTD) +
            ", balance " + money(c.balance) + ". Open details.") + '">' +
          '<span class="muted num" style="width:16px">' + (i + 1) + "</span>" +
          '<span class="grow">' + esc(c.name) + "</span>" +
          '<span class="muted" style="width:52px">' + esc(c.accountNumber || "—") + "</span>" +
          '<span class="ov-minibar"><i style="width:' + ((c.salesYTD / max) * 100).toFixed(1) + '%"></i></span>' +
          '<span class="num muted" style="width:44px">' + share.toFixed(1) + "%</span>" +
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

    BM.bindBar(root, {
      onRefresh: function () { loadSummary(); },
      onAuto: function () {
        state.autoIndex = (state.autoIndex + 1) % BM.AUTO_OPTIONS.length;
        applyAuto();
        render();
      },
      onCsv: exportSummaryCsv
    });

    root.querySelectorAll("[data-drill]").forEach(function (el) {
      el.addEventListener("click", function () { BM.openDrill(el.dataset.drill); });
    });
  }

  /** Sales-by-month is already in memory — never spend a round trip on it. */
  function monthsAsTable() {
    if (!state.data || !state.data.trend) return null;
    var months = state.data.trend.months.slice().reverse();
    return {
      kind: "sales-months",
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
    BM.downloadCsv("business-metrics-overview-" + state.period + ".csv", rows);
  }

  /* ─────────── init ─────────── */

  function init() {
    root = document.getElementById("ovRoot");
    if (!root) return;

    BM.registerLocalDrill("sales-months", monthsAsTable);
    applyAuto = BM.makeAutoRefresher(function () { return state.autoIndex; },
      function () { loadSummary({ background: true }); });

    BM.startFreshnessTicker(function (el) {
      return root.contains(el) ? state : null;
    });

    // A hidden tab skips its polls; catch up as soon as it comes back.
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && BM.AUTO_OPTIONS[state.autoIndex].ms) loadSummary({ background: true });
    });

    render();
    loadSummary().then(function () {
      if (location.hash.indexOf("#drill=") === 0) {
        BM.openDrill(decodeURIComponent(location.hash.slice("#drill=".length)), { replaceStack: true });
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
