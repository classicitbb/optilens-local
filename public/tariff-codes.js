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
    editingId: ""
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
    } catch (error) {
      setInvoiceStatus(error.message, true);
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
        <label for="ciTariffInput"><span>Tariff Codes / Customs Classification</span></label>
        <div class="ci-tariff-box">
          <input type="text" id="ciTariffInput" class="ci-entry-input" data-ci-tariff-input autocomplete="off" spellcheck="false"
            role="combobox" aria-expanded="false" aria-controls="ciTariffList" aria-autocomplete="list"
            placeholder="Type / to select a tariff, search, or add your own...">
          <ul id="ciTariffList" class="ci-tariff-list" role="listbox" aria-label="Tariff codes" hidden></ul>
        </div>
        <div class="ci-tariff-actions"><button type="button" class="button secondary" data-ci-tariff-custom-toggle aria-expanded="false" aria-controls="ciTariffCustom">Add Custom Tariff</button></div>
        <div class="ci-tariff-custom" id="ciTariffCustom" data-ci-tariff-custom hidden></div>
        <ul class="ci-tariff-selected" data-ci-tariff-selected aria-label="Selected tariff codes"></ul>
        <small class="ci-tariff-status" data-ci-tariff-status role="status" aria-live="polite"></small>
      </div>`;
  }

  function selectedHtml() {
    if (!state.selection.length) return `<li class="ci-tariff-empty">No tariff codes selected.</li>`;
    return state.selection.map((tariff, index) => `
      <li class="ci-tariff-row">
        <span class="ci-tariff-row-text"><strong>${esc(tariff.tariffCode)}</strong> — ${esc(tariff.description)}</span>
        <button type="button" class="button secondary ci-tariff-remove" data-ci-tariff-remove="${index}" aria-label="Remove ${esc(tariff.tariffCode)}">Remove</button>
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

  function rowHtml(tariff) {
    const editing = state.canManage && state.editingId === tariff.id;
    const verified = tariff.verificationStatus === "verified";
    if (editing) {
      return `
        <tr data-tariff-row="${esc(tariff.id)}" class="is-editing">
          <td><input data-tariff-field="tariffCode" value="${esc(tariff.tariffCode)}" aria-label="Tariff code" maxlength="40"></td>
          <td><input data-tariff-field="description" value="${esc(tariff.description)}" aria-label="Description" maxlength="500"></td>
          <td><input data-tariff-field="searchAliases" value="${esc(tariff.searchAliases)}" aria-label="Search keywords" maxlength="1000"></td>
          <td><select data-tariff-field="verificationStatus" aria-label="Verification status"><option value="unverified"${verified ? "" : " selected"}>Unverified</option><option value="verified"${verified ? " selected" : ""}>Verified</option></select></td>
          <td>${tariff.isActive ? "Active" : "Inactive"}</td>
          <td><label><input type="checkbox" data-tariff-field="isPinned"${tariff.isPinned ? " checked" : ""}> Pin</label> <input type="number" class="tariff-order" data-tariff-field="displayOrder" value="${esc(tariff.displayOrder)}" aria-label="Display order"></td>
          <td class="tariff-actions"><button type="button" class="button primary" data-tariff-save="${esc(tariff.id)}">Save</button> <button type="button" class="button secondary" data-tariff-cancel>Cancel</button></td>
        </tr>`;
    }
    const actions = state.canManage
      ? `<button type="button" class="button secondary" data-tariff-edit="${esc(tariff.id)}">Edit</button>
         <button type="button" class="button secondary" data-tariff-toggle="${esc(tariff.id)}">${tariff.isActive ? "Deactivate" : "Reactivate"}</button>
         <button type="button" class="button secondary" data-tariff-delete="${esc(tariff.id)}"${tariff.usageCount ? ` title="Used on ${esc(tariff.usageCount)} invoice line(s); deactivate instead"` : ""}>Delete</button>`
      : "";
    return `
      <tr data-tariff-row="${esc(tariff.id)}"${tariff.isActive ? "" : ` class="is-inactive"`}>
        <td><code>${esc(tariff.tariffCode)}</code></td>
        <td>${esc(tariff.description)}</td>
        <td>${esc(tariff.searchAliases)}</td>
        <td><span class="tariff-badge ${verified ? "verified" : "unverified"}">${verified ? "Verified" : "Unverified"}</span></td>
        <td>${tariff.isActive ? "Active" : "Inactive"}</td>
        <td>${tariff.isPinned ? "Pinned · " : ""}${esc(tariff.displayOrder)}</td>
        <td class="tariff-actions">${actions}</td>
      </tr>`;
  }

  function renderSettings() {
    const body = $("#tariffCodeRows");
    if (!body) return;
    const rows = state.library.filter(matchesFilter);
    body.innerHTML = rows.map(rowHtml).join("") || `<tr><td colspan="7">${state.loaded ? "No tariff codes match." : "Loading tariff codes..."}</td></tr>`;
    const form = $("#tariffAddForm");
    if (form) form.hidden = !state.canManage;
    const note = $("#tariffReadOnlyNote");
    if (note) note.hidden = state.canManage || !state.loaded;
  }

  function setSettingsMessage(message, isError = false) {
    const target = $("#tariffCodesMessage");
    if (!target) return;
    target.textContent = message || "";
    target.classList.toggle("error", Boolean(isError));
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

  function readRow(row) {
    const fields = {};
    row.querySelectorAll("[data-tariff-field]").forEach((input) => {
      fields[input.dataset.tariffField] = input.type === "checkbox" ? input.checked : input.value;
    });
    return fields;
  }

  function onSettingsClick(event) {
    const target = event.target;
    const id = (name) => target.closest(`[${name}]`)?.getAttribute(name);
    if (target.closest("#tariffAddBtn")) {
      const form = $("#tariffAddForm");
      const fields = {
        tariffCode: form.querySelector("[data-tariff-new=tariffCode]").value,
        description: form.querySelector("[data-tariff-new=description]").value,
        searchAliases: form.querySelector("[data-tariff-new=searchAliases]").value,
        isPinned: form.querySelector("[data-tariff-new=isPinned]").checked,
        verificationStatus: form.querySelector("[data-tariff-new=verified]").checked ? "verified" : "unverified"
      };
      return settingsAction(async () => {
        const created = await api("POST", "/api/delivery/tariff-codes", fields);
        replaceInLibrary(created.tariff);
        form.querySelectorAll("input[type=text]").forEach((input) => { input.value = ""; });
        form.querySelectorAll("input[type=checkbox]").forEach((input) => { input.checked = false; });
      }, "Tariff added.");
    }
    if (id("data-tariff-edit")) {
      state.editingId = id("data-tariff-edit");
      return renderSettings();
    }
    if (target.closest("[data-tariff-cancel]")) {
      state.editingId = "";
      return renderSettings();
    }
    if (id("data-tariff-save")) {
      const tariffId = id("data-tariff-save");
      const fields = readRow(target.closest("tr"));
      return settingsAction(async () => {
        const updated = await api("PUT", `/api/delivery/tariff-codes/${encodeURIComponent(tariffId)}`, fields);
        replaceInLibrary(updated.tariff);
        state.editingId = "";
      }, "Tariff saved. Issued invoices keep their original wording.");
    }
    if (id("data-tariff-toggle")) {
      const tariffId = id("data-tariff-toggle");
      const current = state.library.find((entry) => entry.id === tariffId);
      return settingsAction(async () => {
        const updated = await api("PUT", `/api/delivery/tariff-codes/${encodeURIComponent(tariffId)}`, { isActive: !current.isActive });
        replaceInLibrary(updated.tariff);
      }, current.isActive ? "Tariff deactivated." : "Tariff reactivated.");
    }
    if (id("data-tariff-delete")) {
      const tariffId = id("data-tariff-delete");
      const current = state.library.find((entry) => entry.id === tariffId);
      if (!window.confirm(`Permanently delete ${current.tariffCode}? This cannot be undone.`)) return;
      return settingsAction(async () => {
        await api("DELETE", `/api/delivery/tariff-codes/${encodeURIComponent(tariffId)}`);
        state.library = state.library.filter((entry) => entry.id !== tariffId);
      }, "Tariff deleted.");
    }
  }

  function onSettingsInput(event) {
    if (event.target.id === "tariffSearch") state.filter.text = event.target.value;
    else if (event.target.id === "tariffStatusFilter") state.filter.status = event.target.value;
    else return;
    renderSettings();
  }

  document.addEventListener("input", onInput);
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("click", onClick);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("click", onSettingsClick);
  document.addEventListener("input", onSettingsInput);
  document.addEventListener("change", onSettingsInput);

  root.TariffUi = { load, selectorHtml, refreshSelector, renderSettings, state };
  load();
})(typeof window !== "undefined" ? window : globalThis);
