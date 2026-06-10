const state = {
  modules: [],
  dashboard: null,
  dashboardEditMode: false,
  dashboardSaving: false,
  deviceId: ""
};

const fallbackDashboard = {
  tiles: [
    { key: "open-source-shipments", title: "Open source shipments", value: "PSQL/MSSQL", detail: "Shipments.Shipped = 0", state: "discovered", isVisible: true, sortOrder: 10, size: "normal" },
    { key: "app-owned-closures", title: "App-owned closures", value: "Pending DB", detail: "Stored in optilens_local first", state: "credentials-needed", isVisible: true, sortOrder: 30, size: "normal" },
    { key: "access-archive-import-status", title: "Access archive/import status", value: "CV_Accounts_be", detail: "Last 12 months active plus archive", state: "ready-for-import", isVisible: true, sortOrder: 70, size: "normal" },
    { key: "write-back-status", title: "Write-back status", value: "Off", detail: "Future approved workflow only", state: "disabled", isVisible: true, sortOrder: 80, size: "normal" }
  ],
  hiddenTiles: [
    { key: "source-mssql-health", title: "Source MSSQL health", value: "Credentials", detail: "Set source MSSQL credentials", state: "credentials-needed", isVisible: false, sortOrder: 50, size: "normal" },
    { key: "private-app-db-health", title: "Private app DB health", value: "Setup", detail: "Create optilens_local", state: "setup-needed", isVisible: false, sortOrder: 60, size: "normal" }
  ],
  integrationHealth: [
    { name: "Private app MSSQL", state: "setup-needed", detail: "Create optilens_local" },
    { name: "Source MSSQL Innovations", state: "credentials-needed", detail: "Use SQL login setup" },
    { name: "PSQL Innovations", state: "discovered", detail: "Shipments and ShipmentItems identified" },
    { name: "Access backend", state: "ready-for-import", detail: "CV_Accounts_be.accdb is first historic source" }
  ]
};

const fallbackModules = [
  {
    id: "delivery-export",
    name: "Delivery and Export",
    status: "first-build",
    href: "/modules/delivery-export",
    summary: "Access delivery, shipment prep, commercial invoice, and archive workflows."
  },
  {
    id: "integrations",
    name: "Integrations",
    status: "planned",
    href: "/modules/integrations",
    summary: "MSSQL, PSQL, Access import, website updates, file-share checks, and future service APIs."
  },
  {
    id: "automation",
    name: "Automation",
    status: "planned",
    href: "/modules/automation",
    summary: "Local LLM and rule-based automation tools routed through audited platform APIs."
  }
];

async function init() {
  tickClock();
  setInterval(tickClock, 1000);
  state.deviceId = await getDashboardDeviceId();

  const [dashboard, modules] = await Promise.all([
    getJson(`/api/dashboard?deviceId=${encodeURIComponent(state.deviceId)}`, fallbackDashboard),
    getJson("/api/modules", { modules: fallbackModules })
  ]);

  state.dashboard = dashboard;
  state.modules = modules.modules || fallbackModules;
  state.accessImport = await getJson("/api/access-import/dry-run", { tables: [] });
  state.shipmentSessions = await getJson("/api/delivery/shipments", { sessions: [] });
  state.dispatchers = await getJson("/api/source/dispatchers", { dispatchers: [] });
  state.exportCustomers = await getJson("/api/source/export-customers", { customers: [] });
  state.sourceShipmentItems = { items: [] };

  renderMetrics();
  renderModules();
  renderHealth();
  renderSourceSelectors();
  renderAccessImport();
  renderShipmentSessions();
  wireDashboardActions();
  wireDeliveryActions();
  revealModuleFromPath();
}

async function getJson(url, fallback) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return fallback;
    return response.json();
  } catch {
    return fallback;
  }
}

function tickClock() {
  const el = document.querySelector("#clock");
  if (el) {
    el.textContent = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date());
  }
}

