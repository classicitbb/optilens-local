/**
 * Business Metrics — Inventory tab.
 *
 * Self-contained: it owns its own fetch, render and refresh, and binds its own
 * tab-button listener rather than registering with business-metrics-tabs.js.
 * That keeps it independent of the shared tab module (which several sections
 * are edited into concurrently) while still reusing window.BM for formatting,
 * the drill drawer, CSV and the command bar.
 *
 * Charts are plain HTML/CSS bars, not canvas: they stay readable at any width,
 * every bar is a real focusable button that opens the rows behind it, and the
 * numbers are present as text for screen readers and copy-paste. Colour roles
 * live in styles/pages/inventory.css, validated against this app's surfaces.
 */
(function () {
  "use strict";

  var BM = window.BM;
  var esc = BM.esc, money = BM.money, intf = BM.intf, dateLabel = BM.dateLabel;

  var SECTION = "inventory";
  var SPEED_ORDER = ["non_mover", "slow", "regular", "fast"];
  var SPEED_VAR = {
    non_mover: "--inv-s1", slow: "--inv-s2", regular: "--inv-s3", fast: "--inv-s4"
  };
  var TREATMENT_VAR = ["--inv-c1", "--inv-c2", "--inv-c3", "--inv-c4", "--inv-c5"];

  // Remembers the previous exception counts so the tile can pulse once when a
  // number gets WORSE, rather than animating forever at everyone all day.
  var LAST_SEEN_KEY = "optilens.inventory.lastSeen";

  var state = {
    root: null, data: null, error: null,
    loading: false, loaded: false, autoIndex: 0, etag: null, loadedAt: null,
    applyAuto: null
  };

  // Phase 2 analytics load on their own clock: the add-power channel join costs
  // ~8s against ~3s for the headline figures, so it must not delay first paint.
  var trends = { data: null, error: null, loading: false, loaded: false, mfType: "Progressive" };

  // Phase 3: recommendations and the assistant, each on their own clock again.
  var recs = { data: null, error: null, loading: false, loaded: false, showAll: false };
  var ask = { status: null, answer: null, error: null, asking: false, question: "" };

  /* ─────────── data ─────────── */

  async function load(opts) {
    opts = opts || {};
    if (state.loading) return;
    state.loading = true;
    state.loaded = true;
    render();

    var headers = {};
    if (state.etag && opts.background) headers["If-None-Match"] = state.etag;

    try {
      var res = await fetch("/api/business-metrics/detail/" + SECTION, { cache: "no-store", headers: headers });

      if (res.status === 304) {
        state.loadedAt = new Date().toISOString();
        state.error = null;
        return;
      }

      var body = await res.json();
      if (!res.ok) throw new Error(body.error || ("Request failed (HTTP " + res.status + ")"));

      state.etag = res.headers.get("ETag");
      state.data = body;
      state.error = body.error || null;
      state.loadedAt = new Date().toISOString();
    } catch (err) {
      state.error = BM.describeError(err);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadTrends() {
    if (trends.loading || trends.loaded) return;
    trends.loading = true;
    renderTrends();

    try {
      var res = await fetch("/api/business-metrics/detail/inventory-trends", { cache: "no-store" });
      var body = await res.json();
      if (!res.ok) throw new Error(body.error || ("Request failed (HTTP " + res.status + ")"));
      trends.data = body.inventoryTrends || null;
      trends.error = body.error || null;
    } catch (err) {
      trends.error = BM.describeError(err);
    } finally {
      trends.loading = false;
      trends.loaded = true;
      renderTrends();
    }
  }

  async function loadRecs() {
    if (recs.loading || recs.loaded) return;
    recs.loading = true;
    renderRecs();
    try {
      var res = await fetch("/api/business-metrics/recommendations", { cache: "no-store" });
      var body = await res.json();
      if (!res.ok) throw new Error(body.error || ("Request failed (HTTP " + res.status + ")"));
      recs.data = body;
    } catch (err) {
      recs.error = BM.describeError(err);
    } finally {
      recs.loading = false;
      recs.loaded = true;
      renderRecs();
    }
  }

  async function loadAskStatus() {
    if (ask.status) return;
    try {
      var res = await fetch("/api/business-metrics/assistant/status", { cache: "no-store" });
      ask.status = await res.json();
    } catch (err) {
      ask.status = { configured: false, detail: BM.describeError(err) };
    }
    renderAsk();
  }

  /* ─────────── render helpers ─────────── */

  function stat(label, value, detail) {
    return '<div class="ov-stat"><span class="ov-tile-label">' + esc(label) + "</span>" +
      '<span class="ov-tile-value">' + value + "</span>" +
      (detail ? '<span class="ov-tile-foot">' + detail + "</span>" : "") + "</div>";
  }

  function panel(title, sub, body) {
    return '<div class="ov-panel"><h3>' + esc(title) +
      (sub ? " <span>· " + esc(sub) + "</span>" : "") + "</h3>" + body + "</div>";
  }

  /**
   * Horizontal bars. `rows` carry their own colour var and drill spec, so a bar
   * is always clickable through to the items behind it.
   */
  function bars(rows, opts) {
    opts = opts || {};
    if (!rows.length) return '<div class="ov-empty">' + esc(opts.emptyText || "Nothing to show.") + "</div>";

    var max = rows.reduce(function (m, r) { return Math.max(m, Number(r.value) || 0); }, 0) || 1;
    var fmt = opts.format || money;

    return '<div class="inv-bars">' + rows.map(function (r) {
      var v = Number(r.value) || 0;
      var pctWidth = Math.max(v > 0 ? 1.5 : 0, (v / max) * 100);
      return '<button type="button" class="inv-bar-row" data-drill="' + esc(r.drill) + '"' +
        ' title="' + esc(r.label + " — " + fmt(v) + (r.sub ? " · " + r.sub : "")) + '"' +
        ' aria-label="' + esc(r.label + ", " + fmt(v) + (r.sub ? ", " + r.sub : "") + ". Open details.") + '">' +
        '<span class="inv-bar-name">' +
          '<span class="inv-swatch" style="background:var(' + r.colorVar + ')"></span>' +
          esc(r.label) +
        "</span>" +
        '<span class="inv-bar-track">' +
          '<span class="inv-bar-fill" style="width:' + pctWidth.toFixed(1) + '%;background:var(' + r.colorVar + ')"></span>' +
        "</span>" +
        '<span class="inv-bar-value">' + esc(fmt(v)) +
          (r.sub ? '<br><span class="inv-bar-sub">' + esc(r.sub) + "</span>" : "") +
        "</span>" +
      "</button>";
    }).join("") + "</div>";
  }

  function legend(items) {
    return '<div class="inv-legend">' + items.map(function (i) {
      return "<span><span class=\"inv-swatch\" style=\"background:var(" + i.colorVar + ")\"></span>" +
        esc(i.label) + "</span>";
    }).join("") + "</div>";
  }

  /* ─────────── exception rail ─────────── */

  function readLastSeen() {
    try { return JSON.parse(sessionStorage.getItem(LAST_SEEN_KEY) || "{}"); }
    catch (e) { return {}; }
  }

  function writeLastSeen(next) {
    try { sessionStorage.setItem(LAST_SEEN_KEY, JSON.stringify(next)); } catch (e) { /* private mode */ }
  }

  function exceptionRail(inv) {
    var ex = inv.exceptions;
    var seen = readLastSeen();
    var now = { negative: ex.negative.count, zeroCost: ex.zeroCost.count };

    function tile(key, count, level, icon, label, detail, drill) {
      // Pulse only on a rise: a steady problem should read as steady.
      var worsened = seen[key] != null && count > seen[key];
      var cls = count === 0 ? "good" : level;
      return '<button type="button" class="inv-exc ' + cls + (worsened ? " worsened" : "") + '"' +
        ' data-drill="' + esc(drill) + '"' +
        ' aria-label="' + esc(label + ": " + count + ". " + detail + ". Open details.") + '">' +
        '<span class="material-symbols-outlined inv-exc-icon" aria-hidden="true">' +
          (count === 0 ? "check_circle" : icon) + "</span>" +
        '<span class="inv-exc-n">' + intf(count) + "</span>" +
        '<span class="inv-exc-text">' +
          '<span class="inv-exc-label">' + esc(label) + "</span>" +
          '<span class="inv-exc-detail">' + esc(detail) + "</span>" +
        "</span>" +
        '<span class="material-symbols-outlined" aria-hidden="true" style="font-size:15px;color:var(--muted)">chevron_right</span>' +
      "</button>";
    }

    var out = '<div class="inv-grid">' +
      tile("negative", ex.negative.count, "critical", "error",
        "Active SKUs with negative stock",
        ex.negative.count === 0
          ? "On target — no negative quantities"
          : intf(Math.abs(ex.negative.units)) + " units · " + money(ex.negative.value) + " exposed · fix by physical count",
        "inventory-negative") +
      tile("zeroCost", ex.zeroCost.count, "warning", "warning",
        "Active SKUs at zero cost",
        ex.zeroCost.count === 0
          ? "On target — every stocked SKU carries a cost"
          : intf(ex.zeroCost.units) + " units recording no COGS when used",
        "inventory-zero-cost") +
      "</div>";

    if (ex.suppressed.count > 0) {
      out += '<div style="margin-top:8px">' +
        tile("suppressed", ex.suppressed.count, "warning", "visibility_off",
          "Suppressed by override",
          "Excluded from the counts above, with a recorded reason",
          "inventory-suppressed") + "</div>";
    }

    writeLastSeen(now);
    return out;
  }

  /* ─────────── body ─────────── */

  function body(d) {
    var inv = d.inventory;
    if (!inv) return '<div class="ov-empty">Live Innovations source unavailable.</div>';

    var h = inv.headline;
    var months = inv.thresholds.windowMonths;

    // The finding that justifies the tab, stated once, in words.
    var out = '<div class="inv-hero ov-fade">' +
      '<span class="inv-hero-value">' + money(h.nonMoverValue) + "</span>" +
      '<span class="inv-hero-label">of stock — <strong>' + esc(String(h.nonMoverShareOfValue)) +
        "% of " + money(h.totalStockValue) + '</strong> — has not moved in ' + intf(months) + " months" +
        " <span class=\"inv-bar-sub\">(" + intf(h.nonMoverItems) + " items, " + intf(h.totalOnHand) + " units on hand)</span>" +
      "</span></div>";

    out += '<div class="ov-tiles ov-fade">' +
      stat("Stock value", money(h.totalStockValue), intf(h.stockedItems) + " stocked items") +
      stat("Not moving", money(h.nonMoverValue), h.nonMoverShareOfValue + "% of value") +
      stat("Units moved", intf(h.unitsMoved), "last " + intf(months) + " months") +
      stat("Items tracked", intf(h.trackedItems), "stocked or moved") +
      "</div>";

    out += '<div class="ov-fade" style="margin-bottom:12px">' + exceptionRail(inv) + "</div>";

    // What to do about it, before the analysis of why.
    out += '<h3 style="margin:16px 0 8px;font-size:14px">What needs attention</h3>' +
      '<div id="invRecs"></div>' +
      '<div id="invAsk" style="margin:12px 0"></div>';

    // Speed: ordered categories, ordinal ramp, value on the bar.
    var speedRows = SPEED_ORDER.map(function (cls) {
      var band = inv.speedBands.find(function (b) { return b.speedClass === cls; }) || { items: 0, stockValue: 0, units: 0, onHand: 0 };
      return {
        label: band.label || cls,
        value: band.stockValue,
        sub: intf(band.items) + " items · " + intf(band.units) + " units",
        colorVar: SPEED_VAR[cls],
        drill: "inventory-speed?class=" + cls
      };
    });

    var thr = inv.thresholds;
    out += '<div class="inv-grid ov-fade">' +
      panel("Stock value by movement speed", intf(months) + "-month window",
        bars(speedRows) +
        '<div class="inv-legend"><span>Non-mover 0 units</span><span>Slow 1–' + thr.slowMaxUnits + "</span>" +
        "<span>Regular " + (thr.slowMaxUnits + 1) + "–" + thr.regularMaxUnits + "</span>" +
        "<span>Fast " + (thr.regularMaxUnits + 1) + "+</span></div>") +

      panel("Stock value by treatment", "photochromic · clear · polarized",
        bars(inv.byTreatment.map(function (t, i) {
          return {
            label: t.treatmentGroup,
            value: t.stockValue,
            sub: intf(t.items) + " items · turn " + (t.turnRate == null ? "—" : t.turnRate) +
                 " · " + intf(t.nonMovers) + " dead",
            colorVar: TREATMENT_VAR[i % TREATMENT_VAR.length],
            drill: "inventory-treatment?group=" + encodeURIComponent(t.treatmentGroup)
          };
        })) +
        '<div class="inv-legend"><span>Turn = units moved ÷ units on hand</span></div>') +
      "</div>";

    // Misc: two panels because the two populations are measured differently and
    // must not be read as comparable.
    var m = inv.misc;
    out += '<div class="inv-grid ov-fade" style="margin-top:12px">' +
      panel("Misc sold", "Chemistrie · snap-ons · frames",
        '<div class="ov-tiles" style="margin-bottom:8px">' +
        stat("Units sold", intf(m.sold.units), intf(m.sold.items) + " items") +
        stat("Stock value", money(m.sold.stockValue), "measured from invoices") +
        "</div>" +
        bars(m.sold.byGroup.slice(0, 8).map(function (g, i) {
          return {
            label: g.groupName, value: g.stockValue,
            sub: intf(g.units) + " units · " + intf(g.items) + " items",
            colorVar: TREATMENT_VAR[i % TREATMENT_VAR.length],
            drill: "inventory-misc?panel=sold"
          };
        }), { emptyText: "No misc items sold in this window." })) +

      panel("Misc consumed", "lab supplies · Satisloh parts",
        '<div class="ov-basis-wrap" style="margin-bottom:8px">' +
        '<span class="inv-basis"><span class="material-symbols-outlined" aria-hidden="true" style="font-size:13px">info</span>' +
        "PURCHASING PROXY — not measured consumption</span></div>" +
        '<div class="ov-tiles" style="margin-bottom:8px">' +
        stat("Units received", intf(m.consumed.receivedUnits), intf(m.consumed.items) + " items") +
        stat("Stock value", money(m.consumed.stockValue), "from PO receipts") +
        "</div>" +
        bars(m.consumed.byGroup.slice(0, 8).map(function (g, i) {
          return {
            label: g.groupName, value: g.stockValue,
            sub: intf(g.units) + " received · " + intf(g.items) + " items",
            colorVar: TREATMENT_VAR[i % TREATMENT_VAR.length],
            drill: "inventory-misc?panel=consumed"
          };
        }), { emptyText: "No misc consumables with purchase activity." }) +
        (m.dormant && m.dormant.items
          ? '<div class="inv-legend"><span>' + intf(m.dormant.items) +
            " further misc items (" + money(m.dormant.stockValue) +
            ") were neither sold nor purchased in this window — " +
            '<a href="#" data-drill="inventory-misc?panel=dormant">see them</a></span></div>'
          : "")) +
      "</div>";

    out += '<div class="inv-caveats ov-fade"><h4>How to read these numbers</h4><ul>' +
      inv.caveats.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") +
      "</ul></div>";

    // Phase 2 mounts here and fills in when its own (slower) fetch returns.
    out += '<h3 style="margin:18px 0 8px;font-size:14px">Add power and channels</h3>' +
      '<div id="invTrends"></div>';

    return out;
  }

  /* ─────────── Phase 2: add-power trends and channel splits ─────────── */

  /**
   * One sparkline. Points are share-of-mix per month, drawn on a scale shared
   * across every add in the panel so the eleven panels are comparable — the
   * whole reason for using small multiples instead of eleven coloured lines.
   */
  function sparkline(points, max, colorVar) {
    if (!points.length) return "";
    var w = 100, h = 30;
    var step = points.length > 1 ? w / (points.length - 1) : w;
    var y = function (v) { return h - (max > 0 ? (v / max) * h : 0); };
    var d = points.map(function (v, i) {
      return (i ? "L" : "M") + (i * step).toFixed(1) + "," + y(v).toFixed(1);
    }).join(" ");

    return '<svg viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="' + d + '" fill="none" stroke="var(' + colorVar + ')" stroke-width="2"' +
      ' vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>' +
      // Last point marked so the current value is locatable at a glance.
      '<circle cx="' + ((points.length - 1) * step).toFixed(1) + '" cy="' + y(points[points.length - 1]).toFixed(1) +
      '" r="2.5" fill="var(' + colorVar + ')"/></svg>';
  }

  function trendIcon(slope) {
    if (slope == null) return { cls: "inv-trend-flat", icon: "remove", text: "—" };
    if (slope > 0.05) return { cls: "inv-trend-up", icon: "trending_up", text: "+" + slope.toFixed(2) };
    if (slope < -0.05) return { cls: "inv-trend-down", icon: "trending_down", text: slope.toFixed(2) };
    return { cls: "inv-trend-flat", icon: "trending_flat", text: slope.toFixed(2) };
  }

  function smallMultiples(channel, mfType, colorVar) {
    var t = channel.byType[mfType];
    if (!t || !t.total) return '<div class="ov-empty">No ' + esc(mfType.toLowerCase()) + " volume in this window.</div>";

    // Shared y-scale across all eleven panels.
    var max = t.series.reduce(function (m, s) {
      return Math.max(m, s.monthlyShare.reduce(function (a, b) { return Math.max(a, b); }, 0));
    }, 0) || 1;

    return '<div class="inv-sparks">' + t.series.map(function (s) {
      var tr = trendIcon(s.slope);
      return '<button type="button" class="inv-spark" data-drill="inventory-add?add=' + s.addX100 +
          "&mf=" + encodeURIComponent(mfType) + '"' +
        ' aria-label="' + esc("Add " + s.label + ", " + s.share + "% of " + mfType.toLowerCase() +
          " volume, " + intf(s.units) + " units, trend " + tr.text + " points per month. Open details.") + '">' +
        '<span class="inv-spark-head"><span class="inv-spark-add">' + esc(s.label) + "</span>" +
        '<span class="inv-spark-share">' + s.share + "%</span></span>" +
        sparkline(s.monthlyShare, max, colorVar) +
        '<span class="inv-spark-foot ' + tr.cls + '">' +
        '<span class="material-symbols-outlined" aria-hidden="true">' + tr.icon + "</span>" +
        esc(tr.text) + "</span></button>";
    }).join("") + "</div>";
  }

  /** Diverging bars: demand share minus held share, per add. */
  function mismatchBars(rows) {
    if (!rows || !rows.length) return '<div class="ov-empty">No add-power mismatch to show.</div>';
    var max = rows.reduce(function (m, r) { return Math.max(m, Math.abs(r.gap)); }, 0) || 1;

    return '<div class="inv-bars">' + rows.map(function (r) {
      var under = r.gap > 0;
      var width = (Math.abs(r.gap) / max) * 100;
      return '<button type="button" class="inv-gap-row" data-drill="inventory-add?add=' + r.addX100 +
          '&mf=Progressive"' +
        ' aria-label="' + esc("Add " + r.label + ": demand " + r.demandShare + "%, held " + r.heldShare +
          "%, " + (under ? "under" : "over") + "-stocked by " + Math.abs(r.gap) + " points. Open details.") + '">' +
        '<span class="inv-gap-label">' + esc(r.label) + "</span>" +
        '<span class="inv-gap-track">' +
          '<span class="inv-gap-half left">' + (under ? "" :
            '<span class="inv-gap-fill over" style="width:' + width.toFixed(1) + '%"></span>') + "</span>" +
          '<span class="inv-gap-half right">' + (under ?
            '<span class="inv-gap-fill under" style="width:' + width.toFixed(1) + '%"></span>' : "") + "</span>" +
        "</span>" +
        '<span class="inv-gap-detail">' + (under ? "under" : "over") + " " + Math.abs(r.gap) + " pts<br>" +
          "demand " + r.demandShare + "% · held " + r.heldShare + "%</span>" +
      "</button>";
    }).join("") + "</div>";
  }

  function splitBars(rows, labelKey, colorFor) {
    return bars(rows.map(function (r, i) {
      return {
        label: r.label || r[labelKey],
        value: r.revenue,
        sub: intf(r.jobs) + " jobs · " + intf(r.lensUnits) + " lenses",
        colorVar: colorFor(r, i),
        drill: r.drill
      };
    }));
  }

  function trendsBody() {
    var d = trends.data;
    if (!d) return "";
    var mf = trends.mfType;
    var ap = d.addPowers;
    var ch = d.channels;

    var out = "";

    // Toggle between Progressive and Bifocal rather than showing both at once:
    // twenty-two panels on screen is a wall, not a chart.
    out += '<div class="ov-bar" style="margin-bottom:8px">' +
      '<span class="inv-bar-sub">Add power</span>' +
      ap.mfTypes.map(function (t) {
        return '<button type="button" class="ov-btn" data-mf="' + esc(t) + '"' +
          (t === mf ? ' aria-pressed="true" style="font-weight:650"' : "") + ">" + esc(t) + "</button>";
      }).join("") + "</div>";

    out += '<div class="inv-grid">' +
      panel("Prescribed", "share of " + mf.toLowerCase() + " Rx volume, by month",
        smallMultiples(ap.channels.prescribed, mf, "--inv-c1")) +
      panel("Consumed from stock", "add of the blank actually pulled",
        smallMultiples(ap.channels.consumed, mf, "--inv-c3")) +
      "</div>";

    out += '<div class="inv-grid" style="margin-top:12px">' +
      panel("Sold as stock lenses", "invoiced on stock orders",
        smallMultiples(ap.channels.stockSold, mf, "--inv-c2")) +
      panel("Demand vs stock held", "biggest mismatches first · Progressive",
        mismatchBars((ap.mismatch && ap.mismatch.Progressive || []).slice(0, 8)) +
        '<div class="inv-legend">' +
          '<span><span class="inv-swatch" style="background:var(--inv-under)"></span>Under-stocked — demand exceeds stock</span>' +
          '<span><span class="inv-swatch" style="background:var(--inv-over)"></span>Over-stocked — stock exceeds demand</span>' +
        "</div>") +
      "</div>";

    // Channels.
    var ex = ch.export, fu = ch.fulfilment;
    out += '<div class="inv-grid" style="margin-top:12px">' +
      panel("Export vs local", "by shipping method · " + intf(ex.total.jobs) + " jobs",
        splitBars(ex.rows.map(function (r) {
          return Object.assign({}, r, { drill: "inventory-channel?channel=" + r.channel });
        }), "label", function (r) {
          return r.channel === "export" ? "--inv-c2" : r.channel === "local" ? "--inv-c1" : "--inv-c5";
        }) +
        '<div class="inv-legend"><span>' +
          esc("Export carries " + ex.rows[0].unitShare + "% of lenses on " + ex.rows[0].jobShare + "% of jobs") +
        "</span></div>") +

      panel("Outsourced vs in-house", "Farmouts · " + intf(fu.total.jobs) + " jobs",
        splitBars(fu.rows.map(function (r) {
          return Object.assign({}, r, { drill: "inventory-fulfilment?kind=" + r.fulfilment });
        }), "label", function (r) {
          return r.fulfilment === "outsourced" ? "--inv-c4" : "--inv-c3";
        }) +
        (fu.customerSuppliedEdging
          ? '<div class="inv-legend"><span>' +
            esc("Includes " + intf(fu.customerSuppliedEdging.jobs) + " customer-supplied edging jobs — exclude them and outsourcing falls to " +
              (Math.round(((fu.total.jobs ? (fu.rows[0].jobs - fu.customerSuppliedEdging.jobs) / fu.total.jobs : 0)) * 1000) / 10) + "%") +
            "</span></div>"
          : "")) +
      "</div>";

    out += '<div class="inv-caveats"><h4>How to read the channels</h4><ul>' +
      d.caveats.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") +
      "</ul></div>";

    return out;
  }

  function renderTrends() {
    var host = state.root && state.root.querySelector("#invTrends");
    if (!host) return;

    if (trends.loading) {
      host.innerHTML = '<div class="ov-empty"><span class="ov-spin"></span> Loading add-power and channel analysis…</div>';
      return;
    }
    if (trends.error) {
      host.innerHTML = '<div class="ov-error">' + esc(trends.error) + "</div>";
      return;
    }
    host.innerHTML = trendsBody();

    host.querySelectorAll("[data-drill]").forEach(function (el) {
      el.addEventListener("click", function () { BM.openDrill(el.dataset.drill); });
    });
    host.querySelectorAll("[data-mf]").forEach(function (el) {
      el.addEventListener("click", function () {
        trends.mfType = el.dataset.mf;
        renderTrends();
      });
    });
  }

  /* ─────────── Phase 3: recommendations and assistant ─────────── */

  var SEVERITY_ICON = {
    critical: "error", warning: "warning", serious: "priority_high", good: "trending_up"
  };

  function recCard(rec, index) {
    var icon = SEVERITY_ICON[rec.severity] || "info";
    var decided = rec.decision;

    return '<div class="inv-rec ' + esc(rec.severity) + '">' +
      '<span class="material-symbols-outlined inv-rec-icon" aria-hidden="true">' + icon + "</span>" +
      '<div class="inv-rec-body">' +
        '<div class="inv-rec-title">' + esc(rec.label) + "</div>" +
        '<div class="inv-rec-action">' + esc(rec.action) + "</div>" +
        '<div class="inv-rec-why">' + esc((rec.evidence && rec.evidence.why) || "") + "</div>" +
        (decided
          ? '<div class="inv-rec-decided">' +
            esc(decided.decision + " — " + (decided.reason || "no reason recorded") +
              (decided.decidedBy ? " (" + decided.decidedBy + ")" : "")) + "</div>"
          : "") +
      "</div>" +
      '<div class="inv-rec-side">' +
        '<span class="inv-rec-value">' + money(rec.valueAtStake) + "</span>" +
        '<span class="inv-rec-kind">' + esc(rec.actionLabel) + "</span>" +
        (decided ? "" :
          '<span class="inv-rec-btns">' +
          '<button type="button" class="ov-btn" data-decide="dismiss" data-rec="' + index + '"' +
            ' aria-label="' + esc("Dismiss: " + rec.label) + '">Dismiss</button>' +
          '<button type="button" class="ov-btn" data-decide="snooze" data-rec="' + index + '"' +
            ' aria-label="' + esc("Snooze 30 days: " + rec.label) + '">Snooze</button>' +
          "</span>") +
      "</div>" +
    "</div>";
  }

  function recsBody() {
    var d = recs.data;
    if (!d) return "";
    var s = d.summary;

    var out = '<div class="ov-tiles">' +
      stat("Item actions", intf(s.openItemActions), money(s.itemValueAtStake) + " at stake") +
      stat("Add-power signals", intf(s.openAddSignals), money(s.addValueAtStake) + " held") +
      stat("Decided", intf(s.decided), "dismissed or snoozed") +
      "</div>";

    // Add signals first: they are few, high-value and about buying strategy.
    if (d.addSignals.length) {
      out += panel("Buying signals by add power", "ranked by value held in that power",
        d.addSignals.map(function (r, i) { return recCard(r, "add:" + i); }).join(""));
    }

    var shown = recs.showAll ? d.itemActions : d.itemActions.slice(0, 10);
    out += panel("Item actions", "specific SKUs, biggest exposure first",
      shown.map(function (r, i) { return recCard(r, "item:" + i); }).join("") +
      (d.itemActions.length > shown.length
        ? '<button type="button" class="ov-btn" data-showall="1" style="margin-top:6px">' +
          "Show all " + intf(d.itemActions.length) + " item actions</button>"
        : "") +
      '<div class="inv-legend"><span>' + esc(d.belowThreshold.note) + "</span></div>");

    out += '<div class="inv-caveats"><h4>About these suggestions</h4><ul>' +
      d.notes.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("") +
      "</ul></div>";

    return out;
  }

  function renderRecs() {
    var host = state.root && state.root.querySelector("#invRecs");
    if (!host) return;

    if (recs.loading) {
      host.innerHTML = '<div class="ov-empty"><span class="ov-spin"></span> Working out what needs attention…</div>';
      return;
    }
    if (recs.error) { host.innerHTML = '<div class="ov-error">' + esc(recs.error) + "</div>"; return; }
    if (!recs.data) return;

    host.innerHTML = recsBody();

    host.querySelectorAll("[data-showall]").forEach(function (el) {
      el.addEventListener("click", function () { recs.showAll = true; renderRecs(); });
    });
    host.querySelectorAll("[data-decide]").forEach(function (el) {
      el.addEventListener("click", function () { decide(el.dataset.rec, el.dataset.decide); });
    });
  }

  /**
   * A decision always requires a reason — that is the entire value of the audit
   * trail, so the prompt is not skippable and an empty answer cancels.
   */
  async function decide(ref, kind) {
    var bits = String(ref).split(":");
    var list = bits[0] === "add" ? recs.data.addSignals : recs.data.itemActions;
    var rec = list[Number(bits[1])];
    if (!rec) return;

    var verb = kind === "snooze" ? "Snooze for 30 days" : "Dismiss";
    var reason = window.prompt(verb + ": " + rec.label + "\n\nWhy? (recorded against this decision)");
    if (!reason || !reason.trim()) return;

    try {
      var res = await fetch("/api/business-metrics/recommendations/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recommendation: rec,
          decision: kind === "snooze" ? "snoozed" : "dismissed",
          reason: reason.trim(),
          snoozeDays: 30
        })
      });
      var body = await res.json();
      if (!res.ok) throw new Error(body.error || ("Request failed (HTTP " + res.status + ")"));
      recs.loaded = false;
      recs.data = null;
      loadRecs();
    } catch (err) {
      window.alert("Could not record that decision: " + BM.describeError(err));
    }
  }

  var ASK_SUGGESTIONS = [
    "What should I write off first?",
    "Which add power should I buy more of?",
    "Why is so much stock not moving?",
    "How much is tied up in photochromic?",
    "Is export growing faster than local?"
  ];

  function askBody() {
    var st = ask.status || {};
    var out = '<div class="inv-ask">' +
      '<div class="inv-ask-row">' +
        '<input type="text" class="inv-ask-input" id="invAskInput" placeholder="Ask about these figures…"' +
          ' value="' + esc(ask.question) + '" aria-label="Ask a question about the inventory figures">' +
        '<button type="button" class="ov-btn" id="invAskGo"' + (ask.asking ? " disabled" : "") + ">" +
          (ask.asking ? "Thinking…" : "Ask") + "</button>" +
      "</div>" +
      '<div class="inv-ask-suggestions">' + ASK_SUGGESTIONS.map(function (q) {
        return '<button type="button" class="inv-ask-chip" data-q="' + esc(q) + '">' + esc(q) + "</button>";
      }).join("") + "</div>";

    if (ask.error) out += '<div class="ov-error" style="margin-top:8px">' + esc(ask.error) + "</div>";

    if (ask.answer) {
      if (ask.answer.answer) {
        out += '<div class="inv-ask-answer">' + esc(ask.answer.answer) + "</div>" +
          '<div class="inv-ask-meta">' +
          esc("Answered from precomputed figures by " + (ask.answer.model || ask.answer.provider) +
            ". No SQL was generated and nothing was written.") + "</div>";
      } else {
        // No local model: say so plainly, and point at what still works.
        out += '<div class="inv-ask-answer">' + esc(ask.answer.note || "No answer available.") + "</div>" +
          '<div class="inv-ask-meta">' +
          esc("The context API still serves every figure on this tab to any external assistant: " +
            "GET /api/business-metrics/context/inventory") + "</div>";
      }
    } else if (st.configured === false) {
      out += '<div class="inv-ask-meta">' + esc(st.detail || "No assistant provider configured.") +
        " Questions still return the full grounding context for an external AI to answer from.</div>";
    }

    return out + "</div>";
  }

  function renderAsk() {
    var host = state.root && state.root.querySelector("#invAsk");
    if (!host) return;
    host.innerHTML = askBody();

    var input = host.querySelector("#invAskInput");
    var go = host.querySelector("#invAskGo");
    if (input) {
      input.addEventListener("input", function () { ask.question = input.value; });
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") submitAsk(); });
    }
    if (go) go.addEventListener("click", submitAsk);
    host.querySelectorAll("[data-q]").forEach(function (el) {
      el.addEventListener("click", function () { ask.question = el.dataset.q; submitAsk(); });
    });
  }

  async function submitAsk() {
    var q = (ask.question || "").trim();
    if (!q || ask.asking) return;
    ask.asking = true;
    ask.error = null;
    renderAsk();

    try {
      var res = await fetch("/api/business-metrics/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, section: "inventory" })
      });
      var body = await res.json();
      if (!res.ok) throw new Error(body.error || ("Request failed (HTTP " + res.status + ")"));
      ask.answer = body;
    } catch (err) {
      ask.error = BM.describeError(err);
    } finally {
      ask.asking = false;
      renderAsk();
      var input = state.root && state.root.querySelector("#invAskInput");
      if (input) input.focus();
    }
  }

  /* ─────────── shell ─────────── */

  function bar() {
    return BM.commandBar({
      loading: state.loading,
      loadedAt: state.loadedAt,
      autoIndex: state.autoIndex,
      canExport: Boolean(state.data && !state.error),
      sources: [{
        label: "Innovations (live)",
        online: Boolean(state.data && state.data.inventory),
        title: "Inventory reads live Innovations MSSQL directly — the Zen mirror carries no stock tables."
      }]
    });
  }

  function skeleton() {
    var s = '<div class="ov-stat"><span class="ov-tile-label ov-skel">Loading</span>' +
      '<span class="ov-tile-value ov-skel">0,000</span></div>';
    return '<div class="ov-tiles ov-fade">' + s + s + s + s + "</div>";
  }

  function render() {
    if (!state.root) return;
    state.root.setAttribute("data-refreshing", state.loading && state.data ? "1" : "0");
    state.root.innerHTML =
      bar() +
      (state.error ? '<div class="ov-error">' + esc(state.error) + "</div>" : "") +
      (state.data && !state.error ? body(state.data) : (state.error ? "" : skeleton()));

    wire();
    updateBadge();

    // Re-paint Phase 2 into the freshly rendered host, and kick off its fetch
    // the first time the body exists.
    if (state.data && !state.error) {
      renderTrends();
      loadTrends();
      renderRecs();
      loadRecs();
      renderAsk();
      loadAskStatus();
    }
  }

  function wire() {
    BM.bindBar(state.root, {
      onRefresh: function () { load(); },
      onAuto: function () {
        state.autoIndex = (state.autoIndex + 1) % BM.AUTO_OPTIONS.length;
        state.applyAuto();
        render();
      },
      onCsv: function () { exportCsv(); }
    });

    state.root.querySelectorAll("[data-drill]").forEach(function (el) {
      el.addEventListener("click", function () { BM.openDrill(el.dataset.drill); });
    });
  }

  /**
   * The tab-level CSV is the per-item universe, because that is what someone
   * actually wants in a sheet — every stocked or moved item with its speed,
   * cover and value. Each drill exports its own rows separately.
   *
   * Thresholds are stamped into the file: a band means nothing without the cut
   * points that produced it.
   */
  function exportCsv() {
    if (!state.data || state.error) return;
    var inv = state.data.inventory;
    var thr = inv.thresholds;

    var rows = [
      ["# OptiLens inventory analysis"],
      ["# generated", inv.generatedAt],
      ["# window months", thr.windowMonths],
      ["# speed bands", "non-mover 0 | slow 1-" + thr.slowMaxUnits +
        " | regular " + (thr.slowMaxUnits + 1) + "-" + thr.regularMaxUnits +
        " | fast " + (thr.regularMaxUnits + 1) + "+"],
      ["# caveat", inv.caveats[0]],
      [],
      ["Section", "Group", "Items", "On hand", "Stock value", "Units moved", "Turn", "Non-movers", "Non-mover value"]
    ];

    inv.speedBands.forEach(function (b) {
      rows.push(["Speed", b.label, b.items, b.onHand, b.stockValue, b.units, "", "", ""]);
    });
    inv.byTreatment.forEach(function (t) {
      rows.push(["Treatment", t.treatmentGroup, t.items, t.onHand, t.stockValue, t.units,
        t.turnRate == null ? "" : t.turnRate, t.nonMovers, t.nonMoverValue]);
    });
    inv.byMaterial.forEach(function (t) {
      rows.push(["Material", t.materialName, t.items, t.onHand, t.stockValue, t.units,
        t.turnRate == null ? "" : t.turnRate, t.nonMovers, t.nonMoverValue]);
    });
    inv.misc.sold.byGroup.forEach(function (g) {
      rows.push(["Misc sold (invoiced)", g.groupName, g.items, g.onHand, g.stockValue, g.units,
        g.turnRate == null ? "" : g.turnRate, g.nonMovers, g.nonMoverValue]);
    });
    inv.misc.consumed.byGroup.forEach(function (g) {
      rows.push(["Misc consumed (purchase proxy)", g.groupName, g.items, g.onHand, g.stockValue, g.units,
        g.turnRate == null ? "" : g.turnRate, g.nonMovers, g.nonMoverValue]);
    });

    rows.push([]);
    rows.push(["Exception", "Count", "Units", "Value"]);
    rows.push(["Negative on hand", inv.exceptions.negative.count, inv.exceptions.negative.units, inv.exceptions.negative.value]);
    rows.push(["Zero cost with stock", inv.exceptions.zeroCost.count, inv.exceptions.zeroCost.units, ""]);
    rows.push(["Suppressed by override", inv.exceptions.suppressed.count, "", ""]);

    BM.downloadCsv("inventory-analysis.csv", rows);
  }

  function updateBadge() {
    var badge = document.getElementById("statusBadge");
    var active = document.querySelector(".workflow-panel.active");
    if (!badge || !active || active.id !== SECTION) return;

    if (state.loading && !state.data) { badge.textContent = "Loading…"; badge.className = "badge planned"; }
    else if (state.error) { badge.textContent = "Error"; badge.className = "badge credentials-needed"; }
    else if (state.data) { badge.textContent = "Live"; badge.className = "badge ready-for-import"; }
  }

  /* ─────────── init ─────────── */

  function init() {
    state.root = document.querySelector('.ov-root[data-section="' + SECTION + '"]');
    if (!state.root) return;

    state.applyAuto = BM.makeAutoRefresher(
      function () { return state.autoIndex; },
      function () { load({ background: true }); }
    );
    BM.startFreshnessTicker(function (el) {
      return state.root && state.root.contains(el) ? state : null;
    });

    // Own listener rather than registering with the shared tab module: panel
    // switching is already handled there for every button, so this only has to
    // load data the first time the tab is opened.
    var btn = document.querySelector('.workflow-tabs button[data-tab="' + SECTION + '"]');
    if (btn) {
      btn.addEventListener("click", function () {
        if (!state.loaded) load();
        else updateBadge();
      });
    }

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) return;
      var active = document.querySelector(".workflow-panel.active");
      if (active && active.id === SECTION && state.loaded && BM.AUTO_OPTIONS[state.autoIndex].ms) {
        load({ background: true });
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
