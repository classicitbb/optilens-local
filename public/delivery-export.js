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
  pollingId: null,
  customerParams: null,
  customerParamsAccount: "",
  invoicePreview: null,
  coAutosaveTimer: null,
  coAutosaveInFlight: false,
  coAutosaveQueued: false
};

initModule();

async function initModule() {
  setDefaultDateRange();
  wireTabs();
  wireActions();
  wireShipmentDivider();

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
  document.querySelector("#deliverySettingsBtn")?.addEventListener("click", openDeliverySettings);
  document.querySelector("#deliverySettingsClose")?.addEventListener("click", closeDeliverySettings);
  document.querySelector("#deliverySettingsModal")?.addEventListener("click", (event) => {
    if (event.target.id === "deliverySettingsModal") closeDeliverySettings();
  });
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    button.addEventListener("click", () => activateSettingsTab(button.dataset.settingsTab));
  });
  document.querySelector("#closeSelectedBtn")?.addEventListener("click", openSelectedDocumentStep);
  document.querySelector("#customerAccountInput")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    loadFilteredShipments();
  });
  document.querySelector("#customerAccountInput")?.addEventListener("input", (event) => {
    // A datalist selection raises `input` immediately. Only react to an exact
    // account match so normal typing does not repeatedly reload the list.
    if (moduleState.customerByAccount.has(String(event.target.value || "").trim().toUpperCase())) {
      loadFilteredShipments();
    }
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
  document.querySelector("#saveCustomerParamsBtn")?.addEventListener("click", saveCustomerParams);
  document.querySelector("#saveItemDefaultsBtn")?.addEventListener("click", saveItemDefaults);
  document.querySelector("#printCommercialInvoiceBtn")?.addEventListener("click", printCommercialInvoice);
  wireCommercialInvoiceHeaderEditing();
  wireCommercialInvoiceLineEditing();
  wireCoDraftAutosave();

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
      <td>${escapeHtml(item.rxNumber || item.invoiceNumber || item.shipmentItemId || "")}</td>
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
  if (saveBtn) saveBtn.disabled = !(hasDraft || moduleState.invoicePreview);
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
    portalEnvironment: app.portalEnvironment || "production",
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
  renderCoItems(payload.items || [], payload);
  renderCoWarnings(app.warnings || []);
  renderCoJobs();
}

function fillCoForm(values) {
  const pairs = {
    coPortalEnvironment: values.portalEnvironment || "production",
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
    ["Customer order no", payload.invoiceDetails?.customerOrderNo],
    ["Presenting bank", payload.invoiceDetails?.presentingBank],
    ["Carrier", payload.transport?.carrier],
    ["Ship date", payload.transport?.shippingDate],
    ["Discharge port", payload.transport?.portOfDischarge],
    ["Delivery terms", payload.transport?.deliveryTerms],
    ["Bank", [payload.bank?.name, payload.bank?.accountNumber].filter(Boolean).join(" \u00b7 ")]
  ];
  target.innerHTML = entries.map(([label, value]) => `
    <div class="co-preview-field">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "")}</strong>
    </div>
  `).join("");
}

function renderCoItems(items, payload = {}) {
  const target = document.querySelector("#coItemsRows");
  if (!target) return;
  const rows = items.map((item, index) => `
    <tr data-co-item="${index}">
      <td class="co-item-name" title="${escapeHtml(item.name || "")}">${escapeHtml(item.name || "")}</td>
      <td>${escapeHtml(item.hsCode || "")}</td>
      <td title="${escapeHtml(item.commercialDescription || item.name || "")}">${escapeHtml(item.commercialDescription || item.name || "")}</td>
      <td>${escapeHtml(item.quantity ?? "")}</td>
      <td>${escapeHtml(item.uom || "")}</td>
      <td>${escapeHtml(item.weightKg ?? "")}</td>
      <td>${escapeHtml(item.countryOfOrigin || "")}</td>
      <td>${formatMoneyBbd(item.unitCost)}</td>
      <td>${formatMoneyBbd(item.value)}</td>
    </tr>
  `).join("");
  // Balance check: the certificate total should always equal the sum of these
  // rows by construction (both now derive from the same override-applied
  // commercial invoice lines — see buildPayloadFromShipment). A gap between
  // the certificate total and the full commercial invoice subtotal is
  // expected whenever the shipment also has non-certificate items (frames,
  // accessories); this footer just makes both numbers visible for a sanity check.
  const certificateTotal = round2(items.reduce((sum, item) => sum + Number(item.value || 0), 0));
  const invoiceSubtotal = Number(payload.commercialInvoiceSubtotal || 0);
  const nonCertificateAmount = round2(invoiceSubtotal - certificateTotal);
  const totalsRow = items.length ? `
    <tr class="co-items-total-row">
      <td colspan="8">Certificate items total${nonCertificateAmount > 0 ? ` (commercial invoice subtotal ${formatMoneyBbd(invoiceSubtotal)}; ${formatMoneyBbd(nonCertificateAmount)} not certificate-eligible)` : ""}</td>
      <td><strong>${formatMoneyBbd(certificateTotal)}</strong></td>
    </tr>
  ` : "";
  target.innerHTML = (rows || `<tr><td colspan="9">Prepare a draft to load certificate items.</td></tr>`) + totalsRow;
}

function wireShipmentDivider() {
  const divider = document.querySelector("#shipmentDivider");
  const grid = document.querySelector(".shipment-master-detail");
  if (!divider || !grid) return;
  divider.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    grid.classList.add("resizing");
    const rect = grid.getBoundingClientRect();
    const move = (moveEvent) => {
      const x = Math.min(Math.max(moveEvent.clientX - rect.left, 360), rect.width - 420);
      grid.style.gridTemplateColumns = `${x}px 8px minmax(420px, 1fr)`;
    };
    const up = () => {
      grid.classList.remove("resizing");
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
      divider.removeEventListener("pointercancel", up);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
    divider.addEventListener("pointercancel", up);
  });
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

function renderCommercialInvoicePreview() {
  const target = document.querySelector("#commercialInvoicePreview");
  const summary = document.querySelector("#commercialPreviewSummary");
  if (!target) return;
  const preview = moduleState.invoicePreview;
  // The checklist lives in the right-hand column beside Fill jobs, outside this
  // sheet, so it can refresh while the operator is still typing in the form.
  renderCiComplianceSlot(preview?.compliance);
  // Avoid replacing the form while an operator is actively typing.
  if (target.contains(document.activeElement)
    && document.activeElement?.matches("[data-ci-header-field], [data-ci-field]")) return;
  if (!preview) {
    if (summary) summary.textContent = "Select an export shipment to open its commercial-invoice workspace.";
    target.innerHTML = `<p class="shipment-empty">Select an export shipment to load the commercial-invoice workspace.</p>`;
    return;
  }
  if (summary) {
    summary.textContent = `Shipment ${preview.shipmentId} · ${preview.itemCount} invoice line${preview.itemCount === 1 ? "" : "s"} · ${formatMoneyBbd(preview.totals?.invoiceTotal || 0)}`;
  }

  const rows = (preview.items || []).map((item) => `
    <tr data-ci-line="${escapeHtml(item.lineKey || "")}">
      <td><input class="ci-line-input ci-line-small" data-ci-field="lineNumber" value="${escapeHtml(item.lineNumber || "")}" aria-label="Line number"></td>
      <td><input class="ci-line-input" data-ci-field="ref" value="${escapeHtml(item.ref || "")}" aria-label="Reference"></td>
      <td><input class="ci-line-input ci-line-small" value="${escapeHtml(item.invoiceNumber || "")}" aria-label="Invoice number" readonly tabindex="-1"></td>
      <td class="ci-spec"><input class="ci-line-input" data-ci-field="specification" value="${escapeHtml(item.specification || "")}" title="${escapeHtml(item.specification || "")}" aria-label="Specification"></td>
      <td><input class="ci-line-input" data-ci-field="hsCode" value="${escapeHtml(item.hsCode || "")}" aria-label="HS code"></td>
      <td><input class="ci-line-input" data-ci-field="origin" value="${escapeHtml(item.origin || "")}" aria-label="Origin"></td>
      <td><input class="ci-line-input ci-line-small" data-ci-field="quantity" value="${escapeHtml(item.quantity ?? "")}" aria-label="Quantity"></td>
      <td><input class="ci-line-input ci-line-money" data-ci-field="unitPrice" value="${escapeHtml(formatPlainMoney(item.unitPrice))}" aria-label="Unit price"></td>
      <td><input class="ci-line-input ci-line-money" data-ci-field="amount" value="${escapeHtml(formatPlainMoney(item.amount))}" aria-label="Amount"></td>
      <td><input class="ci-line-input ci-line-small" value="${escapeHtml(item.weightKg ?? "")}" aria-label="Weight kg" readonly tabindex="-1"></td>
    </tr>
  `).join("");

  target.innerHTML = `
    <article class="commercial-invoice-entry">
      <div class="ci-entry-layout">
        <div class="ci-entry-main">
          <section class="ci-entry-intro">
            <div>
              <p class="eyebrow">Commercial invoice workspace</p>
              <h3>Edit the shipment record, then use Print / PDF for the final document.</h3>
              <p>Source-controlled details are shown for reference. Shipment details, costs, delivery terms and shipping marks are editable above; invoice-specific fields below save when you leave the field.</p>
            </div>
            <span class="ci-entry-status">Draft for shipment ${escapeHtml(preview.shipmentId || "")}</span>
          </section>
          <section class="ci-entry-section">
            <div class="ci-entry-section-head"><div><h3>Invoice & parties</h3><p>Invoice identity and consignee details supplied by the selected shipment.</p></div></div>
            <div class="ci-entry-grid">
              ${ciReadOnly("Invoice date", preview.invoiceDate)}
              ${ciReadOnly("Invoice number", preview.invoiceNo)}
              ${ciEntryInput("Customer order no.", "customerOrderNo", preview.customerOrderNo, { placeholder: "Enter customer order number" })}
              ${ciEntryInput("PO numbers", "poNumbers", preview.poNumbers, { placeholder: "Enter PO numbers" })}
              ${ciReadOnly("Presenting bank", preview.presentingBank)}
              ${ciReadOnly("Buyer", "Buyer (if not consignee)")}
              ${ciReadOnly("Seller", preview.seller?.name, { detail: [...(preview.seller?.addressLines || []), preview.seller?.phone].filter(Boolean).join(" · ") })}
              ${ciReadOnly("Consignee", preview.consignee?.name, { detail: [preview.consignee?.address, preview.consignee?.country, preview.consignee?.phone].filter(Boolean).join(" · ") })}
            </div>
          </section>
          <section class="ci-entry-section">
            <div class="ci-entry-section-head"><div><h3>Shipment & customs</h3><p>Complete the commercial-invoice fields that differ from the shipment defaults.</p></div></div>
            <div class="ci-entry-grid">
              ${ciEntryInput("Port of loading", "portOfLoading", preview.transport?.portOfLoading, { placeholder: "Enter port of loading" })}
              ${ciEntryInput("Carrier", "carrier", preview.transport?.carrier, { placeholder: "Enter carrier" })}
              ${ciEntryInput("Marks & numbers", "marksAndNumbers", preview.transport?.marksAndNumbers, { placeholder: "Customer account / shipment" })}
              ${ciEntryInput("Package type", "packageType", preview.packaging?.packageType, { placeholder: "Enter package type" })}
              ${ciEntryInput("Gross weight (lbs)", "grossWeightLbs", preview.packaging?.grossWeightLbs, { placeholder: "Enter pounds", hint: preview.packaging?.grossWeight ? `Calculated: ${preview.packaging.grossWeight}` : "" })}
              ${ciReadOnly("Delivery terms", preview.deliveryTerms)}
              ${ciReadOnly("Tracking / AWB", preview.transport?.trackingNumber)}
              ${ciReadOnly("No. & kind of packages", [preview.packaging?.numberOfPackages, preview.packaging?.packageType].filter(Boolean).join(" · "))}
              ${ciReadOnly("Cube", preview.packaging?.cube)}
              ${ciReadOnly("Country of origin", preview.countryOfOriginOfGoods)}
              ${ciReadOnly("Final destination", preview.transport?.countryOfDestination)}
              ${ciEntryInput("Declaration", "declaration", preview.declarationOverride, { multiline: true, wide: true, placeholder: "Leave blank to use the standard tariff declaration" })}
            </div>
          </section>
          <section class="ci-entry-section ci-entry-lines-section">
            <div class="ci-entry-section-head"><div><h3>Invoice line items</h3><p>Edit description, customs data, quantity or price. Amounts and totals recalculate immediately.</p></div></div>
            <div class="table-wrap ci-entry-table-wrap">
              <table class="ci-items ci-entry-items">
                <thead><tr><th>Line #</th><th>Ref #</th><th>Inv #</th><th>Specification of commodities</th><th>HS code</th><th>Origin</th><th>Qty</th><th>Unit price</th><th>Amount</th><th>Weight kg</th></tr></thead>
                <tbody>${rows || `<tr><td colspan="10">No invoice lines.</td></tr>`}</tbody>
              </table>
            </div>
            <div class="ci-entry-totals" data-ci-totals>
              ${renderTotalRow("Sub total", preview.totals?.subTotal)}
              ${renderTotalRow("Packaging", preview.totals?.packaging)}
              ${renderTotalRow("Freight", preview.totals?.freight)}
              ${renderTotalRow("Other costs", preview.totals?.other)}
              ${renderTotalRow("Insurance", preview.totals?.insurance)}
              ${renderTotalRow("Invoice total", preview.totals?.invoiceTotal, true)}
            </div>
          </section>
        </div>
      </div>
    </article>
  `;
}

function ciEntryInput(label, key, rawValue, opts = {}) {
  const value = rawValue ?? "";
  const control = opts.multiline
    ? `<textarea class="ci-entry-input" data-ci-header-field="${escapeHtml(key)}" placeholder="${escapeHtml(opts.placeholder || "")}">${escapeHtml(value)}</textarea>`
    : `<input type="text" class="ci-entry-input" data-ci-header-field="${escapeHtml(key)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(opts.placeholder || "")}">`;
  return `<label class="ci-entry-field ${opts.wide ? "ci-entry-field-wide" : ""}"><span>${escapeHtml(label)}</span>${control}${opts.hint ? `<small>${escapeHtml(opts.hint)}</small>` : ""}</label>`;
}

function ciReadOnly(label, value, opts = {}) {
  return `<div class="ci-entry-readonly"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "—")}</strong>${opts.detail ? `<small>${escapeHtml(opts.detail)}</small>` : ""}</div>`;
}

function renderTotalRow(label, value, strong = false) {
  return `<div class="${strong ? "strong" : ""}"><span>${escapeHtml(label)}</span><b>${formatMoneyBbd(value || 0)}</b></div>`;
}

function renderCommercialInvoiceTotals() {
  const target = document.querySelector("[data-ci-totals]");
  const totals = moduleState.invoicePreview?.totals;
  if (!target || !totals) return;
  target.innerHTML = [
    renderTotalRow("Sub Total", totals.subTotal),
    renderTotalRow("Packaging", totals.packaging),
    renderTotalRow("Freight", totals.freight),
    renderTotalRow("Other Costs", totals.other),
    renderTotalRow("Insurance", totals.insurance),
    renderTotalRow("Invoice Total", totals.invoiceTotal, true)
  ].join("");
}

function updateCommercialInvoiceCostTotals() {
  const totals = moduleState.invoicePreview?.totals;
  if (!totals) return;
  const numberValue = (selector) => {
    const value = Number(valueOf(selector));
    return Number.isFinite(value) ? value : 0;
  };
  totals.freight = numberValue("#coFreightCost");
  totals.packaging = numberValue("#coPackingCost");
  totals.insurance = numberValue("#coInsuranceCost");
  totals.other = numberValue("#coOtherCost");
  totals.invoiceTotal = Number((Number(totals.subTotal || 0) + totals.freight + totals.packaging + totals.insurance + totals.other).toFixed(2));
  renderCommercialInvoiceTotals();
}

function wireCoDraftAutosave() {
  const form = document.querySelector("#coDraftForm");
  if (!form) return;
  const costField = "#coFreightCost, #coPackingCost, #coInsuranceCost, #coOtherCost";
  const commit = () => requestCoDraftAutosave(0);
  form.addEventListener("input", (event) => {
    if (event.target.matches(costField)) updateCommercialInvoiceCostTotals();
    requestCoDraftAutosave(500);
  });
  form.addEventListener("change", commit);
  form.addEventListener("focusout", commit);
  form.addEventListener("pointerleave", commit);
}

function requestCoDraftAutosave(delay) {
  if (!moduleState.coApplication) return;
  if (moduleState.coAutosaveTimer) clearTimeout(moduleState.coAutosaveTimer);
  moduleState.coAutosaveTimer = setTimeout(() => {
    moduleState.coAutosaveTimer = null;
    autosaveCoDraft();
  }, delay);
}

async function autosaveCoDraft() {
  if (!moduleState.coApplication) return;
  if (moduleState.coAutosaveInFlight) {
    moduleState.coAutosaveQueued = true;
    return;
  }
  moduleState.coAutosaveInFlight = true;
  try {
    await saveCoDraft({ silent: true });
  } finally {
    moduleState.coAutosaveInFlight = false;
    if (moduleState.coAutosaveQueued) {
      moduleState.coAutosaveQueued = false;
      requestCoDraftAutosave(0);
    }
  }
}

// Click-to-edit commercial-invoice header fields: shows the computed/DB value
// as plain text with a pencil button; clicking it reveals an input in place.
// Saving (blur/Enter) PUTs every header field to commercial-invoice/header
// and reloads the preview, which re-renders back to view mode with the
// server-computed display value (matters for grossWeightLbs, whose view text
// is the converted kg, not the lbs the operator typed).
function ciEditableField(label, key, rawValue, opts = {}) {
  const value = rawValue ?? "";
  const displayText = opts.display !== undefined ? opts.display : value;
  const hasValue = Boolean(String(displayText || "").trim());
  const viewHtml = hasValue
    ? `<strong>${escapeHtml(displayText)}</strong>`
    : `<em>${escapeHtml(opts.placeholder || "—")}</em>`;
  const editBtn = `<button type="button" class="ci-edit-btn" data-ci-edit="${escapeHtml(key)}" aria-label="Edit ${escapeHtml(label)}" title="Edit ${escapeHtml(label)}">&#9998;</button>`;
  const input = `<input type="text" class="ci-field-input" data-ci-header-field="${escapeHtml(key)}" value="${escapeHtml(value)}" hidden>`;

  if (opts.bare) {
    return `
      <span class="ci-inline-edit" data-ci-header-box="${escapeHtml(key)}">
        <span class="ci-field-view" data-ci-view="${escapeHtml(key)}">${viewHtml}</span>
        ${editBtn}
        ${input}
      </span>
    `;
  }

  return `
    <div class="ci-field ${opts.wide ? "ci-wide" : ""}" data-ci-header-box="${escapeHtml(key)}">
      <div class="ci-field-head"><small>${escapeHtml(label)}</small>${editBtn}</div>
      <div class="ci-field-view" data-ci-view="${escapeHtml(key)}">${viewHtml}</div>
      ${input}
    </div>
  `;
}

function wireCommercialInvoiceHeaderEditing() {
  const target = document.querySelector("#commercialInvoicePreview");
  if (!target) return;

  target.addEventListener("click", (event) => {
    const editBtn = event.target.closest("[data-ci-edit]");
    if (!editBtn) return;
    const key = editBtn.dataset.ciEdit;
    const view = target.querySelector(`[data-ci-view="${key}"]`);
    const input = target.querySelector(`[data-ci-header-field="${key}"]`);
    if (!view || !input) return;
    view.hidden = true;
    editBtn.hidden = true;
    input.hidden = false;
    input.focus();
    input.select?.();
  });

  target.addEventListener("focusout", (event) => {
    const input = event.target.closest("[data-ci-header-field]");
    if (input) saveCommercialInvoiceHeader();
  });

  target.addEventListener("keydown", (event) => {
    const input = event.target.closest("[data-ci-header-field]");
    if (!input) return;
    if (event.key === "Enter" && input.tagName !== "TEXTAREA") {
      event.preventDefault();
      input.blur();
    } else if (event.key === "Escape") {
      input.blur();
    }
  });
}

// Line edits (qty/unit price/amount) previously only recalculated after an
// explicit Save round-tripped through the server — an operator editing a
// commercial-invoice line saw a stale Amount/Sub Total/Invoice Total until
// they clicked Save elsewhere. This recomputes in the DOM immediately, then
// debounces a real save so the correction persists (2026-08-13, shipment 11357).
let ciLinesSaveTimer = null;

function wireCommercialInvoiceLineEditing() {
  const target = document.querySelector("#commercialInvoicePreview");
  if (!target) return;

  target.addEventListener("input", (event) => {
    const input = event.target.closest("[data-ci-field]");
    if (!input) return;
    const row = input.closest("[data-ci-line]");
    if (!row) return;
    if (input.dataset.ciField === "quantity" || input.dataset.ciField === "unitPrice") {
      recalcCommercialInvoiceLineAmount(row);
    }
    recalcCommercialInvoiceTotalsFromDom();
    if (ciLinesSaveTimer) clearTimeout(ciLinesSaveTimer);
    ciLinesSaveTimer = setTimeout(commitCommercialInvoiceLines, 600);
  });

  target.addEventListener("focusout", (event) => {
    if (event.target.closest("[data-ci-field]")) commitCommercialInvoiceLines();
  });
}

function parseMoneyInput(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function recalcCommercialInvoiceLineAmount(row) {
  const qtyInput = row.querySelector('[data-ci-field="quantity"]');
  const priceInput = row.querySelector('[data-ci-field="unitPrice"]');
  const amountInput = row.querySelector('[data-ci-field="amount"]');
  if (!qtyInput || !priceInput || !amountInput) return;
  const amount = round2(parseMoneyInput(qtyInput.value) * parseMoneyInput(priceInput.value));
  amountInput.value = formatPlainMoney(amount);
}

function recalcCommercialInvoiceTotalsFromDom() {
  const totals = moduleState.invoicePreview?.totals;
  if (!totals) return;
  const subTotal = [...document.querySelectorAll('[data-ci-line] [data-ci-field="amount"]')]
    .reduce((sum, input) => sum + parseMoneyInput(input.value), 0);
  totals.subTotal = round2(subTotal);
  totals.invoiceTotal = round2(totals.subTotal + Number(totals.packaging || 0) + Number(totals.freight || 0)
    + Number(totals.other || 0) + Number(totals.insurance || 0));
  renderCommercialInvoiceTotals();
}

async function commitCommercialInvoiceLines() {
  ciLinesSaveTimer = null;
  try {
    await saveCommercialInvoiceLines();
  } catch (error) {
    setCoMessage(error.message, true);
  }
}

function readCommercialInvoiceHeader() {
  const fields = {};
  document.querySelectorAll("#commercialInvoicePreview [data-ci-header-field]").forEach((input) => {
    fields[input.dataset.ciHeaderField] = input.value;
  });
  return fields;
}

async function saveCommercialInvoiceHeader() {
  const session = getSelectedSession();
  if (!session) return;
  const fields = readCommercialInvoiceHeader();
  await putJson(`/api/delivery/shipments/${encodeURIComponent(session.shipment_session_id)}/commercial-invoice/header`, { fields }).catch((error) => {
    setCoMessage(error.message, true);
  });
  await loadCommercialInvoicePreview();
}

// Standardisation/validation panel: shows whether the invoice has every required
// CARICOM/Barbados field (Incoterms-2020 delivery terms included) and the filing
// reminders. Data comes from preview.compliance (server-side, lib/beswift-co.js).
function renderCiCompliance(c) {
  if (!c) return "";
  const checks = (c.checks || [])
    .map((chk) => `<li class="${chk.ok ? "ci-check-ok" : "ci-check-miss"}"><span aria-hidden="true">${chk.ok ? "✓" : "!"}</span>${escapeHtml(chk.label)}</li>`)
    .join("");
  const reminders = (c.reminders || []).map((r) => `<li>${escapeHtml(r)}</li>`).join("");
  const outstanding = (c.missing || []).length;
  return `
    <aside class="ci-compliance ci-compliance-sidebar" aria-label="Commercial invoice compliance">
      <p class="eyebrow">Automatic checklist</p>
      <h2>${c.ready ? "Ready to print" : "Finish before printing"}</h2>
      <p class="${c.ready ? "ci-compliance-ok" : "ci-compliance-warn"}">${c.ready ? "All required invoice fields are present." : `${outstanding} required item${outstanding === 1 ? "" : "s"} still need${outstanding === 1 ? "s" : ""} attention.`}</p>
      <ul class="ci-compliance-checks">${checks}</ul>
      ${reminders ? `<details><summary>Filing reminders</summary><ul class="ci-compliance-reminders">${reminders}</ul></details>` : ""}
    </aside>
  `;
}

// Renders the checklist into its own slot in the right-hand column, beneath
// Fill jobs, so the invoice sheet keeps the full width of the left panel.
function renderCiComplianceSlot(compliance) {
  const slot = document.querySelector("#coComplianceSlot");
  if (!slot) return;
  slot.innerHTML = renderCiCompliance(compliance) || `
    <aside class="ci-compliance ci-compliance-sidebar" aria-label="Commercial invoice compliance">
      <p class="eyebrow">Automatic checklist</p>
      <h2>No shipment selected</h2>
      <p class="ci-compliance-warn">Select an export shipment to run the invoice checklist.</p>
    </aside>
  `;
}

function renderItemDefaults() {
  const target = document.querySelector("#itemDefaultsRows");
  if (!target) return;
  const items = moduleState.invoicePreview?.items || [];
  target.innerHTML = items.map((item, index) => {
    const key = item.catalogName || item.specification || item.sourceName || item.ref || `Item ${index + 1}`;
    return `
      <tr data-item-setting="${index}" data-item-name="${escapeHtml(key)}">
        <td><input data-setting-field="certificateEligible" type="checkbox" ${item.certificateEligible ? "checked" : ""} aria-label="Certificate eligible for ${escapeHtml(key)}"></td>
        <td class="item-setting-source" title="${escapeHtml(item.sourceName || key)}">${escapeHtml(item.sourceName || key)}</td>
        <td><input data-setting-field="shortName" value="${escapeHtml(item.catalogName || item.specification || item.sourceName || "")}" autocomplete="off"></td>
        <td><input data-setting-field="hsCode" value="${escapeHtml(item.hsCode || "")}" autocomplete="off"></td>
        <td><input data-setting-field="countryOfOrigin" value="${escapeHtml(item.origin || "")}" autocomplete="off"></td>
        <td><input data-setting-field="unitOfMeasure" value="${escapeHtml(item.uom || "")}" autocomplete="off"></td>
        <td><input data-setting-field="commercialDescription" value="${escapeHtml(item.sourceName || item.specification || item.catalogName || "")}" autocomplete="off"></td>
      </tr>
    `;
  }).join("") || `<tr><td colspan="7">Load an export shipment to edit item defaults.</td></tr>`;
}

function openDeliverySettings() {
  const modal = document.querySelector("#deliverySettingsModal");
  if (!modal) return;
  activateSettingsTab("customerDefaults");
  renderItemDefaults();
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeDeliverySettings() {
  const modal = document.querySelector("#deliverySettingsModal");
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = "";
}

function activateSettingsTab(tabId) {
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.settingsTab === tabId);
  });
  document.querySelectorAll(".settings-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === tabId);
  });
}

