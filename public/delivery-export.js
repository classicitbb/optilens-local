const POLL_INTERVAL_MS = 30000;

const moduleState = {
  dispatchers: [],
  customers: [],
  customerByAccount: new Map(),
  shipmentSessions: [],
  shipmentItems: [],
  coApplication: null,
  coJobs: [],
  selectedSessionId: "",
  selectedDomesticIds: new Set(),
  dashboard: null,
  pollingId: null
};

initModule();

async function initModule() {
  setDefaultDateRange();
  wireTabs();
  wireActions();

  const [dashboard, dispatchers, customers] = await Promise.all([
    getJson("/api/dashboard", { integrationHealth: [] }),
    getJson("/api/source/dispatchers", { dispatchers: [], error: "" }),
    getJson("/api/source/customers", { customers: [], error: "" })
  ]);

  moduleState.dashboard = dashboard;
  moduleState.dispatchers = dispatchers.dispatchers || [];
  moduleState.customers = customers.customers || [];
  moduleState.customerByAccount = new Map(moduleState.customers.map((customer) => [
    String(customer.customerAccount || "").toUpperCase(),
    customer
  ]));

  renderHealth();
  renderDispatchers(dispatchers.error);
  renderCustomers(customers.error);
  await refreshShipmentSessions({ preserveSelection: true });
  startPolling();
}

function wireTabs() {
  document.querySelectorAll(".workflow-tabs button[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      activateTab(button.dataset.tab);
    });
  });
}

function wireActions() {
  document.querySelector("#startShipmentBtn")?.addEventListener("click", startShipmentSession);
  document.querySelector("#refreshShipmentsBtn")?.addEventListener("click", () => refreshShipmentSessions({ preserveSelection: true }));
  document.querySelector("#closeSelectedBtn")?.addEventListener("click", closeSelectedDomesticShipments);
  document.querySelector("#customerAccountInput")?.addEventListener("change", handleCustomerChange);
  document.querySelector("#fromDateInput")?.addEventListener("change", () => refreshShipmentSessions({ preserveSelection: false }));
  document.querySelector("#toDateInput")?.addEventListener("change", () => refreshShipmentSessions({ preserveSelection: false }));
  document.querySelector("#addRowsBtn")?.addEventListener("click", openAddRowsModal);
  document.querySelector("#addRowsClose")?.addEventListener("click", closeAddRowsModal);
  document.querySelector("#addRowsModal")?.addEventListener("click", (event) => {
    if (event.target.id === "addRowsModal") closeAddRowsModal();
  });
  document.querySelector("#addRowsForm")?.addEventListener("submit", submitAddRow);
  document.querySelector("#prepareCoBtn")?.addEventListener("click", prepareCoDraft);
  document.querySelector("#saveCoDraftBtn")?.addEventListener("click", saveCoDraft);
  document.querySelector("#queueCoJobBtn")?.addEventListener("click", queueCoJob);

  document.querySelector("#shipmentGroups")?.addEventListener("click", (event) => {
    const checkbox = event.target.closest("[data-select-domestic]");
    if (checkbox) {
      toggleDomesticSelection(checkbox.dataset.selectDomestic, checkbox.checked);
      return;
    }

    const row = event.target.closest("[data-session-id]");
    if (row) selectShipmentSession(row.dataset.sessionId);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPolling();
    } else {
      startPolling();
      refreshShipmentSessions({ preserveSelection: true });
    }
  });
}

function activateTab(tabId) {
  document.querySelectorAll(".workflow-tabs button[data-tab]").forEach((item) => {
    item.classList.toggle("active", item.dataset.tab === tabId);
  });
  document.querySelectorAll(".workflow-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === tabId);
  });
  if (tabId === "commercialInvoice") loadCoDraft();
}

function setDefaultDateRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 7);
  const fromInput = document.querySelector("#fromDateInput");
  const toInput = document.querySelector("#toDateInput");
  if (fromInput) fromInput.value = toDateInputValue(from);
  if (toInput) toInput.value = toDateInputValue(to);
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

  target.innerHTML = `<option value="">Select customer</option>` + moduleState.customers.map((customer) => {
    const type = customer.isExportCustomer ? "Export" : "Domestic";
    return `
      <option value="${escapeHtml(customer.customerAccount)}" data-export="${customer.isExportCustomer ? "1" : "0"}">
        ${escapeHtml(customer.customerAccount)} - ${escapeHtml(customer.customerName)} (${type})
      </option>`;
  }).join("");
}