function renderMetrics() {
  const target = document.querySelector("#metrics");
  if (!target) return;

  const visibleTiles = normalizeDashboardTiles(state.dashboard.tiles || state.dashboard.metrics || []);
  const hiddenTiles = normalizeDashboardTiles(state.dashboard.hiddenTiles || []);
  const tiles = state.dashboardEditMode ? visibleTiles.concat(hiddenTiles) : visibleTiles;

  target.classList.toggle("editing", state.dashboardEditMode);
  target.innerHTML = tiles.map((tile, index) => `
    <article
      class="metric ${tile.isVisible ? "" : "hidden-tile"} ${tile.size === "wide" ? "wide" : ""}"
      draggable="${state.dashboardEditMode ? "true" : "false"}"
      data-tile-key="${escapeHtml(tile.key)}"
    >
      <div class="metric-toolbar">
        <span>${escapeHtml(tile.title || tile.label)}</span>
        ${state.dashboardEditMode ? `
          <div class="tile-actions">
            <button class="tile-icon" type="button" data-move="up" data-index="${index}" aria-label="Move ${escapeHtml(tile.title || tile.label)} up">&#8593;</button>
            <button class="tile-icon" type="button" data-move="down" data-index="${index}" aria-label="Move ${escapeHtml(tile.title || tile.label)} down">&#8595;</button>
            <button class="tile-icon" type="button" data-toggle-visible="${escapeHtml(tile.key)}" aria-label="${tile.isVisible ? "Hide" : "Show"} ${escapeHtml(tile.title || tile.label)}">${tile.isVisible ? "Hide" : "Show"}</button>
          </div>
        ` : ""}
      </div>
      <strong>${escapeHtml(tile.value)}</strong>
      <small>${escapeHtml(tile.detail || tile.description || "")}</small>
      ${state.dashboardEditMode && !tile.isVisible ? `<em>Hidden in locked mode</em>` : ""}
    </article>
  `).join("");

  renderDashboardSaveState();
}

function wireDashboardActions() {
  document.querySelector("#dashboardEditToggle")?.addEventListener("click", () => {
    state.dashboardEditMode = !state.dashboardEditMode;
    const toggle = document.querySelector("#dashboardEditToggle");
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(state.dashboardEditMode));
      toggle.setAttribute("aria-label", state.dashboardEditMode ? "Lock dashboard layout" : "Unlock dashboard layout");
      toggle.setAttribute("title", state.dashboardEditMode ? "Lock dashboard layout" : "Unlock dashboard layout");
      toggle.innerHTML = state.dashboardEditMode ? "&#128275;" : "&#128274;";
    }
    renderMetrics();
  });

  const grid = document.querySelector("#metrics");
  grid?.addEventListener("click", async (event) => {
    const toggleKey = event.target.dataset.toggleVisible;
    const move = event.target.dataset.move;
    if (toggleKey) {
      setTileVisibility(toggleKey, !findDashboardTile(toggleKey).isVisible);
      renderMetrics();
      await saveDashboardLayout();
    }
    if (move) {
      moveTile(Number(event.target.dataset.index), move === "up" ? -1 : 1);
      renderMetrics();
      await saveDashboardLayout();
    }
  });

  grid?.addEventListener("dragstart", (event) => {
    if (!state.dashboardEditMode) return;
    event.dataTransfer.setData("text/plain", event.target.closest("[data-tile-key]")?.dataset.tileKey || "");
    event.dataTransfer.effectAllowed = "move";
  });

  grid?.addEventListener("dragover", (event) => {
    if (state.dashboardEditMode && event.target.closest("[data-tile-key]")) {
      event.preventDefault();
    }
  });

  grid?.addEventListener("drop", async (event) => {
    if (!state.dashboardEditMode) return;
    event.preventDefault();
    const fromKey = event.dataTransfer.getData("text/plain");
    const toKey = event.target.closest("[data-tile-key]")?.dataset.tileKey;
    if (fromKey && toKey && fromKey !== toKey) {
      reorderTileByKey(fromKey, toKey);
      renderMetrics();
      await saveDashboardLayout();
    }
  });
}

function normalizeDashboardTiles(tiles) {
  return tiles.map((tile, index) => ({
    ...tile,
    key: tile.key || tile.tileKey || `tile-${index}`,
    title: tile.title || tile.label || "",
    isVisible: tile.isVisible !== false,
    sortOrder: Number(tile.sortOrder ?? index + 1),
    size: tile.size || "normal"
  })).sort((a, b) => (a.sortOrder - b.sortOrder) || a.title.localeCompare(b.title));
}

function allDashboardTiles() {
  return normalizeDashboardTiles(state.dashboard.tiles || state.dashboard.metrics || [])
    .concat(normalizeDashboardTiles(state.dashboard.hiddenTiles || []));
}

function replaceDashboardTiles(tiles) {
  const normalized = tiles.map((tile, index) => ({ ...tile, sortOrder: index + 1 }));
  state.dashboard.tiles = normalized.filter(tile => tile.isVisible);
  state.dashboard.hiddenTiles = normalized.filter(tile => !tile.isVisible);
}

function findDashboardTile(key) {
  return allDashboardTiles().find(tile => tile.key === key) || {};
}

function setTileVisibility(key, isVisible) {
  replaceDashboardTiles(allDashboardTiles().map(tile => tile.key === key ? { ...tile, isVisible } : tile));
}