async function saveItemDefaults() {
  const rows = [...document.querySelectorAll("[data-item-setting]")];
  if (!rows.length) {
    setItemDefaultsMessage("Load an export shipment before saving item defaults.", true);
    return;
  }

  try {
    for (const row of rows) {
      const itemName = row.dataset.itemName || "";
      const body = {};
      row.querySelectorAll("[data-setting-field]").forEach((input) => {
        body[input.dataset.settingField] = input.type === "checkbox" ? input.checked : input.value.trim();
      });
      await putJson(`/api/delivery/co-item-catalog/${encodeURIComponent(itemName)}`, body);
    }
  } catch (error) {
    setItemDefaultsMessage(error.message, true);
    return;
  }

  setItemDefaultsMessage("Item defaults saved.");
  await loadCommercialInvoicePreview();
  if (moduleState.coApplication) await prepareCoDraft();
}

function setItemDefaultsMessage(message, isError = false) {
  const target = document.querySelector("#itemDefaultsMessage");
  if (!target) return;
  target.textContent = message || "";
  target.classList.toggle("error", Boolean(isError));
}

function printCommercialInvoice() {
  const session = getSelectedSession();
  if (!session) return;
  window.open(`/api/delivery/shipments/${encodeURIComponent(session.shipment_session_id)}/commercial-invoice.pdf`, "_blank", "noopener");
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
  const metaParts = [
    isExportSession(session) ? "Export" : "Domestic",
    session.app_status || "prep",
    `${Number(session.item_count || 0)} counted items`
  ];
  if (session.tracking_number) metaParts.push(`Closed with tracking ${session.tracking_number}`);
  if (session.dispatcher_id) metaParts.push(`Operator ${session.dispatcher_id}`);
  setText("#selectedShipmentMeta", metaParts.join(" · "));
  if (addRowsBtn) addRowsBtn.hidden = !(isExportSession(session) && session.app_status !== "closed");

  const data = await getJson(`/api/delivery/shipments/${encodeURIComponent(session.shipment_session_id)}/items`, { items: [] });
  moduleState.shipmentItems = data.items || [];
  renderShipmentItems();
  updateCommercialInvoiceAvailability();
  if (!options.skipCoDraft) await loadCoDraft();
}

