(() => {
  const state = { orders: [], current: null, pollTimer: null, customerTimer: null, selectedCustomer: null, canWrite: false, canRelease: false, userId: null, username: "" };
  const $ = (selector) => document.querySelector(selector);
  const screens = [...document.querySelectorAll(".screen")];
  const pathLabels = {
    "patient.name": "Patient name",
    "patient.reference": "Patient reference",
    "prescription.od.sphere": "OD sphere",
    "prescription.od.cylinder": "OD cylinder",
    "prescription.od.axis": "OD axis",
    "prescription.od.add": "OD ADD",
    "prescription.od.prism": "OD prism",
    "prescription.od.base": "OD base",
    "prescription.os.sphere": "OS sphere",
    "prescription.os.cylinder": "OS cylinder",
    "prescription.os.axis": "OS axis",
    "prescription.os.add": "OS ADD",
    "prescription.os.prism": "OS prism",
    "prescription.os.base": "OS base",
    "pd.type": "PD type",
    "pd.binocular": "Binocular PD",
    "pd.od": "OD PD",
    "pd.os": "OS PD",
    "pd.nearOd": "Near OD PD",
    "pd.nearOs": "Near OS PD",
    "lensRequest.lensType": "Lens type",
    "lensRequest.design": "Lens design",
    "lensRequest.material": "Lens material",
    "lensRequest.option": "Lens option",
    "lensRequest.coating": "Lens coating",
    "frame.status": "Frame workflow",
    "frame.model": "Frame model",
    "frame.color": "Frame color",
    "frame.a": "Frame A",
    "frame.b": "Frame B",
    "frame.dbl": "Frame DBL",
    "frame.ed": "Frame ED",
    "frame.segHeightOd": "OD segment height",
    "frame.segHeightOs": "OS segment height"
  };

  async function init() {
    try {
      const auth = await api("/api/auth/me");
      $("#currentUser").textContent = auth.user?.displayName || auth.user?.username || "";
      state.userId = auth.user?.userId || null;
      state.username = auth.user?.username || auth.user?.displayName || "";
      state.canWrite = (auth.user?.permissions || []).includes("rx-capture.write");
      state.canRelease = (auth.user?.permissions || []).includes("rx-capture.release");
      $("#newRxButton").hidden = !state.canWrite;
      $("#saveReviewButton").hidden = !state.canWrite;
      wireEvents();
      await loadOrders();
    } catch (error) {
      if (error.status === 401) location.assign("/");
      else showNotice(error.message, true);
    }
  }

  function wireEvents() {
    $("#newRxButton").addEventListener("click", () => showScreen("captureScreen"));
    $("#refreshOrdersButton").addEventListener("click", loadOrders);
    document.querySelectorAll("[data-back]").forEach((button) => button.addEventListener("click", async () => {
      stopPolling();
      showScreen("ordersScreen");
      await loadOrders();
    }));
    $("#logoutButton").addEventListener("click", async () => {
      await api("/api/auth/logout", { method: "POST" }).catch(() => {});
      location.assign("/");
    });
    $("#primaryImage").addEventListener("change", () => previewFile("primaryImage", "primaryPreview", "primaryFileName"));
    $("#secondaryImage").addEventListener("change", () => previewFile("secondaryImage", "secondaryPreview", "secondaryFileName"));
    $("#customerSearch").addEventListener("input", searchCustomers);
    $("#captureForm").addEventListener("submit", submitCapture);
    $("#reviewForm").addEventListener("submit", saveReview);
    $("#resolutionForm").addEventListener("submit", saveResolution);
    $("#reprocessButton").addEventListener("click", reprocess);
    $("#submitOrderButton").addEventListener("click", submitOrder);
    document.querySelectorAll("[data-path]").forEach((input) => input.addEventListener("input", () => resolveIssue(input.dataset.path)));
  }

  async function loadOrders() {
    const payload = await api("/api/rx-capture/orders?limit=30");
    state.orders = payload.orders || [];
    const list = $("#ordersList");
    list.replaceChildren(...state.orders.map((order) => orderButton(order)));
    $("#ordersEmpty").hidden = state.orders.length > 0;
  }

  function orderRow(order, onClick = () => openOrder(order.id)) {
    const row = document.createElement("tr");
    row.className = "order-row";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `Open ${order.patientName || "prescription"}`);
    const patient = document.createElement("strong");
    patient.textContent = order.patientName || "Patient not identified";
    const patientCell = document.createElement("td");
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "order-link";
    openButton.append(patient);
    const status = document.createElement("span");
    status.className = "status-pill";
    status.dataset.status = order.status;
    status.textContent = statusLabel(order.status);
    const dateCell = document.createElement("td");
    dateCell.className = "order-meta";
    dateCell.textContent = formatDate(order.createdAt);
    const statusCell = document.createElement("td");
    statusCell.append(status);
    patientCell.append(openButton);
    row.append(patientCell, dateCell, statusCell);
    row.addEventListener("click", onClick);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onClick();
      }
    });
    openButton.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return row;
  }

  function orderButton(order, onClick) {
    return orderRow(order, onClick);
  }

  async function submitCapture(event) {
    event.preventDefault();
    const primary = $("#primaryImage").files[0];
    const secondary = $("#secondaryImage").files[0];
    if (!state.selectedCustomer) return showNotice("Select the ERP customer before submitting the prescription.", true);
    if (!primary) return showNotice("Choose a prescription image first.", true);
    const button = $("#submitCaptureButton");
    button.disabled = true;
    button.textContent = "PREPARING IMAGE…";
    try {
      const images = [];
      for (const file of [primary, secondary].filter(Boolean)) {
        images.push({ name: file.name, dataUrl: await imageDataUrl(file) });
      }
      button.textContent = "SUBMITTING…";
      const payload = await api("/api/rx-capture/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images, customer: state.selectedCustomer })
      });
      $("#captureForm").reset();
      clearSelectedCustomer();
      clearPreview("primaryPreview", "primaryFileName");
      clearPreview("secondaryPreview", "secondaryFileName");
      await showOrder(payload.order);
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = "SUBMIT FOR EXTRACTION";
    }
  }

  async function openOrder(id) {
    try {
      const payload = await api(`/api/rx-capture/orders/${encodeURIComponent(id)}`);
      await showOrder(payload.order);
    } catch (error) {
      showNotice(error.message, true);
    }
  }

  async function showOrder(order) {
    state.current = order;
    const canEdit = state.canWrite && String(order.createdByUserId || "").toLowerCase() === String(state.userId || "").toLowerCase();
    showScreen("reviewScreen");
    $("#reviewStatus").dataset.status = order.status;
    $("#reviewStatus").textContent = statusLabel(order.status);
    $("#processingPanel").hidden = order.status !== "PROCESSING";
    $("#failedPanel").hidden = order.status !== "FAILED";
    $("#reviewForm").hidden = !order.normalizedOrder || order.status === "PROCESSING";
    const failureMessage = order.errorMessage || "Try the extraction again or create a new capture.";
    $("#failedMessage").textContent = order.normalizedOrder
      ? `${failureMessage} The last saved values remain available below for review.`
      : failureMessage;
    $("#reprocessButton").hidden = !canEdit;
    $("#saveReviewButton").hidden = !canEdit;
    document.querySelectorAll("#reviewForm [data-path]").forEach((input) => { input.disabled = !canEdit; });
    if (order.normalizedOrder) renderOrder(order.normalizedOrder);
    await renderResolution(order, canEdit);
    renderApprovalActions(order);
    stopPolling();
    if (order.status === "PROCESSING") state.pollTimer = setTimeout(pollCurrentOrder, 1800);
  }

  async function pollCurrentOrder() {
    if (!state.current) return;
    try {
      const payload = await api(`/api/rx-capture/orders/${encodeURIComponent(state.current.id)}`);
      await showOrder(payload.order);
    } catch (error) {
      showNotice(error.message, true);
    }
  }

  function renderOrder(order) {
    order.frame ||= {};
    order.frame.status ||= "TO_BE_TRACED";
    if (order.frame.supplied == null) order.frame.supplied = order.frame.status !== "UNCUT";
    document.querySelectorAll("[data-path]").forEach((input) => {
      input.value = valueAtPath(order, input.dataset.path) ?? "";
      input.classList.remove("missing", "uncertain");
    });
    for (const path of effectiveMissingFields(order)) fieldForPath(path)?.classList.add("missing");
    for (const path of order.uncertainFields || []) fieldForPath(path)?.classList.add("uncertain");
    renderIssues(order);
  }

  async function renderResolution(order, canEdit) {
    const canConfigure = canEdit && order.status === "READY_FOR_REVIEW" && Boolean(order.reviewConfirmedAt);
    $("#resolutionForm").hidden = !canConfigure;
    if (!canConfigure) return;
    const values = order.resolution || {};
    for (const field of $("#resolutionForm").elements) {
      if (!field.name) continue;
      if (field.name === "addonSkus") field.value = (values.addonSkus || []).join(", ");
      else if (field.name === "remoteOperator") field.value = state.username;
      else if (field.name === "customerNumber") field.value = order.customer?.account || values.customerNumber || "";
      else if (field.name === "shipName") field.value = values.shipName || order.customer?.name || "";
      else field.value = values[field.name] ?? "";
    }
    try {
      const payload = await api(`/api/rx-capture/orders/${encodeURIComponent(order.id)}/alias-suggestion`);
      const suggestion = payload.suggestion || {};
      const field = $("#resolutionForm").elements.lensAlias;
      const notice = $("#aliasSuggestion");
      notice.replaceChildren();
      const summary = document.createElement("p");
      summary.textContent = suggestion.reason || "Choose an active catalogue lens.";
      notice.append(summary);
      if (suggestion.status === "suggested" && suggestion.suggestedAlias && !field.value) field.value = suggestion.suggestedAlias;
      const candidates = suggestion.candidates || [];
      if (candidates.length) {
        const list = document.createElement("div");
        list.className = "alias-candidates";
        for (const candidate of candidates) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "alias-candidate";
          const label = document.createElement("strong");
          label.textContent = candidate.label || [candidate.type, candidate.material, candidate.design, candidate.color].filter(Boolean).join(" · ");
          const hint = document.createElement("small");
          hint.textContent = "Use this active catalogue lens";
          button.append(label, hint);
          button.addEventListener("click", () => {
            field.value = candidate.alias;
            summary.textContent = `Selected: ${label.textContent}. The exact alias has been filled for this production configuration.`;
            list.querySelectorAll(".alias-candidate").forEach((item) => item.classList.toggle("selected", item === button));
          });
          list.append(button);
        }
        notice.append(list);
      }
      notice.hidden = false;
    } catch (error) {
      showNotice(error.message, true);
    }
    await loadCoatings(values.coatingSku || "");
  }

  function renderApprovalActions(order) {
    const visible = (state.canWrite && state.canRelease && order.status === "READY_FOR_REVIEW" && order.resolution) || order.status === "RELEASED";
    $("#approvalActions").hidden = !visible;
    if (!visible) return;
    if (order.status === "RELEASED") $("#approvalMessage").textContent = `Released ${order.generatedFilename || "RX file"} to Innovations. The approved copy is archived.`;
    else $("#approvalMessage").textContent = "Submitting creates the RX file, stages it, and sends it to Innovations. The order can continue to be edited there.";
  }

  function renderIssues(order) {
    const issues = [
      ...effectiveMissingFields(order).map((path) => ({ path, kind: "Missing" })),
      ...(order.uncertainFields || []).map((path) => ({ path, kind: "Uncertain" }))
    ];
    $("#issuesCard").hidden = issues.length === 0;
    $("#issuesList").replaceChildren(...issues.map((issue) => {
      const item = document.createElement("li");
      item.textContent = `${issue.kind}: ${pathLabels[issue.path] || issue.path}`;
      return item;
    }));
  }

  function effectiveMissingFields(order) {
    return (order.missingFields || []).filter((path) => {
      if (/^(frame|lensRequest)\./.test(path)) return false;
      if (/^prescription\.(od|os)\.(prism|base)$/.test(path)) return false;
      if (/^prescription\.(od|os)\.add$/.test(path)) return requiresAddPower(order);
      return true;
    });
  }

  function requiresAddPower(order) {
    const description = [order.lensRequest?.lensType, order.lensRequest?.design].filter(Boolean).join(" ");
    if (/\b(single[ -]?vision|sv)\b/i.test(description)) return false;
    return /\b(progressive|bifocal|trifocal|multifocal|occupational)\b/i.test(description);
  }

  function resolveIssue(path) {
    if (!state.current?.normalizedOrder) return;
    const input = fieldForPath(path);
    if (!input || !String(input.value).trim()) return;
    state.current.normalizedOrder.missingFields = (state.current.normalizedOrder.missingFields || []).filter((item) => item !== path);
    state.current.normalizedOrder.uncertainFields = (state.current.normalizedOrder.uncertainFields || []).filter((item) => item !== path);
    input.classList.remove("missing", "uncertain");
    renderIssues(state.current.normalizedOrder);
  }

  async function saveReview(event) {
    event.preventDefault();
    if (!state.current?.normalizedOrder) return;
    const order = JSON.parse(JSON.stringify(state.current.normalizedOrder));
    document.querySelectorAll("[data-path]").forEach((input) => setAtPath(order, input.dataset.path, input.value.trim() || null));
    order.patient.name = normalizePatientName(order.patient.name);
    fieldForPath("patient.name").value = order.patient.name || "";
    order.frame.supplied = order.frame.status !== "UNCUT";
    const button = $("#saveReviewButton");
    button.disabled = true;
    try {
      const payload = await api(`/api/rx-capture/orders/${encodeURIComponent(state.current.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ normalizedOrder: order })
      });
      await showOrder(payload.order);
      showNotice("Draft saved. You can continue it now or return later.");
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  async function reprocess() {
    if (!state.current) return;
    try {
      const payload = await api(`/api/rx-capture/orders/${encodeURIComponent(state.current.id)}/reprocess`, { method: "POST" });
      await showOrder(payload.order);
    } catch (error) {
      showNotice(error.message, true);
    }
  }

  async function saveResolution(event) {
    event.preventDefault();
    if (!state.current) return;
    const form = new FormData($("#resolutionForm"));
    const resolution = Object.fromEntries(form.entries());
    resolution.addonSkus = String(resolution.addonSkus || "").split(",").map((value) => value.trim()).filter(Boolean);
    const button = $("#saveResolutionButton");
    button.disabled = true;
    try {
      const payload = await api(`/api/rx-capture/orders/${encodeURIComponent(state.current.id)}/resolution`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resolution })
      });
      await showOrder(payload.order);
      showNotice("Submission choices saved. You can submit this draft to Innovations.");
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  async function submitOrder() {
    if (!state.current) return;
    if (!window.confirm("Submit this RX draft to Innovations? It will be staged and released, then remain editable in Innovations.")) return;
    const button = $("#submitOrderButton");
    button.disabled = true;
    try {
      const payload = await api(`/api/rx-capture/orders/${encodeURIComponent(state.current.id)}/submit`, { method: "POST" });
      await showOrder(payload.order);
      showNotice("RX draft submitted to Innovations and archived.");
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  async function loadCoatings(selectedSku) {
    const field = $("#resolutionForm").elements.coatingSku;
    if (!field) return;
    try {
      const payload = await api("/api/rx-capture/coatings");
      const options = [new Option("No coating selected", "")];
      for (const item of payload.items || []) options.push(new Option(item.description, item.sku));
      field.replaceChildren(...options);
      field.value = selectedSku;
    } catch (error) {
      showNotice(`Coating choices are unavailable: ${error.message}`, true);
    }
  }

  async function imageDataUrl(file) {
    if (file.size > 18 * 1024 * 1024) throw new Error("Choose an image smaller than 18 MB.");
    const sourceUrl = await fileToDataUrl(file);
    try {
      const image = await loadImage(sourceUrl);
      const maxDimension = 2200;
      const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", .9);
    } catch {
      if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
        throw new Error("This phone could not convert that image. Use a JPEG or PNG photo.");
      }
      return sourceUrl;
    }
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function previewFile(inputId, previewId, nameId) {
    const file = $(`#${inputId}`).files[0];
    const preview = $(`#${previewId}`);
    if (!file) return clearPreview(previewId, nameId);
    $(`#${nameId}`).textContent = file.name;
    try {
      preview.src = await fileToDataUrl(file);
      preview.hidden = false;
    } catch {
      preview.hidden = true;
    }
  }

  function clearPreview(previewId, nameId) {
    const preview = $(`#${previewId}`);
    preview.removeAttribute("src");
    preview.hidden = true;
    $(`#${nameId}`).textContent = "";
  }

  function showScreen(id) {
    screens.forEach((screen) => screen.classList.toggle("active", screen.id === id));
    document.body.dataset.screen = id;
    window.scrollTo({ top: 0, behavior: "instant" });
    $("#globalStatus").hidden = true;
  }

  function showNotice(message, isError = false) {
    const notice = $("#globalStatus");
    notice.textContent = message;
    notice.className = `notice${isError ? " error" : ""}`;
    notice.hidden = false;
  }

  function stopPolling() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  function valueAtPath(object, path) {
    return path.split(".").reduce((value, key) => value?.[key], object);
  }

  function setAtPath(object, path, value) {
    const keys = path.split(".");
    const final = keys.pop();
    const target = keys.reduce((current, key) => current[key], object);
    target[final] = path.endsWith(".axis") && value !== null ? Number(value) : value;
  }

  function fieldForPath(path) {
    return [...document.querySelectorAll("[data-path]")].find((input) => input.dataset.path === path) || null;
  }

  function statusLabel(status) {
    if (status === "READY_FOR_REVIEW") return "READY TO SUBMIT";
    return String(status || "NEW").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  async function searchCustomers() {
    const query = $("#customerSearch").value.trim();
    state.selectedCustomer = null;
    renderSelectedCustomer();
    clearTimeout(state.customerTimer);
    if (query.length < 2) return renderCustomerResults([]);
    state.customerTimer = setTimeout(async () => {
      try {
        const payload = await api(`/api/rx-capture/customers?q=${encodeURIComponent(query)}`);
        if ($("#customerSearch").value.trim() === query) renderCustomerResults(payload.customers || []);
      } catch (error) {
        renderCustomerResults([]);
        showNotice(error.message, true);
      }
    }, 180);
  }

  function renderCustomerResults(customers) {
    const results = $("#customerResults");
    results.replaceChildren(...customers.map((customer) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "customer-result";
      button.setAttribute("role", "option");
      button.innerHTML = "";
      const name = document.createElement("strong");
      name.textContent = customer.name;
      const detail = document.createElement("small");
      detail.textContent = `${customer.account} · ID ${customer.id}`;
      button.append(name, detail);
      button.addEventListener("click", () => {
        state.selectedCustomer = customer;
        $("#customerSearch").value = customer.name;
        renderSelectedCustomer();
        renderCustomerResults([]);
      });
      return button;
    }));
    results.hidden = customers.length === 0;
  }

  function renderSelectedCustomer() {
    const selected = $("#selectedCustomer");
    if (!state.selectedCustomer) {
      selected.textContent = "Search and select the customer before taking the prescription photo.";
      selected.classList.remove("is-selected");
      return;
    }
    selected.textContent = `Selected: ${state.selectedCustomer.name} (${state.selectedCustomer.account}, ID ${state.selectedCustomer.id})`;
    selected.classList.add("is-selected");
  }

  function clearSelectedCustomer() {
    state.selectedCustomer = null;
    renderCustomerResults([]);
    renderSelectedCustomer();
  }

  function normalizePatientName(value) {
    const name = String(value || "").trim().replace(/\s+/g, " ");
    if (!name) return null;
    if (name.includes(",")) {
      const [last, ...first] = name.split(",");
      return first.join(" ").trim() ? `${last.trim()}, ${first.join(" ").trim()}` : last.trim();
    }
    const parts = name.split(" ");
    if (parts.length < 2) return name;
    const last = parts.pop();
    return `${last}, ${parts.join(" ")}`;
  }

  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || `Request failed (${response.status}).`), { status: response.status });
    return payload;
  }

  init();
})();