function renderShipmentSessions() {
  const open = moduleState.shipmentSessions.filter((session) => session.app_status !== "closed");
  const closed = moduleState.shipmentSessions.filter((session) => session.app_status === "closed");

  setText("#openShipmentCount", String(open.length));
  setText("#closedShipmentCount", String(closed.length));
  setText("#shipmentListSummary", `${open.length} open / ${closed.length} closed`);

  renderShipmentRows("#openShipmentRows", open, "No open shipments.");
  renderShipmentRows("#closedShipmentRows", closed, "No closed shipments in this close-date range.");
  updateCloseSelectedState();
  updateCommercialInvoiceAvailability();
}

function renderShipmentRows(selector, sessions, emptyText) {
  const target = document.querySelector(selector);
  if (!target) return;

  target.innerHTML = sessions.map((session) => {
    const id = escapeHtml(session.shipment_session_id);
    const isOpenDomestic = isDomesticClosable(session);
    const selected = moduleState.selectedSessionId === session.shipment_session_id;
    return `
      <article class="shipment-list-row ${selected ? "selected" : ""}" data-session-id="${id}">
        <div class="shipment-row-select">
          ${isOpenDomestic
            ? `<input type="checkbox" aria-label="Select domestic shipment ${escapeHtml(session.customer_account || "")}" data-select-domestic="${id}" ${moduleState.selectedDomesticIds.has(session.shipment_session_id) ? "checked" : ""}>`
            : ""}
        </div>
        <div class="shipment-row-main">
          <strong>${escapeHtml(session.customer_name || session.customer_account || "Unassigned customer")}</strong>
          <span>${escapeHtml(session.customer_account || "")}${session.source_shipment_id ? ` · Shipment ${escapeHtml(session.source_shipment_id)}` : ""}</span>
          <small>${formatDate(session.closed_at || session.started_at)}</small>
        </div>
        <div class="shipment-row-meta">
          <span class="badge ${session.app_status === "closed" ? "" : "open"}">${escapeHtml(session.app_status || "prep")}</span>
          <span>${Number(session.item_count || 0)} items</span>
          <span>${isExportSession(session) ? "Export" : "Domestic"}</span>
        </div>
      </article>`;
  }).join("") || `<p class="shipment-empty">${escapeHtml(emptyText)}</p>`;
}

function renderShipmentItems() {
  const target = document.querySelector("#shipmentItemsRows");
  if (!target) return;

  target.innerHTML = moduleState.shipmentItems.map((item) => `
    <tr>
      <td>${escapeHtml(item.orderId || "")}</td>
      <td>${escapeHtml(item.invoiceNumber || "")}</td>
      <td>${escapeHtml(item.patientName || "")}</td>
      <td>${formatMoney(item.price)}</td>
      <td><span class="badge">${escapeHtml(item.origin || "app")}</span></td>
      <td><span class="badge ${item.itemState === "shipped" ? "" : "open"}">${escapeHtml(item.itemState || "prep")}</span></td>
    </tr>
  `).join("") || `<tr><td colspan="6">No jobs found for the selected shipment.</td></tr>`;
}

function renderCoDraft() {
  const app = moduleState.coApplication;
  const payload = app?.editable || null;
  const hasDraft = Boolean(app && payload);
  const session = getSelectedSession();

  setText("#coDraftSummary", hasDraft
    ? `Draft ${app.status || "draft"} · Shipment ${payload.shipmentId || session?.source_shipment_id || ""}`
    : session
      ? "No BeSwift draft for this shipment yet."
      : "Select an export shipment, then prepare a draft.");

  const saveBtn = document.querySelector("#saveCoDraftBtn");
  const queueBtn = document.querySelector("#queueCoJobBtn");
  if (saveBtn) saveBtn.disabled = !hasDraft;
  if (queueBtn) queueBtn.disabled = !hasDraft;

  if (!hasDraft) {
    fillCoForm({});
    renderCoHeaderPreview(null);
    renderCoItems([]);
    renderCoWarnings([]);
    renderCoJobs();
    return;
  }

  fillCoForm({
    portalEnvironment: app.portalEnvironment || "training",
    trackingNumber: payload.transport?.trackingNumber || "",
    shippingDate: payload.transport?.shippingDate || "",
    boxCode: payload.packaging?.box || "DHL-FLYER",
    packageCount: payload.packaging?.numberOfPackages || 1,
    actualGrossKg: payload.packaging?.actualGrossKg || "",
    cubeQuantity: payload.invoiceDetails?.cubeQuantity || "",
    shippingMarks: payload.transport?.shippingMarks || "",
    freightCost: payload.invoiceDetails?.freightCost || 0,
    packingCost: payload.invoiceDetails?.packingCost || 0,
    insuranceCost: payload.invoiceDetails?.insuranceCost || 0,
    otherCost: payload.invoiceDetails?.otherCost || 0,
    deliveryTerms: payload.transport?.deliveryTerms || "",
    originNotes: payload.origin?.notes || ""
  });
  renderCoHeaderPreview(payload);
  renderCoItems(payload.items || []);
  renderCoWarnings(app.warnings || []);
  renderCoJobs();
}

