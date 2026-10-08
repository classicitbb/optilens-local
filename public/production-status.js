/**
 * Production Status — one-page Workflow Monitor: WIP totals, Production Throughput and
 * Work Order Aging from /api/production-status (live Innovations). Every figure is a
 * button that opens the orders behind it via /api/production-status/orders.
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
  function pct(share) { return (share * 100).toFixed(1) + "%"; }

  /** A figure that drills into its orders. Zero and unknown values stay plain text. */
  function figure(value, query, title, cls) {
    if (!value) return value === 0 ? "" : "—";
    return '<button type="button" class="ps-num ' + (cls || "") + '" data-drill="' + esc(query) +
      '" data-title="' + esc(title) + '">' + num(value) + "</button>";
  }
  function qs(obj) {
    return Object.keys(obj).map(function (k) { return k + "=" + encodeURIComponent(obj[k]); }).join("&");
  }

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
      document.getElementById("psTotals").innerHTML = '<p class="ps-error">' + esc(state.error) + "</p>";
      return;
    }
    if (!data) return;

    setStatus(state.error ? "Stale — " + state.error
      : "Live · " + new Date(data.generatedAt).toLocaleTimeString(), state.error ? "blocked" : "ready");
    document.getElementById("psTotals").innerHTML = renderTotals(data.totals);
    document.getElementById("psAssignments").innerHTML = renderAssignments(data.assignments);
    document.getElementById("psStaging").innerHTML = renderStaging(data.staging);
    document.getElementById("psThroughput").innerHTML = renderThroughput(data.throughput);
    document.getElementById("psAging").innerHTML = renderAging(data.aging);

    var note = document.getElementById("psNote");
    note.hidden = !(data.notes && data.notes.length);
    note.textContent = (data.notes || []).join(" ");
  }

  function renderTotals(totals) {
    var tiles = [
      ["Waiting", totals.waiting, "waiting", "ps-tile-waiting"],
      ["In Progress", totals.inProgress, "inProgress", "ps-tile-progress"],
      ["Outsourced", totals.outsourced, "outsourced", "ps-tile-outsourced"],
      ["Total WIP", totals.totalWip, "total", "ps-tile-total"]
    ];
    return '<div class="ps-tiles">' + tiles.map(function (t) {
      var inner = '<span class="ps-tile-l">' + esc(t[0]) + '</span><span class="ps-tile-n">' + num(t[1]) + "</span>";
      if (!t[1]) return '<div class="ps-tile ' + t[3] + '">' + inner + "</div>";
      return '<button type="button" class="ps-tile ' + t[3] + '" data-drill="' +
        esc(qs({ metric: "wip", segment: t[2] })) + '" data-title="' + esc("Work in progress — " + t[0]) + '">' +
        inner + "</button>";
    }).join("") + "</div>";
  }

  function renderAssignments(a) {
    var items = [
      ["All Assigned Orders", a.all, "all"], ["Assigned to Customer Service", a.cs, "cs"],
      ["Assigned to Users &amp; Groups", a.user, "user"], ["Assigned to Customers", a.customer, "customer"]
    ];
    return '<dl class="ps-assign">' + items.map(function (i) {
      return "<div><dt>" + i[0] + "</dt><dd>" + (figure(i[1], qs({ metric: "assignments", type: i[2] }),
        "Assigned orders — " + i[0].replace("&amp;", "&")) || "0") + "</dd></div>";
    }).join("") + "</dl>";
  }

  function renderStaging(staging) {
    if (!staging.columns.length) return '<p class="ps-empty">No jobs are staged.</p>';
    var head = "<tr><th></th>" + staging.columns.map(function (c) {
      return '<th class="num" title="' + esc(c) + '">' + esc(c.replace(/^Staging - /i, "")) + "</th>";
    }).join("") + "</tr>";
    function row(r, band) {
      return '<tr><th scope="row"><span class="ps-swatch ps-stage-' + esc(band) + '"></span>' + esc(r.label) + "</th>" +
        staging.columns.map(function (c) {
          return '<td class="num">' + figure(r.cells[c], qs({ metric: "staging", status: c, band: band }),
            "Job staging — " + c + " — " + r.label) + "</td>";
        }).join("") + "</tr>";
    }
    var body = row(staging.total, "total") + staging.bands.map(function (b) { return row(b, b.key); }).join("");
    return '<div class="table-wrap"><table class="ps-table">' + head + body + "</table></div>";
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
        return '<td class="num">' + figure(p[s.key],
          qs({ metric: s.key, kind: "row", seq: p.key, label: p.label }), s.label + " — " + p.label) + "</td>";
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
        var title = s.label + ", week of " + w.weekStart;
        return '<circle class="ps-dot ps-' + s.cls + '" cx="' + x(i).toFixed(1) + '" cy="' + y(w[s.key]).toFixed(1) +
          '" r="4" tabindex="0" role="button" data-drill="' +
          esc(qs({ metric: s.key, kind: "week", seq: w.seq, label: "week of " + w.weekStart })) +
          '" data-title="' + esc(title) + '"><title>' + esc(title + ": " + w[s.key]) + "</title></circle>";
      }).join("");
      return '<polyline class="ps-line ps-' + s.cls + '" points="' + pts + '"/>' + dots;
    }).join("");

    return '<svg class="ps-chart" viewBox="0 0 ' + W + " " + H + '" role="group" aria-label="Weekly throughput">' +
      grid + labels + lines + "</svg>";
  }

  function renderAging(aging) {
    var rows = aging.buckets.map(function (b) {
      return '<tr><th scope="row"><span class="ps-swatch ps-age-' + esc(b.key) + '"></span>' + esc(b.label) + "</th>" +
        '<td class="num">' + figure(b.count, qs({ metric: "aging", bucket: b.key }), "Work order aging — " + b.label) + "</td>" +
        '<td class="num">' + pct(b.share) + "</td>" +
        '<td class="num">' + figure(b.olderThan, qs({ metric: "aging", bucket: b.key, older: 1 }),
          "Work order aging — " + b.label + " and older") + "</td></tr>";
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
      var title = "Work order aging — " + b.label;
      var arc = '<circle class="ps-arc ps-age-stroke-' + esc(b.key) + '" cx="100" cy="100" r="' + R +
        '" stroke-dasharray="' + len.toFixed(2) + " " + (C - len).toFixed(2) +
        '" stroke-dashoffset="' + (-offset).toFixed(2) + '" tabindex="0" role="button" data-drill="' +
        esc(qs({ metric: "aging", bucket: b.key })) + '" data-title="' + esc(title) + '"><title>' +
        esc(b.label + ": " + b.count) + "</title></circle>";
      offset += len;
      return arc;
    }).join("");
    return '<svg class="ps-donut" viewBox="0 0 200 200" role="group" aria-label="Open work orders by age">' +
      '<g transform="rotate(-90 100 100)">' + arcs + "</g>" +
      '<text class="ps-donut-n" x="100" y="104" text-anchor="middle">' + num(aging.total) + "</text>" +
      '<text class="ps-axis" x="100" y="122" text-anchor="middle">open orders</text></svg>';
  }

  /* ─────────── drill-through ─────────── */

  var dialog = document.getElementById("psDrill");
  var drillBody = document.getElementById("psDrillBody");

  function dateTime(value) {
    if (!value) return "";
    var d = new Date(value);
    return isNaN(d) ? "" : d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  async function openDrill(query, title) {
    document.getElementById("psDrillTitle").textContent = title;
    document.getElementById("psDrillMeta").textContent = "Loading…";
    drillBody.innerHTML = "";
    if (!dialog.open) dialog.showModal();
    try {
      var res = await fetch("/api/production-status/orders?" + query, { cache: "no-store" });
      var body = await res.json();
      if (!res.ok) throw new Error(body.error || ("Request failed (HTTP " + res.status + ")"));
      document.getElementById("psDrillMeta").textContent = body.count + " order" + (body.count === 1 ? "" : "s") +
        (body.truncated ? " (showing the first " + body.count + ")" : "");
      drillBody.innerHTML = drillTable(body.orders);
    } catch (err) {
      document.getElementById("psDrillMeta").textContent = "";
      drillBody.innerHTML = '<p class="ps-error">' + esc(err.message) + "</p>";
    }
  }

  function drillTable(orders) {
    if (!orders.length) return '<p class="ps-empty">No orders.</p>';
    var hasEvent = orders.some(function (o) { return o.eventName; });
    var head = "<tr><th>Job</th><th>Order</th><th>Customer</th><th>Tray</th><th>Received</th><th>Shipped</th><th>Current status</th>" +
      (hasEvent ? "<th>Event</th><th>When</th>" : "") + "</tr>";
    var body = orders.map(function (o) {
      return "<tr><td>" + esc(o.jobId) + "</td><td>" + esc(o.orderId) + "</td><td>" + esc(o.customer) + "</td><td>" +
        esc(o.tray) + "</td><td>" + esc(dateTime(o.receivedTime)) + "</td><td>" + esc(dateTime(o.shippedTime)) + "</td><td>" +
        esc(o.status) + "</td>" + (hasEvent ? "<td>" + esc(o.eventName) + "</td><td>" + esc(dateTime(o.eventDate)) + "</td>" : "") + "</tr>";
    }).join("");
    return '<div class="table-wrap"><table class="ps-table ps-drill-table">' + head + body + "</table></div>";
  }

  function handleDrill(event) {
    var target = event.target.closest("[data-drill]");
    if (!target) return;
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openDrill(target.getAttribute("data-drill"), target.getAttribute("data-title") || "Orders");
  }

  /* ─────────── wiring ─────────── */

  document.addEventListener("click", handleDrill);
  document.addEventListener("keydown", handleDrill);
  document.getElementById("psDrillClose").addEventListener("click", function () { dialog.close(); });
  dialog.addEventListener("click", function (event) { if (event.target === dialog) dialog.close(); });
  document.getElementById("psRefresh").addEventListener("click", load);
  setInterval(function () { if (!document.hidden && !dialog.open) load(); }, REFRESH_MS);
  load();
})();