function moveTile(index, direction) {
  const tiles = allDashboardTiles();
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= tiles.length) return;
  const [tile] = tiles.splice(index, 1);
  tiles.splice(nextIndex, 0, tile);
  replaceDashboardTiles(tiles);
}

function reorderTileByKey(fromKey, toKey) {
  const tiles = allDashboardTiles();
  const fromIndex = tiles.findIndex(tile => tile.key === fromKey);
  const toIndex = tiles.findIndex(tile => tile.key === toKey);
  if (fromIndex < 0 || toIndex < 0) return;
  const [tile] = tiles.splice(fromIndex, 1);
  tiles.splice(toIndex, 0, tile);
  replaceDashboardTiles(tiles);
}

async function saveDashboardLayout() {
  state.dashboardSaving = true;
  renderDashboardSaveState("Saving");
  try {
    const saved = await putJson("/api/dashboard/tiles", {
      deviceId: state.deviceId,
      tiles: allDashboardTiles().map((tile, index) => ({
        key: tile.key,
        isVisible: tile.isVisible,
        sortOrder: index + 1,
        size: tile.size || "normal"
      }))
    });
    state.dashboard = saved;
    renderDashboardSaveState("Saved");
  } catch (error) {
    renderDashboardSaveState(error.message || "Save failed");
  } finally {
    state.dashboardSaving = false;
  }
}

function renderDashboardSaveState(message) {
  const target = document.querySelector("#dashboardSaveState");
  if (!target) return;
  target.textContent = message || (state.dashboardEditMode ? "Edit mode" : "");
}

function renderModules() {
  const target = document.querySelector("#moduleGrid");
  target.innerHTML = state.modules.map(module => `
    <a class="module-card" href="${escapeHtml(module.href)}">
      <span class="badge ${escapeHtml(module.status)}">${escapeHtml(module.status)}</span>
      <h3>${escapeHtml(module.name)}</h3>
      <p>${escapeHtml(module.summary)}</p>
    </a>
  `).join("");
}

function renderHealth() {
  const target = document.querySelector("#healthList");
  target.innerHTML = state.dashboard.integrationHealth.map(item => `
    <article class="setup-card">
      <span class="badge ${escapeHtml(item.state)}">${escapeHtml(item.state)}</span>
      <h3>${escapeHtml(item.name)}</h3>
      <p>${escapeHtml(item.detail)}</p>
    </article>
  `).join("");
}

function renderAccessImport() {
  const target = document.querySelector("#accessImportRows");
  if (!target) return;

  const tables = state.accessImport.tables || [];
  target.innerHTML = tables.map(table => `
    <tr>
      <td>${escapeHtml(table.table)}</td>
      <td>${table.row_count === null || table.row_count === undefined ? "-" : Number(table.row_count).toLocaleString()}</td>
      <td><span class="badge">${escapeHtml(table.migration_treatment || "review")}</span></td>
    </tr>
  `).join("") || `<tr><td colspan="3">Run the Access import dry-run script to populate this section.</td></tr>`;
}

function renderShipmentSessions() {
  const target = document.querySelector("#shipmentSessionsRows");
  if (!target) return;

  const sessions = state.shipmentSessions.sessions || [];
  target.innerHTML = sessions.map(session => `
    <tr>
      <td>${escapeHtml(session.customer_account || "")}</td>
      <td>${escapeHtml(session.source_shipment_id || "")}</td>
      <td><span class="badge ${session.app_status === "closed" ? "" : "open"}">${escapeHtml(session.app_status)}</span></td>
      <td>${formatDate(session.started_at)}</td>
      <td>
        ${session.app_status === "closed"
          ? `<button class="text-button" type="button" data-reopen="${escapeHtml(session.shipment_session_id)}">Reopen</button>`
          : `<button class="text-button" type="button" data-close="${escapeHtml(session.shipment_session_id)}">Close</button>`}
      </td>
    </tr>
  `).join("") || `<tr><td colspan="5">No app-owned shipment sessions yet.</td></tr>`;
}

function renderSourceSelectors() {
  const customerSelect = document.querySelector("#customerAccountInput");
  const dispatcherSelect = document.querySelector("#dispatcherInput");

  if (customerSelect) {
    customerSelect.innerHTML = `<option value="">Select export customer</option>` + (state.exportCustomers.customers || []).map(customer => `
      <option value="${escapeHtml(customer.customerAccount)}">${escapeHtml(customer.customerAccount)} - ${escapeHtml(customer.customerName)}</option>
    `).join("");
  }

  if (dispatcherSelect) {
    dispatcherSelect.innerHTML = `<option value="">Select dispatcher</option>` + (state.dispatchers.dispatchers || []).map(dispatcher => `
      <option value="${escapeHtml(dispatcher.dispatcherId)}">${escapeHtml(dispatcher.dispatcherName)}${dispatcher.jobTitle ? ` - ${escapeHtml(dispatcher.jobTitle)}` : ""}</option>
    `).join("");
  }
}