async function loadCoDraft() {
  const session = getSelectedSession();
  await loadCustomerParamsForSession(session && isExportSession(session) ? session : null);

  if (!session || !isExportSession(session)) {
    moduleState.coApplication = null;
    moduleState.coJobs = [];
    moduleState.invoicePreview = null;
    renderCommercialInvoicePreview();
    renderItemDefaults();
    renderCoDraft();
    return;
  }

  const [data] = await Promise.all([
    getJson(`/api/delivery/shipments/${encodeURIComponent(session.shipment_session_id)}/commercial-invoice/co`, { application: null, jobs: [] }),
    loadCommercialInvoicePreview(session)
  ]);
  moduleState.coApplication = data.application || null;
  moduleState.coJobs = data.jobs || [];
  renderCoDraft();
}

async function loadCommercialInvoicePreview(session = getSelectedSession()) {
  const printBtn = document.querySelector("#printCommercialInvoiceBtn");
  if (!session || !isExportSession(session)) {
    moduleState.invoicePreview = null;
    if (printBtn) printBtn.disabled = true;
    renderCommercialInvoicePreview();
    renderItemDefaults();
    return;
  }
  const data = await getJson(`/api/delivery/shipments/${encodeURIComponent(session.shipment_session_id)}/commercial-invoice/preview`, { preview: null });
  moduleState.invoicePreview = data.preview || null;
  if (printBtn) printBtn.disabled = !moduleState.invoicePreview;
  const saveBtn = document.querySelector("#saveCoDraftBtn");
  if (saveBtn) saveBtn.disabled = !(moduleState.coApplication || moduleState.invoicePreview);
  renderCommercialInvoicePreview();
  renderItemDefaults();
}

