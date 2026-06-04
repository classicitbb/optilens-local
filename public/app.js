const state = {
  modules: [],
  dashboard: null
};

const fallbackDashboard = {
  metrics: [
    { label: "Open source shipments", value: "PSQL/MSSQL", detail: "Shipments.Shipped = 0" },
    { label: "App-owned closures", value: "Pending DB", detail: "Stored in optilens_local first" },
    { label: "Access import source", value: "CV_Accounts_be", detail: "Last 12 months active plus archive" },
    { label: "Write-back", value: "Off", detail: "Future approved workflow only" }
  ],
  integrationHealth: [
    { name: "Private app MSSQL", state: "setup-needed", detail: "Create optilens_local" },
    { name: "Source MSSQL Innovations", state: "credentials-needed", detail: "Use SQL login setup" },
    { name: "PSQL Innovations", state: "discovered", detail: "Shipments and ShipmentItems identified" },
    { name: "Access backend", state: "ready-for-import", detail: "CV_Accounts_be.accdb is first historic source" }
  ]
};

const fallbackModules = [
  {
    id: "delivery-export",
    name: "Delivery and Export",
    status: "first-build",
    href: "/modules/delivery-export",
    summary: "Access delivery, shipment prep, commercial invoice, and archive workflows."
  },
  {
    id: "integrations",
    name: "Integrations",
    status: "planned",
    href: "/modules/integrations",
    summary: "MSSQL, PSQL, Access import, website updates, file-share checks, and future service APIs."
  },
  {
    id: "automation",
    name: "Automation",
    status: "planned",
    href: "/modules/automation",
    summary: "Local LLM and rule-based automation tools routed through audited platform APIs."
  }
];

async function init() {
  tickClock();
  setInterval(tickClock, 1000);

  const [dashboard, modules] = await Promise.all([
    getJson("/api/dashboard", fallbackDashboard),
    getJson("/api/modules", { modules: fallbackModules })
  ]);

  state.dashboard = dashboard;
  state.modules = modules.modules || fallbackModules;
  state.accessImport = await getJson("/api/access-import/dry-run", { tables: [] });
  state.shipmentSessions = await getJson("/api/delivery/shipments", { sessions: [] });
  state.dispatchers = await getJson("/api/source/dispatchers", { dispatchers: [] });
  state.exportCustomers = await getJson("/api/source/export-customers", { customers: [] });
  state.sourceShipmentItems = { items: [] };

  renderMetrics();
  renderModules();
  renderHealth();
  renderSourceSelectors();
  renderAccessImport();
  renderShipmentSessions();
  wireDeliveryActions();
  revealModuleFromPath();
}

async function getJson(url, fallback) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return fallback;
    return response.json();
  } catch {
    return fallback;
  }
}

function tickClock() {
  const el = document.querySelector("#clock");
  if (el) {
    el.textContent = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date());
  }
}

function renderMetrics() {
  const target = document.querySelector("#metrics");
  target.innerHTML = state.dashboard.metrics.map(metric => `
    <article class="metric">
      <span>${escapeHtml(metric.label)}</span>
      <strong>${escapeHtml(metric.value)}</strong>
      <small>${escapeHtml(metric.detail)}</small>
    </article>
  `).join("");
}

function renderModules() {
  const target = document.querySelector("#moduleGrid");
  target.innerHTML = state.modules.map(module => `
    <a class="module-card" href="${escapeHtml(module.href)}">
      <span class="badge ${escapeHtml(module.status)}">${escapeHtml(module.status)}</span>
      <h3>${escapeHtml(module.name)}</h3>
      <p>${escapeHtml(module.summary)}</p>
    </a>
  `).join("");
}

function renderHealth() {
  const target = document.querySelector("#healthList");
  target.innerHTML = state.dashboard.integrationHealth.map(item => `
    <article class="setup-card">
      <span class="badge ${escapeHtml(item.state)}">${escapeHtml(item.state)}</span>
      <h3>${escapeHtml(item.name)}</h3>
      <p>${escapeHtml(item.detail)}</p>
    </article>
  `).join("");
}

function renderAccessImport() {
  const target = document.querySelector("#accessImportRows");
  if (!target) return;

  const tables = state.accessImport.tables || [];
  target.innerHTML = tables.map(table => `
    <tr>
      <td>${escapeHtml(table.table)}</td>
      <td>${table.row_count === null || table.row_count === undefined ? "-" : Number(table.row_count).toLocaleString()}</td>
      <td><span class="badge">${escapeHtml(table.migration_treatment || "review")}</span></td>
    </tr>
  `).join("") || `<tr><td colspan="3">Run the Access import dry-run script to populate this section.</td></tr>`;
}

