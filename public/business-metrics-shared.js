/**
 * Business Metrics — shared front-end kit.
 *
 * Exposes window.BM: formatters, the drill drawer, CSV export, a command bar and a
 * refresh manager. The Overview module and the tab-2-to-6 module both build on this,
 * so a table drills and refreshes the same way wherever it appears.
 *
 * The drawer is generic: it renders whatever { title, subtitle, summary, columns, rows,
 * next } it is handed, whether that came from /drill/:kind or from data already in
 * memory. Adding a new drillable table means describing its columns, not writing UI.
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

  function pct(n) { return n == null ? "—" : (Number(n) || 0).toFixed(1) + "%"; }

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
      case "money0": return value == null ? "—" : money(value);
      case "int": return value == null ? "—" : intf(value);
      case "pct": return pct(value);
      case "days": return value == null ? "—" : intf(value) + "d";
      case "date": return dateLabel(value);
      default: return value == null || value === "" ? "—" : String(value);
    }
  }

  function describeError(err) {
    var msg = err && err.message ? err.message : String(err);
    if (/permission|denied|403/i.test(msg)) return "You need delivery read access to view business metrics.";
    if (/auth|401|sign/i.test(msg)) return "Please sign in to view business metrics.";
    if (/Failed to fetch|NetworkError/i.test(msg)) return "Could not reach the server. Is OptiLens Local running?";
    return msg;
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

  function tableToCsv(data, name) {
    if (!data || !data.rows) return;
    var cols = data.columns || [];
    var rows = [cols.map(function (c) { return c.label; })];
    data.rows.forEach(function (r) {
      rows.push(cols.map(function (c) { return r[c.key] == null ? "" : r[c.key]; }));
    });
    downloadCsv(name || ((data.kind || "detail") + ".csv"), rows);
  }

  /* ─────────── drill drawer ─────────── */

  var stack = [];

  function host() {
    var el = document.getElementById("ovDrawerHost");
    if (!el) {
      el = document.createElement("div");
      el.id = "ovDrawerHost";
      document.body.appendChild(el);
    }
    return el;
  }

  // Two accepted forms: the short colon form for the common drills ("aging-bucket:4"),
  // which makes readable hashes, and a generic query form ("invoice-threshold?band=x").
  function parseSpec(spec) {
    var q = String(spec).indexOf("?");
    if (q !== -1) {
      return {
        kind: String(spec).slice(0, q),
        params: Object.fromEntries(new URLSearchParams(String(spec).slice(q + 1)))
      };
    }

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

  function buildSpec(kind, params) {
    if (kind === "aging-bucket") return "aging-bucket:" + params.bucket;
    if (kind === "month-invoices") return "month-invoices:" + params.month;
    if (kind === "customer") return "customer:" + params.customerId;
    if (kind === "wip-customer") return "wip-customer:" + params.customerId;
    if (kind === "aging-customer") return "aging-customer:" + params.bucket + ":" + params.customerId;
    var qs = new URLSearchParams(params || {}).toString();
    return qs ? kind + "?" + qs : kind;
  }

  // Drills that are satisfied from data already in the page. Registered by the modules
  // that own that data, so level-one expansion never costs a round trip.
  var localDrills = {};

  function registerLocalDrill(kind, provider) { localDrills[kind] = provider; }

  async function openDrill(spec, opts) {
    opts = opts || {};
    var parsed = parseSpec(spec);

    if (localDrills[parsed.kind]) {
      var local = localDrills[parsed.kind](parsed.params);
      if (local) {
        push({ kind: parsed.kind, params: parsed.params, data: local, loading: false, error: null }, opts);
        return;
      }
    }

    var entry = { kind: parsed.kind, params: parsed.params, data: null, loading: true, error: null };
    push(entry, opts);

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

  /** Open the drawer directly on a table built in memory. */
  function openTable(data) {
    push({ kind: data.kind || "table", params: {}, data: data, loading: false, error: null }, { replaceStack: true });
  }

  function push(entry, opts) {
    if (opts && opts.replaceStack) stack = [entry];
    else stack.push(entry);
    renderDrawer();
  }

  function close() {
    stack = [];
    renderDrawer();
  }

  function popTo(index) {
    stack = stack.slice(0, index + 1);
    renderDrawer();
  }

  function renderDrawer() {
    var el = host();

    if (!stack.length) {
      el.innerHTML = "";
      document.body.style.overflow = "";
      if (location.hash.indexOf("#drill=") === 0) {
        history.replaceState(null, "", location.pathname + location.search);
      }
      return;
    }

    document.body.style.overflow = "hidden";
    var top = stack[stack.length - 1];
    if (top.kind && !localDrills[top.kind]) {
      history.replaceState(null, "", "#drill=" + buildSpec(top.kind, top.params));
    }

    var crumb = stack.length > 1
      ? '<div class="ov-crumb">' + stack.map(function (e, i) {
          var label = esc((e.data && e.data.title) || e.kind);
          return i === stack.length - 1
            ? "<span>" + label + "</span>"
            : '<button type="button" data-crumb="' + i + '">' + label + "</button><span aria-hidden=\"true\">›</span>";
        }).join("") + "</div>"
      : "";

    var body;
    if (top.loading) body = '<div class="ov-empty"><span class="ov-spin"></span> Loading…</div>';
    else if (top.error) body = '<div class="ov-error" style="margin-top:12px">' + esc(top.error) + "</div>";
    else body = renderTable(top.data);

    // Without this the heading stays on "Loading…" after a failure, which reads as a
    // hang rather than an error.
    var heading = (top.data && top.data.title) ||
      (top.error ? "Could not load this view" : "Loading…");

    el.innerHTML =
      '<div class="ov-scrim" id="ovScrim"></div>' +
      '<aside class="ov-drawer" role="dialog" aria-modal="true" aria-label="' +
        esc((top.data && top.data.title) || "Detail") + '">' +
        '<div class="ov-drawer-head">' + crumb +
          '<div class="ov-drawer-title"><div>' +
            "<h2>" + esc(heading) + "</h2>" +
            '<div class="ov-drawer-sub">' + esc((top.data && top.data.subtitle) || "") + "</div>" +
          "</div>" +
          '<div class="ov-drawer-actions">' +
            (localDrills[top.kind] ? "" :
              '<button type="button" class="ov-btn" id="ovDrillRefresh" aria-label="Refresh">' +
              '<span class="material-symbols-outlined" aria-hidden="true" style="font-size:15px">refresh</span></button>') +
            '<button type="button" class="ov-btn" id="ovDrillCsv">CSV</button>' +
            '<button type="button" class="ov-btn" id="ovDrillClose" aria-label="Close">' +
              '<span class="material-symbols-outlined" aria-hidden="true" style="font-size:15px">close</span></button>' +
          "</div></div>" +
          renderSummary(top.data) +
        "</div>" +
        '<div class="ov-drawer-body">' + body + "</div>" +
      "</aside>";

    wireDrawer();
  }

  function renderSummary(data) {
    if (!data || !data.summary || !data.summary.length) return "";
    return '<div class="ov-drawer-sum">' + data.summary.map(function (s) {
      return "<div>" + esc(s.label) + "<strong>" + esc(formatCell(s.value, s.format)) + "</strong></div>";
    }).join("") + "</div>" +
    (data.generatedAt ? '<div class="ov-drawer-sub" style="margin-top:6px">as of ' + esc(dateLabel(data.generatedAt)) +
      " " + esc(new Date(data.generatedAt).toLocaleTimeString()) + "</div>" : "");
  }

  function renderTable(data) {
    if (!data || !data.rows || !data.rows.length) {
      return '<div class="ov-empty">' + esc(data && data.emptyText ? data.emptyText : "Nothing to show — this view returned no rows.") + "</div>";
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
    var el = host();
    var top = stack[stack.length - 1];

    var scrim = el.querySelector("#ovScrim");
    if (scrim) scrim.addEventListener("click", close);

    var closeBtn = el.querySelector("#ovDrillClose");
    if (closeBtn) closeBtn.addEventListener("click", close);

    var refresh = el.querySelector("#ovDrillRefresh");
    if (refresh) refresh.addEventListener("click", function () {
      stack.pop();
      openDrill(buildSpec(top.kind, top.params));
    });

    var csv = el.querySelector("#ovDrillCsv");
    if (csv) csv.addEventListener("click", function () { tableToCsv(top.data, (top.kind || "detail") + ".csv"); });

    el.querySelectorAll("[data-crumb]").forEach(function (b) {
      b.addEventListener("click", function () { popTo(Number(b.dataset.crumb)); });
    });

    if (top.data && top.data.next) {
      el.querySelectorAll("tr[data-row]").forEach(function (tr) {
        tr.addEventListener("click", function () {
          var row = top.data.rows[Number(tr.dataset.row)];
          var next = top.data.next;
          var params = Object.assign({}, next.fixed || {});
          (next.carry || []).forEach(function (k) { params[k] = row[k]; });
          openDrill(buildSpec(next.kind, params));
        });
      });
    }
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && stack.length) close();
  });

  /* ─────────── command bar ─────────── */

  /**
   * Renders the shared bar. `opts` may carry extra controls (the Overview passes its
   * period selector) and a source-state list.
   */
  function commandBar(opts) {
    var stale = opts.loadedAt && (Date.now() - new Date(opts.loadedAt).getTime()) > STALE_AFTER_MS;
    var auto = AUTO_OPTIONS[opts.autoIndex || 0];

    var dots = (opts.sources || []).map(function (s) {
      return '<span class="ov-fresh" title="' + esc(s.title || s.label) + '">' +
        '<span class="ov-dot ' + (s.online ? "online" : "offline") + '"></span> ' + esc(s.label) + "</span>";
    }).join("");

    return '<div class="ov-bar">' +
      (opts.leading || "") +
      '<span class="ov-fresh' + (stale ? " stale" : "") + '" data-fresh="1">' +
        (opts.loading ? '<span class="ov-spin"></span> refreshing…' : "updated " + esc(relTime(opts.loadedAt))) +
      "</span>" +
      '<span class="ov-bar-spacer"></span>' +
      '<button type="button" class="ov-btn" data-act="refresh"' + (opts.loading ? " disabled" : "") + ">" +
        '<span class="material-symbols-outlined" aria-hidden="true" style="font-size:15px">refresh</span> Refresh</button>' +
      '<button type="button" class="ov-btn" data-act="auto" aria-pressed="' + (auto.ms ? "true" : "false") + '">' +
        esc(auto.label) + "</button>" +
      dots +
      (opts.csv === false ? "" :
        '<button type="button" class="ov-btn" data-act="csv"' + (opts.canExport ? "" : " disabled") + ">" +
        '<span class="material-symbols-outlined" aria-hidden="true" style="font-size:15px">download</span> CSV</button>') +
      "</div>";
  }

  /**
   * Wires a command bar. Handles the auto-refresh interval, the hidden-tab pause and
   * the ticking freshness label so callers do not each re-implement them.
   */
  function bindBar(container, handlers) {
    var refresh = container.querySelector('[data-act="refresh"]');
    if (refresh) refresh.addEventListener("click", function () { handlers.onRefresh(); });

    var auto = container.querySelector('[data-act="auto"]');
    if (auto) auto.addEventListener("click", function () { handlers.onAuto(); });

    var csv = container.querySelector('[data-act="csv"]');
    if (csv) csv.addEventListener("click", function () { handlers.onCsv(); });
  }

  function makeAutoRefresher(getIndex, poll) {
    var timer = null;
    return function apply() {
      if (timer) { clearInterval(timer); timer = null; }
      var ms = AUTO_OPTIONS[getIndex()].ms;
      if (!ms) return;
      timer = setInterval(function () {
        // A hidden tab must not poll — this is what stops a forgotten wall display
        // from querying MSSQL all night.
        if (document.hidden) return;
        poll();
      }, ms);
    };
  }

  function startFreshnessTicker(getState) {
    setInterval(function () {
      document.querySelectorAll("[data-fresh]").forEach(function (el) {
        var s = getState(el);
        if (!s || s.loading) return;
        var stale = s.loadedAt && (Date.now() - new Date(s.loadedAt).getTime()) > STALE_AFTER_MS;
        el.className = "ov-fresh" + (stale ? " stale" : "");
        el.textContent = "updated " + relTime(s.loadedAt);
      });
    }, 1000);
  }

  window.BM = {
    CURRENCY: CURRENCY,
    AUTO_OPTIONS: AUTO_OPTIONS,
    STALE_AFTER_MS: STALE_AFTER_MS,
    esc: esc, money: money, intf: intf, pct: pct,
    dateLabel: dateLabel, monthLabel: monthLabel, relTime: relTime,
    formatCell: formatCell, describeError: describeError,
    downloadCsv: downloadCsv, tableToCsv: tableToCsv,
    openDrill: openDrill, openTable: openTable, closeDrawer: close,
    registerLocalDrill: registerLocalDrill,
    hasDrawer: function () { return stack.length > 0; },
    commandBar: commandBar, bindBar: bindBar,
    makeAutoRefresher: makeAutoRefresher, startFreshnessTicker: startFreshnessTicker
  };
})();