async function loadCustomerParamsForSession(session) {
  const saveBtn = document.querySelector("#saveCustomerParamsBtn");

  if (!session || !session.customer_account) {
    moduleState.customerParams = null;
    moduleState.customerParamsAccount = "";
    fillCustomerParamsForm({});
    setText("#customerParamsSummary", "Select an export shipment to edit its customer's commercial-invoice defaults.");
    if (saveBtn) saveBtn.disabled = true;
    return;
  }

  const account = session.customer_account;
  moduleState.customerParamsAccount = account;
  const data = await getJson(`/api/delivery/customer-parameters/${encodeURIComponent(account)}`, { parameters: null });
  moduleState.customerParams = data.parameters || null;
  fillCustomerParamsForm(moduleState.customerParams || {});
  setText("#customerParamsSummary", `Defaults for ${account} \u2014 prefills new BeSwift drafts for this customer.`);
  if (saveBtn) saveBtn.disabled = false;
}

function fillCustomerParamsForm(values) {
  const pairs = {
    cpPortOfDischarge: values.portOfDischarge || "",
    cpDeliveryTerms: values.deliveryTerms || "",
    cpBankName: values.bankName || "",
    cpBankAccountName: values.bankAccountName || "",
    cpBankAccountNumber: values.bankAccountNumber || "",
    cpBankSwiftBic: values.bankSwiftBic || "",
    cpBankRoutingNumber: values.bankRoutingNumber || "",
    cpBankBranchAddress: values.bankBranchAddress || "",
    cpNotes: values.notes || ""
  };
  for (const [id, value] of Object.entries(pairs)) {
    const input = document.querySelector(`#${id}`);
    if (input) input.value = value;
  }
}