function renderShipmentSessions() {
  const target = document.querySelector("#shipmentSessionsRows");
  if (!target) return;

  const sessions = state.shipmentSessions.sessions || [];
  target.innerHTML = sessions.map(session => `
    <tr>
      <td>${escapeHtml(session.customer_account || "")}</td>
      <td>${escapeHtml(session.source_shipment_id || "")}</td>
      <td><span class="badge ${session.app_status === "closed" ? "" : "open"}">${escapeHtml(session.app_status)}</span></td>
      <td>${formatDate(session.started_at)}</td>
      <td>
        ${session.app_status === "closed"
          ? `<button class="text-button" type="button" data-reopen="${escapeHtml(session.shipment_session_id)}">Reopen</button>`
          : `<button class="text-button" type="button" data-close="${escapeHtml(session.shipment_session_id)}">Close</button>`}
      </td>
    </tr>
  `).join("") || `<tr><td colspan="5">No app-owned shipment sessions yet.</td></tr>`;
}

function renderSourceSelectors() {
  const customerSelect = document.querySelector("#customerAccountInput");
  const dispatcherSelect = document.querySelector("#dispatcherInput");

  if (customerSelect) {
    customerSelect.innerHTML = `<option value="">Select export customer</option>` + (state.exportCustomers.customers || []).map(customer => `
      <option value="${escapeHtml(customer.customerAccount)}">${escapeHtml(customer.customerAccount)} - ${escapeHtml(customer.customerName)}</option>
    `).join("");
  }

  if (dispatcherSelect) {
    dispatcherSelect.innerHTML = `<option value="">Select dispatcher</option>` + (state.dispatchers.dispatchers || []).map(dispatcher => `
      <option value="${escapeHtml(dispatcher.dispatcherId)}">${escapeHtml(dispatcher.dispatcherName)}${dispatcher.jobTitle ? ` - ${escapeHtml(dispatcher.jobTitle)}` : ""}</option>
    `).join("");
  }
}

function renderSourceShipmentItems() {
  const target = document.querySelector("#sourceShipmentItemsRows");
  if (!target) return;

  const items = state.sourceShipmentItems.items || [];
  target.innerHTML = items.map(item => `
    <tr>
      <td>${escapeHtml(item.shipmentItemId)}</td>
      <td>${escapeHtml(item.orderId || "")}</td>
      <td>${escapeHtml(item.invoiceNumber || "")}</td>
      <td>${escapeHtml(item.patientName || "")}</td>
      <td>${formatMoney(item.price)}</td>
      <td><span class="badge ${Number(item.sourceShipped) === 1 ? "" : "open"}">${Number(item.sourceShipped) === 1 ? "shipped" : "open"}</span></td>
    </tr>
  `).join("") || `<tr><td colspan="6">No source shipment items found for this customer/shipment.</td></tr>`;
}

function wireDeliveryActions() {
  document.querySelector("#startShipmentBtn")?.addEventListener("click", startShipmentSession);
  document.querySelector("#refreshShipmentsBtn")?.addEventListener("click", refreshShipmentSessions);
  document.querySelector("#preloadItemsBtn")?.addEventListener("click", preloadSourceShipmentItems);
  document.querySelector("#shipmentSessionsRows")?.addEventListener("click", async (event) => {
    const closeId = event.target.dataset.close;
    const reopenId = event.target.dataset.reopen;

    if (closeId) {
      await postJson(`/api/delivery/shipments/${closeId}/close`, {});
      await refreshShipmentSessions();
    }

    if (reopenId) {
      await postJson(`/api/delivery/shipments/${reopenId}/reopen`, {});
      await refreshShipmentSessions();
    }
  });
}

async function startShipmentSession() {
  const customerAccount = document.querySelector("#customerAccountInput").value.trim();
  const sourceShipmentId = document.querySelector("#shipmentIdInput").value.trim();
  const dispatcherId = document.querySelector("#dispatcherInput").value.trim();

  await postJson("/api/delivery/shipments", {
    sourceSystem: "mssql",
    customerAccount,
    sourceShipmentId,
    dispatcherId,
    sourceShipped: false
  });

  await refreshShipmentSessions();
}

async function preloadSourceShipmentItems() {
  const customerAccount = document.querySelector("#customerAccountInput").value.trim();
  const shipmentId = document.querySelector("#shipmentIdInput").value.trim();
  const query = new URLSearchParams({ customerAccount, shipmentId });

  state.sourceShipmentItems = await getJson(`/api/source/shipment-items?${query.toString()}`, { items: [] });
  renderSourceShipmentItems();
}

async function refreshShipmentSessions() {
  state.shipmentSessions = await getJson("/api/delivery/shipments", { sessions: [] });
  renderShipmentSessions();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(data.error || "Request failed");
  }

  return response.json();
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatMoney(value) {
  if (value === null || value === undefined || value === "") return "";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD"
  }).format(Number(value));
}

function revealModuleFromPath() {
  if (location.pathname.startsWith("/modules/delivery-export")) {
    document.querySelector("#deliveryModule")?.scrollIntoView();
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

init();
