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
    summary: "Access delivery, shipment prep, commercial invoice, and archive workflows.",
    icon: "📦"
  },
  {
    id: "pricing-automation",
    name: "Pricing Automation",
    status: "first-build",
    href: "/modules/pricing-automation",
    summary: "Rule-based pricing calculator with app-owned write history and audit events.",
    icon: "💲"
  },
  {
    id: "integrations",
    name: "Integrations",
    status: "planned",
    href: "/modules/integrations",
    summary: "MSSQL, PSQL, Access import, website updates, file-share checks, and future service APIs.",
    icon: "🔗"
  },
  {
    id: "automation",
    name: "Automation",
    status: "planned",
    href: "/modules/automation",
    summary: "Local LLM and rule-based automation tools routed through audited platform APIs.",
    icon: "⚡"
  }
];

// NOTE: The launcher and search are owned entirely by shared.js (LAUNCHER_APPS /
// SEARCH_INDEX / wireLauncher / wireSearch). The previous duplicate copies here were
// stale (missing Doc Studio, Business Metrics, Users, Credentials) and raced with
// shared.js to populate #launcherGrid, so they have been removed.

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

  renderMetrics();
  renderModules();
  wireDashboardActions();
  wireHeaderActions();  // analytics section collapse (home-page specific)
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

  const stateClass = {
    "discovered": "",
    "ready-for-import": "",
    "credentials-needed": "warn",
    "setup-needed": "warn",
    "disabled": "muted",
    "planned": "info"
  };

  target.innerHTML = tiles.map(tile => `
    <div class="analytics-metric ${tile.isVisible ? "" : "hidden-tile"}" data-tile-key="${escapeHtml(tile.key)}">
      <div class="a-label">${escapeHtml(tile.title || tile.label)}</div>
      <strong class="a-value">${escapeHtml(tile.value)}</strong>
      <span class="a-detail ${stateClass[tile.state] || "muted"}">${escapeHtml(tile.detail || tile.description || "")}</span>
    </div>
  `).join("");

  renderDashboardSaveState();
}

function wireDashboardActions() {
  document.querySelector("#dashboardEditToggle")?.addEventListener("click", () => {
    state.dashboardEditMode = !state.dashboardEditMode;
    const toggle = document.querySelector("#dashboardEditToggle");
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(state.dashboardEditMode));
      toggle.setAttribute("aria-label", state.dashboardEditMode ? "Lock dashboard" : "Edit dashboard");
    }
    renderMetrics();
  });
}

function wireHeaderActions() {
  // Analytics section collapse
  const head = document.querySelector("#analyticsHead");
  const body = document.querySelector("#analyticsBody");
  head?.addEventListener("click", () => {
    const isOpen = !body.hidden;
    body.hidden = isOpen;
    head.classList.toggle("is-open", !isOpen);
    head.setAttribute("aria-expanded", String(!isOpen));
    head.querySelector(".analytics-chevron").innerHTML = isOpen ? "&#9660;" : "&#9650;";
  });
  head?.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); head.click(); } });
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

// Theme and launcher/search wired by shared.js (loaded before app.js in index.html)

init();
