(() => {
  const state = { orders: [], current: null, pollTimer: null, customerTimer: null, selectedCustomer: null, canWrite: false, canRelease: false, userId: null, username: "", catalog: null, coatings: null, lensLabels: {}, lensCombos: {}, images: {} };
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
    "lensRequest.materialGroup": "Material group",
    "lensRequest.design": "Lens design",
    "lensRequest.material": "Lens material",
    "lensRequest.option": "Lens option",
    "lensRequest.coating": "Lens coating",
    "lensRequest.coatingSku": "Lens coating",
    "lensRequest.catalogAlias": "Active lens",
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
    // Camera and gallery inputs share one image per slot; the latest pick wins.
    document.querySelectorAll("[data-image-input]").forEach((input) => input.addEventListener("change", () => {
      const file = input.files[0];
      if (!file) return;
      state.images[input.dataset.imageInput] = file;
      input.value = "";
      previewFile(input.dataset.imageInput);
    }));
    $("#manualEntryButton").addEventListener("click", startManualEntry);
    $("#ownLensButton").addEventListener("click", chooseOwnLenses);
    $("#customerSearch").addEventListener("input", searchCustomers);
    $("#customerSearch").addEventListener("keydown", customerSearchKeys);
    $("#customerSearch").addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== $("#customerSearch")) renderCustomerResults([]); }, 150));
    window.addEventListener("scroll", positionCustomerResults, true);
    window.addEventListener("resize", positionCustomerResults);
    $("#captureForm").addEventListener("submit", submitCapture);
    // The review form has no submit button, so Enter never saves by accident;
    // saving and submitting are explicit (buttons or Ctrl+S / Ctrl+Enter).
    $("#reviewForm").addEventListener("submit", (event) => event.preventDefault());
    $("#reviewForm").addEventListener("keydown", advanceOnEnter);
    $("#saveReviewButton").addEventListener("click", saveReview);
    $("#reprocessButton").addEventListener("click", reprocess);
    $("#submitOrderButton").addEventListener("click", submitOrder);
    $("#addMeasurementsButton").addEventListener("click", () => {
      state.measurementsOpened = true;
      renderFrameState();
      fieldForPath("frame.a").focus();
    });
    document.addEventListener("keydown", reviewShortcuts);
    // Every dropdown uses the website's combo list; Enter on a pick moves on.
    document.querySelectorAll("#reviewForm select").forEach((select) => window.RxCombo.select(select, { onAdvance: (field) => focusNextField(field) }));
    document.querySelectorAll("[data-lens]").forEach((input) => {
      const key = input.dataset.lens;
      state.lensCombos[key] = window.RxCombo.combo(input, {
        items: () => state.lensLabels[key] || [],
        allItems: () => [...(state.lensUniverse?.[key] || [])].sort(compareLensValues(key)),
        pinned: key === "design" ? isOwnLensDesign : undefined,
        onAdvance: (field) => focusNextField(field),
        synonyms: LENS_SHORTHAND
      });
      input.addEventListener("input", () => onLensInput(input.dataset.lens));
      input.addEventListener("change", () => onLensCommit(input.dataset.lens));
    });
    document.querySelectorAll("[data-path]").forEach((input) => {
      const update = () => {
        resolveIssue(input.dataset.path);
        if (input.dataset.path === "frame.status") renderFrameState();
        runValidation();
      };
      input.addEventListener("input", update);
      input.addEventListener("change", update);
      if (input.tagName === "INPUT" && !input.readOnly) {
        input.addEventListener("blur", () => {
          const formatted = window.RxValidation.formatField(input.dataset.path, input.value);
          if (formatted !== input.value) input.value = formatted;
          runValidation();
        });
      }
    });
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
    const { primary, secondary } = state.images;
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
      resetCapture();
      await showOrder(payload.order);
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = "SUBMIT FOR EXTRACTION";
    }
  }

  // Manual entry: same customer check, no photo, straight to an empty review.
  async function startManualEntry() {
    if (!state.selectedCustomer) {
      showNotice("Select the ERP customer before entering the prescription.", true);
      $("#customerSearch").focus();
      return;
    }
    const button = $("#manualEntryButton");
    button.disabled = true;
    try {
      const payload = await api("/api/rx-capture/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manual: true, customer: state.selectedCustomer })
      });
      resetCapture();
      await showOrder(payload.order);
      fieldForPath("patient.name")?.focus();
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  function resetCapture() {
    $("#captureForm").reset();
    clearSelectedCustomer();
    state.images = {};
    previewFile("primary");
    previewFile("secondary");
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
    const editable = canEdit && !["APPROVED", "RX_GENERATED", "STAGED", "RELEASED"].includes(order.status);
    state.canEdit = editable;
    state.lensResolved = null;
    state.lastValidation = null;
    if (state.current?.id !== state.renderedOrderId) state.measurementsOpened = false;
    state.renderedOrderId = order.id;
    $("#reprocessButton").hidden = !editable;
    $("#saveReviewButton").hidden = !editable;
    document.querySelectorAll("#reviewForm :is(input, select, textarea)").forEach((input) => { input.disabled = !editable; });
    if (order.normalizedOrder) {
      renderOrder(order.normalizedOrder);
      renderFrameState();
      await renderLensSelection(order);
      renderSubmission(order);
    }
    runValidation();
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
    order.frame.mounting ||= "1";
    if (order.frame.supplied == null) order.frame.supplied = order.frame.status !== "UNCUT";
    document.querySelectorAll("[data-path]").forEach((input) => {
      input.value = valueAtPath(order, input.dataset.path) ?? "";
      input.classList.remove("missing", "uncertain");
    });
    for (const path of effectiveMissingFields(order)) fieldForPath(path)?.classList.add("missing");
    for (const path of order.uncertainFields || []) fieldForPath(path)?.classList.add("uncertain");
    renderIssues(order);
  }

  // Lens selection mirrors the CV website rx-order form: material, design and
  // colour option are three linked choices over the active group-1 catalogue,
  // each narrowing the other two. Every complete choice is exactly one alias.
  const LENS_KEYS = ["material", "design", "option"];
  const LENS_LABELS = { material: "material", design: "design", option: "colour option" };
  const LENS_TYPE_ORDER = ["Single Vision", "Bifocal", "Trifocal", "Progressive"];
  // Shorthand operators type, as it appears on prescriptions and order sheets.
  const LENS_SHORTHAND = {
    ft: ["flat"], rd: ["round"], sv: ["single", "singlevision"], bf: ["bifocal"], tf: ["trifocal"],
    pal: ["progressive"], prog: ["progressive"], pc: ["poly"], polycarbonate: ["poly"],
    cr39: ["plastic"], cr: ["plastic"], hi: ["1.67", "1.74"], trans: ["transitions"], transitions: ["trans"],
    grey: ["gray"], photo: ["photochromic"], ar: ["ar", "hmc", "shmc"], uc: ["uncoated", "unc"], src: ["srcoated", "src"]
  };
  const lensInput = (key) => $(`#lens${key[0].toUpperCase()}${key.slice(1)}`);
  const setLensValue = (key, value) => { lensInput(key).value = value || ""; state.lensCombos?.[key]?.setCommitted(value || ""); };
  const designLabel = (item) => [item.lensType, item.style].filter(Boolean).join(" · ");
  const lensValue = (item, key) => (key === "material" ? item.material : key === "design" ? designLabel(item) : item.option);

  async function loadCatalog() {
    if (state.catalog) return;
    const [catalogPayload, coatingPayload] = await Promise.all([api("/api/rx-capture/catalog"), api("/api/rx-capture/coatings")]);
    state.catalog = (catalogPayload.items || []).filter((item) => String(item.materialGroupCode || "1") === "1");
    state.coatings = coatingPayload.items || [];
    state.lensUniverse = Object.fromEntries(LENS_KEYS.map((key) => [key, new Set(state.catalog.map((item) => lensValue(item, key)).filter(Boolean))]));
  }

  async function renderLensSelection(order) {
    const request = order.normalizedOrder.lensRequest ||= {};
    try {
      await loadCatalog();
    } catch (error) {
      showNotice(`Catalogue choices are unavailable: ${error.message}`, true);
      return;
    }
    fillOptions(fieldForPath("lensRequest.coatingSku"), state.coatings.map((item) => ({ value: item.sku, label: item.description })), request.coatingSku, "No coating selected");
    renderLensEvidence(order.extractedOrder?.lensRequest);
    let values = knownLensValues(lensValuesFromRequest(request));
    let guessed = Boolean(order.normalizedOrder.lensGuessed);
    if (!LENS_KEYS.some((key) => values[key]) && state.canEdit) {
      try {
        const payload = await api(`/api/rx-capture/orders/${encodeURIComponent(order.id)}/alias-suggestion`);
        const guess = payload.suggestion?.guess;
        if (guess) {
          values = knownLensValues({ material: guess.material, design: designLabel(guess), option: guess.option });
          guessed = LENS_KEYS.some((key) => values[key]);
        }
      } catch { /* the employee chooses from the lists instead */ }
    }
    for (const key of LENS_KEYS) {
      setLensValue(key, values[key]);
      lensInput(key).classList.toggle("guessed", guessed && Boolean(values[key]));
    }
    $("#lensGuessNote").hidden = !guessed;
    $("#ownLensButton").hidden = !state.canEdit || ![...state.lensUniverse.design].some(isOwnLensDesign);
    refreshLensLists();
  }

  function lensValuesFromRequest(request) {
    const byAlias = request.catalogAlias && state.catalog.find((item) => item.alias === String(request.catalogAlias));
    const source = byAlias || request;
    return { material: source.material, design: source.style ? designLabel(source) : "", option: source.option };
  }

  function knownLensValues(values) {
    return Object.fromEntries(LENS_KEYS.map((key) => [key, state.lensUniverse[key].has(values[key]) ? values[key] : ""]));
  }

  function renderLensEvidence(printed) {
    const parts = ["lensType", "design", "material", "option", "coating"].map((key) => String(printed?.[key] || "").trim()).filter(Boolean);
    const evidence = $("#lensEvidence");
    evidence.hidden = parts.length === 0;
    evidence.replaceChildren();
    if (!parts.length) return;
    const label = document.createElement("strong");
    label.textContent = "Printed on prescription: ";
    evidence.append(label, parts.join(" · "));
  }

  // A choice only narrows the others once it matches a catalogue value exactly;
  // half-typed search text is ignored until it is picked from the list.
  function lensChoices() {
    return Object.fromEntries(LENS_KEYS.map((key) => {
      const value = lensInput(key).value.trim();
      return [key, state.lensUniverse?.[key].has(value) ? value : ""];
    }));
  }

  function lensMatches(choices, except) {
    return state.catalog.filter((item) => LENS_KEYS.every((key) => key === except || !choices[key] || lensValue(item, key) === choices[key]));
  }

  function compareLensValues(key) {
    if (key !== "design") return (left, right) => left.localeCompare(right, undefined, { numeric: true });
    // Customer-supplied designs lead the list: they are the most common job.
    const rank = (value) => {
      if (isOwnLensDesign(value)) return -1;
      const index = LENS_TYPE_ORDER.indexOf(value.split(" · ")[0]);
      return index === -1 ? LENS_TYPE_ORDER.length : index;
    };
    return (left, right) => rank(left) - rank(right) || left.localeCompare(right, undefined, { numeric: true });
  }


  // Innovations spells the customer-supplied style both "Custom Lens" and "Custom lens".
  const isOwnLensDesign = (label) => / · custom lens$/i.test(label);

  // One action for the usual job: switch the design to the customer-supplied
  // ("Custom Lens") design of the current lens type, keeping material and
  // colour where they still fit; the normal conflict repair clears the rest.
  function chooseOwnLenses() {
    if (!state.catalog || !state.canEdit) return;
    const choices = lensChoices();
    const current = choices.design.split(" · ")[0] || state.current?.normalizedOrder?.lensRequest?.lensType || "";
    const designs = [...state.lensUniverse.design].filter(isOwnLensDesign);
    // Innovations has two spellings of the style with different colour lists;
    // take the one that keeps the most of the current material and colour.
    const fit = (label) => lensMatches({ ...choices, design: label }).length * 4 + lensMatches({ ...choices, option: "", design: label }).length;
    const best = (labels) => labels.sort((left, right) => fit(right) - fit(left))[0];
    const target = best(designs.filter((label) => label.startsWith(`${current} · `))) || best(designs.filter((label) => label.startsWith("Single Vision · "))) || designs[0];
    if (!target) return showNotice("No customer-supplied lens is available in the catalogue.", true);
    setLensValue("design", target);
    lensInput("design").classList.remove("guessed");
    onLensCommit("design");
    focusNextField(lensInput("design"));
  }

  function refreshLensLists() {
    if (!state.catalog) return;
    const choices = lensChoices();
    for (const key of LENS_KEYS) {
      const values = [...new Set(lensMatches(choices, key).map((item) => lensValue(item, key)).filter(Boolean))].sort(compareLensValues(key));
      state.lensLabels[key] = values;
      state.lensCombos?.[key]?.refresh();
    }
    const matches = lensMatches(choices);
    state.lensResolved = LENS_KEYS.every((key) => choices[key]) && matches.length
      ? [...matches].sort((left, right) => left.alias.localeCompare(right.alias))[0]
      : null;
    const design = choices.design ? state.catalog.find((item) => designLabel(item) === choices.design) : null;
    setHiddenPath("lensRequest.materialGroup", "1");
    setHiddenPath("lensRequest.material", choices.material);
    setHiddenPath("lensRequest.lensType", design?.lensType || "");
    setHiddenPath("lensRequest.style", design?.style || "");
    setHiddenPath("lensRequest.option", choices.option);
    setHiddenPath("lensRequest.catalogAlias", state.lensResolved?.alias || "");
    $("#ownLensButton").setAttribute("aria-pressed", String(isOwnLensDesign(choices.design)));
    $("#lensComboCount").textContent = `${matches.length} valid combination${matches.length === 1 ? "" : "s"}`;
    const summary = $("#lensSummary");
    summary.classList.toggle("resolved", Boolean(state.lensResolved));
    summary.replaceChildren();
    if (state.lensResolved) {
      const label = document.createElement("strong");
      label.textContent = [state.lensResolved.material, designLabel(state.lensResolved), state.lensResolved.option].join(" · ");
      const alias = document.createElement("span");
      alias.textContent = `Innovations alias ${state.lensResolved.alias}${state.lensResolved.customerSupplied ? " · customer-supplied lens" : ""}`;
      summary.append(label, alias);
    } else {
      summary.textContent = "Choose a material, design and colour option to identify the exact Innovations lens.";
    }
  }

  function setHiddenPath(path, value) {
    const input = fieldForPath(path);
    if (input) input.value = value || "";
  }

  function onLensInput(key) {
    lensInput(key).classList.remove("guessed");
    $("#lensGuessNote").hidden = !document.querySelector("[data-lens].guessed");
    refreshLensLists();
    runValidation();
  }

  // On commit, accept a case-insensitive match, then drop whichever other
  // choice conflicts (colour first, then design, then material) so the three
  // always describe a lens that exists, as the website form does.
  function onLensCommit(key) {
    if (!state.catalog) return;
    const input = lensInput(key);
    const typed = input.value.trim();
    if (typed && !state.lensUniverse[key].has(typed)) {
      const exact = [...state.lensUniverse[key]].find((value) => value.toLowerCase() === typed.toLowerCase());
      if (exact) input.value = exact;
    }
    const cleared = [];
    for (const other of ["option", "design", "material"]) {
      if (lensMatches(lensChoices()).length) break;
      if (other === key || !lensChoices()[other]) continue;
      setLensValue(other, "");
      lensInput(other).classList.remove("guessed");
      cleared.push(LENS_LABELS[other]);
    }
    if (cleared.length) showNotice(`Cleared the ${cleared.join(" and ")}: that combination is not on the Innovations catalogue.`);
    refreshLensLists();
    runValidation();
  }

  function lensIssues() {
    if (!state.catalog) return [];
    const issues = [];
    const choices = lensChoices();
    for (const key of LENS_KEYS) {
      const typed = lensInput(key).value.trim();
      if (typed && !choices[key] && document.activeElement !== lensInput(key)) issues.push({ path: `lens:${key}`, message: `Lens ${LENS_LABELS[key]} "${typed}" is not on the catalogue; pick one from the list.` });
    }
    if (!issues.length && !state.lensResolved) {
      const missing = LENS_KEYS.filter((key) => !choices[key]);
      const names = missing.map((key) => LENS_LABELS[key]);
      const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
      issues.push({ path: `lens:${missing[0] || "material"}`, message: `Choose the lens ${list} before submitting.` });
    }
    return issues;
  }

  function fillOptions(field, options, selected, placeholder) {
    if (!field) return;
    const current = selected ?? field.value;
    field.replaceChildren(new Option(placeholder, ""), ...options.map((item) => new Option(item.label, item.value)));
    field.value = options.some((item) => item.value === String(current || "")) ? String(current) : "";
  }

  // The workflow decides the job type sent to Innovations. Measurements stay
  // tucked away for traced and uncut jobs unless the photo supplied them.
  function renderFrameState() {
    const status = fieldForPath("frame.status").value;
    const hasMeasurements = ["frame.a", "frame.b", "frame.dbl", "frame.ed"].some((path) => fieldForPath(path).value.trim());
    const showMeasurements = status === "MEASURED" || hasMeasurements || state.measurementsOpened;
    $("#frameMeasurements").hidden = !showMeasurements;
    $("#addMeasurementsButton").hidden = showMeasurements || !state.canEdit;
    $("#frameJobBadge").textContent = status === "UNCUT" ? "Uncut job" : "Edged job";
  }

  // Enter moves to the next field, like a keyed order-entry screen. Open
  // dropdowns handle their own Enter (pick, then move on) before this runs.
  function advanceOnEnter(event) {
    if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.altKey) return;
    const field = event.target;
    if (!field.matches("input, select") || field.type === "hidden") return;
    event.preventDefault();
    focusNextField(field, event.shiftKey);
  }

  function focusNextField(field, backwards) {
    const fields = [...$("#reviewForm").querySelectorAll("input, select, textarea")]
      .filter((item) => item.type !== "hidden" && !item.disabled && !item.readOnly && item.offsetParent !== null);
    const next = fields[fields.indexOf(field) + (backwards ? -1 : 1)];
    if (next) {
      next.focus();
      if (next.select && next.tagName === "INPUT") next.select();
    } else {
      $("#submitOrderButton").hidden || $("#submitOrderButton").disabled ? $("#saveReviewButton").focus() : $("#submitOrderButton").focus();
    }
  }

  function reviewShortcuts(event) {
    if (!$("#reviewScreen").classList.contains("active") || $("#reviewForm").hidden) return;
    if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === "KeyC") {
      event.preventDefault();
      chooseOwnLenses();
      return;
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (!$("#saveReviewButton").hidden) saveReview(event);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const button = $("#submitOrderButton");
      if (!button.hidden && !button.disabled) submitOrder();
    }
  }

  async function renderSubmission(order) {
    const customer = order.customer || {};
    const summary = $("#submissionSummary");
    const describe = (account, labNum) => [
      `Ship to ${customer.name || "the selected customer"}`,
      `Innovations account ${account || "not set"}`,
      labNum ? `Lab ${labNum}` : null
    ].filter(Boolean).join(" · ");
    summary.textContent = describe(customer.account);
    if (!state.canEdit) return;
    try {
      const account = await api(`/api/rx-capture/orders/${encodeURIComponent(order.id)}/submission-account`);
      if (state.current?.id === order.id) summary.textContent = describe(account.customerNumber || customer.account, account.labNum);
    } catch { /* the ERP account shown above is what the server falls back to */ }
  }

  function renderApprovalActions(order) {
    const button = $("#submitOrderButton");
    const message = $("#approvalMessage");
    if (order.status === "RELEASED") {
      button.hidden = true;
      message.textContent = `Released ${order.generatedFilename || "RX file"} to Innovations. The approved copy is archived.`;
      return;
    }
    button.hidden = !state.canEdit || !state.canRelease;
    if (!state.canEdit) {
      message.textContent = "";
      return;
    }
    updateSubmitState();
  }

  function updateSubmitState() {
    const order = state.current;
    if (!order || order.status === "RELEASED" || !state.canEdit) return;
    const errors = state.lastValidation?.errors || [];
    const blockers = [];
    if (!state.lensResolved) blockers.push("choose a lens material, design and colour option that exist together");
    if (errors.length) blockers.push(`fix the ${errors.length === 1 ? "value" : `${errors.length} values`} marked in red`);
    $("#submitOrderButton").disabled = blockers.length > 0;
    $("#approvalMessage").textContent = !state.canRelease
      ? "Save the draft. Submitting to Innovations needs release access."
      : blockers.length
        ? `To submit, ${blockers.join(" and ")}.`
        : "Ready. Submit saves this draft, creates the RX file, stages it and releases it to Innovations.";
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

  // Saves the reviewed values. Throws before the request when a value is
  // invalid, so an unsaved edit is never replaced by the stored copy.
  async function persistReview() {
    const order = JSON.parse(JSON.stringify(state.current.normalizedOrder));
    delete order.lensGuessed;
    document.querySelectorAll("[data-path]").forEach((input) => setAtPath(order, input.dataset.path, input.value.trim() || null));
    order.lensRequest.materialGroup = "1";
    order.patient.name = normalizePatientName(order.patient.name);
    fieldForPath("patient.name").value = order.patient.name || "";
    order.frame.supplied = order.frame.status !== "UNCUT";
    const { errors } = runValidation();
    if (errors.length) {
      focusField(errors[0].path);
      throw new Error(`Fix ${errors.length} value${errors.length === 1 ? "" : "s"} before saving: ${errors[0].message}`);
    }
    const payload = await api(`/api/rx-capture/orders/${encodeURIComponent(state.current.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ normalizedOrder: order })
    });
    return payload.order;
  }

  async function saveReview(event) {
    event.preventDefault();
    if (!state.current?.normalizedOrder) return;
    const button = $("#saveReviewButton");
    button.disabled = true;
    try {
      await showOrder(await persistReview());
      showNotice(state.lensResolved ? "Draft saved. Submit it to Innovations when ready." : "Draft saved. Complete the lens selection to submit it.");
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  function currentDraft() {
    const draft = JSON.parse(JSON.stringify(state.current?.normalizedOrder || {}));
    document.querySelectorAll("#reviewForm [data-path]").forEach((input) => {
      try { setAtPath(draft, input.dataset.path, input.value.trim() || null); } catch { /* path absent from this draft */ }
    });
    return draft;
  }

  function runValidation() {
    const card = $("#validationCard");
    if (!state.current?.normalizedOrder || $("#reviewForm").hidden) {
      card.hidden = true;
      return { errors: [], warnings: [] };
    }
    const result = window.RxValidation.validateOrder(currentDraft());
    result.warnings.push(...lensIssues());
    document.querySelectorAll("#reviewForm :is([data-path], [data-lens])").forEach((input) => {
      input.classList.remove("invalid", "warned");
      input.removeAttribute("aria-invalid");
    });
    for (const item of result.warnings) visibleField(item.path)?.classList.add("warned");
    for (const item of result.errors) {
      const input = visibleField(item.path);
      input?.classList.add("invalid");
      input?.setAttribute("aria-invalid", "true");
    }
    renderValidationList($("#validationErrors"), result.errors);
    renderValidationList($("#validationWarnings"), result.warnings);
    card.classList.toggle("has-errors", result.errors.length > 0);
    card.hidden = result.errors.length + result.warnings.length === 0;
    state.lastValidation = result;
    updateSubmitState();
    return result;
  }

  // Lens values are stored in hidden inputs; problems point at the visible choice.
  function visibleField(path) {
    const lensKey = path.startsWith("lens:") ? path.slice(5)
      : { "lensRequest.material": "material", "lensRequest.lensType": "design", "lensRequest.style": "design", "lensRequest.option": "option", "lensRequest.catalogAlias": "material" }[path];
    return lensKey ? lensInput(lensKey) : fieldForPath(path);
  }

  function renderValidationList(list, items) {
    list.replaceChildren(...items.map((item) => {
      const row = document.createElement("li");
      const link = document.createElement("button");
      link.type = "button";
      link.className = "validation-link";
      link.textContent = item.message;
      link.addEventListener("click", () => focusField(item.path));
      row.append(link);
      if (item.fix && !fieldForPath(item.path)?.disabled) {
        const fix = document.createElement("button");
        fix.type = "button";
        fix.className = "validation-fix";
        fix.textContent = item.fix.label;
        fix.addEventListener("click", () => applyFix(item.fix));
        row.append(fix);
      }
      return row;
    }));
  }

  function applyFix(fix) {
    if (fix.type === "minus-cylinder") {
      fieldForPath(`prescription.${fix.side}.sphere`).value = fix.values.sphere;
      fieldForPath(`prescription.${fix.side}.cylinder`).value = fix.values.cylinder;
      fieldForPath(`prescription.${fix.side}.axis`).value = String(fix.values.axis);
    }
    runValidation();
  }

  function focusField(path) {
    const input = visibleField(path);
    if (!input) return;
    input.scrollIntoView({ block: "center", behavior: "smooth" });
    input.focus({ preventScroll: true });
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

  // One action: save the reviewed draft, record the submission choices, then
  // stage and release. Saving clears any earlier choices, so all three run together.
  async function submitOrder() {
    if (!state.current?.normalizedOrder || !state.lensResolved) return;
    const lens = [state.lensResolved.material, designLabel(state.lensResolved), state.lensResolved.option].join(" · ");
    if (!window.confirm(`Submit this RX to Innovations as ${lens}? It will be staged and released, then remain editable in Innovations.`)) return;
    const id = encodeURIComponent(state.current.id);
    const button = $("#submitOrderButton");
    button.disabled = true;
    button.textContent = "SUBMITTING…";
    let saved = false;
    try {
      await persistReview();
      saved = true;
      await api(`/api/rx-capture/orders/${id}/resolution`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resolution: {} }) });
      const payload = await api(`/api/rx-capture/orders/${id}/submit`, { method: "POST" });
      await showOrder(payload.order);
      showNotice("RX submitted to Innovations and archived.");
    } catch (error) {
      if (saved) await api(`/api/rx-capture/orders/${id}`).then((payload) => showOrder(payload.order)).catch(() => {});
      showNotice(error.message, true);
    } finally {
      button.textContent = "SUBMIT TO INNOVATIONS";
      updateSubmitState();
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

  async function previewFile(slot) {
    const file = state.images[slot];
    const preview = $(`#${slot}Preview`);
    const name = $(`#${slot}FileName`);
    preview.closest(".file-card").classList.toggle("has-image", Boolean(file));
    if (!file) {
      preview.removeAttribute("src");
      preview.hidden = true;
      name.textContent = "";
      return;
    }
    name.textContent = file.name;
    try {
      preview.src = await fileToDataUrl(file);
      preview.hidden = false;
    } catch {
      preview.hidden = true;
    }
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

  // Customer matches use the same list as every other dropdown: it floats
  // under the search field, and Up/Down + Enter pick without the mouse.
  function renderCustomerResults(customers) {
    const results = $("#customerResults");
    state.customerMatches = customers;
    state.customerActive = customers.length ? 0 : -1;
    results.replaceChildren(...customers.map((customer, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `cbopt customer-result${index === state.customerActive ? " act" : ""}`;
      button.tabIndex = -1;
      button.setAttribute("role", "option");
      const name = document.createElement("strong");
      name.textContent = customer.name;
      const detail = document.createElement("small");
      detail.textContent = `${customer.account} · ID ${customer.id}`;
      button.append(name, detail);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => pickCustomer(customer));
      return button;
    }));
    results.hidden = customers.length === 0;
    results.classList.toggle("on", customers.length > 0);
    positionCustomerResults();
  }

  function positionCustomerResults() {
    const results = $("#customerResults");
    if (results.hidden) return;
    const rect = $("#customerSearch").getBoundingClientRect();
    Object.assign(results.style, { left: `${rect.left}px`, top: `${rect.bottom + 4}px`, width: `${rect.width}px` });
  }

  function pickCustomer(customer) {
    state.selectedCustomer = customer;
    $("#customerSearch").value = customer.name;
    renderSelectedCustomer();
    renderCustomerResults([]);
  }

  function customerSearchKeys(event) {
    const matches = state.customerMatches || [];
    if (!matches.length || !["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") return renderCustomerResults([]);
    if (event.key === "Enter") return pickCustomer(matches[Math.max(state.customerActive, 0)]);
    state.customerActive = Math.min(Math.max(state.customerActive + (event.key === "ArrowDown" ? 1 : -1), 0), matches.length - 1);
    [...$("#customerResults").children].forEach((option, index) => option.classList.toggle("act", index === state.customerActive));
    $("#customerResults").children[state.customerActive]?.scrollIntoView({ block: "nearest" });
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