function readCustomerParamsForm() {
  return {
    portOfDischarge: valueOf("#cpPortOfDischarge"),
    deliveryTerms: valueOf("#cpDeliveryTerms"),
    bankName: valueOf("#cpBankName"),
    bankAccountName: valueOf("#cpBankAccountName"),
    bankAccountNumber: valueOf("#cpBankAccountNumber"),
    bankSwiftBic: valueOf("#cpBankSwiftBic"),
    bankRoutingNumber: valueOf("#cpBankRoutingNumber"),
    bankBranchAddress: valueOf("#cpBankBranchAddress"),
    notes: valueOf("#cpNotes")
  };
}

async function saveCustomerParams() {
  const account = moduleState.customerParamsAccount;
  if (!account) return;
  const data = await putJson(`/api/delivery/customer-parameters/${encodeURIComponent(account)}`, readCustomerParamsForm()).catch((error) => {
    setCustomerParamsMessage(error.message, true);
    return null;
  });
  if (!data) return;
  moduleState.customerParams = data.parameters || null;
  setCustomerParamsMessage(`Saved defaults for ${account}.`);
  await loadCommercialInvoicePreview();
}

function setCustomerParamsMessage(message, isError = false) {
  const target = document.querySelector("#customerParamsMessage");
  if (!target) return;
  target.textContent = message || "";
  target.classList.toggle("error", Boolean(isError));
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

async function saveCoDraft(options = {}) {
  const app = moduleState.coApplication;
  try {
    await saveCommercialInvoiceLines({ reloadPreview: false });
  } catch (error) {
    setCoMessage(error.message, true);
    return false;
  }
  if (!app) {
    setCoMessage("");
    return false;
  }
  const data = await putJson(`/api/delivery/co-applications/${encodeURIComponent(app.coApplicationId)}/draft`, readCoDraftForm()).catch((error) => {
    setCoMessage(error.message, true);
    return null;
  });
  if (!data) return false;
  moduleState.coApplication = data.application;
  await loadCommercialInvoicePreview();
  renderCoDraft();
  if (!options.silent) setCoMessage("Draft saved.");
  return true;
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
    portalEnvironment: valueOf("#coPortalEnvironment") || "production",
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

function readCommercialInvoiceLines() {
  return [...document.querySelectorAll("[data-ci-line]")].map((row) => {
    const line = { lineKey: row.dataset.ciLine || "" };
    row.querySelectorAll("[data-ci-field]").forEach((input) => {
      line[input.dataset.ciField] = input.value;
    });
    return line;
  }).filter((line) => line.lineKey);
}

async function saveCommercialInvoiceLines(options = {}) {
  const session = getSelectedSession();
  const lines = readCommercialInvoiceLines();
  if (!session || !lines.length) return true;
  await putJson(`/api/delivery/shipments/${encodeURIComponent(session.shipment_session_id)}/commercial-invoice/lines`, { lines });
  if (options.reloadPreview !== false) await loadCommercialInvoicePreview();
  return true;
}

function readCoItems() {
  const rows = [...document.querySelectorAll("[data-co-item]")];
  if (!rows.some((row) => row.querySelector("[data-co-field]"))) {
    return moduleState.coApplication?.editable?.items || [];
  }
  return rows.map((row) => {
    const item = { name: row.querySelector(".co-item-name")?.textContent || "" };
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
  target.hidden = !(message && isError);
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

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function formatMoneyBbd(value) {
  if (value === null || value === undefined || value === "") return "";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "BBD"
  }).format(Number(value));
}

function formatPlainMoney(value) {
  if (value === null || value === undefined || value === "") return "";
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
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
