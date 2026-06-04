const moduleState = {
  dispatchers: [],
  customers: [],
  sourceShipmentItems: [],
  shipmentSessions: [],
  dashboard: null
};

initModule();

async function initModule() {
  wireTabs();
  wireActions();

  const [dashboard, dispatchers, customers, sessions] = await Promise.all([
    getJson("/api/dashboard", { integrationHealth: [] }),
    getJson("/api/source/dispatchers", { dispatchers: [], error: "" }),
    getJson("/api/source/export-customers", { customers: [], error: "" }),
    getJson("/api/delivery/shipments", { sessions: [], error: "" })
  ]);

  moduleState.dashboard = dashboard;
  moduleState.dispatchers = dispatchers.dispatchers || [];
  moduleState.customers = customers.customers || [];
  moduleState.shipmentSessions = sessions.sessions || [];

  renderHealth();
  renderDispatchers(dispatchers.error);
  renderCustomers(customers.error);
  renderShipmentSessions();
}

function wireTabs() {
  document.querySelectorAll(".workflow-tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      const tabId = button.dataset.tab;
      document.querySelectorAll(".workflow-tabs button").forEach((item) => item.classList.toggle("active", item === button));
      document.querySelectorAll(".workflow-panel").forEach((panel) => panel.classList.toggle("active", panel.id === tabId));
    });
  });
}

function wireActions() {
  document.querySelector("#startShipmentBtn")?.addEventListener("click", startShipmentSession);
  document.querySelector("#preloadItemsBtn")?.addEventListener("click", preloadSourceShipmentItems);
  document.querySelector("#refreshShipmentsBtn")?.addEventListener("click", refreshShipmentSessions);

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

function renderHealth() {
  const target = document.querySelector("#healthList");
  if (!target) return;

  target.innerHTML = (moduleState.dashboard.integrationHealth || []).map((item) => `
    <article class="setup-card">
      <span class="badge ${escapeHtml(item.state)}">${escapeHtml(item.state)}</span>
      <h3>${escapeHtml(item.name)}</h3>
      <p>${escapeHtml(item.detail)}</p>
    </article>
  `).join("");
}

function renderDispatchers(error) {
  const target = document.querySelector("#dispatcherInput");
  if (!target) return;

  if (error) {
    target.innerHTML = `<option value="">Source error: ${escapeHtml(error)}</option>`;
    return;
  }

  target.innerHTML = `<option value="">Select dispatcher</option>` + moduleState.dispatchers.map((dispatcher) => `
    <option value="${escapeHtml(dispatcher.dispatcherId)}">${escapeHtml(dispatcher.dispatcherName)}${dispatcher.jobTitle ? ` - ${escapeHtml(dispatcher.jobTitle)}` : ""}</option>
  `).join("");
}

function renderCustomers(error) {
  const target = document.querySelector("#customerAccountInput");
  if (!target) return;

  if (error) {
    target.innerHTML = `<option value="">Source error: ${escapeHtml(error)}</option>`;
    return;
  }

  target.innerHTML = `<option value="">Select export customer</option>` + moduleState.customers.map((customer) => `
    <option value="${escapeHtml(customer.customerAccount)}">${escapeHtml(customer.customerAccount)} - ${escapeHtml(customer.customerName)}</option>
  `).join("");
}

function renderShipmentSessions() {
  const target = document.querySelector("#shipmentSessionsRows");
  if (!target) return;

  target.innerHTML = moduleState.shipmentSessions.map((session) => `
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

function renderSourceShipmentItems() {
  const target = document.querySelector("#sourceShipmentItemsRows");
  if (!target) return;

  target.innerHTML = moduleState.sourceShipmentItems.map((item) => `
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
  const data = await getJson(`/api/source/shipment-items?${query.toString()}`, { items: [] });

  moduleState.sourceShipmentItems = data.items || [];
  renderSourceShipmentItems();
}

async function refreshShipmentSessions() {
  const data = await getJson("/api/delivery/shipments", { sessions: [] });
  moduleState.shipmentSessions = data.sessions || [];
  renderShipmentSessions();
}

async function getJson(url, fallback) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();
    return response.ok ? data : { ...fallback, error: data.error || "Request failed" };
  } catch (error) {
    return { ...fallback, error: error.message };
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