function fillCoForm(values) {
  const pairs = {
    coPortalEnvironment: values.portalEnvironment || "training",
    coTrackingNumber: values.trackingNumber || "",
    coShippingDate: values.shippingDate || "",
    coBoxCode: values.boxCode || "DHL-FLYER",
    coPackageCount: values.packageCount || "",
    coActualGrossKg: values.actualGrossKg || "",
    coCubeQuantity: values.cubeQuantity || "",
    coShippingMarks: values.shippingMarks || "",
    coFreightCost: values.freightCost ?? "",
    coPackingCost: values.packingCost ?? "",
    coInsuranceCost: values.insuranceCost ?? "",
    coOtherCost: values.otherCost ?? "",
    coDeliveryTerms: values.deliveryTerms || "",
    coOriginNotes: values.originNotes || ""
  };
  for (const [id, value] of Object.entries(pairs)) {
    const input = document.querySelector(`#${id}`);
    if (input) input.value = value;
  }
}

function renderCoHeaderPreview(payload) {
  const target = document.querySelector("#coHeaderPreview");
  if (!target) return;
  if (!payload) {
    target.innerHTML = "<p>Select an export shipment and prepare a draft.</p>";
    return;
  }
  const entries = [
    ["Importer", payload.importer?.name],
    ["Company", payload.importer?.company],
    ["Country", payload.importer?.country],
    ["Address", payload.importer?.address],
    ["Contact", [payload.importer?.phone, payload.importer?.email].filter(Boolean).join(" · ")],
    ["Invoices", payload.invoiceDetails?.invoiceNumbers],
    ["Invoice date", payload.invoiceDetails?.invoiceDate],
    ["Order refs", payload.invoiceDetails?.customerOrderNo],
    ["Carrier", payload.transport?.carrier],
    ["Discharge port", payload.transport?.portOfDischarge]
  ];
  target.innerHTML = entries.map(([label, value]) => `
    <div class="co-preview-field">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "")}</strong>
    </div>
  `).join("");
}

function renderCoItems(items) {
  const target = document.querySelector("#coItemsRows");
  if (!target) return;
  target.innerHTML = items.map((item, index) => `
    <tr data-co-item="${index}">
      <td><input data-co-field="hsCode" value="${escapeHtml(item.hsCode || "")}" aria-label="Item ${index + 1} HS code"></td>
      <td><input data-co-field="commercialDescription" value="${escapeHtml(item.commercialDescription || "")}" aria-label="Item ${index + 1} description"></td>
      <td><input data-co-field="quantity" type="number" min="0" step="1" value="${escapeHtml(item.quantity ?? "")}" aria-label="Item ${index + 1} quantity"></td>
      <td><input data-co-field="weightKg" type="number" min="0" step="0.001" value="${escapeHtml(item.weightKg ?? "")}" aria-label="Item ${index + 1} weight"></td>
      <td><input data-co-field="unitCost" type="number" min="0" step="0.01" value="${escapeHtml(item.unitCost ?? "")}" aria-label="Item ${index + 1} unit cost"></td>
      <td>${formatMoneyBbd(item.value)}</td>
    </tr>
  `).join("") || `<tr><td colspan="6">Prepare a draft to load certificate items.</td></tr>`;
}

function renderCoWarnings(warnings) {
  const target = document.querySelector("#coWarnings");
  if (!target) return;
  target.hidden = !warnings.length;
  target.innerHTML = warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join("");
}

