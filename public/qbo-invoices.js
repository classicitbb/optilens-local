// QuickBooks invoice review workspace (Automation > Quickbooks Sync).
// Shows every Innovations invoice since the cutover, what the sync intends to do with it, and lets a person
// post clean invoices to QuickBooks. All business rules live on the server; this file only presents and asks.
(() => {
  const root = document.getElementById("qboInvoiceWorkspace");
  if (!root) return;

  const card = root.closest(".qbo-scheduled-card") || root;
  const headerExport = card.querySelector("#qboHeaderExport");
  const duplicateHeaderMessage = (message) => Boolean(message && message.trim() === document.getElementById("qboInvoiceSyncDetail")?.textContent.trim());

  const API = "/api/automation/qbo-invoices";
  const PAGE_SIZE = 50;
  const BATCH_LIMIT = 25;
  const POLL_MS = 2000;
  const CONFIRM_MS = 6000;
  const LANES = [
    { id: "ready", label: "Ready to post", hint: "Clean invoices" },
    { id: "attention", label: "Needs a look", hint: "VAT, credits, large totals" },
    { id: "exception", label: "Exceptions", hint: "Cannot post yet" },
    { id: "new", label: "Not checked", hint: "Waiting for the next sync" },
    { id: "posted", label: "In QuickBooks", hint: "Already posted" },
    { id: "all", label: "All invoices", hint: "Since the cutover" }
  ];
  const STATUS_TEXT = { ready: "Ready", attention: "Needs a look", exception: "Exception", posted: "In QuickBooks", new: "Not checked" };
  const EXPORT_SCOPES = [["unposted", "Not yet in QuickBooks"], ["ready", "Ready to post"], ["posted", "Already posted"], ["all", "Everything"]];

  const state = { view: "invoices", recon: { data: null, loading: false, error: "", filter: "todo", sort: { key: "date", dir: "asc" }, visible: PAGE_SIZE }, review: null, lane: "ready", query: "", visible: PAGE_SIZE, selected: new Set(), expanded: new Set(), job: null, confirming: null, error: "", exportScope: "unposted", sort: { key: "date", dir: "asc" }, fix: null, fixError: "", info: "", working: null, started: false, autoOpened: new Set() };
  let polling = false;
  let confirmTimer = null;

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const money = (value) => Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const day = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const slot = (name) => root.querySelector(`[data-slot="${name}"]`);

  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, { credentials: "same-origin", cache: "no-store", ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
    return body;
  }
  const postJson = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  // Sortable columns: each key maps to a comparable value on the row.
  const COLUMNS = [
    { key: "invoice", label: "Invoice", value: (row) => Number(row.sourceInvoiceId) || row.sourceInvoiceId },
    { key: "date", label: "Date", value: (row) => row.invoiceDate || "" },
    { key: "customer", label: "Customer · patient", value: (row) => `${row.customer} ${row.memo}`.toLowerCase() },
    { key: "total", label: "Total", value: (row) => (row.isCredit ? -row.total : row.total), numeric: true },
    { key: "sale", label: "Sale", value: (row) => row.segment },
    { key: "tax", label: "Tax", value: (row) => row.taxCode },
    { key: "status", label: "Status", value: (row) => STATUS_TEXT[row.lane] || row.status }
  ];
  const compareRows = ({ key, dir }) => {
    const { value } = COLUMNS.find((column) => column.key === key);
    const sign = dir === "desc" ? -1 : 1;
    return (a, b) => {
      const x = value(a), y = value(b);
      const order = x < y ? -1 : x > y ? 1 : 0;
      return (order || Number(a.sourceInvoiceId) - Number(b.sourceInvoiceId)) * sign;
    };
  };

  // ---- reconciliation: every QuickBooks document against Innovations, whoever entered it -------
  const RECON_FILTERS = [
    { id: "todo", label: "Needs reconciling", tone: "attention", test: (row) => row.state !== "matched" },
    { id: "differs", label: "Amount differs", tone: "exception", test: (row) => row.state === "differs" || row.state === "duplicate" },
    { id: "missing", label: "Not in QuickBooks", tone: "ready", test: (row) => row.state === "missing" },
    { id: "qbo_only", label: "Only in QuickBooks", tone: "attention", test: (row) => row.state === "qbo_only" },
    { id: "matched", label: "Matched", tone: "posted", test: (row) => row.state === "matched" },
    { id: "all", label: "All", tone: "all", test: () => true }
  ];
  const RECON_TEXT = { matched: "Matches", differs: "Amount differs", duplicate: "Duplicate number", missing: "Not in QuickBooks", qbo_only: "Only in QuickBooks" };
  const RECON_TONE = { matched: "posted", differs: "exception", duplicate: "exception", missing: "attention", qbo_only: "attention" };
  const ORIGIN_TEXT = { optilens: "OptiLens", other: "Entered in QuickBooks" };
  const RECON_COLUMNS = [
    { key: "invoice", label: "Invoice", value: (row) => Number(row.docNumber) || row.docNumber },
    { key: "date", label: "Date", value: (row) => row.invoiceDate || "" },
    { key: "customer", label: "Customer", value: (row) => String(row.customer || "").toLowerCase() },
    { key: "innovations", label: "Innovations", value: (row) => row.innovationsTotal ?? -Infinity, numeric: true },
    { key: "quickbooks", label: "QuickBooks", value: (row) => row.qboTotal ?? -Infinity, numeric: true },
    { key: "difference", label: "Difference", value: (row) => row.difference ?? 0, numeric: true },
    { key: "state", label: "Result", value: (row) => RECON_TEXT[row.state] },
    { key: "origin", label: "Entered by", value: (row) => ORIGIN_TEXT[row.origin] || "" }
  ];
  const reconRows = () => state.recon.data?.rows || [];
  const reconCount = (filter) => reconRows().filter(filter.test).length;
  const compareRecon = ({ key, dir }) => {
    const { value } = RECON_COLUMNS.find((column) => column.key === key);
    const sign = dir === "desc" ? -1 : 1;
    return (a, b) => {
      const x = value(a), y = value(b);
      const order = x < y ? -1 : x > y ? 1 : 0;
      return (order || Number(a.docNumber) - Number(b.docNumber)) * sign;
    };
  };
  function visibleRecon() {
    const query = state.query.trim().toLowerCase();
    const filter = RECON_FILTERS.find((item) => item.id === state.recon.filter) || RECON_FILTERS[0];
    return reconRows()
      .filter((row) => (query ? [row.docNumber, row.customer, row.qboCustomer, row.mappedCustomer].some((value) => String(value || "").toLowerCase().includes(query)) : filter.test(row)))
      .sort(compareRecon(state.recon.sort));
  }

  async function loadRecon() {
    state.recon.loading = true; state.recon.error = "";
    render();
    try { state.recon.data = await api("/reconcile"); } catch (error) { state.recon.error = error.message || "Unable to read QuickBooks."; }
    state.recon.loading = false;
    render();
  }

  function renderReconLanes() {
    slot("lanes").innerHTML = `<button type="button" class="qbo-lane" data-action="view" data-view="invoices"><span class="qbo-lane-label">Back to invoices</span></button>` + RECON_FILTERS.map((filter) => `
      <button type="button" class="qbo-lane" data-action="recon-filter" data-filter="${filter.id}" data-tone="${filter.tone}" aria-pressed="${state.recon.filter === filter.id}">
        <span class="qbo-lane-label">${filter.label}</span>
        <strong>${state.recon.data ? reconCount(filter) : "-"}</strong>
      </button>`).join("");
  }

  function renderReconNotice() {
    const { data, loading, error } = state.recon;
    const lines = [];
    if (error && !duplicateHeaderMessage(error)) lines.push(`<p class="qbo-notice-error">${escapeHtml(error)}</p>`);
    if (loading) lines.push("<p>Reading QuickBooks.</p>");
    if (data) {
      const summary = data.summary;
      const time = new Date(data.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      lines.push(`<p>Every invoice and credit memo in QuickBooks dated ${day(data.from)} or later, matched to Innovations by invoice number, whoever entered it. Innovations ${money(summary.innovationsTotal)}, QuickBooks ${money(summary.quickbooksTotal)}. Checked ${time}. Read-only.</p>`);
      if (data.truncated) lines.push('<p class="qbo-notice-error">QuickBooks has more documents than this view reads, so the list is incomplete.</p>');
    }
    slot("notice").innerHTML = lines.join("");
    fitTable();
  }

  function reconHeaderCell(column) {
    const active = state.recon.sort.key === column.key;
    const arrow = active ? (state.recon.sort.dir === "asc" ? "\u25b2" : "\u25bc") : "";
    return `<th scope="col" class="${column.numeric ? "qbo-num" : ""}" aria-sort="${active ? (state.recon.sort.dir === "asc" ? "ascending" : "descending") : "none"}"><button type="button" class="qbo-sort" data-action="recon-sort" data-key="${column.key}">${column.label}<span aria-hidden="true">${arrow}</span></button></th>`;
  }

  function reconRow(row) {
    const link = row.qboId ? ` <a class="qbo-link" href="https://app.qbo.intuit.com/app/${row.qboType === "CreditMemo" ? "creditmemo" : "invoice"}?txnId=${encodeURIComponent(row.qboId)}" target="_blank" rel="noopener" aria-label="Open ${escapeHtml(row.docNumber)} in QuickBooks">Open</a>` : "";
    const gap = row.difference ? money(row.difference) : "";
    return `
      <tr class="qbo-row">
        <td>${escapeHtml(row.docNumber)}${link}</td>
        <td>${day(row.invoiceDate)}</td>
        <td class="qbo-customer"><strong>${escapeHtml(row.customer)}</strong>${row.note ? ` <small>${escapeHtml(row.note)}</small>` : ""}</td>
        <td class="qbo-num">${row.innovationsTotal == null ? "" : money(row.innovationsTotal)}</td>
        <td class="qbo-num">${row.qboTotal == null ? "" : money(row.qboTotal)}</td>
        <td class="qbo-num">${gap}</td>
        <td><span class="qbo-pill" data-tone="${RECON_TONE[row.state]}">${RECON_TEXT[row.state]}</span></td>
        <td>${escapeHtml(ORIGIN_TEXT[row.origin] || "")}</td>
      </tr>`;
  }

  function renderReconTable() {
    const { data, loading, error } = state.recon;
    if (!data) { slot("table").innerHTML = `<p class="qbo-empty">${loading ? "Comparing with QuickBooks." : escapeHtml(error ? "Comparison unavailable." : "Nothing to show yet.")}</p>`; return; }
    const list = visibleRecon();
    const shown = list.slice(0, state.recon.visible);
    slot("table").innerHTML = list.length ? `
      <table class="qbo-table">
        <thead><tr>${RECON_COLUMNS.map(reconHeaderCell).join("")}</tr></thead>
        <tbody>${shown.map(reconRow).join("")}</tbody>
      </table>
      <p class="qbo-table-foot">${shown.length} of ${list.length} shown${list.length > shown.length ? ` <button type="button" class="button secondary" data-action="recon-more">Show ${Math.min(PAGE_SIZE, list.length - shown.length)} more</button>` : ""}</p>`
      : `<p class="qbo-empty">${state.query ? "Nothing matches your search." : "Nothing in this list."}</p>`;
  }

  function renderLanes() {
    if (state.view === "reconcile") { renderReconLanes(); return; }
    renderInvoiceLanes();
  }

  function renderActions() {
    if (headerExport) headerExport.innerHTML = `
      <select data-role="export-scope" aria-label="Which invoices to include in the CSV">${EXPORT_SCOPES.map(([value, label]) => `<option value="${value}" ${value === state.exportScope ? "selected" : ""}>${label}</option>`).join("")}</select>
      <a class="button secondary" href="${API}/export.csv?scope=${encodeURIComponent(state.exportScope)}" download>CSV for QuickBooks</a>`;

    if (state.view === "reconcile") {
      slot("actions").innerHTML = `<button type="button" class="button secondary" data-action="recon-refresh" ${state.recon.loading ? "disabled" : ""}>${state.recon.loading ? "Reading QuickBooks." : "Refresh from QuickBooks"}</button>`;
      return;
    }
    renderInvoiceActions();
  }

  // ---- selectors ---------------------------------------------------------------------------
  const rows = () => state.review?.rows || [];
  const laneCount = (id) => (id === "all" ? rows().length : state.review?.summary.lanes[id]?.count || 0);
  const laneTotal = (id) => (id === "all" ? rows().reduce((sum, row) => sum + (row.isCredit ? -row.total : row.total), 0) : state.review?.summary.lanes[id]?.total || 0);
  const matchesQuery = (row, query) => !query || [row.sourceInvoiceId, row.customer, row.account, row.memo, row.tracking].some((value) => String(value || "").toLowerCase().includes(query));
  const visibleRows = () => {
    const query = state.query.trim().toLowerCase();
    return rows().filter((row) => (query || state.lane === "all" || row.lane === state.lane) && matchesQuery(row, query)).sort(compareRows(state.sort));
  };
  const jobRunning = () => state.job?.state === "running";
  const canPost = () => Boolean(state.review?.canPost) && !jobRunning();

  // ---- rendering ---------------------------------------------------------------------------
  function renderInvoiceLanes() {
    slot("lanes").innerHTML = LANES.filter((lane) => lane.id !== "new" || laneCount("new") > 0).map((lane) => `
      <button type="button" class="qbo-lane" data-action="lane" data-lane="${lane.id}" data-tone="${lane.id}" title="${lane.hint}" aria-pressed="${state.lane === lane.id}">
        <span class="qbo-lane-label">${lane.label}</span>
        <strong>${laneCount(lane.id)}</strong>
        ${lane.id === "exception" || lane.id === "new" ? "" : `<small>${money(laneTotal(lane.id))}</small>`}
      </button>`).join("");
  }

  // Auto-post: a switch with a confirm step before it turns on. Turning it off is immediate.
  function autoSwitch() {
    const review = state.review;
    if (!review?.canPost || !review.canManage) return "";
    const on = Boolean(review.autoPost);
    const asking = state.confirming === "auto";
    const label = asking ? "Confirm: turn auto-post on" : "Auto-post";
    return `<button type="button" class="button secondary qbo-switch" role="switch" aria-checked="${on}" data-action="toggle-auto" data-on="${on}" title="Post clean Ready invoices to QuickBooks on each sync. Exceptions, credit notes, VAT and large invoices always wait for a person.">${label}<span>${on ? "On" : "Off"}</span></button>`;
  }

  function renderInvoiceActions() {
    const selected = state.selected.size;
    const confirming = state.confirming === "batch";
    const readyOnPage = visibleRows().filter((row) => row.lane === "ready").length;
    slot("actions").innerHTML = `
      ${autoSwitch()}
      ${readyOnPage && canPost() ? `<button type="button" class="button secondary" data-action="select-batch">Select next ${Math.min(BATCH_LIMIT, readyOnPage)}</button>` : ""}
      ${selected ? `<button type="button" class="button secondary" data-action="clear-selection">Clear (${selected})</button>` : ""}
      <button type="button" class="button primary" data-action="post-selected" ${selected && canPost() ? "" : "disabled"}>${confirming ? `Confirm: post ${selected} to QuickBooks` : `Post ${selected || ""} selected`.replace("  ", " ")}</button>
      `;
  }

  function renderNotice() {
    if (state.view === "reconcile") { renderReconNotice(); return; }
    const review = state.review;
    const lines = [];
    if (state.info) lines.push(`<p>${escapeHtml(state.info)}</p>`);
    if (state.error && !duplicateHeaderMessage(state.error)) lines.push(`<p class="qbo-notice-error">${escapeHtml(state.error)}</p>`);
    if (review?.canPost && review.autoPost) lines.push(`<p>Auto-post is on: Ready invoices post on each sync, up to ${review.autoPostPerRun || 25} at a time. Exceptions, credit notes, VAT and large invoices always wait for you.</p>`);
    if (review && !review.canPost) lines.push("<p>Posting to QuickBooks is switched off on this server. You can still review every invoice and download the CSV.</p>");
    if (state.job) {
      const { total, finished, items } = state.job;
      const failed = items.filter((item) => item.status === "failed");
      const skipped = items.filter((item) => item.status === "skipped");
      const posted = items.filter((item) => item.status === "created" || item.status === "updated").length;
      const percent = total ? Math.round((finished / total) * 100) : 0;
      lines.push(`
        <div class="qbo-job" data-state="${state.job.state}">
          <div class="qbo-job-line"><strong>${jobRunning() ? `Posting ${finished} of ${total}` : `Finished: ${posted} posted, ${skipped.length} skipped, ${failed.length} failed`}</strong>
            ${jobRunning() ? "<span>Each invoice takes about 20 seconds. You can leave this page; posting continues.</span>" : ""}</div>
          <div class="qbo-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${finished}"><span style="width:${percent}%"></span></div>
          ${[...failed, ...skipped].map((item) => `<p class="qbo-job-issue">${escapeHtml(item.sourceInvoiceId)}: ${escapeHtml(item.message || item.status)}</p>`).join("")}
        </div>`);
    }
    slot("notice").innerHTML = lines.join("");
    if (state.review) fitTable();
  }

  function statusCell(row) {
    const link = row.qboId ? ` <a class="qbo-link" href="https://app.qbo.intuit.com/app/${row.qboType === "CreditMemo" ? "creditmemo" : "invoice"}?txnId=${encodeURIComponent(row.qboId)}" target="_blank" rel="noopener" aria-label="Open invoice ${escapeHtml(row.sourceInvoiceId)} in QuickBooks">Open</a>` : "";
    const text = row.lane === "ready" && row.kind === "update" ? "Update ready" : STATUS_TEXT[row.lane] || row.status;
    return `<span class="qbo-pill" data-tone="${row.lane}">${text}</span>${row.lane === "posted" ? link : ""}`;
  }

  // Exception rows carry their own fix: map the customer, pick the VAT code, or re-check once it is fixed elsewhere.
  function exceptionPanel(row) {
    const { kind, action } = row.advice;
    const id = escapeHtml(row.sourceInvoiceId);
    const busy = state.working === row.sourceInvoiceId || !state.review.canManage;
    const options = state.fix;
    const loading = !options && !state.fixError;
    const customerControls = `
      <input type="search" list="qboCustomerOptions" placeholder="${loading ? "Loading QuickBooks customers…" : "Search QuickBooks customers"}" data-fix="customer" data-invoice="${id}" aria-label="QuickBooks customer for account ${escapeHtml(row.account)}" ${options && !busy ? "" : "disabled"}>
      <button type="button" class="button primary" data-action="map-customer" data-invoice="${id}" data-account="${escapeHtml(row.account)}" ${options && !busy ? "" : "disabled"}>Map ${escapeHtml(row.account)}</button>`;
    const taxControls = `
      <select data-fix="tax" data-invoice="${id}" aria-label="QuickBooks code for VAT 17.5%" ${options && !busy ? "" : "disabled"}>
        <option value="">${loading ? "Loading tax codes…" : "Choose the VAT 17.5% code"}</option>
        ${(options?.taxCodes || []).map((code) => `<option value="${escapeHtml(code.id)}" ${code.id === options.standardTaxCodeId ? "selected" : ""}>${escapeHtml(code.name)}</option>`).join("")}
      </select>
      <button type="button" class="button primary" data-action="save-tax" data-invoice="${id}" ${options && !busy ? "" : "disabled"}>Save code</button>`;
    return `
      <div class="qbo-error">
        <strong>${escapeHtml(row.error)}</strong>
        <p>${escapeHtml(action)}</p>
        <div class="qbo-fix">
          ${kind === "customer" ? customerControls : ""}${kind === "tax" ? taxControls : ""}
          <button type="button" class="button secondary" data-action="recheck" data-invoice="${id}" ${state.working === row.sourceInvoiceId ? "disabled" : ""}>Re-check</button>
        </div>
        ${state.fixError && (kind === "customer" || kind === "tax") ? `<p class="qbo-notice-error">${escapeHtml(state.fixError)}</p>` : ""}
      </div>`;
  }

  function detailRow(row) {
    const ship = [row.shipVia, row.shipDate ? day(row.shipDate) : "", row.tracking ? `Tracking ${row.tracking}` : ""].filter(Boolean).join(" · ") || "No shipment recorded";
    const confirming = state.confirming === row.sourceInvoiceId;
    const postable = (row.lane === "ready" || row.lane === "attention") && canPost();
    return `
      <tr class="qbo-detail"><td colspan="8">
        <dl class="qbo-facts">
          <div class="qbo-fact-wide"><dt>Job memo</dt><dd>${escapeHtml(row.memo) || "None"}</dd></div>
          <div><dt>Class / Location</dt><dd>${escapeHtml(row.className)} / ${escapeHtml(row.location)}</dd></div>
          <div><dt>Tax code</dt><dd>${escapeHtml(row.taxCode)}</dd></div>
          <div><dt>Ship</dt><dd>${escapeHtml(ship)}</dd></div>
          <div><dt>QuickBooks customer</dt><dd>${escapeHtml(row.qboCustomer || "Not mapped")}</dd></div>
          <div><dt>Item</dt><dd>${escapeHtml(row.itemName)}</dd></div>
          <div><dt>Due</dt><dd>${day(row.dueDate)}</dd></div>
        </dl>
        ${row.holds.length ? `<ul class="qbo-holds">${row.holds.map((hold) => `<li>${escapeHtml(hold)}</li>`).join("")}</ul>` : ""}
        ${row.error ? exceptionPanel(row) : ""}
        ${postable ? `<button type="button" class="button ${row.lane === "attention" ? "secondary" : "primary"}" data-action="post-one" data-invoice="${escapeHtml(row.sourceInvoiceId)}">${confirming ? "Confirm: post to QuickBooks" : (row.kind === "update" ? "Update in QuickBooks" : "Post to QuickBooks")}</button>` : ""}
      </td></tr>`;
  }

  function invoiceRow(row) {
    const open = state.expanded.has(row.sourceInvoiceId);
    const selectable = row.lane === "ready";
    return `
      <tr class="qbo-row" data-invoice="${escapeHtml(row.sourceInvoiceId)}">
        <td class="qbo-check">${selectable ? `<input type="checkbox" data-action="select" data-invoice="${escapeHtml(row.sourceInvoiceId)}" aria-label="Select invoice ${escapeHtml(row.sourceInvoiceId)}" ${state.selected.has(row.sourceInvoiceId) ? "checked" : ""} ${canPost() ? "" : "disabled"}>` : ""}</td>
        <td><button type="button" class="qbo-expand" data-action="expand" data-invoice="${escapeHtml(row.sourceInvoiceId)}" aria-expanded="${open}">${escapeHtml(row.sourceInvoiceId)}</button></td>
        <td>${day(row.invoiceDate)}</td>
        <td class="qbo-customer"><strong>${escapeHtml(row.customer)}</strong> <small>${escapeHtml(row.account)} · ${escapeHtml(row.memo.split(". ")[0])}</small></td>
        <td class="qbo-num">${row.isCredit ? "−" : ""}${money(row.total)}</td>
        <td>${escapeHtml(row.segment)}</td>
        <td>${escapeHtml(row.taxCode)}</td>
        <td>${statusCell(row)}</td>
      </tr>${open ? detailRow(row) : ""}`;
  }

  function headerCell(column) {
    const active = state.sort.key === column.key;
    const arrow = active ? (state.sort.dir === "asc" ? "▲" : "▼") : "";
    return `<th scope="col" class="${column.numeric ? "qbo-num" : ""}" aria-sort="${active ? (state.sort.dir === "asc" ? "ascending" : "descending") : "none"}"><button type="button" class="qbo-sort" data-action="sort" data-key="${column.key}">${column.label}<span aria-hidden="true">${arrow}</span></button></th>`;
  }

  function renderTable() {
    if (state.view === "reconcile") { renderReconTable(); return; }
    if (!state.review) { slot("table").textContent = state.error ? "Invoices unavailable." : "Loading invoices…"; return; }
    const list = visibleRows();
    const shown = list.slice(0, state.visible);
    slot("table").innerHTML = list.length ? `
      <table class="qbo-table">
        <thead><tr><th></th>${COLUMNS.map(headerCell).join("")}</tr></thead>
        <tbody>${shown.map(invoiceRow).join("")}</tbody>
      </table>
      <p class="qbo-table-foot">${shown.length} of ${list.length} shown${list.length > shown.length ? ` <button type="button" class="button secondary" data-action="more">Show ${Math.min(PAGE_SIZE, list.length - shown.length)} more</button>` : ""}</p>`
      : `<p class="qbo-empty">${state.query ? "No invoices match your search." : "Nothing here."}</p>`;
  }

  // The table takes the rest of the window height, so the rows scroll under a fixed heading row.
  function fitTable() {
    const wrap = slot("table");
    const top = wrap.getBoundingClientRect().top + window.scrollY;
    wrap.style.maxHeight = `${Math.max(240, window.innerHeight - top - 12)}px`;
    const over = document.documentElement.scrollHeight - window.innerHeight;
    if (over > 0) wrap.style.maxHeight = `${Math.max(240, wrap.getBoundingClientRect().height - over)}px`;
  }
  const render = () => { renderLanes(); renderActions(); renderNotice(); renderTable(); fitTable(); };

  // ---- behaviour ---------------------------------------------------------------------------
  async function refresh() {
    try {
      state.review = await api("/review");
      state.error = "";
      const valid = new Set(rows().filter((row) => row.lane === "ready").map((row) => row.sourceInvoiceId));
      state.selected = new Set([...state.selected].filter((id) => valid.has(id)));
      if (!state.started) { state.started = true; if (laneCount("exception") > 0) state.lane = "exception"; }
      rows().filter((row) => row.lane === "exception" && !state.autoOpened.has(row.sourceInvoiceId)).forEach((row) => { state.autoOpened.add(row.sourceInvoiceId); state.expanded.add(row.sourceInvoiceId); });
      if (state.review.job && !polling) { state.job = state.review.job; void followJob(state.job.id); }
      if (laneCount("exception") > 0 && state.review.canManage) void loadFixOptions();
    } catch (error) { state.error = error.message || "Unable to load invoices."; }
    render();
  }

  async function followJob(id) {
    polling = true;
    try {
      while (jobRunning()) {
        await sleep(POLL_MS);
        state.job = await api(`/approval-jobs/${encodeURIComponent(id)}`);
        renderNotice();
      }
    } catch (error) { state.error = error.message; }
    polling = false;
    await refresh();
  }

  async function loadFixOptions() {
    if (state.fix || state.fixLoading) return;
    state.fixLoading = true;
    try {
      state.fix = await api("/fix-options");
      state.fixError = "";
      slot("customers").replaceChildren(...state.fix.customers.map((customer) => Object.assign(document.createElement("option"), { value: customer.displayName })));
    } catch (error) { state.fixError = `Could not load QuickBooks options: ${error.message}`; }
    state.fixLoading = false;
    renderTable();
  }

  // Re-check some invoices (dry run: the sync ledger changes, nothing is written to QuickBooks) and say what happened.
  async function recheck(ids, lead) {
    const { results } = await postJson("/recheck", { sourceInvoiceIds: ids });
    const still = results.filter((result) => result.status === "exception" || result.status === "failed");
    state.info = `${lead}${results.length - still.length} of ${results.length} moved on${still.length ? `; ${still.length} still need attention (${still[0].sourceInvoiceId}: ${still[0].reason})` : ""}.`;
  }
  // Runs a fix, then reloads. Values typed into the row are read by the caller first, because the reload redraws the row.
  async function fixAction(el, work) {
    state.working = el.dataset.invoice;
    state.error = ""; state.info = "";
    el.disabled = true;
    try { await work(); } catch (error) {
      // Leave the row as it is so what was typed is not lost; Re-check picks up any partial progress.
      state.working = null; el.disabled = false; state.error = error.message; renderNotice();
      return;
    }
    state.working = null;
    await refresh();
  }
  const exceptionIds = (match) => rows().filter((row) => row.lane === "exception" && match(row)).map((row) => row.sourceInvoiceId);
  const fixInput = (el, field) => root.querySelector(`[data-fix="${field}"][data-invoice="${el.dataset.invoice}"]`);

  async function post(ids) {
    clearConfirm();
    try {
      state.job = await postJson("/approve-batch", { sourceInvoiceIds: ids });
      state.selected.clear();
      state.error = "";
      render();
      void followJob(state.job.id);
    } catch (error) { state.error = error.message; render(); }
  }

  function askConfirm(target) {
    clearTimeout(confirmTimer);
    state.confirming = target;
    confirmTimer = setTimeout(() => { state.confirming = null; render(); }, CONFIRM_MS);
    render();
  }
  function clearConfirm() { clearTimeout(confirmTimer); state.confirming = null; }

  const actions = {
    view: (el) => {
      state.view = el.dataset.view; state.visible = PAGE_SIZE; clearConfirm(); render();
      if (state.view === "reconcile" && !state.recon.data && !state.recon.loading) void loadRecon();
    },
    "recon-filter": (el) => { state.recon.filter = el.dataset.filter; state.recon.visible = PAGE_SIZE; render(); },
    "recon-refresh": () => { void loadRecon(); },
    "recon-more": () => { state.recon.visible += PAGE_SIZE; renderTable(); fitTable(); },
    "recon-sort": (el) => {
      const sort = state.recon.sort;
      state.recon.sort = sort.key === el.dataset.key ? { key: sort.key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key: el.dataset.key, dir: "asc" };
      renderTable();
    },
    lane: (el) => { state.lane = el.dataset.lane; state.visible = PAGE_SIZE; clearConfirm(); render(); },
    expand: (el) => { const id = el.dataset.invoice; if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id); renderTable(); },
    select: (el) => { if (el.checked && state.selected.size >= BATCH_LIMIT) { el.checked = false; state.error = `Post at most ${BATCH_LIMIT} invoices at a time.`; renderNotice(); return; } if (el.checked) state.selected.add(el.dataset.invoice); else state.selected.delete(el.dataset.invoice); clearConfirm(); renderActions(); },
    "select-batch": () => { visibleRows().filter((row) => row.lane === "ready").slice(0, BATCH_LIMIT).forEach((row) => state.selected.add(row.sourceInvoiceId)); state.error = ""; clearConfirm(); render(); },
    "clear-selection": () => { state.selected.clear(); clearConfirm(); render(); },
    "toggle-auto": async () => {
      const turnOn = !state.review.autoPost;
      if (turnOn && state.confirming !== "auto") { askConfirm("auto"); return; }
      clearConfirm();
      try { const saved = await postJson("/auto-post", { enabled: turnOn }); state.review.autoPost = saved.autoPost; state.error = ""; state.info = saved.autoPost ? "Auto-post is on." : "Auto-post is off."; }
      catch (error) { state.error = error.message; }
      render();
    },
    "post-selected": () => (state.confirming === "batch" ? post([...state.selected]) : askConfirm("batch")),
    "post-one": (el) => (state.confirming === el.dataset.invoice ? post([el.dataset.invoice]) : askConfirm(el.dataset.invoice)),
    sort: (el) => { const key = el.dataset.key; state.sort = { key, dir: state.sort.key === key && state.sort.dir === "asc" ? "desc" : "asc" }; renderTable(); },
    recheck: (el) => fixAction(el, () => recheck([el.dataset.invoice], "Re-checked: ")),
    "map-customer": (el) => { const typed = fixInput(el, "customer").value.trim(); return fixAction(el, async () => {
      const customer = (state.fix?.customers || []).find((candidate) => candidate.displayName === typed);
      if (!customer) throw new Error("Pick a customer from the list, then map it.");
      await postJson("/customer-mappings", { sourceAccount: el.dataset.account, qboCustomerId: customer.id });
      await recheck(exceptionIds((row) => row.account === el.dataset.account), `Mapped ${el.dataset.account} to ${customer.displayName}. `);
    }); },
    "save-tax": (el) => { const taxCodeId = fixInput(el, "tax").value; return fixAction(el, async () => {
      if (!taxCodeId) throw new Error("Choose the QuickBooks code for VAT 17.5%.");
      await postJson("/tax-code", { taxCodeId });
      state.fix = null;
      await recheck(exceptionIds((row) => row.advice.kind === "tax"), "Saved the VAT code. ");
    }); },
    more: () => { state.visible += PAGE_SIZE; renderTable(); }
  };

  root.innerHTML = `
    <div class="qbo-lanes" data-slot="lanes"></div>
    <div class="qbo-toolbar">
      <label class="qbo-search"><input type="search" data-page-filter data-role="search" aria-label="Find an invoice" placeholder="Invoice, customer, patient or tracking number" autocomplete="off"></label>
      <div class="qbo-actions" data-slot="actions"></div>
    </div>
    <div class="qbo-notice" data-slot="notice" role="status" aria-live="polite"></div>
    <div class="qbo-table-wrap" data-slot="table"></div>
    <datalist id="qboCustomerOptions" data-slot="customers"></datalist>`;

  card.addEventListener("click", (event) => {
    const el = event.target.closest("[data-action]");
    if (el && el.tagName !== "INPUT" && !el.disabled && actions[el.dataset.action]) actions[el.dataset.action](el);
  });
  card.addEventListener("change", (event) => {
    if (event.target.matches('input[data-action="select"]')) actions.select(event.target);
    if (event.target.matches('[data-role="export-scope"]')) { state.exportScope = event.target.value; renderActions(); }
  });
  root.addEventListener("input", (event) => {
    if (event.target.matches('[data-role="search"]')) { state.query = event.target.value; state.visible = PAGE_SIZE; renderActions(); renderTable(); }
  });
  document.addEventListener("qbo-invoices:refresh", refresh);
  document.addEventListener("qbo-sync:detail", renderNotice);
  window.addEventListener("resize", fitTable);
  window.addEventListener("focus", () => { if (!jobRunning()) void refresh(); });

  render();
  void refresh();
})();
