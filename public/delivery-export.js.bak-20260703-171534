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

  const [dashboard, customers] = await Promise.all([
    getJson("/api/dashboard", { integrationHealth: [] }),
    getJson("/api/source/customers", { customers: [], error: "" })
  ]);

  moduleState.dashboard = dashboard;
  moduleState.customers = customers.customers || [];
  moduleState.customerByAccount = new Map(moduleState.customers.map((customer) => [
    String(customer.customerAccount || "").toUpperCase(),
    customer
  ]));

  renderHealth();
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
  document.querySelector("#startShipmentBtn")?.addEventListener("click", loadFilteredShipments);
  document.querySelector("#clearFiltersBtn")?.addEventListener("click", clearFilters);
  document.querySelector("#refreshShipmentsBtn")?.addEventListener("click", () => refreshShipmentSessions({ preserveSelection: true }));
  document.querySelector("#closeSelectedBtn")?.addEventListener("click", openSelectedDocumentStep);
  document.querySelector("#customerAccountInput")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    loadFilteredShipments();
  });
  document.querySelector("#shipmentIdInput")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    loadFilteredShipments();
  });
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

function renderCustomers(error) {
  const target = document.querySelector("#customerAccountOptions");
  if (!target) return;

  if (error) {
    target.innerHTML = "";
    setMessage(`Customer source error: ${error}`, true);
    return;
  }

  target.innerHTML = moduleState.customers.map((customer) => {
    const type = customer.isExportCustomer ? "Export" : "Domestic";
    return `<option value="${escapeHtml(customer.customerAccount)}">${escapeHtml(customer.customerName)} (${type})</option>`;
  }).join("");
}

function renderShipmentSessions() {
  const visible = getVisibleShipmentSessions();
  const open = visible.filter((session) => session.app_status !== "closed");
  const closed = visible.filter((session) => session.app_status === "closed");
  const filterAccount = getCustomerFilterAccount();

  setText("#openShipmentCount", String(open.length));
  setText("#closedShipmentCount", String(closed.length));
  setText("#shipmentListSummary", `${open.length} open / ${closed.length} closed${filterAccount ? ` for ${filterAccount}` : ""}`);

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
    const selected = moduleState.selectedSessionId === session.shipment_session_id;
    return `
      <article class="shipment-list-row ${selected ? "selected" : ""}" data-session-id="${id}">
        <strong>${escapeHtml(session.customer_name || session.customer_account || "Unassigned customer")}</strong>
        <span>${escapeHtml(session.customer_account || "")}</span>
        <span>${escapeHtml(session.shipping_method_name || "")}</span>
        <span class="shipment-count-cell">${Number(session.item_count || 0)}</span>
        <span>${escapeHtml(shipmentMessage(session))}</span>
        <span>${escapeHtml(session.app_status === "closed" ? formatDate(session.closed_at) : "")}</span>
        <span>${escapeHtml(session.tracking_number || "")}</span>
        <span>${escapeHtml(session.source_shipment_id || "")}</span>
        <span>${escapeHtml(session.source_shipment_batch_id || "")}</span>
        <span>${escapeHtml(session.shipment_bin || "")}</span>
      </article>`;
  }).join("") || `<p class="shipment-empty">${escapeHtml(emptyText)}</p>`;
}