function renderCoJobs() {
  const target = document.querySelector("#coJobList");
  if (!target) return;
  const jobs = moduleState.coJobs || [];
  target.innerHTML = jobs.map((job) => `
    <article class="co-job-row">
      <div>
        <strong>${escapeHtml(job.status || "queued")}</strong>
        <span>${escapeHtml(formatDate(job.createdAt))}</span>
      </div>
      <code>${escapeHtml(job.claimCode || "")}</code>
      ${job.errorMessage ? `<p>${escapeHtml(job.errorMessage)}</p>` : ""}
    </article>
  `).join("") || `<p class="shipment-empty">No queued jobs for this draft.</p>`;
}

function handleCustomerChange() {
  moduleState.selectedSessionId = "";
  moduleState.shipmentItems = [];
  renderShipmentSessions();
  loadSelectedShipmentItems();
}

async function startShipmentSession() {
  const customerAccount = document.querySelector("#customerAccountInput").value.trim();
  const sourceShipmentId = document.querySelector("#shipmentIdInput").value.trim();
  const dispatcherId = document.querySelector("#dispatcherInput").value.trim();

  if (!customerAccount) {
    setMessage("Select a customer before starting a shipment.", true);
    return;
  }

  const data = await postJson("/api/delivery/shipments", {
    sourceSystem: "mssql",
    customerAccount,
    sourceShipmentId,
    dispatcherId,
    sourceShipped: false
  }).catch((error) => {
    setMessage(error.message, true);
    return null;
  });
  if (!data) return;

  moduleState.selectedSessionId = data.session.shipment_session_id;
  await refreshShipmentSessions({ preserveSelection: true });
  setMessage("Shipment started.");
}

async function refreshShipmentSessions(options = {}) {
  const query = new URLSearchParams({
    fromDate: document.querySelector("#fromDateInput")?.value || "",
    toDate: document.querySelector("#toDateInput")?.value || ""
  });
  const data = await getJson(`/api/delivery/shipments?${query.toString()}`, { sessions: [] });
  moduleState.shipmentSessions = (data.sessions || []).map(enrichSessionFromCustomerList);
  moduleState.selectedDomesticIds = new Set([...moduleState.selectedDomesticIds].filter((id) => {
    const session = getSessionById(id);
    return session && isDomesticClosable(session);
  }));

  if (!options.preserveSelection || !getSessionById(moduleState.selectedSessionId)) {
    moduleState.selectedSessionId = moduleState.shipmentSessions[0]?.shipment_session_id || "";
  }

  renderShipmentSessions();
  await loadSelectedShipmentItems({ skipCoDraft: Boolean(options.silent) });
}

async function selectShipmentSession(sessionId) {
  moduleState.selectedSessionId = sessionId;
  renderShipmentSessions();
  await loadSelectedShipmentItems();
}

async function loadSelectedShipmentItems(options = {}) {
  const session = getSelectedSession();
  const addRowsBtn = document.querySelector("#addRowsBtn");

  if (!session) {
    moduleState.shipmentItems = [];
    moduleState.coApplication = null;
    moduleState.coJobs = [];
    setText("#selectedShipmentTitle", "Select a shipment");
    setText("#selectedShipmentMeta", "Choose an open or closed shipment to review jobs.");
    if (addRowsBtn) addRowsBtn.hidden = true;
    renderShipmentItems();
    updateCommercialInvoiceAvailability();
    renderCoDraft();
    return;
  }

  setText("#selectedShipmentTitle", `${session.customer_account || "Shipment"} ${session.source_shipment_id || ""}`.trim());
  setText("#selectedShipmentMeta", `${isExportSession(session) ? "Export" : "Domestic"} · ${session.app_status || "prep"} · ${Number(session.item_count || 0)} counted items`);
  if (addRowsBtn) addRowsBtn.hidden = !(isExportSession(session) && session.app_status !== "closed");

  const data = await getJson(`/api/delivery/shipments/${encodeURIComponent(session.shipment_session_id)}/items`, { items: [] });
  moduleState.shipmentItems = data.items || [];
  renderShipmentItems();
  updateCommercialInvoiceAvailability();
  if (!options.skipCoDraft) await loadCoDraft();
}

