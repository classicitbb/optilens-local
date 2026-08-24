(() => {
  const form = document.getElementById("rxForm");
  if (!form) return;

  const state = { catalog: [], stagedFiles: [] };
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const status = $("#rxStatus");
  const lensStatusSyncButton = $("#runLensStatusSync");
  const lensStatusSyncNotice = $("#lensStatusSyncNotice");
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
    if (crumb) crumb.textContent = button?.dataset.tab === "supplier-email" ? "OS Lab Status Update Inbox" : "Automation";
  }

  function formatSyncTime(value) {
    if (!value) return "Not recorded";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
  }

  function setLensStatusSyncNotice(message, kind = "") {
    lensStatusSyncNotice.textContent = message;
    lensStatusSyncNotice.className = `scheduled-notice show ${kind}`;
  }

  function renderLensStatusSyncStatus(sync) {
    $("#lensStatusSyncDetail").textContent = sync.detail;
    $("#lensStatusSyncSchedule").textContent = `Every ${sync.intervalMinutes} minutes`;
    $("#lensStatusSyncTaskState").textContent = sync.running ? "Running" : (sync.task?.state || "Not installed");
    $("#lensStatusSyncNextRun").textContent = formatSyncTime(sync.task?.nextRun);
    $("#lensStatusSyncLastRun").textContent = formatSyncTime(sync.lastRun);
    lensStatusSyncButton.disabled = Boolean(sync.running);
    lensStatusSyncButton.textContent = sync.running ? "Running…" : "Run now";
    setLensStatusSyncNotice(sync.detail, sync.state === "error" ? "error" : sync.state === "warning" ? "warning" : "success");
  }

  async function loadLensStatusSyncStatus() {
    try {
      const response = await request("/api/automation/actian-lens-status-sync");
      renderLensStatusSyncStatus(await response.json());
    } catch (error) {
      lensStatusSyncButton.disabled = true;
      setLensStatusSyncNotice(error.message || "Unable to load the scheduled-task status.", "error");
    }
  }

  async function runLensStatusSync() {
    lensStatusSyncButton.disabled = true;
    lensStatusSyncButton.textContent = "Running…";
    setLensStatusSyncNotice("Comparing Actian and Innovations SQL Server status flags…");
    try {
      const response = await postJson("/api/automation/actian-lens-status-sync/run", {});
      const result = await response.json();
      const updated = Object.values(result.updated || {}).reduce((total, value) => total + Number(value || 0), 0);
      setLensStatusSyncNotice(`Completed: ${updated} status correction${updated === 1 ? "" : "s"}; ${result.plannedUpdates || 0} difference${result.plannedUpdates === 1 ? "" : "s"} found.`, "success");
      await loadLensStatusSyncStatus();
    } catch (error) {
      setLensStatusSyncNotice(error.message || "The lens status sync could not complete.", "error");
      lensStatusSyncButton.disabled = false;
      lensStatusSyncButton.textContent = "Run now";
    }
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
  async function loadQboInvoiceExceptions() {
    const container = $("#qboInvoiceSyncExceptions");
    const count = $("#qboInvoiceSyncExceptionCount");
    try {
      const data = await (await request("/api/automation/qbo-invoices/ledger?status=exception&limit=50")).json();
      const rows = data.rows || [];
      count.textContent = String(rows.length);
      container.innerHTML = rows.length
        ? `<div class="qbo-exception-list">${rows.map((row) => `<article class="qbo-exception-item"><div class="qbo-exception-meta"><strong>Invoice ${escapeHtml(row.source_invoice_id)}</strong><span>${escapeHtml(row.source_customer_account || row.source_customer_name || "Unmatched customer")}</span></div><p>${escapeHtml(row.last_error || "No reason recorded.")}</p><small>Updated ${escapeHtml(formatSyncTime(row.updated_at))}</small></article>`).join("")}</div>`
        : "No exceptions are currently recorded.";
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
  lensStatusSyncButton.addEventListener("click", runLensStatusSync);
  qboSyncButton.addEventListener("click", () => runQboInvoiceSync(false));
  qboDryRunButton.addEventListener("click", () => runQboInvoiceSync(true));
  toggleConditionalFields();
  load();
  loadLensStatusSyncStatus();
  loadQboInvoiceSyncStatus();
  loadQboInvoiceLedger();
  loadQboInvoiceExceptions();
})();