function renderShipmentItems() {
  const target = document.querySelector("#shipmentItemsRows");
  if (!target) return;
  const session = getSelectedSession();

  target.innerHTML = moduleState.shipmentItems.map((item) => `
    <tr>
      <td>${escapeHtml(item.orderId || "")}</td>
      <td>${escapeHtml(item.orderType || "Rx")}</td>
      <td>${escapeHtml(item.invoiceNumber || item.shipmentItemId || "")}</td>
      <td>${escapeHtml(item.shipmentId || session?.source_shipment_id || "")}</td>
      <td>${escapeHtml(item.customerAccount || session?.customer_account || "")}</td>
      <td>${escapeHtml(item.patientName || "")}</td>
      <td>${escapeHtml(formatDate(item.createdAt))}</td>
    </tr>
  `).join("") || `<tr><td colspan="7">No jobs found for the selected shipment.</td></tr>`;
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

function clearFilters() {
  const customerInput = document.querySelector("#customerAccountInput");
  const shipmentIdInput = document.querySelector("#shipmentIdInput");
  if (customerInput) customerInput.value = "";
  if (shipmentIdInput) shipmentIdInput.value = "";
  setDefaultDateRange();
  refreshShipmentSessions({ preserveSelection: false });
  setMessage("Filters cleared.");
}

async function loadFilteredShipments() {
  const visible = getVisibleShipmentSessions();
  if (!visible.length) {
    setMessage("No shipments match the current filters.", true);
    return;
  }
  if (!getSessionById(moduleState.selectedSessionId) || !visible.some((session) => session.shipment_session_id === moduleState.selectedSessionId)) {
    moduleState.selectedSessionId = visible[0].shipment_session_id;
  }
  renderShipmentSessions();
  await loadSelectedShipmentItems();
  const account = getCustomerFilterAccount();
  const shipmentId = getShipmentIdFilter();
  const scope = [account && `account ${account}`, shipmentId && `shipment ${shipmentId}`].filter(Boolean).join(", ");
  setMessage(`Loaded ${visible.length} shipment${visible.length === 1 ? "" : "s"}${scope ? ` for ${scope}` : ""}.`);
}

async function refreshShipmentSessions(options = {}) {
  const query = new URLSearchParams({
    fromDate: document.querySelector("#fromDateInput")?.value || "",
    toDate: document.querySelector("#toDateInput")?.value || ""
  });
  const data = await getJson(`/api/delivery/shipments?${query.toString()}`, { sessions: [] });
  moduleState.shipmentSessions = (data.sessions || []).map(enrichSessionFromCustomerList);
  moduleState.selectedDomesticIds.clear();

  const visible = getVisibleShipmentSessions();
  if (!options.preserveSelection || !visible.some((session) => session.shipment_session_id === moduleState.selectedSessionId)) {
    moduleState.selectedSessionId = visible[0]?.shipment_session_id || "";
  }

  renderShipmentSessions();
  await loadSelectedShipmentItems({ skipCoDraft: Boolean(options.silent) });
}

async function selectShipmentSession(sessionId) {
  moduleState.selectedSessionId = sessionId;
  const session = getSelectedSession();
  const customerInput = document.querySelector("#customerAccountInput");
  if (session && customerInput && !customerInput.value) {
    customerInput.value = session.customer_account || "";
  }
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

async function openSelectedDocumentStep() {
  const session = getSelectedSession();
  if (!session) {
    setMessage("Select a shipment before preparing the next document step.", true);
    return;
  }
  if (isExportSession(session)) {
    activateTab("commercialInvoice");
    await loadCoDraft();
    setMessage("Commercial invoice and certificate workspace opened.");
    return;
  }
  activateTab("deliveryChecklist");
  setText("#deliveryChecklistSummary", `${session.customer_account || "Domestic shipment"} ${session.source_shipment_id || ""}`.trim());
  setMessage("Delivery checklist opened.");
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
  const session = getSelectedSession();
  button.disabled = !session;
  button.textContent = session && !isExportSession(session) ? "Prepare delivery checklist" : "Prepare certificate/invoice";
}

function updateCommercialInvoiceAvailability() {
  const tab = document.querySelector("#commercialInvoiceTab");
  if (!tab) return;
  const session = getSelectedSession();
  const enabled = Boolean(session && isExportSession(session));
  tab.disabled = !enabled;
  tab.title = enabled ? "" : "Commercial invoices are only available after selecting an export shipment.";
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
    shipment_bin: session.shipment_bin || customer?.shipmentBin || "",
    is_export_customer: Boolean(session.is_export_customer || customer?.isExportCustomer)
  };
}

function getSelectedSession() {
  return getSessionById(moduleState.selectedSessionId);
}

function getSessionById(id) {
  return moduleState.shipmentSessions.find((session) => session.shipment_session_id === id) || null;
}

function getVisibleShipmentSessions() {
  const account = getCustomerFilterAccount();
  const shipmentId = getShipmentIdFilter();
  return moduleState.shipmentSessions.filter((session) => {
    if (account && String(session.customer_account || "").toUpperCase() !== account.toUpperCase()) return false;
    if (shipmentId && String(session.source_shipment_id || "") !== shipmentId) return false;
    return true;
  });
}

function getCustomerFilterAccount() {
  return document.querySelector("#customerAccountInput")?.value.trim() || "";
}

function getShipmentIdFilter() {
  return document.querySelector("#shipmentIdInput")?.value.trim() || "";
}

function getSelectedCustomer() {
  const account = document.querySelector("#customerAccountInput")?.value || "";
  return moduleState.customerByAccount.get(String(account).toUpperCase()) || null;
}

function isExportSession(session) {
  return Boolean(session?.is_export_customer);
}

function shipmentMessage(session) {
  if (!session) return "";
  return session.source_result_message || session.notes || (session.app_status === "closed" ? "Shipped" : "");
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