async function loadCoDraft() {
  const session = getSelectedSession();
  if (!session || !isExportSession(session)) {
    moduleState.coApplication = null;
    moduleState.coJobs = [];
    renderCoDraft();
    return;
  }

  const data = await getJson(`/api/delivery/shipments/${encodeURIComponent(session.shipment_session_id)}/commercial-invoice/co`, { application: null, jobs: [] });
  moduleState.coApplication = data.application || null;
  moduleState.coJobs = data.jobs || [];
  renderCoDraft();
}

async function prepareCoDraft() {
  const session = getSelectedSession();
  if (!session) {
    setCoMessage("Select an export shipment before preparing a BeSwift draft.", true);
    return;
  }
  const data = await postJson(`/api/delivery/shipments/${encodeURIComponent(session.shipment_session_id)}/commercial-invoice/co`, readCoDraftForm()).catch((error) => {
    setCoMessage(error.message, true);
    return null;
  });
  if (!data) return;
  moduleState.coApplication = data.application;
  moduleState.coJobs = [];
  renderCoDraft();
  setCoMessage("BeSwift draft prepared from Innovations.");
}

async function saveCoDraft() {
  const app = moduleState.coApplication;
  if (!app) return;
  const data = await putJson(`/api/delivery/co-applications/${encodeURIComponent(app.coApplicationId)}/draft`, readCoDraftForm()).catch((error) => {
    setCoMessage(error.message, true);
    return null;
  });
  if (!data) return;
  moduleState.coApplication = data.application;
  renderCoDraft();
  setCoMessage("Draft saved.");
}

async function queueCoJob() {
  const app = moduleState.coApplication;
  if (!app) return;
  await saveCoDraft();
  const current = moduleState.coApplication;
  const data = await postJson(`/api/delivery/co-applications/${encodeURIComponent(current.coApplicationId)}/automation-jobs`, {}).catch((error) => {
    setCoMessage(error.message, true);
    return null;
  });
  if (!data) return;
  moduleState.coJobs = [data.job, ...moduleState.coJobs];
  renderCoJobs();
  setCoMessage(`Fill job queued. Claim code: ${data.job.claimCode}`);
}

function readCoDraftForm() {
  return {
    portalEnvironment: valueOf("#coPortalEnvironment") || "training",
    trackingNumber: valueOf("#coTrackingNumber"),
    shippingDate: valueOf("#coShippingDate"),
    boxCode: valueOf("#coBoxCode"),
    packageCount: valueOf("#coPackageCount"),
    actualGrossKg: valueOf("#coActualGrossKg"),
    cubeQuantity: valueOf("#coCubeQuantity"),
    shippingMarks: valueOf("#coShippingMarks"),
    freightCost: valueOf("#coFreightCost"),
    packingCost: valueOf("#coPackingCost"),
    insuranceCost: valueOf("#coInsuranceCost"),
    otherCost: valueOf("#coOtherCost"),
    deliveryTerms: valueOf("#coDeliveryTerms"),
    originNotes: valueOf("#coOriginNotes"),
    items: readCoItems()
  };
}

function readCoItems() {
  return [...document.querySelectorAll("[data-co-item]")].map((row) => {
    const item = {};
    row.querySelectorAll("[data-co-field]").forEach((input) => {
      item[input.dataset.coField] = input.value;
    });
    return item;
  });
}

async function closeSelectedDomesticShipments() {
  const sessionIds = [...moduleState.selectedDomesticIds];
  const dispatcherId = document.querySelector("#dispatcherInput").value.trim();

  if (!sessionIds.length) {
    setMessage("Select at least one open domestic shipment.", true);
    return;
  }
  if (!dispatcherId) {
    setMessage("Select a dispatcher before closing domestic shipments.", true);
    return;
  }

  const data = await postJson("/api/delivery/shipments/close-batch", { sessionIds, dispatcherId }).catch((error) => {
    setMessage(error.message, true);
    return null;
  });
  if (!data) return;

  moduleState.selectedDomesticIds.clear();
  await refreshShipmentSessions({ preserveSelection: true });
  setMessage(`Closed ${data.sessions.length} domestic shipment${data.sessions.length === 1 ? "" : "s"}.`);
}

function toggleDomesticSelection(sessionId, isSelected) {
  if (isSelected) {
    moduleState.selectedDomesticIds.add(sessionId);
  } else {
    moduleState.selectedDomesticIds.delete(sessionId);
  }
  updateCloseSelectedState();
}

