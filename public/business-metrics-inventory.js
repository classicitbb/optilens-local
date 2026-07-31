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

    return out;
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