function renderSourceShipmentItems() {
  const target = document.querySelector("#sourceShipmentItemsRows");
  if (!target) return;

  const items = state.sourceShipmentItems.items || [];
  target.innerHTML = items.map(item => `
    <tr>
      <td>${escapeHtml(item.shipmentItemId)}</td>
      <td>${escapeHtml(item.orderId || "")}</td>
      <td>${escapeHtml(item.invoiceNumber || "")}</td>
      <td>${escapeHtml(item.patientName || "")}</td>
      <td>${formatMoney(item.price)}</td>
      <td><span class="badge ${Number(item.sourceShipped) === 1 ? "" : "open"}">${Number(item.sourceShipped) === 1 ? "shipped" : "open"}</span></td>
    </tr>
  `).join("") || `<tr><td colspan="6">No source shipment items found for this customer/shipment.</td></tr>`;
}

function wireDeliveryActions() {
  document.querySelector("#startShipmentBtn")?.addEventListener("click", startShipmentSession);
  document.querySelector("#refreshShipmentsBtn")?.addEventListener("click", refreshShipmentSessions);
  document.querySelector("#preloadItemsBtn")?.addEventListener("click", preloadSourceShipmentItems);
  document.querySelector("#shipmentSessionsRows")?.addEventListener("click", async (event) => {
    const closeId = event.target.dataset.close;
    const reopenId = event.target.dataset.reopen;

    if (closeId) {
      await postJson(`/api/delivery/shipments/${closeId}/close`, {});
      await refreshShipmentSessions();
    }

    if (reopenId) {
      await postJson(`/api/delivery/shipments/${reopenId}/reopen`, {});
      await refreshShipmentSessions();
    }
  });
}

async function startShipmentSession() {
  const customerAccount = document.querySelector("#customerAccountInput").value.trim();
  const sourceShipmentId = document.querySelector("#shipmentIdInput").value.trim();
  const dispatcherId = document.querySelector("#dispatcherInput").value.trim();

  await postJson("/api/delivery/shipments", {
    sourceSystem: "mssql",
    customerAccount,
    sourceShipmentId,
    dispatcherId,
    sourceShipped: false
  });

  await refreshShipmentSessions();
}

async function preloadSourceShipmentItems() {
  const customerAccount = document.querySelector("#customerAccountInput").value.trim();
  const shipmentId = document.querySelector("#shipmentIdInput").value.trim();
  const query = new URLSearchParams({ customerAccount, shipmentId });

  state.sourceShipmentItems = await getJson(`/api/source/shipment-items?${query.toString()}`, { items: [] });
  renderSourceShipmentItems();
}

async function refreshShipmentSessions() {
  state.shipmentSessions = await getJson("/api/delivery/shipments", { sessions: [] });
  renderShipmentSessions();
}

async function getDashboardDeviceId() {
  const storageKey = "optilens.dashboard.deviceId";
  const existing = localStorage.getItem(storageKey);
  if (existing) return existing;

  const generated = crypto.randomUUID ? crypto.randomUUID() : `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const registration = await postJson("/api/dashboard/device", { deviceId: generated }).catch(() => ({ deviceId: generated }));
  localStorage.setItem(storageKey, registration.deviceId || generated);
  return localStorage.getItem(storageKey);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(data.error || "Request failed");
  }

  return response.json();
}

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(data.error || "Request failed");
  }

  return response.json();
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

function revealModuleFromPath() {
  if (location.pathname.startsWith("/modules/delivery-export")) {
    document.querySelector("#deliveryModule")?.scrollIntoView();
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function applyTheme() {
  const saved = localStorage.getItem("optilens.theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved || (prefersDark ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  const btn = document.querySelector("#themeToggle");
  if (btn) {
    btn.setAttribute("aria-pressed", String(theme === "dark"));
    btn.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
    btn.setAttribute("title", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
    btn.textContent = theme === "dark" ? "☼" : "☽";
  }
}

function wireThemeToggle() {
  document.querySelector("#themeToggle")?.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem("optilens.theme", next);
    applyTheme();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!localStorage.getItem("optilens.theme")) applyTheme();
  });
}

applyTheme();
wireThemeToggle();

init();