function updateCloseSelectedState() {
  const button = document.querySelector("#closeSelectedBtn");
  if (!button) return;
  const count = moduleState.selectedDomesticIds.size;
  button.disabled = count === 0;
  button.textContent = count ? `Close selected domestic (${count})` : "Close selected domestic";
}

function updateCommercialInvoiceAvailability() {
  const tab = document.querySelector("#commercialInvoiceTab");
  if (!tab) return;
  const session = getSelectedSession();
  const customer = getSelectedCustomer();
  const enabled = session ? isExportSession(session) : Boolean(customer?.isExportCustomer);
  tab.disabled = !enabled;
  tab.title = enabled ? "" : "Commercial invoices are only available for export customers.";
  if (!enabled && tab.classList.contains("active")) activateTab("shipmentPrep");
}

function openAddRowsModal() {
  const modal = document.querySelector("#addRowsModal");
  const input = document.querySelector("#addRowsInvoiceInput");
  const error = document.querySelector("#addRowsError");
  if (!modal) return;
  if (error) error.textContent = "";
  if (input) input.value = "";
  modal.hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => input?.focus(), 0);
}

function closeAddRowsModal() {
  const modal = document.querySelector("#addRowsModal");
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = "";
}

async function submitAddRow(event) {
  event.preventDefault();
  const input = document.querySelector("#addRowsInvoiceInput");
  const error = document.querySelector("#addRowsError");
  const submit = document.querySelector("#addRowsSubmit");
  const session = getSelectedSession();
  if (!session) return;

  if (submit) submit.disabled = true;
  if (error) error.textContent = "";

  const data = await postJson(`/api/delivery/shipments/${encodeURIComponent(session.shipment_session_id)}/items`, {
    invoiceNumber: input?.value.trim() || ""
  }).catch((err) => {
    if (error) error.textContent = err.message;
    return null;
  });

  if (submit) submit.disabled = false;
  if (!data) return;

  moduleState.shipmentItems = data.items || [];
  renderShipmentItems();
  closeAddRowsModal();
  await refreshShipmentSessions({ preserveSelection: true });
  setMessage("Invoice row added.");
}

function startPolling() {
  if (moduleState.pollingId || document.hidden) return;
  moduleState.pollingId = setInterval(() => {
    refreshShipmentSessions({ preserveSelection: true, silent: true });
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (!moduleState.pollingId) return;
  clearInterval(moduleState.pollingId);
  moduleState.pollingId = null;
}

function enrichSessionFromCustomerList(session) {
  const customer = moduleState.customerByAccount.get(String(session.customer_account || "").toUpperCase());
  return {
    ...session,
    customer_name: session.customer_name || customer?.customerName || "",
    shipping_method_id: session.shipping_method_id ?? customer?.shippingMethodId ?? null,
    is_export_customer: Boolean(session.is_export_customer || customer?.isExportCustomer)
  };
}

function getSelectedSession() {
  return getSessionById(moduleState.selectedSessionId);
}

function getSessionById(id) {
  return moduleState.shipmentSessions.find((session) => session.shipment_session_id === id) || null;
}

function getSelectedCustomer() {
  const account = document.querySelector("#customerAccountInput")?.value || "";
  return moduleState.customerByAccount.get(String(account).toUpperCase()) || null;
}

function isExportSession(session) {
  return Boolean(session?.is_export_customer);
}

function isDomesticClosable(session) {
  return Boolean(session && session.app_status !== "closed" && session.shipping_method_id !== null && !isExportSession(session));
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

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function setMessage(message, isError = false) {
  const target = document.querySelector("#shipmentPrepMessage");
  if (!target) return;
  target.textContent = message || "";
  target.classList.toggle("error", Boolean(isError));
}

function setCoMessage(message, isError = false) {
  const target = document.querySelector("#coMessage");
  if (!target) return;
  target.textContent = message || "";
  target.classList.toggle("error", Boolean(isError));
}

function setText(selector, value) {
  const target = document.querySelector(selector);
  if (target) target.textContent = value;
}

function toDateInputValue(date) {
  return date.toISOString().slice(0, 10);
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

function formatMoneyBbd(value) {
  if (value === null || value === undefined || value === "") return "";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "BBD"
  }).format(Number(value));
}

function valueOf(selector) {
  return document.querySelector(selector)?.value.trim() || "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
