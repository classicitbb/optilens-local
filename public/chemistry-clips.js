/**
 * chemistry-clips.js — Chemistrie clip order recording (shop-floor tablet page).
 * Standalone: does not use shared.js / the platform app shell. Auth is the
 * PIN gate in lib/chemistry-pin-session.js, not a platform login.
 */
(function () {
  "use strict";

  const state = {
    currentOrderId: null,
    currentOrder: null
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheEls();
    wirePinScreen();
    wireApp();

    // If a session cookie from a previous unlock is still valid, skip the PIN screen.
    const stillUnlocked = await tryEnterApp({ silent: true });
    if (!stillUnlocked) await showPinScreen();
  }

  function cacheEls() {
    [
      "ccPinScreen", "ccPinIntro", "ccPinForm", "ccPinInput", "ccPinError",
      "ccPinSetupDetails", "ccPinSetupForm", "ccPinSetupInput",
      "ccApp", "ccNewOrderBtn", "ccLockBtn",
      "ccListView", "ccSearchInput", "ccSearchBtn", "ccListStatus", "ccOrdersBody",
      "ccFormView", "ccBackBtn", "ccFormStatusBadge", "ccFormMessage", "ccOrderForm",
      "ccScanInput", "ccItemRoleSelect", "ccItemQtyInput", "ccAddItemBtn",
      "ccScanMessage", "ccItemList", "ccLockOrderBtn", "ccUnlockOrderBtn"
    ].forEach((id) => { els[id] = document.getElementById(id); });
  }

  // ── API helper ───────────────────────────────────────────────────────────
  async function api(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    let data = null;
    try { data = await response.json(); } catch { /* no body */ }
    if (!response.ok) {
      const error = new Error((data && data.error) || `Request failed (${response.status})`);
      error.statusCode = response.status;
      throw error;
    }
    return data;
  }

  // ── PIN screen ───────────────────────────────────────────────────────────
  async function showPinScreen() {
    els.ccPinScreen.hidden = false;
    els.ccApp.hidden = true;
    try {
      const { hasPin } = await api("/api/chemistry/session/state");
      if (hasPin) {
        els.ccPinForm.hidden = false;
        els.ccPinSetupDetails.hidden = true;
        els.ccPinIntro.textContent = "Enter the shop PIN to continue.";
      } else {
        els.ccPinForm.hidden = true;
        els.ccPinSetupDetails.hidden = false;
        els.ccPinSetupDetails.open = true;
        els.ccPinIntro.textContent = "No PIN is set up yet for this tablet.";
      }
    } catch (error) {
      els.ccPinIntro.textContent = "Could not reach the server. Check the connection and reload.";
    }
  }

  function wirePinScreen() {
    els.ccPinForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      setPinError("");
      try {
        await api("/api/chemistry/session/unlock", { method: "POST", body: { pin: els.ccPinInput.value } });
        els.ccPinInput.value = "";
        await enterApp();
      } catch (error) {
        setPinError(error.message);
      }
    });

    els.ccPinSetupForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      setPinError("");
      try {
        await api("/api/chemistry/session/setup", { method: "POST", body: { pin: els.ccPinSetupInput.value } });
        els.ccPinSetupInput.value = "";
        await enterApp();
      } catch (error) {
        setPinError(error.message);
      }
    });
  }

  function setPinError(message) {
    els.ccPinError.hidden = !message;
    els.ccPinError.textContent = message || "";
  }

  async function tryEnterApp({ silent } = {}) {
    try {
      await api("/api/chemistry/orders?limit=1");
      await enterApp();
      return true;
    } catch (error) {
      if (!silent) setPinError(error.message);
      return false;
    }
  }

  async function enterApp() {
    els.ccPinScreen.hidden = true;
    els.ccApp.hidden = false;
    showListView();
    await refreshOrderList();
  }

  // ── App chrome ───────────────────────────────────────────────────────────
  function wireApp() {
    els.ccLockBtn.addEventListener("click", async () => {
      try { await api("/api/chemistry/session/lock", { method: "POST" }); } catch { /* ignore */ }
      window.location.reload();
    });

    els.ccNewOrderBtn.addEventListener("click", () => {
      showFormView();
      loadOrderIntoForm(null);
    });

    els.ccBackBtn.addEventListener("click", async () => {
      showListView();
      await refreshOrderList();
    });

    els.ccSearchBtn.addEventListener("click", () => refreshOrderList());
    els.ccSearchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); refreshOrderList(); }
    });

    els.ccOrdersBody.addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-order-id]");
      if (!row) return;
      showFormView();
      loadOrderIntoForm(row.dataset.orderId);
    });

    els.ccOrderForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveOrderFromForm();
    });

    els.ccAddItemBtn.addEventListener("click", () => addItem("manual"));
    els.ccScanInput.addEventListener("keydown", (event) => {
      // A USB/Bluetooth barcode scanner types the SKU and presses Enter.
      if (event.key === "Enter") { event.preventDefault(); addItem("barcode"); }
    });

    els.ccItemList.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-remove-item]");
      if (!button || !state.currentOrderId) return;
      try {
        state.currentOrder = await api(`/api/chemistry/orders/${state.currentOrderId}/items/${button.dataset.removeItem}`, { method: "DELETE" });
        renderItemList();
      } catch (error) {
        showFormMessage(error.message, true);
      }
    });

    els.ccLockOrderBtn.addEventListener("click", async () => {
      if (!state.currentOrderId) return;
      try {
        state.currentOrder = await api(`/api/chemistry/orders/${state.currentOrderId}/lock`, {
          method: "POST", body: { operator: currentOperator() }
        });
        applyOrderStateToForm();
        showFormMessage("Order locked.");
      } catch (error) {
        showFormMessage(error.message, true);
      }
    });

    els.ccUnlockOrderBtn.addEventListener("click", async () => {
      if (!state.currentOrderId) return;
      try {
        state.currentOrder = await api(`/api/chemistry/orders/${state.currentOrderId}/unlock`, {
          method: "POST", body: { operator: currentOperator() }
        });
        applyOrderStateToForm();
        showFormMessage("Order unlocked for editing.");
      } catch (error) {
        showFormMessage(error.message, true);
      }
    });
  }

  function currentOperator() {
    const value = els.ccOrderForm.elements.optician && els.ccOrderForm.elements.optician.value;
    return value ? value.trim() || null : null;
  }

  // ── List view ────────────────────────────────────────────────────────────
  function showListView() {
    els.ccListView.hidden = false;
    els.ccFormView.hidden = true;
  }

  function showFormView() {
    els.ccListView.hidden = true;
    els.ccFormView.hidden = false;
    showFormMessage("");
  }

  async function refreshOrderList() {
    els.ccListStatus.textContent = "Loading…";
    try {
      const orders = await api(`/api/chemistry/orders?search=${encodeURIComponent(els.ccSearchInput.value || "")}`);
      els.ccOrdersBody.innerHTML = orders.map(orderRowHtml).join("");
      els.ccListStatus.textContent = orders.length ? `${orders.length} order${orders.length === 1 ? "" : "s"}` : "No orders found.";
    } catch (error) {
      els.ccListStatus.textContent = error.message;
    }
  }

  function orderRowHtml(order) {
    const date = order.orderDate ? String(order.orderDate).slice(0, 10) : "";
    return `<tr data-order-id="${escapeHtml(order.orderId)}">
      <td>${escapeHtml(date)}</td>
      <td>${escapeHtml(order.patientName || "")}</td>
      <td>${escapeHtml(order.jobNumber || "")}</td>
      <td>${escapeHtml(order.trayNumber || "")}</td>
      <td>${escapeHtml(order.baseCurve || "")}</td>
      <td>${escapeHtml(order.bridgeColor || "")}</td>
      <td>${escapeHtml(order.magnetColor || "")}</td>
      <td>${order.status === "locked" ? "🔒 Locked" : "Draft"}</td>
    </tr>`;
  }

  // ── Form view ────────────────────────────────────────────────────────────
  async function loadOrderIntoForm(orderId) {
    els.ccOrderForm.reset();
    state.currentOrderId = orderId;
    state.currentOrder = null;

    if (!orderId) {
      applyOrderStateToForm();
      renderItemList();
      return;
    }

    try {
      state.currentOrder = await api(`/api/chemistry/orders/${orderId}`);
      populateForm(state.currentOrder);
      applyOrderStateToForm();
      renderItemList();
    } catch (error) {
      showFormMessage(error.message, true);
    }
  }

  const FORM_FIELDS = [
    "patientName", "jobNumber", "trayNumber", "optician", "orderDate",
    "baseCurve", "lensColor", "lensMaterial", "bridgeColor", "bridgeSizeMm",
    "magnetColor", "magnetSeparationMm", "upsizeAmount", "edgeWork", "roundSquare",
    "comments", "fitNotes"
  ];
  const FORM_CHECK_FIELDS = ["clipOnly", "redrillOnly", "permanentCrystal", "magneticCrystal", "fitChecked"];

  function populateForm(order) {
    const form = els.ccOrderForm;
    for (const field of FORM_FIELDS) {
      if (!form.elements[field]) continue;
      let value = order[field];
      if (field === "orderDate" && value) value = String(value).slice(0, 10);
      form.elements[field].value = value == null ? "" : value;
    }
    for (const field of FORM_CHECK_FIELDS) {
      if (form.elements[field]) form.elements[field].checked = !!order[field];
    }
  }

  function readFormBody() {
    const form = els.ccOrderForm;
    const body = {};
    for (const field of FORM_FIELDS) {
      if (!form.elements[field]) continue;
      const raw = form.elements[field].value;
      body[field] = raw === "" ? null : raw;
    }
    for (const field of FORM_CHECK_FIELDS) {
      if (form.elements[field]) body[field] = form.elements[field].checked;
    }
    return body;
  }

  function applyOrderStateToForm() {
    const locked = state.currentOrder && state.currentOrder.status === "locked";
    els.ccFormStatusBadge.textContent = !state.currentOrder ? "New" : locked ? "Locked" : "Draft";
    els.ccFormStatusBadge.classList.toggle("locked", !!locked);

    els.ccLockOrderBtn.hidden = !state.currentOrderId || locked;
    els.ccUnlockOrderBtn.hidden = !state.currentOrderId || !locked;

    // Order fields: disabled only once locked (a brand-new, unsaved order
    // must stay editable so the patient name etc. can be typed at all).
    // Lock/unlock buttons live inside the same <form> but must stay usable
    // regardless of lock state, so they're excluded here.
    Array.from(els.ccOrderForm.elements).forEach((el) => {
      if (el === els.ccLockOrderBtn || el === els.ccUnlockOrderBtn) return;
      el.disabled = !!locked;
    });

    // Inventory items are a sub-resource that needs an existing order, so
    // those controls are also disabled before the first save.
    const disableItemControls = !state.currentOrderId || locked;
    els.ccScanInput.disabled = disableItemControls;
    els.ccItemRoleSelect.disabled = disableItemControls;
    els.ccItemQtyInput.disabled = disableItemControls;
    els.ccAddItemBtn.disabled = disableItemControls;

    const submitButton = els.ccOrderForm.querySelector('button[type="submit"]');
    if (submitButton) submitButton.hidden = !!locked;

    if (!state.currentOrderId) {
      showFormMessage("Fill in the patient name and Save draft to start adding inventory items.");
    }
  }

  async function saveOrderFromForm() {
    const body = readFormBody();
    if (!body.patientName || !body.patientName.trim()) {
      showFormMessage("Patient name is required.", true);
      return;
    }
    body.operator = currentOperator();

    try {
      if (state.currentOrderId) {
        state.currentOrder = await api(`/api/chemistry/orders/${state.currentOrderId}`, { method: "PUT", body });
        showFormMessage("Saved.");
      } else {
        state.currentOrder = await api("/api/chemistry/orders", { method: "POST", body });
        state.currentOrderId = state.currentOrder.orderId;
        showFormMessage("Order created. Case and cloth were added automatically if the catalog has synced.");
      }
      applyOrderStateToForm();
      renderItemList();
    } catch (error) {
      showFormMessage(error.message, true);
    }
  }

  function showFormMessage(message, isError) {
    els.ccFormMessage.hidden = !message;
    els.ccFormMessage.textContent = message || "";
    els.ccFormMessage.classList.toggle("cc-message-error", !!isError);
  }

  // ── Inventory items ──────────────────────────────────────────────────────
  function renderItemList() {
    const items = (state.currentOrder && state.currentOrder.items) || [];
    const locked = state.currentOrder && state.currentOrder.status === "locked";
    els.ccItemList.innerHTML = items.map((item) => `
      <li>
        <span><strong>${escapeHtml(item.sku)}</strong> — ${escapeHtml(item.itemName)} (${escapeHtml(item.itemRole)}) × ${item.quantity}
          <small class="cc-muted"> · ${escapeHtml(item.entryMethod)}</small></span>
        ${locked ? "" : `<button type="button" class="cc-item-remove" data-remove-item="${escapeHtml(item.orderItemId)}" aria-label="Remove">✕</button>`}
      </li>
    `).join("") || `<li class="cc-muted">No items recorded yet.</li>`;
  }

  async function addItem(entryMethod) {
    if (!state.currentOrderId) {
      showScanMessage("Save the order first.", true);
      return;
    }
    const sku = els.ccScanInput.value.trim();
    if (!sku) return;
    const itemRole = els.ccItemRoleSelect.value;
    const quantity = Number(els.ccItemQtyInput.value) || 1;

    try {
      state.currentOrder = await api(`/api/chemistry/orders/${state.currentOrderId}/items`, {
        method: "POST",
        body: { sku, itemRole, quantity, entryMethod, operator: currentOperator() }
      });
      els.ccScanInput.value = "";
      showScanMessage(`Added ${sku}.`);
      renderItemList();
    } catch (error) {
      showScanMessage(error.message, true);
    } finally {
      els.ccScanInput.focus();
    }
  }

  function showScanMessage(message, isError) {
    els.ccScanMessage.textContent = message || "";
    els.ccScanMessage.classList.toggle("cc-error", !!isError);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
  }
})();
