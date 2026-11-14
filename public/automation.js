(() => {
  const form = document.getElementById("rxForm");
  if (!form) return;

  const state = { catalog: [], stagedFiles: [] };
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const status = $("#rxStatus");
  const setStatus = (message, kind = "") => {
    status.textContent = message;
    status.className = `rx-status show ${kind}`;
  };
  const clearStatus = () => { status.className = "rx-status"; status.textContent = ""; };
  const request = async (url, options = {}) => {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...options });
    const type = response.headers.get("content-type") || "";
    if (!response.ok) {
      const payload = type.includes("json") ? await response.json().catch(() => ({})) : {};
      throw new Error(payload.error || `Request failed (${response.status}).`);
    }
    return response;
  };
  const postJson = (url, body) => request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const formValue = (name) => form.elements[name]?.value ?? "";
  const supplierMatches = (item, supplier) => supplier === "TOG"
    ? ["TOG Rx Lab", "TOG USA"].some((value) => (item.suppliers || []).includes(value))
    : (item.suppliers || []).includes(supplier);

  function toggleConditionalFields() {
    const patientMode = formValue("patientMode");
    $(".rx-patient-fixed").hidden = patientMode !== "fixed";
    $(".rx-patient-list").hidden = patientMode !== "list";
    $(".rx-lens-alias").hidden = formValue("lensMode") !== "fixed";
    $(".rx-fixed-rx").hidden = formValue("prescriptionMode") !== "fixed";
    $("#coatingSkuWrap").hidden = formValue("coatingMode") !== "fixed";
  }

  function fillSelect(select, items, label) {
    select.replaceChildren(...items.map((item) => {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      return option;
    }));
  }

  function fillCoatingSelect(items) {
    const groups = new Map();
    for (const item of items) {
      const group = item.groupName || "Coatings";
      const values = groups.get(group) || [];
      values.push(item);
      groups.set(group, values);
    }
    const sections = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, values]) => {
      const optgroup = document.createElement("optgroup");
      optgroup.label = name;
      values.sort((left, right) => left.description.localeCompare(right.description)).forEach((item) => {
        const option = document.createElement("option");
        option.value = item.sku;
        option.textContent = `${item.description} (${item.sku})`;
        optgroup.append(option);
      });
      return optgroup;
    });
    $("#coatingSku").replaceChildren(...sections);
  }

  function syncLensOptions() {
    const category = formValue("lensCatalog");
    const supplier = formValue("lensSupplier");
    const option = formValue("lensOption");
    const matchingCategory = state.catalog.filter((item) => category === "All valid lenses" || item.category === category);
    const matchingSupplier = matchingCategory.filter((item) => supplier === "All supported labs" || supplierMatches(item, supplier));
    const options = [...new Set(matchingSupplier.map((item) => item.colorDescription).filter(Boolean))].sort((left, right) => left.localeCompare(right));
    const previousOption = $("#lensOption").value;
    fillSelect($("#lensOption"), [{ value: "All lens options", label: "All lens options" }, ...options.map((item) => ({ value: item, label: item }))]);
    $("#lensOption").value = options.includes(previousOption) ? previousOption : "All lens options";
    const aliases = matchingSupplier.filter((item) => $("#lensOption").value === "All lens options" || item.colorDescription === $("#lensOption").value);
    fillSelect($("#lensAlias"), aliases.map((item) => ({ value: item.alias, label: `${item.alias} · ${item.materialDescription} · ${item.styleDescription} · ${item.colorDescription}` })));
  }

  function payload() {
    const patientMode = formValue("patientMode");
    const lensMode = formValue("lensMode");
    const prescriptionMode = formValue("prescriptionMode");
    const frameMode = formValue("frameMode");
    return {
      batchSize: Number(formValue("batchSize")),
      randomSeed: formValue("randomSeed"),
      extension: formValue("extension"),
      instructions: formValue("instructions"),
      labNum: formValue("labNum"),
      remoteOperator: formValue("remoteOperator"),
      customer: { custNum: formValue("custNum"), custSeqNum: formValue("custSeqNum"), shipName: formValue("shipName") },
      patient: { mode: patientMode, name: formValue("patientName"), names: formValue("patientNames") },
      lens: { mode: lensMode, catalog: formValue("lensCatalog"), supplier: formValue("lensSupplier"), option: formValue("lensOption"), alias: formValue("lensAlias"), unique: form.elements.uniqueAliases.checked },
      prescription: {
        mode: prescriptionMode, pdOd: Number(formValue("pdOd")), pdOs: Number(formValue("pdOs")),
        od: { sphere: Number(formValue("odSphere")), cylinder: Number(formValue("odCylinder")), axis: Number(formValue("odAxis")), add: Number(formValue("odAdd")), segHeight: Number(formValue("odSegHeight")) },
        os: { sphere: Number(formValue("osSphere")), cylinder: Number(formValue("osCylinder")), axis: Number(formValue("osAxis")), add: Number(formValue("osAdd")), segHeight: Number(formValue("osSegHeight")) }
      },
      frame: { mode: frameMode, model: formValue("frameModel"), color: formValue("frameColor"), a: Number(formValue("frameA")), b: Number(formValue("frameB")), dbl: Number(formValue("frameDbl")) },
      coating: { mode: formValue("coatingMode"), sku: formValue("coatingSku") },
      addons: { skus: [] }
    };
  }

  function orderSettings() {
    return {
      batchSize: Number(formValue("batchSize")), randomSeed: formValue("randomSeed"), instructions: formValue("instructions"),
      custNum: formValue("custNum"), custSeqNum: formValue("custSeqNum"), shipName: formValue("shipName"),
      labNum: formValue("labNum"), remoteOperator: formValue("remoteOperator"), extension: formValue("extension")
    };
  }

  function applyOrderSettings(settings) {
    if (!settings) return;
    for (const [name, value] of Object.entries(settings)) {
      if (form.elements[name]) form.elements[name].value = value;
    }
  }

  function showPreview(preview) {
    $("#rxFilename").textContent = preview.filename;
    $("#rxPatient").textContent = preview.summary.patient;
    $("#rxLens").textContent = preview.summary.lens;
    $("#rxFrame").textContent = preview.summary.frame;
    $("#rxContent").textContent = preview.content;
  }

  async function preview() {
    clearStatus();
    const response = await postJson("/api/rx/preview", payload());
    const result = await response.json();
    showPreview(result);
    setStatus("Preview validated. Review the raw line order before staging or download.", "success");
  }

  async function stage() {
    clearStatus();
    const response = await postJson("/api/rx/generate", { ...payload(), delivery: "stage" });
    const result = await response.json();
    state.stagedFiles = result.generated.map((item) => item.filename);
    $("#releaseRx").disabled = !state.stagedFiles.length;
    setStatus(`${result.batchSize} RX ${result.batchSize === 1 ? "file was" : "files were"} safely staged.`, "success");
  }

  async function saveOrderSettings() {
    clearStatus();
    const response = await postJson("/api/rx/order-settings", { settings: orderSettings() });
    const result = await response.json();
    applyOrderSettings(result.settings);
    setStatus("Order settings saved for your account.", "success");
  }

  async function download() {
    clearStatus();
    const response = await postJson("/api/rx/generate", payload());
    const content = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] || "rx-files.zip";
    const link = document.createElement("a");
    link.href = URL.createObjectURL(content);
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    setStatus(`${response.headers.get("x-rx-generated-count") || "RX"} file(s) generated, staged, and downloaded.`, "success");
  }

  async function release() {
    clearStatus();
    if (!state.stagedFiles.length) throw new Error("Stage a batch before releasing it.");
    const response = await postJson("/api/rx/release", { filenames: state.stagedFiles });
    const result = await response.json();
    setStatus(`${result.released.length} staged file(s) released to the configured incoming folder.`, "success");
  }

  async function run(action) {
    try { await action(); } catch (error) { setStatus(error.message || "The RX request could not be completed.", "error"); }
  }

  async function load() {
    try {
      const [catalogResponse, coatingResponse, settingsResponse] = await Promise.all([request("/api/rx/catalog"), request("/api/rx/coatings"), request("/api/rx/order-settings")]);
      const [catalog, coatings, savedSettings] = await Promise.all([catalogResponse.json(), coatingResponse.json(), settingsResponse.json()]);
      applyOrderSettings(savedSettings.settings);
      state.catalog = catalog.items || [];
      const supportedLabs = [
        { value: "TOG", label: "TOG" },
        { value: "Vision Rx Lab", label: "VisionRx" },
        { value: "Optex Laboratories", label: "Optex" },
        { value: "SkyLab", label: "SkyLab" },
        { value: "Essilor Lab", label: "EssLab" }
      ].filter((lab) => state.catalog.some((item) => supplierMatches(item, lab.value)));
      fillSelect($("#lensSupplier"), [{ value: "All supported labs", label: "All supported labs" }, ...supportedLabs]);
      const categories = [...new Set(state.catalog.map((item) => item.category))].sort();
      fillSelect($("#lensCatalog"), [{ value: "All valid lenses", label: "All valid lenses" }, ...categories.map((item) => ({ value: item, label: item }))]);
      syncLensOptions();
      fillCoatingSelect(coatings.items || []);
      if (!(coatings.items || []).length) {
        throw new Error("No live coating options were returned. Refresh the page to retry the source catalogue.");
      }
      toggleConditionalFields();
      setStatus(`${state.catalog.length} source-validated lens aliases loaded. Only aliases matched to active Pricing Automation products are available.`, "success");
    } catch (error) { setStatus(error.message || "Unable to load RX generator data.", "error"); }
  }

  function updateAutomationCrumb(button) {
    const crumb = document.querySelector("#app-shell-header .top-crumb");
    if (crumb) crumb.textContent = "Automation";
  }

  function formatSyncTime(value) {
    if (!value) return "Not recorded";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
  }

  const qboSyncButton = $("#runQboInvoiceSync");
  const qboDryRunButton = $("#runQboInvoiceSyncDryRun");
  function renderQboInvoiceSyncStatus(sync) {
    $("#qboInvoiceSyncDetail").textContent = sync.detail;
    $("#qboInvoiceSyncMode").textContent = sync.environment ? `${sync.environment}${sync.realmId ? ` · realm ${sync.realmId}` : ""}` : "Not configured";
    $("#qboInvoiceSyncSchedule").textContent = `Every ${sync.intervalMinutes} minutes`;
    $("#qboInvoiceSyncTaskState").textContent = sync.running ? "Running" : (sync.task?.state || "Not installed");
    $("#qboInvoiceSyncLastRun").textContent = formatSyncTime(sync.lastRun);
    qboSyncButton.disabled = Boolean(sync.running);
    qboDryRunButton.disabled = Boolean(sync.running);
  }
  async function loadQboInvoiceLedger() {
    try {
      const data = await (await request("/api/automation/qbo-invoices/ledger?limit=8")).json();
      const rows = data.rows || [];
      $("#qboInvoiceSyncLedger").innerHTML = rows.length
        ? `<strong>Recent processed invoices</strong><br>${rows.map((row) => `${escapeHtml(row.source_invoice_id)} · ${escapeHtml(row.source_customer_name || row.source_customer_account || "unmatched")} · <b>${escapeHtml(row.status)}</b>`).join("<br>")}`
        : "No transaction history loaded.";
    } catch (error) { $("#qboInvoiceSyncLedger").textContent = error.message || "Unable to load transaction history."; }
  }
  let qboFixOptions = null;
  const qboExceptionKind = (reason) => /customer mapping/i.test(reason) ? "customer" : /tax code/i.test(reason) ? "tax" : /item mapping/i.test(reason) ? "item" : "other";
  async function loadQboFixOptions() {
    if (!qboFixOptions) qboFixOptions = await (await request("/api/automation/qbo-invoices/fix-options")).json();
    return qboFixOptions;
  }
  function qboFixControls(row, kind) {
    const id = escapeHtml(row.source_invoice_id);
    const recheck = `<button type="button" class="secondary" data-qbo-action="recheck" data-invoice="${id}">Re-check</button>`;
    if (kind === "customer") return `<div class="qbo-exception-fix"><input type="search" list="qboCustomerOptions" placeholder="Search QBO customer…" data-qbo-field="customer" aria-label="QBO customer for account ${escapeHtml(row.source_customer_account || "")}"><button type="button" data-qbo-action="map-customer" data-invoice="${id}" data-account="${escapeHtml(row.source_customer_account || "")}" data-name="${escapeHtml(row.source_customer_name || "")}">Confirm mapping</button>${recheck}</div>`;
    if (kind === "tax") return `<div class="qbo-exception-fix"><select data-qbo-field="tax" aria-label="QBO tax code for VAT 17.5%"><option value="">Choose the 17.5% VAT tax code…</option></select><button type="button" data-qbo-action="save-tax" data-invoice="${id}">Save tax code</button>${recheck}</div>`;
    if (kind === "item") return `<div class="qbo-exception-fix"><span class="qbo-exception-hint">Create or rename the item in QuickBooks so its name matches exactly, then re-check.</span>${recheck}</div>`;
    return `<div class="qbo-exception-fix">${recheck}</div>`;
  }
  async function fillQboFixControls(container) {
    const needsOptions = container.querySelector('[data-qbo-field]');
    if (!needsOptions) return;
    try {
      const options = await loadQboFixOptions();
      let list = document.getElementById("qboCustomerOptions");
      if (!list) { list = document.createElement("datalist"); list.id = "qboCustomerOptions"; container.appendChild(list); }
      list.innerHTML = options.customers.map((c) => `<option value="${escapeHtml(c.displayName)}"></option>`).join("");
      container.querySelectorAll('select[data-qbo-field="tax"]').forEach((select) => {
        select.innerHTML = `<option value="">Choose the 17.5% VAT tax code…</option>${options.taxCodes.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}${t.description ? ` — ${escapeHtml(t.description)}` : ""}</option>`).join("")}`;
      });
      container.querySelectorAll('input[data-qbo-field="customer"]').forEach((input) => {
        const button = input.parentElement.querySelector('[data-qbo-action="map-customer"]');
        const guess = `${button.dataset.name} - ${button.dataset.account}`.toLowerCase();
        const hit = options.customers.find((c) => c.displayName.toLowerCase() === guess);
        if (hit) input.value = hit.displayName;
      });
    } catch (error) {
      container.querySelectorAll(".qbo-exception-fix").forEach((fix) => fix.insertAdjacentHTML("beforeend", `<span class="qbo-exception-hint">Could not load QuickBooks options: ${escapeHtml(error.message || "request failed")}</span>`));
    }
  }
  async function recheckQboInvoices(ids) {
    const result = await (await postJson("/api/automation/qbo-invoices/recheck", { sourceInvoiceIds: ids })).json();
    return result.results || [];
  }
  async function handleQboExceptionAction(event) {
    const button = event.target.closest("[data-qbo-action]");
    if (!button) return;
    const item = button.closest(".qbo-exception-item");
    const note = item.querySelector(".qbo-exception-result");
    const action = button.dataset.qboAction;
    const rows = [...document.querySelectorAll(".qbo-exception-item")];
    button.disabled = true;
    note.textContent = "Working…";
    try {
      let idsToRecheck = [button.dataset.invoice];
      if (action === "map-customer") {
        const typed = item.querySelector('[data-qbo-field="customer"]').value.trim();
        const customer = (qboFixOptions?.customers || []).find((c) => c.displayName === typed);
        if (!customer) throw new Error("Pick a customer from the QuickBooks list.");
        await postJson("/api/automation/qbo-invoices/customer-mappings", { sourceAccount: button.dataset.account, qboCustomerId: customer.id });
        idsToRecheck = rows.filter((r) => r.dataset.kind === "customer" && r.dataset.account === button.dataset.account).map((r) => r.dataset.invoice);
      } else if (action === "save-tax") {
        const taxCodeId = item.querySelector('[data-qbo-field="tax"]').value;
        if (!taxCodeId) throw new Error("Choose a tax code first.");
        await postJson("/api/automation/qbo-invoices/tax-code", { taxCodeId });
        qboFixOptions = null;
        idsToRecheck = rows.filter((r) => r.dataset.kind === "tax").map((r) => r.dataset.invoice);
      }
      const results = await recheckQboInvoices(idsToRecheck);
      const mine = results.find((r) => r.sourceInvoiceId === button.dataset.invoice);
      await loadQboInvoiceLedger();
      await loadQboInvoiceExceptions();
      const fresh = [...document.querySelectorAll(".qbo-exception-item")].find((r) => r.dataset.invoice === button.dataset.invoice);
      const target = fresh ? fresh.querySelector(".qbo-exception-result") : null;
      if (target) target.textContent = mine ? `Still an exception: ${mine.reason || mine.status}` : "";
    } catch (error) {
      note.textContent = error.message || "That fix could not be applied.";
      button.disabled = false;
    }
  }
  async function loadQboInvoiceExceptions() {
    const container = $("#qboInvoiceSyncExceptions");
    const count = $("#qboInvoiceSyncExceptionCount");
    try {
      const data = await (await request("/api/automation/qbo-invoices/ledger?status=exception&limit=50")).json();
      const rows = data.rows || [];
      count.textContent = String(rows.length);
      container.innerHTML = rows.length
        ? `<div class="qbo-exception-list">${rows.map((row) => { const kind = qboExceptionKind(row.last_error || ""); return `<article class="qbo-exception-item" data-invoice="${escapeHtml(row.source_invoice_id)}" data-kind="${kind}" data-account="${escapeHtml(row.source_customer_account || "")}"><div class="qbo-exception-meta"><strong>Invoice ${escapeHtml(row.source_invoice_id)}</strong><span>${escapeHtml(row.source_customer_account || row.source_customer_name || "Unmatched customer")}</span></div><p>${escapeHtml(row.last_error || "No reason recorded.")}</p>${qboFixControls(row, kind)}<p class="qbo-exception-result" role="status"></p><small>Updated ${escapeHtml(formatSyncTime(row.updated_at))}</small></article>`; }).join("")}</div>`
        : "No exceptions are currently recorded.";
      if (rows.length) fillQboFixControls(container);
    } catch (error) {
      count.textContent = "—";
      container.textContent = error.message || "Unable to load exceptions for review.";
    }
  }
  async function loadQboInvoiceSyncStatus() {
    try { renderQboInvoiceSyncStatus(await (await request("/api/automation/qbo-invoices")).json()); }
    catch (error) { $("#qboInvoiceSyncDetail").textContent = error.message || "Unable to load QuickBooks sync status."; qboSyncButton.disabled = true; qboDryRunButton.disabled = true; }
  }
  async function runQboInvoiceSync(dryRun) {
    qboSyncButton.disabled = true; qboDryRunButton.disabled = true;
    $("#qboInvoiceSyncDetail").textContent = dryRun ? "Previewing eligible Innovations invoices…" : "Synchronizing invoices to QuickBooks…";
    try {
      const result = await (await postJson("/api/automation/qbo-invoices/run", { dryRun })).json();
      const c = result.counts || {};
      $("#qboInvoiceSyncDetail").textContent = `${dryRun ? "Preview" : "Sync"} complete: ${c.created || 0} created, ${c.updated || 0} updated, ${c.skipped || 0} skipped, ${c.exception || 0} exceptions.`;
      await loadQboInvoiceSyncStatus();
      await loadQboInvoiceLedger();
      await loadQboInvoiceExceptions();
    } catch (error) { $("#qboInvoiceSyncDetail").textContent = error.message || "QuickBooks invoice sync failed."; qboSyncButton.disabled = false; qboDryRunButton.disabled = false; }
  }

  document.querySelectorAll(".workflow-tabs button").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".workflow-tabs button").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelectorAll(".workflow-panel").forEach((panel) => panel.classList.toggle("active", panel.id === button.dataset.tab));
    updateAutomationCrumb(button);
  }));
  ["patientMode", "lensMode", "prescriptionMode", "coatingMode"].forEach((name) => form.elements[name].addEventListener("change", toggleConditionalFields));
  ["lensSupplier", "lensCatalog", "lensOption"].forEach((name) => form.elements[name].addEventListener("change", syncLensOptions));
  $("#previewRx").addEventListener("click", () => run(preview));
  $("#saveRxSettings").addEventListener("click", () => run(saveOrderSettings));
  $("#stageRx").addEventListener("click", () => run(stage));
  $("#downloadRx").addEventListener("click", () => run(download));
  $("#releaseRx").addEventListener("click", () => run(release));
  $("#qboInvoiceSyncExceptions").addEventListener("click", handleQboExceptionAction);
  qboSyncButton.addEventListener("click", () => runQboInvoiceSync(false));
  qboDryRunButton.addEventListener("click", () => runQboInvoiceSync(true));
  toggleConditionalFields();
  load();
  loadQboInvoiceSyncStatus();
  loadQboInvoiceLedger();
  loadQboInvoiceExceptions();
})();
