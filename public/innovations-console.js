// Innovations Console: client for the four pages of the vendor Innovations web
// client (Tracking, Status Update, Rx Job Details, Stock). All data comes from
// /api/innovations-console/*; every value is written with textContent.
(function () {
  "use strict";

  var API = "/api/innovations-console";
  var MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  var PAGE_KEY = "innovationsConsole.page";
  var state = { writesEnabled: false, busy: 0 };

  function byId(id) { return document.getElementById(id); }
  function remember(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function recall(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  // h("div", {class: "x"}, child, "text") builds DOM nodes from plain text only.
  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] === null || attrs[k] === undefined || attrs[k] === false) return;
      if (k === "text") el.textContent = attrs[k];
      else if (k === "class") el.className = attrs[k];
      else el.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    });
    for (var i = 2; i < arguments.length; i += 1) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return el;
  }
  function icon(name, cls) { return h("span", { class: "material-symbols-outlined " + (cls || ""), "aria-hidden": "true", text: name }); }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function pad(n, w) { return ("0000" + String(n)).slice(-w); }

  // ---- loader, errors, api -------------------------------------------------
  function busy(on) {
    state.busy = Math.max(0, state.busy + (on ? 1 : -1));
    byId("icLoader").hidden = state.busy === 0;
  }
  function showError(code, desc) {
    byId("icErrorCode").textContent = code == null ? "" : String(code);
    byId("icErrorDesc").textContent = desc == null ? "" : String(desc);
    var d = byId("icError");
    if (typeof d.showModal === "function") { if (!d.open) d.showModal(); } else { window.alert("Error " + code + ": " + desc); }
  }
  async function api(path, body, quiet) {
    if (!quiet) busy(true);
    try {
      var res = await fetch(API + path, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store"
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        var err = new Error(data.error || ("Request failed (HTTP " + res.status + ")"));
        err.status = res.status;
        throw err;
      }
      return data;
    } finally { if (!quiet) busy(false); }
  }
  function fail(e) { showError(e.status || 1, e.message); }

  // ---- formatting helpers -------------------------------------------------
  function num(v, digits) { var n = Number(v); return isFinite(n) ? n.toFixed(digits) : ""; }
  function padAxis(v) { var n = Math.round(Number(v)); return isFinite(n) ? pad(n, 3) : ""; }
  function parseDate(v) { var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function fmtDate(d) { return d.getFullYear() + "/" + pad(d.getMonth() + 1, 2) + "/" + pad(d.getDate(), 2); }
  function fmtTime(d) {
    var hr = d.getHours(), ampm = hr > 11 ? "PM" : "AM";
    hr = hr > 12 ? hr - 12 : hr;
    return pad(hr, 2) + ":" + pad(d.getMinutes(), 2) + " " + ampm;
  }
  function dateTile(v) {
    var d = parseDate(v);
    if (!d) return h("span", { text: "" });
    return h("span", { class: "ic-date", title: fmtDate(d) + " " + fmtTime(d) },
      h("span", { class: "ic-date-m", text: MONTHS[d.getMonth()] }),
      h("span", { class: "ic-date-d", text: d.getDate() }),
      h("span", { class: "ic-date-y", text: d.getFullYear() }));
  }
  function trueFalse(value) {
    return value ? h("span", { class: "ic-tf ic-green" }, icon("check_circle")) : h("span", { class: "ic-tf ic-red" }, icon("cancel"));
  }

  // ---- data table (search, sort, paging, optional row groups) --------------
  // columns: [{ name, value(row) -> string|number, render(row) -> Node, hidden }]
  function dataTable(mount, columns, rows, options) {
    options = options || {};
    var st = { q: "", sort: -1, dir: 1, page: 0, size: options.pageSize || 10 };
    var visible = columns.filter(function (c) { return !c.hidden; });
    var wrap = h("div", { class: "ic-table-wrap" });
    var bar = h("div", { class: "ic-dt-bar" });
    var info = h("span");
    var pager = h("div", { class: "ic-dt-pager" });
    var search = h("input", { type: "search", "aria-label": "Search results", placeholder: "Search" });
    var sizeSel = h("select", { "aria-label": "Rows per page" });
    [10, 25, 50, 100].forEach(function (n) { sizeSel.appendChild(h("option", { value: n, text: n })); });
    sizeSel.value = String(st.size);
    bar.appendChild(h("label", null, "Show ", sizeSel, " entries"));
    bar.appendChild(h("label", null, "Search: ", search));

    var table = h("table", { class: "ic-table ic-striped" });
    var thead = h("thead"), tbody = h("tbody"), tr = h("tr");
    visible.forEach(function (c, i) {
      var th = h("th", { class: "is-sortable", tabindex: 0, scope: "col", text: c.name });
      function sortBy() { st.dir = st.sort === i ? -st.dir : 1; st.sort = i; st.page = 0; draw(); }
      th.addEventListener("click", sortBy);
      th.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sortBy(); } });
      c._th = th;
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    mount.appendChild(bar);
    mount.appendChild(wrap);
    mount.appendChild(h("div", { class: "ic-dt-bar" }, info, pager));

    function text(c, row) { return String(c.value ? c.value(row) : "").toLowerCase(); }
    function filtered() {
      var q = st.q.toLowerCase();
      var out = rows.filter(function (r) { return !q || columns.some(function (c) { return text(c, r).indexOf(q) !== -1; }); });
      if (st.sort >= 0) {
        var c = visible[st.sort];
        out = out.slice().sort(function (a, b) {
          var x = c.value ? c.value(a) : "", y = c.value ? c.value(b) : "";
          var nx = Number(x), ny = Number(y);
          var cmp = (x !== "" && y !== "" && isFinite(nx) && isFinite(ny)) ? nx - ny : String(x).localeCompare(String(y));
          return cmp * st.dir;
        });
      }
      return out;
    }
    function draw() {
      var all = filtered();
      var pages = Math.max(1, Math.ceil(all.length / st.size));
      st.page = Math.min(st.page, pages - 1);
      var slice = all.slice(st.page * st.size, st.page * st.size + st.size);
      visible.forEach(function (c, i) { if (st.sort === i) c._th.setAttribute("aria-sort", st.dir > 0 ? "ascending" : "descending"); else c._th.removeAttribute("aria-sort"); });
      clear(tbody);
      var lastGroup = null;
      slice.forEach(function (r) {
        if (options.groupBy) {
          var g = options.groupBy(r);
          if (g !== lastGroup) {
            lastGroup = g;
            tbody.appendChild(h("tr", { class: "ic-group" }, h("td", { colspan: visible.length, text: g })));
          }
        }
        var row = h("tr");
        visible.forEach(function (c) { row.appendChild(h("td", null, c.render ? c.render(r) : String(c.value ? c.value(r) : ""))); });
        tbody.appendChild(row);
      });
      if (!slice.length) tbody.appendChild(h("tr", null, h("td", { colspan: visible.length, class: "ic-empty", text: "No matching records found" })));
      var from = all.length ? st.page * st.size + 1 : 0;
      info.textContent = "Showing " + from + " to " + Math.min(all.length, (st.page + 1) * st.size) + " of " + all.length + " entries";
      clear(pager);
      function pbtn(label, to, disabled, current) {
        var b = h("button", { type: "button", text: label, disabled: disabled, class: current ? "is-current" : "" });
        b.addEventListener("click", function () { st.page = to; draw(); });
        pager.appendChild(b);
      }
      pbtn("Previous", st.page - 1, st.page === 0);
      for (var p = Math.max(0, st.page - 2); p <= Math.min(pages - 1, st.page + 2); p += 1) pbtn(String(p + 1), p, false, p === st.page);
      pbtn("Next", st.page + 1, st.page >= pages - 1);
    }
    search.addEventListener("input", function () { st.q = search.value; st.page = 0; draw(); });
    sizeSel.addEventListener("change", function () { st.size = Number(sizeSel.value); st.page = 0; draw(); });
    draw();
  }

  // ---- navigation ---------------------------------------------------------
  var PAGES = ["tracking", "statusUpdate", "jobDetails", "stockActions"];
  function show(page) {
    if (PAGES.indexOf(page) === -1) page = "tracking";
    PAGES.forEach(function (p) { byId(p).hidden = p !== page; });
    Array.prototype.forEach.call(document.querySelectorAll(".ic-link"), function (a) {
      var on = a.getAttribute("data-page") === page;
      a.classList.toggle("is-active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    remember(PAGE_KEY, page);
    setNav(false);
  }
  function setNav(open) {
    byId("ic").classList.toggle("is-nav-open", open);
    byId("icMenuBtn").setAttribute("aria-expanded", open ? "true" : "false");
  }
  function openPage(page) { if (location.hash !== "#" + page) location.hash = page; else show(page); }

  // ---- Tracking -----------------------------------------------------------
  var TRACK_COLUMNS = [
    ["orderType", "Order Type"], ["invoiceID", "Invoice ID"], ["trayID", "Tray Number"], ["orderID", "Rx Number"],
    ["poNumber", "PO Number"], ["patientName", "Patient"], ["startDate", "Start Date", "date"], ["statusDate", "Status Date", "date"],
    ["statusName", "Status"], ["accountID", "Account"], ["billToAccount", "Bill To"], ["shipToID", "Ship To"],
    ["iteration", "Iteration"], ["shippingMethod", "Shipping Method"], ["shippingNumber", "Shipping Number"],
    ["farmOutJob", "Farmout", "boolean"], ["farmOutState", "Farmout State"]
  ];

  function dateCell(v) {
    var d = parseDate(v);
    return d ? fmtDate(d) + " " + fmtTime(d).replace(" ", "") : "";
  }

  function renderTracking(data) {
    var results = byId("trackingResults"), header = byId("trackingHeader");
    clear(results); clear(header);
    if (data.Errors && data.Errors.length) {
      showError(data.Errors.map(function (e) { return e.Code; }).join(","), data.Errors.map(function (e) { return e.Message; }).join(","));
      return;
    }
    if (data.detail) {
      var info = [["TrayID", data.TrayID], ["OrderID", data.OrderID], ["AccountID", data.account], ["Bill To Account", data.billToAccount],
        ["Ship To Account", data.shipToAccount], ["Invoice ID", data.invoiceID]];
      var content = h("div", { class: "ic-card-content ic-info" },
        h("span", { class: "ic-card-title" }, icon("account_circle"), " " + (data.PatientID || "")));
      info.forEach(function (p) { content.appendChild(h("p", null, h("b", { text: p[0] + ": " }), p[1] == null ? "" : String(p[1]))); });
      header.appendChild(h("div", { class: "ic-card" }, content));
      var cols = [
        { name: "Status Date (YYYY/MM/DD)", value: function (r) { var d = parseDate(r.statusDate); return d ? d.getTime() : ""; }, render: function (r) { var d = parseDate(r.statusDate); return d ? fmtDate(d) : ""; } },
        { name: "Status Time (HH:MM AM/PM)", value: function (r) { var d = parseDate(r.statusDate); return d ? d.getTime() : ""; }, render: function (r) { var d = parseDate(r.statusDate); return d ? fmtTime(d) : ""; } },
        { name: "Status Name", value: function (r) { return r.statusName; } },
        { name: "Scheduled", value: function (r) { return r.scheduled; } },
        { name: "Invoice Number", value: function (r) { return r.invoiceID; }, hidden: true },
        { name: "Updated By", value: function (r) { return r.statusUserName; } }
      ];
      dataTable(results, cols, data.detail, { groupBy: function (r) { return "Invoice " + (r.invoiceID == null || r.invoiceID === "" ? "—" : r.invoiceID); } });
    } else if (data.list) {
      var tcols = TRACK_COLUMNS.map(function (f) {
        var key = f[0], type = f[2];
        return {
          name: f[1],
          value: function (r) { return type === "date" ? (parseDate(r[key]) ? parseDate(r[key]).getTime() : "") : (r[key] == null ? "" : r[key]); },
          render: type === "boolean" ? function (r) { return trueFalse(r[key]); } : type === "date" ? function (r) { return dateCell(r[key]); } : null
        };
      });
      header.appendChild(h("div", { class: "ic-card" }, h("div", { class: "ic-card-content" },
        h("span", { class: "ic-card-title" }, icon("account_circle"), " " + ((data.Parameters && (data.Parameters.AccountID || data.Parameters.PatientID || data.Parameters.RxID)) || "Results")))));
      dataTable(results, tcols, data.list, {});
    } else {
      results.appendChild(h("p", { class: "ic-empty", text: "No tracking records found." }));
    }
  }

  function bindTracking() {
    var type = byId("trackingSearchType"), input = byId("trackingSearch");
    type.addEventListener("change", function () { byId("trackingSearchLabel").textContent = type.options[type.selectedIndex].text; });
    byId("trackingForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      if (!input.value.trim()) { input.focus(); return; }
      try {
        var q = "?searchType=" + encodeURIComponent(type.value) + "&value=" + encodeURIComponent(input.value.trim());
        renderTracking(await api("/tracking" + q));
      } catch (err) { fail(err); }
      input.focus();
    });
  }

  // ---- Status Update ------------------------------------------------------
  async function loadStatusItems() {
    var select = byId("statusSearchType");
    try {
      var data = await api("/status-items", undefined, true);
      var groups = {}, order = [];
      (data.StatusList || []).forEach(function (s) {
        if (!groups[s.StatusGroupID]) { groups[s.StatusGroupID] = []; order.push(s.StatusGroupID); }
        groups[s.StatusGroupID].push(s);
      });
      clear(select);
      order.forEach(function (gid) {
        var g = h("optgroup", { label: "Status Group " + gid });
        groups[gid].forEach(function (s) { g.appendChild(h("option", { value: s.ID, text: s.Name })); });
        select.appendChild(g);
      });
      if (!order.length) select.appendChild(h("option", { value: "", text: "No statuses available" }));
    } catch (e) {
      clear(select);
      select.appendChild(h("option", { value: "", text: "Statuses unavailable" }));
    }
  }

  function bindStatus() {
    byId("statusForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var tray = byId("statusSearch"), sel = byId("statusSearchType");
      var trayId = tray.value.trim();
      if (!trayId || !sel.value) { (trayId ? sel : tray).focus(); return; }
      var stamp = Date.now();
      var okCell = h("td", null, h("span", { class: "ic-blue" }, icon("hourglass_top")));
      var noteCell = h("td", { text: "Processing..." });
      var row = h("tr", null, h("td", null, dateTile(new Date(stamp).toISOString())), h("td", { text: trayId }),
        h("td", { text: sel.options[sel.selectedIndex].text }), okCell, noteCell);
      byId("statusResultsTable").insertBefore(row, byId("statusResultsTable").firstChild);
      tray.value = "";
      tray.focus();
      try {
        var res = await api("/status-update", { trayId: trayId, statusId: Number(sel.value), timestamp: stamp }, true);
        clear(okCell); okCell.appendChild(trueFalse(res.processed === 0));
        noteCell.textContent = res.processMessage || "";
      } catch (err) {
        clear(okCell); okCell.appendChild(trueFalse(false));
        noteCell.textContent = err.message;
      }
    });
  }

  // ---- Rx Job Details -----------------------------------------------------
  function gridRow(cols, values, size) {
    var row = h("div", { class: "ic-row" });
    values.forEach(function (v, i) { row.appendChild(h("div", { class: "ic-col ic-col-" + size + " ic-center-align" + (cols ? " ic-bold" : ""), text: v == null ? "" : v })); });
    return row;
  }
  function section(title, heads, right, left, size) {
    var frag = document.createDocumentFragment();
    frag.appendChild(h("div", { class: "ic-row" }, h("div", { class: "ic-col ic-col-12" }, h("h4", { text: title }))));
    frag.appendChild(gridRow(true, heads, size));
    frag.appendChild(gridRow(false, right, size));
    frag.appendChild(gridRow(false, left, size));
    return frag;
  }
  function eye(e) {
    return {
      sph: num(e.Sphere, 2), cyl: num(e.Cyl, 2), axis: padAxis(e.Axis), base: num(e.Base, 2), center: num(e.CenterThick, 2),
      fpd: num(e.FPD, 1), npd: num(e.NPD, 1), add: num(e.Add, 2), pin: num(e.PrismIN, 2), pup: num(e.PrismUP, 2),
      ind: num(e.RefractiveIndex, 3), seg: num(e.SegHgt, 1)
    };
  }
  function renderJob(list) {
    var mount = byId("jobDetailsResults");
    clear(mount);
    if (!list.length) { mount.appendChild(h("div", { class: "ic-card" }, h("div", { class: "ic-card-content ic-empty", text: "No job found for that tray." }))); return; }
    list.forEach(function (val) {
      var rx = val.Rx || {}, Rr = rx.R || {}, Ll = rx.L || {}, R = eye(Rr), L = eye(Ll);
      var content = h("div", { class: "ic-card-content" },
        h("span", { class: "ic-card-title" }, icon("account_circle"), " " + (val.PatientID || "")));
      var meta = h("table", { class: "ic-table" },
        h("thead", null, h("tr", null, h("th", { text: "Rx Date" }), h("th", { text: "Est. Ship Date" }), h("th", { text: "Iteration" }))),
        h("tbody", null, h("tr", null, h("td", null, dateTile(val.rxDate)), h("td", null, dateTile(val.shipByDate)),
          h("td", { class: "ic-flow ic-bold ic-center-align", text: val.iteration == null ? "" : val.iteration }))));
      content.appendChild(h("div", { class: "ic-table-wrap" }, meta));
      content.appendChild(section("Rx", ["SPH", "CYL", "AXIS", "ADD", "PRISM IN", "PRISM UP"],
        [R.sph, R.cyl, R.axis, R.add, R.pin, R.pup], [L.sph, L.cyl, L.axis, L.add, L.pin, L.pup], 2));
      content.appendChild(section("Lens", ["TYPE", "MATERIAL", "STYLE", "OPTION", "INDEX", "BASE"],
        [Rr.MultiFocalType, Rr.Material, Rr.LensType, Rr.LensOption, R.ind, R.base],
        [Ll.MultiFocalType, Ll.Material, Ll.LensType, Ll.LensOption, L.ind, L.base], 2));
      content.appendChild(section("Measurements", ["DIST PD", "NEAR PD", "SEG/OC", "CENTER THICKNESS"],
        [R.fpd, R.npd, R.seg, R.center], [L.fpd, L.npd, L.seg, L.center], 3));
      mount.appendChild(h("div", { class: "ic-card" }, content));
    });
  }
  function bindJob() {
    byId("jobDetailsForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var tray = byId("jobDetailsSearch");
      if (!tray.value.trim()) { tray.focus(); return; }
      try {
        var data = await api("/rx-details?trayId=" + encodeURIComponent(tray.value.trim()));
        if (data.Errors && data.Errors.length) { showError(data.Errors[0].Code, data.Errors[0].Message); return; }
        renderJob(data.orderDetails || []);
      } catch (err) { fail(err); }
    });
  }

  // ---- Stock --------------------------------------------------------------
  async function adjust(opc, input) {
    var qty = Number(input.value);
    if (!Number.isInteger(qty) || qty === 0) { showError(1, "Enter a non-zero whole number quantity."); input.focus(); return; }
    if (!window.confirm("Adjust stock for " + opc + " by " + (qty > 0 ? "+" : "") + qty + "?")) return;
    try {
      await api("/stock-adjust", { opc: opc, qty: qty });
      byId("stockStatusSearch").value = opc;
      byId("stockForm").requestSubmit();
    } catch (err) { fail(err); }
  }
  function renderStock(data) {
    var mount = byId("stockStatusResults");
    clear(mount);
    if (data.Errors && data.Errors.length) { showError(data.Errors[0].Code, data.Errors[0].Message); return; }
    var lens = data.details;
    if (!lens) { mount.appendChild(h("p", { class: "ic-empty", text: "No stock item found for that OPC." })); return; }
    mount.appendChild(h("p", { class: "ic-flow", text: lens.LensName || "" }));
    var heads = ["MANUFACTURER", "TYPE", "MATERIAL", "BASE", "ADD", "SIZE"];
    var vals = [lens.ManufacturerName, lens.FinishedOrSemiName, lens.MaterialName, lens.LensBaseName, lens.LensAdd, lens.LensSizeName];
    var hr = h("div", { class: "ic-row" }), vr = h("div", { class: "ic-row" });
    heads.forEach(function (t, i) {
      hr.appendChild(h("div", { class: "ic-col ic-col-2 ic-bold", text: t }));
      vr.appendChild(h("div", { class: "ic-col ic-col-2", text: vals[i] == null ? "" : vals[i] }));
    });
    mount.appendChild(hr); mount.appendChild(vr);

    var onHand = String(lens.LensOnHand || "").split(";");
    var hasPair = lens.PairOPC !== undefined && lens.PairOPC !== null && lens.PairOPC !== "";
    var sides = [["RIGHT", lens.RightOPC, onHand[0]], ["LEFT", lens.LeftOPC, onHand[1]]];
    if (hasPair) sides.push(["PAIRS", lens.PairOPC, onHand[2]]);
    var colClass = "ic-col ic-col-4 ic-center-align";
    var titles = h("div", { class: "ic-row" }), counts = h("div", { class: "ic-row" }), inputs = h("div", { class: "ic-row" }), buttons = h("div", { class: "ic-row" });
    sides.forEach(function (s) {
      titles.appendChild(h("div", { class: colClass + " ic-bold", text: s[0] }));
      counts.appendChild(h("div", { class: colClass + " ic-flow ic-blue ic-bold", text: s[2] == null ? "" : s[2] }));
      var input = h("input", { class: "ic-adjust", type: "number", step: "1", inputmode: "numeric", "aria-label": s[0] + " quantity" });
      inputs.appendChild(h("div", { class: colClass }, input, h("span", { class: "ic-adjust-label", text: "Quantity" })));
      var b = h("button", { class: "ic-btn ic-btn-block", type: "button", text: "Adjust", disabled: !state.writesEnabled,
        title: state.writesEnabled ? "" : "Source-system writes are disabled for this host" });
      b.addEventListener("click", function () { adjust(s[1], input); });
      buttons.appendChild(h("div", { class: colClass }, b));
    });
    mount.appendChild(titles); mount.appendChild(counts); mount.appendChild(inputs); mount.appendChild(buttons);
  }
  function bindStock() {
    byId("stockForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var opc = byId("stockStatusSearch");
      if (!opc.value.trim()) { opc.focus(); return; }
      try { renderStock(await api("/stock?opc=" + encodeURIComponent(opc.value.trim()))); } catch (err) { fail(err); }
    });
  }

  // ---- skin + status ------------------------------------------------------
  function b64urlToDataUri(logo, type) {
    var s = String(logo).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return "data:image/" + String(type || "png").replace(/[^a-z0-9.+-]/gi, "") + ";base64," + s;
  }
  function rgb(c) { return c && isFinite(c.R) && isFinite(c.G) && isFinite(c.B) ? "rgb(" + c.R + "," + c.G + "," + c.B + ")" : null; }
  async function loadSkin() {
    try {
      var skin = await api("/skin", undefined, true);
      var root = byId("ic");
      var p = rgb(skin.primaryColor), s = rgb(skin.secondaryColor);
      if (p) root.style.setProperty("--ic-primary", p);
      if (s) root.style.setProperty("--ic-secondary", s);
      if (skin.logo) { var img = byId("icLogo"); img.src = b64urlToDataUri(skin.logo, skin.logoType); img.hidden = false; }
      byId("icFooter").textContent = [skin.email, skin.slogan].filter(Boolean).join(" - ");
    } catch (e) { /* default skin */ }
  }
  async function loadStatus() {
    var banner = byId("icBanner");
    try {
      var st = await api("/status", undefined, true);
      state.writesEnabled = Boolean(st.writesEnabled);
      byId("icHost").textContent = st.host || "";
      if (!st.configured) {
        banner.textContent = "The Innovations REST service is not configured on this host, so lookups are unavailable. See docs/INNOVATIONS_CONSOLE.md.";
        banner.hidden = false;
      } else if (!st.writesEnabled) {
        banner.textContent = "Read-only: status updates and stock adjustments are disabled until an administrator enables source-system writes.";
        banner.hidden = false;
      }
      return st.configured;
    } catch (e) {
      banner.textContent = "Could not read module status: " + e.message;
      banner.hidden = false;
      return false;
    }
  }

  // ---- init ---------------------------------------------------------------
  function init() {
    byId("icErrorOk").addEventListener("click", function () { byId("icError").close(); });
    byId("icMenuBtn").addEventListener("click", function () { setNav(!byId("ic").classList.contains("is-nav-open")); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") setNav(false); });
    window.addEventListener("hashchange", function () { show(location.hash.slice(1)); });
    bindTracking(); bindStatus(); bindJob(); bindStock();
    show(location.hash.slice(1) || recall(PAGE_KEY) || "tracking");
    loadStatus().then(function (configured) {
      if (!configured) return;
      loadSkin();
      loadStatusItems();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
