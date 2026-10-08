/**
 * Production Status — Totals, Throughput and Work Order Aging, read from
 * /api/production-status (live Innovations). Mirrors the Innovations web dashboard.
 */
(function () {
  "use strict";

  var REFRESH_MS = 60000;
  var SERIES = [
    { key: "received", label: "Received", cls: "received" },
    { key: "remakes", label: "Remakes", cls: "remakes" },
    { key: "breakages", label: "Breakages", cls: "breakages" },
    { key: "cancelled", label: "Cancelled", cls: "cancelled" },
    { key: "shipped", label: "Shipped", cls: "shipped" }
  ];
  var ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  var state = { data: null, error: null, loading: false };

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) { return ESCAPES[c]; });
  }
  function num(value) { return value == null ? "—" : Number(value).toLocaleString("en-US"); }
  function cell(value) { return value ? num(value) : ""; }
  function pct(share) { return (share * 100).toFixed(1) + "%"; }

  /* ─────────── data ─────────── */

  async function load() {
    if (state.loading) return;
    state.loading = true;
    try {
      var res = await fetch("/api/production-status", { cache: "no-store" });
      var body = await res.json();
      if (!res.ok) throw new Error(body.error || ("Request failed (HTTP " + res.status + ")"));
      state.data = body;
      state.error = null;
    } catch (err) {
      state.error = /Failed to fetch/i.test(err.message)
        ? "Could not reach the server. Is OptiLens Local running?" : err.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  function setStatus(text, kind) {
    var badge = document.getElementById("psStatus");
    badge.textContent = text;
    badge.className = "badge " + kind;
  }

  /* ─────────── render ─────────── */

  function render() {
    var data = state.data;
    if (state.error && !data) {
      setStatus("Unavailable", "blocked");
      ["psTotals", "psThroughput", "psAging"].forEach(function (id) {
        document.getElementById(id).innerHTML = '<p class="ps-error">' + esc(state.error) + "</p>";
      });
      return;
    }
    if (!data) return;

    setStatus(state.error ? "Stale — " + state.error
      : "Live · " + new Date(data.generatedAt).toLocaleTimeString(), state.error ? "blocked" : "ready");
    document.getElementById("psTotals").innerHTML = renderTotals(data.totals);
    document.getElementById("psThroughput").innerHTML = renderThroughput(data.throughput);
    document.getElementById("psAging").innerHTML = renderAging(data.aging);

    var note = document.getElementById("psNote");
    note.hidden = !(data.notes && data.notes.length);
    note.textContent = (data.notes || []).join(" ");
  }

  function renderTotals(totals) {
    var tiles = [
      ["Waiting", totals.waiting], ["In Progress", totals.inProgress], ["Outsourced", totals.outsourced],
      ["Total WIP", totals.totalWip], ["Assigned", totals.assigned]
    ];
    return '<div class="ps-tiles">' + tiles.map(function (t) {
      return '<div class="ps-tile' + (t[0] === "Total WIP" ? " ps-tile-total" : "") + '">' +
        '<span class="ps-tile-n">' + num(t[1]) + "</span>" +
        '<span class="ps-tile-l">' + esc(t[0]) + "</span></div>";
    }).join("") + "</div>";
  }

  function renderThroughput(throughput) {
    var legend = '<ul class="ps-legend">' + SERIES.map(function (s) {
      return '<li><span class="ps-swatch ps-' + s.cls + '"></span>' + esc(s.label) + "</li>";
    }).join("") + "</ul>";

    var head = "<tr><th></th>" + SERIES.map(function (s) {
      return '<th class="num">' + esc(s.label) + "</th>";
    }).join("") + "</tr>";
    var body = throughput.periods.map(function (p) {
      return '<tr><th scope="row">' + esc(p.label) + "</th>" + SERIES.map(function (s) {
        return '<td class="num">' + cell(p[s.key]) + "</td>";
      }).join("") + "</tr>";
    }).join("");

    return '<div class="ps-throughput">' + legend + lineChart(throughput.weekly) + "</div>" +
      '<div class="table-wrap"><table class="ps-table">' + head + body + "</table></div>";
  }

  function lineChart(weekly) {
    var W = 640, H = 220, L = 38, R = 12, T = 10, B = 28;
    if (!weekly.length) return "";
    var max = 0;
    weekly.forEach(function (w) { SERIES.forEach(function (s) { max = Math.max(max, w[s.key]); }); });
    var top = Math.max(10, Math.ceil(max / 50) * 50);
    var x = function (i) { return L + (weekly.length === 1 ? 0 : i * (W - L - R) / (weekly.length - 1)); };
    var y = function (v) { return T + (H - T - B) * (1 - v / top); };

    var grid = [0, 0.5, 1].map(function (f) {
      var v = Math.round(top * f);
      return '<line class="ps-grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
        '<text class="ps-axis" x="' + (L - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + "</text>";
    }).join("");
    var labels = weekly.map(function (w, i) {
      if (i % 3 !== (weekly.length - 1) % 3) return "";
      var d = new Date(w.weekStart + "T00:00:00");
      return '<text class="ps-axis" x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle">' +
        d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) + "</text>";
    }).join("");
    var lines = SERIES.map(function (s) {
      var pts = weekly.map(function (w, i) { return x(i).toFixed(1) + "," + y(w[s.key]).toFixed(1); }).join(" ");
      var dots = weekly.map(function (w, i) {
        return '<circle class="ps-dot ps-' + s.cls + '" cx="' + x(i).toFixed(1) + '" cy="' + y(w[s.key]).toFixed(1) +
          '" r="3"><title>' + esc(s.label + ", week of " + w.weekStart + ": " + w[s.key]) + "</title></circle>";
      }).join("");
      return '<polyline class="ps-line ps-' + s.cls + '" points="' + pts + '"/>' + dots;
    }).join("");

    return '<svg class="ps-chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Weekly throughput">' +
      grid + labels + lines + "</svg>";
  }

  function renderAging(aging) {
    var rows = aging.buckets.map(function (b) {
      return '<tr><th scope="row"><span class="ps-swatch ps-age-' + esc(b.key) + '"></span>' + esc(b.label) + "</th>" +
        '<td class="num">' + num(b.count) + '</td><td class="num">' + pct(b.share) +
        '</td><td class="num">' + num(b.olderThan) + "</td></tr>";
    }).join("");
    return '<div class="ps-aging"><div class="table-wrap"><table class="ps-table"><tr><th></th>' +
      '<th class="num" title="Orders in this age band">Orders</th><th class="num">Share</th>' +
      '<th class="num" title="Orders at least this old">Older</th></tr>' + rows + "</table></div>" +
      donut(aging) + "</div>";
  }

  function donut(aging) {
    var R = 70, C = 2 * Math.PI * R, offset = 0;
    if (!aging.total) return '<p class="ps-empty">No open work orders.</p>';
    var arcs = aging.buckets.map(function (b) {
      if (!b.count) return "";
      var len = b.share * C;
      var arc = '<circle class="ps-arc ps-age-stroke-' + esc(b.key) + '" cx="100" cy="100" r="' + R +
        '" stroke-dasharray="' + len.toFixed(2) + " " + (C - len).toFixed(2) +
        '" stroke-dashoffset="' + (-offset).toFixed(2) + '"><title>' + esc(b.label + ": " + b.count) + "</title></circle>";
      offset += len;
      return arc;
    }).join("");
    return '<svg class="ps-donut" viewBox="0 0 200 200" role="img" aria-label="Open work orders by age">' +
      '<g transform="rotate(-90 100 100)">' + arcs + "</g>" +
      '<text class="ps-donut-n" x="100" y="104" text-anchor="middle">' + num(aging.total) + "</text>" +
      '<text class="ps-axis" x="100" y="122" text-anchor="middle">open orders</text></svg>';
  }

  /* ─────────── wiring ─────────── */

  function showTab(name) {
    document.querySelectorAll(".workflow-tabs button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === name);
    });
    document.querySelectorAll(".workflow-panel").forEach(function (p) {
      p.classList.toggle("active", p.id === name);
    });
  }

  document.querySelectorAll(".workflow-tabs button").forEach(function (b) {
    b.addEventListener("click", function () { showTab(b.dataset.tab); });
  });
  document.getElementById("psRefresh").addEventListener("click", load);
  setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
  load();
})();
