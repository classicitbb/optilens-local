// Commercial-invoice tariff codes: the searchable multi-select on the invoice
// and the library editor under Delivery export settings. Server side lives in
// lib/tariff-codes.js; invoice selections are saved as snapshots there.
(function (root) {
  const CODE_PATTERN = /^[0-9][0-9 .\-/]*$/;

  function digitsOf(value) {
    return String(value || "").replace(/\D/g, "");
  }

  // Case-insensitive search over code (with or without punctuation),
  // description and keywords. Every typed word must match somewhere. A leading
  // "/" is the slash command and is ignored. Code-prefix hits rank first; the
  // incoming order (pinned, then display order) is otherwise kept.
  function searchTariffs(list, rawQuery) {
    const query = String(rawQuery || "").replace(/^\s*\//, "").trim().toLowerCase();
    if (!query) return list.slice();
    const tokens = query.split(/\s+/).filter(Boolean);
    const scored = [];
    list.forEach((tariff, index) => {
      const code = String(tariff.tariffCode || "").toLowerCase();
      const codeDigits = digitsOf(code);
      const text = `${tariff.description || ""} ${tariff.searchAliases || ""}`.toLowerCase();
      let score = 1;
      for (const token of tokens) {
        const tokenDigits = digitsOf(token);
        const codePrefix = code.startsWith(token) || (tokenDigits && /^[\d.\-/ ]+$/.test(token) && codeDigits.startsWith(tokenDigits));
        const codeHit = codePrefix || code.includes(token) || (tokenDigits && /^[\d.\-/ ]+$/.test(token) && codeDigits.includes(tokenDigits));
        if (!codeHit && !text.includes(token)) return;
        if (codePrefix) score = 0;
      }
      scored.push({ tariff, score, index });
    });
    return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((entry) => entry.tariff);
  }

  function validateCustom(code, description) {
    const cleanCode = String(code || "").replace(/\s+/g, " ").trim();
    const cleanDescription = String(description || "").replace(/\s+/g, " ").trim();
    if (!cleanCode) return { error: "Enter a tariff code." };
    if (cleanCode.length > 40 || !CODE_PATTERN.test(cleanCode)) return { error: "Tariff code may only contain digits, dots, dashes and spaces (40 characters at most)." };
    if (!cleanDescription) return { error: "Enter a description." };
    if (cleanDescription.length > 500) return { error: "Description must be 500 characters or fewer." };
    return { tariffCode: cleanCode, description: cleanDescription };
  }

  const exported = { searchTariffs, validateCustom };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (typeof document === "undefined") return;

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

  async function api(method, url, body) {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  const state = {
    library: [],       // everything the caller may see (inactive too for admins)
    canManage: false,
    loaded: false,
    selection: [],     // this invoice's tariffs, in order
    sessionId: "",
    open: false,
    results: [],
    active: 0,
    customOpen: false,
    saveQueue: Promise.resolve(),
    filter: { text: "", status: "all" },
    editingId: "",
    addOpen: false,
    loadError: false
  };

  const activeLibrary = () => state.library.filter((tariff) => tariff.isActive);
  const $ = (selector) => document.querySelector(selector);

  async function load() {
    try {
      let data = await api("GET", "/api/delivery/tariff-codes");
      state.canManage = Boolean(data.canManage);
      if (state.canManage) data = await api("GET", "/api/delivery/tariff-codes?all=1");
      state.library = data.tariffs || [];
      state.loaded = true;
      state.loadError = false;
    } catch (error) {
      state.loadError = true;
      setInvoiceStatus(error.message, true);
      setSettingsMessage(`Could not load the tariff library: ${error.message}`, true);
    }
    renderSettings();
    refreshSelector();
  }

  // ---------- invoice selector ----------

  function selectorHtml(preview) {
    state.selection = (preview?.tariffSelections || []).map((tariff) => ({ ...tariff }));
    state.sessionId = preview?.shipmentSessionId || "";
    state.open = false;
    state.customOpen = false;
    return `
      <div class="ci-entry-field ci-entry-field-tariffs" data-ci-tariffs>
        <label for="ciTariffInput"><span>Tariff Codes / Customs Classification</span><small>This is the declaration printed on the invoice.</small></label>
        <div class="ci-tariff-box">
          <input type="text" id="ciTariffInput" class="ci-entry-input" data-ci-tariff-input autocomplete="off" spellcheck="false"
            role="combobox" aria-expanded="false" aria-controls="ciTariffList" aria-autocomplete="list"
            placeholder="Type / to select a tariff, search, or add your own...">
          <button type="button" class="ci-tariff-add" data-ci-tariff-custom-toggle aria-expanded="false" aria-controls="ciTariffCustom">+ Custom</button>
          <ul id="ciTariffList" class="ci-tariff-list" role="listbox" aria-label="Tariff codes" hidden></ul>
        </div>
        <div class="ci-tariff-custom" id="ciTariffCustom" data-ci-tariff-custom hidden></div>
        <ul class="ci-tariff-selected" data-ci-tariff-selected aria-label="Selected tariff codes"></ul>
        <small class="ci-tariff-status" data-ci-tariff-status role="status" aria-live="polite">${preview?.tariffSelectionsSaved === false && state.selection.length ? "Suggested from the invoice lines and printed as the declaration. Add or remove codes to confirm." : ""}</small>
      </div>`;
  }

  function selectedHtml() {
    if (!state.selection.length) return `<li class="ci-tariff-empty">No tariff codes selected.</li>`;
    return state.selection.map((tariff, index) => `
      <li class="ci-tariff-row">
        <span class="ci-tariff-row-text"><strong>${esc(tariff.tariffCode)}</strong> — ${esc(tariff.description)}</span>
        <button type="button" class="ci-tariff-remove" data-ci-tariff-remove="${index}" aria-label="Remove ${esc(tariff.tariffCode)}">&times;</button>
      </li>`).join("");
  }

  function customHtml(seed = {}) {
    const saveBox = state.canManage
      ? `<label class="ci-tariff-check"><input type="checkbox" data-ci-tariff-custom-save> Save to Tariff Library</label>`
      : "";
    return `
      <label class="ci-entry-field"><span>Tariff code</span><input type="text" class="ci-entry-input" data-ci-tariff-custom-code value="${esc(seed.tariffCode || "")}" autocomplete="off" maxlength="40"></label>
      <label class="ci-entry-field"><span>Description</span><input type="text" class="ci-entry-input" data-ci-tariff-custom-description value="${esc(seed.description || "")}" autocomplete="off" maxlength="500"></label>
      ${saveBox}
      <div class="ci-tariff-actions">
        <button type="button" class="button primary" data-ci-tariff-custom-add>Add to invoice</button>
        <button type="button" class="button secondary" data-ci-tariff-custom-cancel>Cancel</button>
      </div>`;
  }

  function refreshSelector() {
    const root = $("[data-ci-tariffs]");
    if (!root) return;
    root.querySelector("[data-ci-tariff-selected]").innerHTML = selectedHtml();
    if (state.open) renderList();
  }

  function setInvoiceStatus(message, isError = false) {
    const target = $("[data-ci-tariff-status]");
    if (!target) return;
    target.textContent = message || "";
    target.classList.toggle("error", Boolean(isError));
  }

  function selectedCodes() {
    return new Set(state.selection.map((tariff) => tariff.tariffCode.toLowerCase()));
  }

  function renderList() {
    const input = $("[data-ci-tariff-input]");
    const list = $("#ciTariffList");
    if (!input || !list) return;
    const taken = selectedCodes();
    const query = input.value;
    state.results = searchTariffs(activeLibrary().filter((tariff) => !taken.has(tariff.tariffCode.toLowerCase())), query).slice(0, 60);
    if (state.active >= state.results.length) state.active = Math.max(0, state.results.length - 1);
    list.innerHTML = state.results.length
      ? state.results.map((tariff, index) => `
          <li id="ciTariffOption${index}" role="option" class="ci-tariff-option${index === state.active ? " active" : ""}" aria-selected="${index === state.active}" data-ci-tariff-option="${index}">
            <strong>${esc(tariff.tariffCode)}</strong> <span>${esc(tariff.description)}</span>${tariff.verificationStatus === "verified" ? "" : ` <em>Unverified</em>`}
          </li>`).join("")
      : `<li class="ci-tariff-none" role="presentation">No matching tariff. Press Enter to add it as a custom tariff.</li>`;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (state.results.length) input.setAttribute("aria-activedescendant", `ciTariffOption${state.active}`);
    else input.removeAttribute("aria-activedescendant");
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }

  function openList() {
    state.open = true;
    renderList();
  }

  function closeList() {
    state.open = false;
    const input = $("[data-ci-tariff-input]");
    const list = $("#ciTariffList");
    if (list) list.hidden = true;
    if (input) {
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
  }

  function persistSelection() {
    const sessionId = state.sessionId;
    const payload = state.selection.map(({ tariffId, tariffCode, description }) => ({ tariffId, tariffCode, description }));
    state.saveQueue = state.saveQueue.then(async () => {
      try {
        await api("PUT", `/api/delivery/shipments/${encodeURIComponent(sessionId)}/commercial-invoice/tariffs`, { tariffs: payload });
        setInvoiceStatus("Tariff codes saved.");
      } catch (error) {
        setInvoiceStatus(`Could not save tariff codes: ${error.message}`, true);
      }
    });
    return state.saveQueue;
  }

  function addToSelection(tariff) {
    if (selectedCodes().has(tariff.tariffCode.toLowerCase())) {
      setInvoiceStatus(`${tariff.tariffCode} is already on this invoice.`, true);
      return false;
    }
    state.selection.push({ tariffId: tariff.id || tariff.tariffId || null, tariffCode: tariff.tariffCode, description: tariff.description });
    refreshSelector();
    persistSelection();
    return true;
  }

  function choose(index) {
    const tariff = state.results[index];
    if (!tariff) return;
    addToSelection(tariff);
    const input = $("[data-ci-tariff-input]");
    if (input) {
      input.value = "";
      input.focus();
    }
    state.active = 0;
    closeList();
  }

  function openCustom(seedText = "") {
    const box = $("[data-ci-tariff-custom]");
    if (!box) return;
    const text = String(seedText || "").replace(/^\s*\//, "").trim();
    const looksLikeCode = text && CODE_PATTERN.test(text);
    box.innerHTML = customHtml(looksLikeCode ? { tariffCode: text } : { description: text });
    box.hidden = false;
    state.customOpen = true;
    $("[data-ci-tariff-custom-toggle]")?.setAttribute("aria-expanded", "true");
    closeList();
    box.querySelector(looksLikeCode ? "[data-ci-tariff-custom-description]" : "[data-ci-tariff-custom-code]")?.focus();
  }

  function closeCustom() {
    const box = $("[data-ci-tariff-custom]");
    if (box) box.hidden = true;
    state.customOpen = false;
    $("[data-ci-tariff-custom-toggle]")?.setAttribute("aria-expanded", "false");
  }

  async function submitCustom() {
    const box = $("[data-ci-tariff-custom]");
    if (!box) return;
    const checked = validateCustom(box.querySelector("[data-ci-tariff-custom-code]").value, box.querySelector("[data-ci-tariff-custom-description]").value);
    if (checked.error) {
      setInvoiceStatus(checked.error, true);
      return;
    }
    const existing = state.library.find((tariff) => tariff.tariffCode.toLowerCase() === checked.tariffCode.toLowerCase());
    let entry = { tariffCode: checked.tariffCode, description: checked.description, tariffId: null };
    try {
      if (state.canManage && box.querySelector("[data-ci-tariff-custom-save]")?.checked) {
        if (existing) throw new Error(`${checked.tariffCode} is already in the Tariff Library.`);
        const created = await api("POST", "/api/delivery/tariff-codes", checked);
        state.library.push(created.tariff);
        entry = { ...entry, tariffId: created.tariff.id };
        renderSettings();
      }
    } catch (error) {
      setInvoiceStatus(error.message, true);
      return;
    }
    if (addToSelection(entry)) {
      closeCustom();
      $("[data-ci-tariff-input]")?.focus();
    }
  }

  function onInput(event) {
    if (!event.target.matches("[data-ci-tariff-input]")) return;
    state.active = 0;
    if (event.target.value.trim()) openList();
    else closeList();
  }

  function onKeydown(event) {
    const input = event.target.closest?.("[data-ci-tariff-input]");
    if (input) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!state.open) openList();
        else if (state.results.length) {
          state.active = (state.active + (event.key === "ArrowDown" ? 1 : -1) + state.results.length) % state.results.length;
          renderList();
        }
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (state.open && state.results.length) choose(state.active);
        else if (input.value.trim()) openCustom(input.value);
      } else if (event.key === "Escape" && state.open) {
        event.preventDefault();
        closeList();
      }
      return;
    }
    if (event.key === "Enter" && event.target.closest?.("[data-ci-tariff-custom]") && event.target.tagName === "INPUT" && event.target.type === "text") {
      event.preventDefault();
      submitCustom();
    } else if (event.key === "Escape" && event.target.closest?.("[data-ci-tariff-custom]")) {
      closeCustom();
      $("[data-ci-tariff-input]")?.focus();
    }
  }

  function onClick(event) {
    const target = event.target;
    const option = target.closest?.("[data-ci-tariff-option]");
    if (option) return choose(Number(option.dataset.ciTariffOption));
    const remove = target.closest?.("[data-ci-tariff-remove]");
    if (remove) {
      state.selection.splice(Number(remove.dataset.ciTariffRemove), 1);
      refreshSelector();
      persistSelection();
      return $("[data-ci-tariff-input]")?.focus();
    }
    if (target.closest?.("[data-ci-tariff-custom-toggle]")) return state.customOpen ? closeCustom() : openCustom($("[data-ci-tariff-input]")?.value);
    if (target.closest?.("[data-ci-tariff-custom-add]")) return submitCustom();
    if (target.closest?.("[data-ci-tariff-custom-cancel]")) return closeCustom();
    if (state.open && !target.closest?.(".ci-tariff-box")) closeList();
  }

  function onFocusIn(event) {
    if (event.target.matches?.("[data-ci-tariff-input]") && event.target.value.trim()) openList();
  }

  // ---------- Tariff Codes settings panel ----------

  function matchesFilter(tariff) {
    const { text, status } = state.filter;
    if (status === "active" && !tariff.isActive) return false;
    if (status === "inactive" && tariff.isActive) return false;
    if (status === "unverified" && tariff.verificationStatus === "verified") return false;
    return !text || searchTariffs([tariff], text).length > 0;
  }

  function keywordChips(aliases) {
    const words = String(aliases || "").split(",").map((word) => word.trim()).filter(Boolean);
    return words.length ? `<span class="tariff-kw">${words.map((word) => `<span>${esc(word)}</span>`).join("")}</span>` : "";
  }

  function editRowHtml(tariff) {
    const verified = tariff.verificationStatus === "verified";
    return `
      <tr data-tariff-row="${esc(tariff.id)}" class="is-editing">
        <td colspan="5">
          <form class="tariff-edit-form" data-tariff-edit-form="${esc(tariff.id)}" novalidate>
            <div class="tariff-form-grid">
              <label class="tariff-field"><span>Tariff code <i class="req">*</i></span>
                <input data-tariff-field="tariffCode" value="${esc(tariff.tariffCode)}" maxlength="40" autocomplete="off">
                <small class="tariff-field-error" data-error-for="tariffCode"></small>
              </label>
              <label class="tariff-field"><span>Description <i class="req">*</i></span>
                <input data-tariff-field="description" value="${esc(tariff.description)}" maxlength="500" autocomplete="off">
                <small class="tariff-field-error" data-error-for="description"></small>
              </label>
              <label class="tariff-field tariff-field-wide">Search keywords
                <input data-tariff-field="searchAliases" value="${esc(tariff.searchAliases)}" maxlength="1000" autocomplete="off" placeholder="Comma separated">
              </label>
            </div>
            <div class="tariff-form-foot">
              <label class="tariff-inline-check"><input type="checkbox" data-tariff-field="verified"${verified ? " checked" : ""}> Verified with customs</label>
              <label class="tariff-inline-check"><input type="checkbox" data-tariff-field="isPinned"${tariff.isPinned ? " checked" : ""}> Pin to top</label>
              <label class="tariff-inline-check">Order <input type="number" class="tariff-order" data-tariff-field="displayOrder" value="${esc(tariff.displayOrder)}" step="10"></label>
              <span class="tariff-form-actions">
                <button type="button" class="button secondary" data-tariff-cancel>Cancel</button>
                <button type="submit" class="button primary">Save changes</button>
              </span>
            </div>
          </form>
        </td>
      </tr>`;
  }

  function rowHtml(tariff) {
    if (state.canManage && state.editingId === tariff.id) return editRowHtml(tariff);
    const verified = tariff.verificationStatus === "verified";
    const actions = state.canManage
      ? `<button type="button" class="tariff-act" data-tariff-edit="${esc(tariff.id)}">Edit</button>
         <button type="button" class="tariff-act" data-tariff-toggle="${esc(tariff.id)}">${tariff.isActive ? "Deactivate" : "Reactivate"}</button>
         <button type="button" class="tariff-act danger" data-tariff-delete="${esc(tariff.id)}"${tariff.usageCount ? ` title="Used on ${esc(tariff.usageCount)} invoice line(s); deactivate instead"` : ""}>Delete</button>`
      : "";
    return `
      <tr data-tariff-row="${esc(tariff.id)}"${tariff.isActive ? "" : ` class="is-inactive"`}>
        <td class="col-code"><code>${esc(tariff.tariffCode)}</code></td>
        <td class="col-desc"><span class="tariff-desc">${esc(tariff.description)}</span>${keywordChips(tariff.searchAliases)}</td>
        <td class="col-status">
          <span class="tariff-badge ${verified ? "verified" : "unverified"}">${verified ? "Verified" : "Unverified"}</span>
          ${tariff.isActive ? "" : `<span class="tariff-badge inactive">Inactive</span>`}
          ${tariff.isPinned ? `<span class="tariff-badge pinned">Pinned</span>` : ""}
        </td>
        <td class="col-order">${esc(tariff.displayOrder)}</td>
        <td class="col-actions"><span class="tariff-actions">${actions}</span></td>
      </tr>`;
  }

  function renderSettings() {
    const body = $("#tariffCodeRows");
    if (!body) return;
    const rows = state.library.filter(matchesFilter);
    const emptyText = !state.loaded
      ? (state.loadError ? `Could not load tariff codes. <button type="button" class="tariff-act" data-tariff-retry>Retry</button>` : "Loading tariff codes...")
      : (state.library.length ? "No tariff codes match your search or filter." : "No tariff codes yet. Use Add tariff to create the first one.");
    body.innerHTML = rows.map(rowHtml).join("") || `<tr><td colspan="5" class="tariff-empty">${emptyText}</td></tr>`;
    const counts = {
      all: state.library.length,
      active: state.library.filter((t) => t.isActive).length,
      inactive: state.library.filter((t) => !t.isActive).length,
      unverified: state.library.filter((t) => t.verificationStatus !== "verified").length
    };
    document.querySelectorAll("[data-tariff-filter]").forEach((chip) => {
      const on = chip.dataset.tariffFilter === state.filter.status;
      chip.classList.toggle("active", on);
      chip.setAttribute("aria-pressed", String(on));
      chip.querySelector("b").textContent = counts[chip.dataset.tariffFilter];
    });
    const count = $("#tariffCount");
    if (count) count.textContent = state.loaded ? `Showing ${rows.length} of ${state.library.length}` : "";
    const form = $("#tariffAddForm");
    if (form) form.hidden = !(state.canManage && state.addOpen);
    const toggle = $("#tariffNewToggle");
    if (toggle) {
      toggle.hidden = !state.canManage;
      toggle.setAttribute("aria-expanded", String(Boolean(state.addOpen)));
    }
    const note = $("#tariffReadOnlyNote");
    if (note) note.hidden = state.canManage || !state.loaded;
  }

  let messageTimer = 0;
  function setSettingsMessage(message, isError = false) {
    const target = $("#tariffCodesMessage");
    if (!target) return;
    clearTimeout(messageTimer);
    target.textContent = message || "";
    target.classList.toggle("error", Boolean(isError));
    target.classList.toggle("success", Boolean(message) && !isError);
    if (message && !isError) messageTimer = setTimeout(() => setSettingsMessage(""), 5000);
  }

  function showFieldErrors(form, error) {
    form.querySelectorAll("[data-error-for]").forEach((node) => { node.textContent = ""; });
    form.querySelectorAll("[aria-invalid]").forEach((input) => input.removeAttribute("aria-invalid"));
    if (!error) return;
    const key = /description/i.test(error) ? "description" : "tariffCode";
    const node = form.querySelector(`[data-error-for="${key}"]`);
    const input = form.querySelector(`[data-tariff-new="${key}"], [data-tariff-field="${key}"]`);
    if (node) node.textContent = error;
    if (input) {
      input.setAttribute("aria-invalid", "true");
      input.focus();
    }
  }

  function replaceInLibrary(tariff) {
    const index = state.library.findIndex((entry) => entry.id === tariff.id);
    if (index >= 0) state.library[index] = tariff;
    else state.library.push(tariff);
    state.library.sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || a.displayOrder - b.displayOrder || a.tariffCode.localeCompare(b.tariffCode));
  }

  async function settingsAction(fn, successMessage) {
    try {
      await fn();
      setSettingsMessage(successMessage);
    } catch (error) {
      setSettingsMessage(error.message, true);
    }
    renderSettings();
    refreshSelector();
  }

  function readFields(container, attr) {
    const fields = {};
    container.querySelectorAll(`[${attr}]`).forEach((input) => {
      fields[input.getAttribute(attr)] = input.type === "checkbox" ? input.checked : input.value;
    });
    return fields;
  }

  // The server expects verificationStatus; the forms use a plain checkbox.
  function toPayload(fields) {
    const { verified, ...rest } = fields;
    return { ...rest, verificationStatus: verified ? "verified" : "unverified" };
  }

  function closeAddForm() {
    state.addOpen = false;
    const form = $("#tariffAddForm");
    if (form) {
      form.reset();
      showFieldErrors(form, "");
    }
    renderSettings();
    $("#tariffNewToggle")?.focus();
  }

  function onSettingsSubmit(event) {
    const form = event.target;
    if (form.id === "tariffAddForm") {
      event.preventDefault();
      const fields = toPayload(readFields(form, "data-tariff-new"));
      const checked = validateCustom(fields.tariffCode, fields.description);
      showFieldErrors(form, checked.error);
      if (checked.error) return;
      if (state.library.some((tariff) => tariff.tariffCode.toLowerCase() === checked.tariffCode.toLowerCase())) {
        return showFieldErrors(form, `${checked.tariffCode} is already in the library.`);
      }
      const button = $("#tariffAddBtn");
      button.disabled = true;
      return settingsAction(async () => {
        const created = await api("POST", "/api/delivery/tariff-codes", { ...fields, tariffCode: checked.tariffCode, description: checked.description });
        replaceInLibrary(created.tariff);
        form.reset();
        $("[data-tariff-new=tariffCode]").focus();
      }, "Tariff added. Add another, or close the form.").finally(() => { button.disabled = false; });
    }
    if (form.matches?.("[data-tariff-edit-form]")) {
      event.preventDefault();
      const tariffId = form.dataset.tariffEditForm;
      const fields = toPayload(readFields(form, "data-tariff-field"));
      const checked = validateCustom(fields.tariffCode, fields.description);
      showFieldErrors(form, checked.error);
      if (checked.error) return;
      return settingsAction(async () => {
        const updated = await api("PUT", `/api/delivery/tariff-codes/${encodeURIComponent(tariffId)}`, { ...fields, tariffCode: checked.tariffCode, description: checked.description });
        replaceInLibrary(updated.tariff);
        state.editingId = "";
      }, "Tariff saved. Issued invoices keep their original wording.");
    }
  }

  function onSettingsClick(event) {
    const target = event.target;
    const id = (name) => target.closest(`[${name}]`)?.getAttribute(name);
    if (target.closest("#tariffNewToggle")) {
      state.addOpen = !state.addOpen;
      renderSettings();
      if (state.addOpen) $("[data-tariff-new=tariffCode]")?.focus();
      return;
    }
    if (target.closest("#tariffAddCancel")) return closeAddForm();
    if (target.closest("[data-tariff-retry]")) {
      setSettingsMessage("");
      return load();
    }
    const chip = target.closest("[data-tariff-filter]");
    if (chip) {
      state.filter.status = chip.dataset.tariffFilter;
      return renderSettings();
    }
    if (id("data-tariff-edit")) {
      state.editingId = id("data-tariff-edit");
      renderSettings();
      return $("[data-tariff-edit-form] [data-tariff-field=tariffCode]")?.focus();
    }
    if (target.closest("[data-tariff-cancel]")) {
      const editedId = state.editingId;
      state.editingId = "";
      renderSettings();
      return document.querySelector(`[data-tariff-edit="${editedId}"]`)?.focus();
    }
    if (id("data-tariff-toggle")) {
      const tariffId = id("data-tariff-toggle");
      const current = state.library.find((entry) => entry.id === tariffId);
      return settingsAction(async () => {
        const updated = await api("PUT", `/api/delivery/tariff-codes/${encodeURIComponent(tariffId)}`, { isActive: !current.isActive });
        replaceInLibrary(updated.tariff);
      }, current.isActive ? `${current.tariffCode} deactivated. It no longer appears in the invoice selector.` : `${current.tariffCode} reactivated.`);
    }
    if (id("data-tariff-delete")) {
      const tariffId = id("data-tariff-delete");
      const current = state.library.find((entry) => entry.id === tariffId);
      const used = current.usageCount ? ` It is used on ${current.usageCount} invoice line(s); consider deactivating instead.` : "";
      if (!window.confirm(`Permanently delete ${current.tariffCode}?${used} This cannot be undone.`)) return;
      return settingsAction(async () => {
        await api("DELETE", `/api/delivery/tariff-codes/${encodeURIComponent(tariffId)}`);
        state.library = state.library.filter((entry) => entry.id !== tariffId);
      }, `${current.tariffCode} deleted.`);
    }
  }

  function onSettingsKeydown(event) {
    if (event.key !== "Escape") return;
    if (event.target.closest?.("[data-tariff-edit-form]")) {
      event.preventDefault();
      event.target.closest("form").querySelector("[data-tariff-cancel]").click();
    } else if (event.target.closest?.("#tariffAddForm")) {
      event.preventDefault();
      closeAddForm();
    }
  }

  function onSettingsInput(event) {
    if (event.target.id === "tariffSearch") state.filter.text = event.target.value;
    else if (event.target.closest?.("#tariffAddForm, [data-tariff-edit-form]")) {
      if (event.target.getAttribute("aria-invalid")) {
        event.target.removeAttribute("aria-invalid");
        event.target.closest("label")?.querySelector("[data-error-for]")?.replaceChildren();
      }
      return;
    } else return;
    renderSettings();
  }

  document.addEventListener("input", onInput);
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("click", onClick);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("click", onSettingsClick);
  document.addEventListener("input", onSettingsInput);
  document.addEventListener("submit", onSettingsSubmit);
  document.addEventListener("keydown", onSettingsKeydown);

  root.TariffUi = { load, selectorHtml, refreshSelector, renderSettings, state };
  load();
})(typeof window !== "undefined" ? window : globalThis);
