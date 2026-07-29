/**
 * Business Metrics — tabs 2-6 (Sales, Invoices, Profitability, Deliveries, Pricing).
 *
 * Each tab is independent: it fetches only its own /api/business-metrics/detail/:section
 * on first open, carries its own command bar (refresh, auto-refresh, source dots, CSV),
 * and opens long row sets in the shared drawer instead of dumping hundreds of rows into
 * the page. Opening Pricing no longer runs a 30-day profitability query; opening
 * Invoices no longer touches the app database.
 *
 * Also owns tab switching, since it decides when a section loads.
 */
(function () {
  "use strict";

  var BM = window.BM;
  var esc = BM.esc, money = BM.money, intf = BM.intf, pct = BM.pct;
  var dateLabel = BM.dateLabel, monthLabel = BM.monthLabel;

  var SECTIONS = ["sales", "invoices", "profitability", "deliveries", "pricing"];

  // One state object per tab, so each refreshes on its own clock.
  var tabs = {};
  SECTIONS.forEach(function (name) {
    tabs[name] = {
      name: name, root: null, data: null, error: null,
      loading: false, loaded: false, autoIndex: 0, etag: null, loadedAt: null,
      applyAuto: null
    };
  });

  /* ─────────── data ─────────── */

  async function load(tab, opts) {
    opts = opts || {};
    if (tab.loading) return;
    tab.loading = true;
    tab.loaded = true;
    render(tab);

    var headers = {};
    if (tab.etag && opts.background) headers["If-None-Match"] = tab.etag;

    try {
      var res = await fetch("/api/business-metrics/detail/" + tab.name, { cache: "no-store", headers: headers });

      if (res.status === 304) {
        tab.loadedAt = new Date().toISOString();
        tab.error = null;
        return;
      }

      var body = await res.json();
      if (!res.ok) throw new Error(body.error || ("Request failed (HTTP " + res.status + ")"));

      tab.etag = res.headers.get("ETag");
      tab.data = body;
      tab.error = body.error || null;
      tab.loadedAt = new Date().toISOString();
    } catch (err) {
      tab.error = BM.describeError(err);
    } finally {
      tab.loading = false;
      render(tab);
    }
  }

  /* ─────────── shared render helpers ─────────── */

  function stat(label, value, detail) {
    return '<div class="ov-stat"><span class="ov-tile-label">' + esc(label) + "</span>" +
      '<span class="ov-tile-value">' + value + "</span>" +
      (detail ? '<span class="ov-tile-foot">' + detail + "</span>" : "") + "</div>";
  }

  /** A row that opens a table in the drawer — the alternative to inlining 100 rows. */
  function openRow(key, label, detail, count) {
    return '<button type="button" class="ov-row" data-open="' + esc(key) + '"' +
      ' aria-label="' + esc(label + ", " + count + " rows. Open details.") + '">' +
      '<span class="grow">' + esc(label) + "</span>" +
      '<span class="muted">' + esc(detail || "") + "</span>" +
      '<span class="num muted" style="width:64px">' + intf(count) + " rows</span>" +
      '<span class="material-symbols-outlined" aria-hidden="true" style="font-size:15px;color:var(--muted)">chevron_right</span>' +
      "</button>";
  }

  function barChart(rows, valueKey, fmt, emptyText) {
    if (!rows || !rows.length) return '<div class="ov-empty">' + esc(emptyText || "No dated records.") + "</div>";
    var max = Math.max.apply(null, rows.map(function (r) { return Number(r[valueKey]) || 0; }).concat([1]));
    return '<div class="bm-chart">' + rows.map(function (r) {
      var v = Number(r[valueKey]) || 0;
      return '<div class="bm-bar-wrap" title="' + esc(monthLabel(r.month) + ": " + fmt(v)) + '">' +
        '<span class="bm-bar-val">' + esc(fmt(v)) + "</span>" +
        '<div class="bm-bar" style="height:' + Math.round((v / max) * 120) + 'px;"></div>' +
        '<span class="bm-bar-lbl">' + esc(monthLabel(r.month)) + "</span></div>";
    }).join("") + "</div>";
  }

  function panel(title, sub, body) {
    return '<div class="ov-panel"><h3>' + esc(title) +
      (sub ? " <span>· " + esc(sub) + "</span>" : "") + "</h3>" + body + "</div>";
  }

  function bar(tab) {
    var s = tab.data && tab.data.sources ? tab.data.sources : {};
    var dots = [];
    if (s.sourceMssql) dots.push({ label: "Innovations", online: s.sourceMssql.state === "online", title: s.sourceMssql.name + ": " + s.sourceMssql.detail });
    if (s.appDb) dots.push({ label: "App DB", online: s.appDb.state === "online", title: s.appDb.name + ": " + s.appDb.detail });

    return BM.commandBar({
      loading: tab.loading,
      loadedAt: tab.loadedAt,
      autoIndex: tab.autoIndex,
      canExport: Boolean(tab.data && !tab.error),
      sources: dots
    });
  }

  function skeleton() {
    var s = '<div class="ov-stat"><span class="ov-tile-label ov-skel">Loading</span>' +
      '<span class="ov-tile-value ov-skel">0,000</span></div>';
    return '<div class="ov-tiles ov-fade">' + s + s + s + "</div>";
  }

  /* ─────────── per-tab bodies ─────────── */

  var BODIES = {
    sales: function (d) {
      var out = "";
      var live = d.live;

      if (live) {
        out += panel("Top customers", "live, sales year to date",
          '<div class="ov-rows">' + live.topCustomers.map(function (c, i) {
            return '<button type="button" class="ov-row" data-drill="customer:' + c.customerId + '"' +
              ' aria-label="' + esc(c.name + ", sales " + money(c.salesYTD) + ". Open details.") + '">' +
              '<span class="muted num" style="width:16px">' + (i + 1) + "</span>" +
              '<span class="grow">' + esc(c.name) + "</span>" +
              '<span class="muted" style="width:52px">' + esc(c.accountNumber || "—") + "</span>" +
              '<span class="num" style="width:92px">' + money(c.salesYTD) + "</span>" +
              '<span class="num muted" style="width:82px">' + money(c.balance) + "</span>" +
              '<span class="material-symbols-outlined" aria-hidden="true" style="font-size:15px;color:var(--muted)">chevron_right</span>' +
              "</button>";
          }).join("") + "</div>");

        var agingRows = live.aging.filter(function (b) { return b.amountDue > 0; });
        out += panel("Receivables aging", "live",
          '<div class="ov-rows">' + agingRows.map(function (b) {
            return '<button type="button" class="ov-row" data-drill="aging-bucket:' + b.bucket + '"' +
              ' aria-label="' + esc(b.label + ": " + money(b.amountDue) + ". Open details.") + '">' +
              '<span class="ov-swatch" style="background:' + (b.bucket === 0 ? "var(--green)" : "var(--red)") + '"></span>' +
              '<span class="grow">' + esc(b.label) + "</span>" +
              '<span class="num muted" style="width:52px">' + intf(b.items) + "</span>" +
              '<span class="num" style="width:96px">' + money(b.amountDue) + "</span>" +
              '<span class="material-symbols-outlined" aria-hidden="true" style="font-size:15px;color:var(--muted)">chevron_right</span>' +
              "</button>";
          }).join("") +
          '<div class="ov-row" data-empty="1">Total due ' + money(live.agingTotal) + "</div></div>");
      }

      var a = d.archive;
      if (a) {
        var months = a.revenueByMonth || [];
        var avg = months.length ? a.archivedRevenueTotal / months.length : 0;
        var best = months.reduce(function (x, y) { return Number(y.revenue) > Number(x.revenue) ? y : x; }, { revenue: 0, month: null });

        out += '<div class="ov-tiles ov-fade">' +
          stat("Archived revenue", money(a.archivedRevenueTotal), "all archived deliveries") +
          stat("Average per month", money(avg), intf(months.length) + " months") +
          stat("Best month", best.month ? money(best.revenue) : "—", best.month ? esc(monthLabel(best.month)) : "") +
          "</div>";

        out += panel("Archived revenue by month", "Access archive", barChart(months, "revenue", money, "No dated records in the archive window."));
        out += panel("Archive detail", "imported deliveries",
          '<div class="ov-rows">' + openRow("archive-customers", "Top customers by archived revenue", "", a.topCustomers.length) +
          openRow("archive-months", "Revenue and deliveries by month", "", months.length) + "</div>");
      }

      return out || '<div class="ov-empty">No sales data available.</div>';
    },

    invoices: function (d) {
      var t = d.invoiceThresholds;
      if (!t) return '<div class="ov-empty">Live Innovations source unavailable.</div>';

      return '<div class="ov-tiles ov-fade">' +
        stat("Shipped invoices", intf(t.shippedInvoiceCount), "last " + intf(t.lookbackDays) + " days") +
        stat("Total under 199", intf(t.under199.count), money(t.under199.total)) +
        stat("Total over 180", intf(t.over180.count), money(t.over180.total)) +
        stat("In both bands", intf(t.overlapCount), "between 180 and 199") +
        "</div>" +
        panel("Invoice lists", "open in a drawer",
          '<div class="ov-rows">' +
          openRow("invoice-threshold?band=under199", "Invoices under 199.00", money(t.under199.total), t.under199.count) +
          openRow("invoice-threshold?band=over180", "Invoices over 180.00", money(t.over180.total), t.over180.count) +
          "</div>");
    },

    profitability: function (d) {
      var p = d.profitability;
      if (!p) return '<div class="ov-empty">Live Innovations source unavailable.</div>';
      var z = p.zeroCost || {};

      var out = '<div class="ov-tiles ov-fade">' +
        stat("Net revenue", money(p.netRevenue), intf(p.invoiceCount) + " invoices · " + intf(p.lineCount) + " lines") +
        stat("Cost", money(p.totalCost), intf(p.costedLineCount) + " costed lines") +
        stat("Margin", money(p.marginAmount), pct(p.marginPct)) +
        stat("Credits", money(p.creditRevenue), "last " + intf(p.lookbackDays) + " days") +
        "</div>";

      out += '<div class="ov-fade">' +
        (z.invoiceCount > 0
          ? '<div class="ov-rail-label">Needs attention · 1 open</div><div class="ov-rail">' +
            '<button type="button" class="ov-exc critical" data-open="zero-cost-lines"' +
            ' aria-label="' + esc(intf(z.invoiceCount) + " zero-cost invoices, target 0, " + money(z.lineRevenue) + " exposed. Open details.") + '">' +
              '<span class="ov-exc-top"><span class="ov-exc-n">' + intf(z.invoiceCount) + "</span>" +
              '<span class="ov-exc-label">zero-cost invoices</span>' +
              '<span class="ov-exc-arrow material-symbols-outlined" aria-hidden="true">arrow_forward</span></span>' +
              '<span class="ov-exc-detail">target 0 · last ' + intf(z.lookbackDays) + " days · " + money(z.lineRevenue) + " exposed</span>" +
            "</button></div>"
          : '<div class="ov-allclear">On target — no shipped invoices with zero-cost lens or add-on lines.</div>') +
        "</div>";

      out += '<div class="ov-tiles ov-fade">' +
        stat("Lens lines", intf(z.lensLineCount) + " / " + intf(z.lensQuantity), money(z.lensRevenue) + " line revenue") +
        stat("Add-on lines", intf(z.addonLineCount) + " / " + intf(z.addonQuantity), money(z.addonRevenue) + " line revenue") +
        stat("Invoice value exposed", money(z.invoiceRevenue), "across " + intf(z.invoiceCount) + " invoices") +
        "</div>";

      out += panel("Breakdowns", "open in a drawer",
        '<div class="ov-rows">' +
        openRow("profit-customers", "Profitability by customer", "", p.byCustomer.length) +
        openRow("profit-groups", "Profitability by product category", "", p.byProductGroup.length) +
        openRow("low-margin-lines", "Lowest-margin lines", "worst margin first", p.lineCount) +
        openRow("zero-cost-lines", "Zero-cost line detail", money(z.lineRevenue), z.lineCount) +
        "</div>");

      out += '<div class="ov-note ov-fade">' +
        '<span class="material-symbols-outlined" aria-hidden="true" style="font-size:16px">info</span><span>' +
        "Margin uses only lines where cost applies: non-credit order types 1, 3 and 12. " +
        "Zero-cost KPI target is 0; excluded: " + esc((z.exceptions || []).join(", ")) + ".</span></div>";

      return out;
    },

    deliveries: function (d) {
      var dl = d.deliveries;
      if (!dl) return '<div class="ov-empty">App database unavailable.</div>';
      var a = dl.appOwned, ar = dl.archive;

      return '<div class="ov-tiles ov-fade">' +
        stat("Total sessions", intf(a.total), "tracked by the app") +
        stat("Open (prep)", intf(a.openPrep), "in progress") +
        stat("Closed", intf(a.closed), "completed") +
        stat("Reopened", intf(a.reopened), "re-edited after close") +
        "</div>" +
        '<div class="ov-tiles ov-fade">' +
        stat("Archived deliveries", intf(ar.deliveriesTotal), ar.avgItemsPerDelivery + " items per delivery") +
        stat("Couriers", intf(ar.couriersTotal), intf(ar.overseasCouriers) + " overseas") +
        stat("Commercial invoices", intf(ar.commercialInvoicesTotal), "export shipments") +
        stat("Freight", money(ar.freightCostTotal), "archived CI total") +
        stat("Packing + insurance", money(Number(ar.packingCostTotal) + Number(ar.insuranceCostTotal)), "archived CI total") +
        "</div>" +
        panel("Deliveries by month", "Access archive", barChart(dl.byMonth || [], "deliveries", intf, "No dated deliveries in the archive."));
    },

    pricing: function (d) {
      var p = d.pricing;
      if (!p) return '<div class="ov-empty">App database unavailable.</div>';
      return '<div class="ov-tiles ov-fade">' +
        stat("Pricing rules", intf(p.rulesTotal), intf(p.rulesActive) + " active") +
        stat("Calculations run", intf(p.calculationsTotal), "app-owned history") +
        stat("Average adjustment", money(p.avgAdjustment, 2), "calculated − input") +
        stat("Last calculation", p.lastCalculationAt ? dateLabel(p.lastCalculationAt) : "—", "") +
        "</div>" +
        '<div class="ov-note ov-fade">' +
        '<span class="material-symbols-outlined" aria-hidden="true" style="font-size:16px">info</span>' +
        "<span>Pricing analytics reflect app-owned rules and calculations. Live price-list version " +
        "history lives in the Innovations source.</span></div>";
    }
  };

  /* ─────────── drawer tables built from data already loaded ─────────── */

  var LOCAL_TABLES = {
    "profit-customers": function () {
      var p = tabs.profitability.data.profitability;
      return {
        kind: "profit-customers", title: "Profitability by customer",
        subtitle: "Shipped lines, last " + p.lookbackDays + " days",
        summary: [
          { label: "Customers", value: p.byCustomer.length, format: "int" },
          { label: "Margin", value: p.marginAmount, format: "money" },
          { label: "Margin %", value: p.marginPct, format: "pct" }
        ],
        columns: [
          { key: "accountNumber", label: "Account", format: "text" },
          { key: "customerName", label: "Customer", format: "text" },
          { key: "invoiceCount", label: "Invoices", format: "int", align: "right" },
          { key: "lineCount", label: "Lines", format: "int", align: "right" },
          { key: "netRevenue", label: "Revenue", format: "money", align: "right" },
          { key: "totalCost", label: "Cost", format: "money", align: "right" },
          { key: "marginAmount", label: "Margin", format: "money", align: "right" },
          { key: "marginPct", label: "Margin %", format: "pct", align: "right" }
        ],
        rows: p.byCustomer
      };
    },

    "profit-groups": function () {
      var p = tabs.profitability.data.profitability;
      return {
        kind: "profit-groups", title: "Profitability by product category",
        subtitle: "Shipped lines, last " + p.lookbackDays + " days",
        summary: [{ label: "Categories", value: p.byProductGroup.length, format: "int" }],
        columns: [
          { key: "productGroup", label: "Category", format: "text" },
          { key: "lineCount", label: "Lines", format: "int", align: "right" },
          { key: "quantity", label: "Qty", format: "int", align: "right" },
          { key: "netRevenue", label: "Revenue", format: "money", align: "right" },
          { key: "totalCost", label: "Cost", format: "money", align: "right" },
          { key: "marginAmount", label: "Margin", format: "money", align: "right" },
          { key: "marginPct", label: "Margin %", format: "pct", align: "right" }
        ],
        rows: p.byProductGroup
      };
    },

    "archive-customers": function () {
      var a = tabs.sales.data.archive;
      return {
        kind: "archive-customers", title: "Top customers by archived revenue",
        subtitle: "Access archive",
        summary: [{ label: "Customers", value: a.topCustomers.length, format: "int" }],
        columns: [
          { key: "name", label: "Customer", format: "text" },
          { key: "accountNumber", label: "Account", format: "text" },
          { key: "items", label: "Line items", format: "int", align: "right" },
          { key: "revenue", label: "Revenue", format: "money", align: "right" }
        ],
        rows: a.topCustomers
      };
    },

    "archive-months": function () {
      var a = tabs.sales.data.archive;
      return {
        kind: "archive-months", title: "Archived revenue by month",
        subtitle: "Access archive",
        summary: [
          { label: "Months", value: a.revenueByMonth.length, format: "int" },
          { label: "Total", value: a.archivedRevenueTotal, format: "money" }
        ],
        columns: [
          { key: "monthLabel", label: "Month", format: "text" },
          { key: "deliveries", label: "Deliveries", format: "int", align: "right" },
          { key: "items", label: "Items", format: "int", align: "right" },
          { key: "revenue", label: "Revenue", format: "money", align: "right" }
        ],
        rows: a.revenueByMonth.map(function (m) {
          return Object.assign({ monthLabel: monthLabel(m.month) }, m);
        })
      };
    }
  };

  /* ─────────── render + wire ─────────── */

  function render(tab) {
    if (!tab.root) return;
    tab.root.setAttribute("data-refreshing", tab.loading && tab.data ? "1" : "0");
    tab.root.innerHTML =
      bar(tab) +
      (tab.error ? '<div class="ov-error">' + esc(tab.error) + "</div>" : "") +
      (tab.data && !tab.error ? BODIES[tab.name](tab.data) : (tab.error ? "" : skeleton()));

    wire(tab);
    updateBadge();
  }

  function wire(tab) {
    BM.bindBar(tab.root, {
      onRefresh: function () { load(tab); },
      onAuto: function () {
        tab.autoIndex = (tab.autoIndex + 1) % BM.AUTO_OPTIONS.length;
        tab.applyAuto();
        render(tab);
      },
      onCsv: function () { exportCsv(tab); }
    });

    tab.root.querySelectorAll("[data-drill]").forEach(function (el) {
      el.addEventListener("click", function () { BM.openDrill(el.dataset.drill); });
    });

    // data-open is either a table we can build from data already loaded, or a drill
    // spec to fetch. Aggregates stay local; long line lists go to the server.
    tab.root.querySelectorAll("[data-open]").forEach(function (el) {
      el.addEventListener("click", function () {
        var key = el.dataset.open;
        var build = LOCAL_TABLES[key];
        if (build) BM.openTable(build());
        else BM.openDrill(key);
      });
    });
  }

  function exportCsv(tab) {
    if (!tab.data || tab.error) return;
    // Export the tab's largest row set — the thing a person actually wants in a sheet.
    var pick = {
      sales: "archive-customers",
      invoices: null,
      profitability: "profit-customers",
      deliveries: null,
      pricing: null
    }[tab.name];

    if (pick && LOCAL_TABLES[pick]) {
      BM.tableToCsv(LOCAL_TABLES[pick](), tab.name + ".csv");
      return;
    }

    // Sections without a natural table export their stat rows instead.
    var d = tab.data;
    var rows = [["Metric", "Value"]];
    if (tab.name === "invoices" && d.invoiceThresholds) {
      var t = d.invoiceThresholds;
      rows.push(["shippedInvoiceCount", t.shippedInvoiceCount]);
      rows.push(["under199.count", t.under199.count], ["under199.total", t.under199.total]);
      rows.push(["over180.count", t.over180.count], ["over180.total", t.over180.total]);
      rows.push(["overlapCount", t.overlapCount]);
    } else if (tab.name === "deliveries" && d.deliveries) {
      Object.keys(d.deliveries.appOwned).forEach(function (k) { rows.push(["sessions." + k, d.deliveries.appOwned[k]]); });
      Object.keys(d.deliveries.archive).forEach(function (k) { rows.push(["archive." + k, d.deliveries.archive[k]]); });
    } else if (tab.name === "pricing" && d.pricing) {
      Object.keys(d.pricing).forEach(function (k) { rows.push([k, d.pricing[k]]); });
    }
    BM.downloadCsv(tab.name + ".csv", rows);
  }

  function updateBadge() {
    var badge = document.getElementById("statusBadge");
    var active = document.querySelector(".workflow-panel.active");
    if (!badge || !active || active.id === "overview") return;

    var tab = tabs[active.id];
    if (!tab) return;
    if (tab.loading && !tab.data) { badge.textContent = "Loading…"; badge.className = "badge planned"; }
    else if (tab.error) { badge.textContent = "Error"; badge.className = "badge credentials-needed"; }
    else if (tab.data) { badge.textContent = "Live"; badge.className = "badge ready-for-import"; }
  }

  /* ─────────── init ─────────── */

  function init() {
    SECTIONS.forEach(function (name) {
      var tab = tabs[name];
      tab.root = document.querySelector('.ov-root[data-section="' + name + '"]');
      tab.applyAuto = BM.makeAutoRefresher(
        function () { return tab.autoIndex; },
        function () { load(tab, { background: true }); }
      );
      BM.startFreshnessTicker(function (el) {
        return tab.root && tab.root.contains(el) ? tab : null;
      });
    });

    document.querySelectorAll(".workflow-tabs button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll(".workflow-tabs button").forEach(function (b) {
          b.classList.toggle("active", b === btn);
        });
        document.querySelectorAll(".workflow-panel").forEach(function (p) {
          p.classList.toggle("active", p.id === btn.dataset.tab);
        });

        var tab = tabs[btn.dataset.tab];
        if (tab && !tab.loaded) load(tab);
        else updateBadge();
      });
    });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) return;
      var active = document.querySelector(".workflow-panel.active");
      var tab = active && tabs[active.id];
      if (tab && tab.loaded && BM.AUTO_OPTIONS[tab.autoIndex].ms) load(tab, { background: true });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
