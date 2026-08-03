const state = {
  modules: [],
  dashboard: null,
  dashboardEditMode: false,
  dashboardSaving: false,
  deviceId: "",
  auth: {
    user: null,
    needsMigration: false,
    needsBootstrap: false
  }
};

const DASHBOARD_REFRESH_MS = 30000;
let dashboardRefreshTimer = null;

const fallbackDashboard = {
  tiles: [
    { key: "open-source-shipments", title: "Open source shipments", value: "PSQL/MSSQL", detail: "Shipments.Shipped = 0", state: "discovered", isVisible: true, sortOrder: 10, size: "normal", moduleCode: "delivery-export" },
    { key: "app-owned-closures", title: "App-owned closures", value: "Pending DB", detail: "Stored in optilens_local first", state: "credentials-needed", isVisible: true, sortOrder: 30, size: "normal", moduleCode: "delivery-export" },
    { key: "access-archive-import-status", title: "Access archive/import status", value: "CV_Accounts_be", detail: "Last 12 months active plus archive", state: "ready-for-import", isVisible: true, sortOrder: 70, size: "normal", moduleCode: "delivery-export" },
    { key: "write-back-status", title: "Write-back status", value: "Off", detail: "Future approved workflow only", state: "disabled", isVisible: true, sortOrder: 80, size: "normal", href: "/settings" }
  ],
  hiddenTiles: [
    { key: "source-mssql-health", title: "Source MSSQL health", value: "Credentials", detail: "Set source MSSQL credentials", state: "credentials-needed", isVisible: false, sortOrder: 50, size: "normal", href: "/credentials" },
    { key: "private-app-db-health", title: "Private app DB health", value: "Setup", detail: "Create optilens_local", state: "setup-needed", isVisible: false, sortOrder: 60, size: "normal", href: "/settings" }
  ],
  integrationHealth: [
    { name: "Private app MSSQL", state: "setup-needed", detail: "Create optilens_local" },
    { name: "Source MSSQL Innovations", state: "credentials-needed", detail: "Use SQL login setup" },
    { name: "ODBC Connector", state: "credentials-needed", detail: "Innovations ODBC DSN not yet configured" },
    { name: "Pricelist DB", state: "discovered", detail: "Pricelist Builder data source identified" },
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
    icon: "inventory_2"
  },
  {
    id: "pricing-automation",
    name: "Pricing Automation",
    status: "first-build",
    href: "/modules/pricing-automation",
    summary: "Rule-based pricing calculator with app-owned write history and audit events.",
    icon: "price_change"
  },
  {
    id: "integrations",
    name: "Integrations",
    status: "planned",
    href: "/modules/integrations",
    summary: "MSSQL, PSQL, Access import, website updates, file-share checks, and future service APIs.",
    icon: "link"
  },
  {
    id: "automation",
    name: "Automation",
    status: "planned",
    href: "/modules/automation",
    summary: "Local LLM and rule-based automation tools routed through audited platform APIs.",
    icon: "bolt"
  }
];

const tileDestinations = {
  "source-mssql-health": "/credentials",
  "private-app-db-health": "/settings",
  "write-back-status": "/settings"
};

// Note: "Launch Pad" (dashboard) and "Users" (admin-users) are intentionally omitted
// from the launch grid — they remain reachable via the app launcher/search in shared.js.
// Icons are Google Material Symbols ligature names (rendered via .material-symbols-outlined).
const platformApplications = [
  {
    id: "business-metrics",
    name: "Business Metrics",
    href: "/modules/business-metrics",
    summary: "Leadership and operations metrics for enabled workflows.",
    status: "planned",
    permissions: ["platform.admin"]
  },
  {
    id: "release-notes",
    name: "Release Notes",
    href: "/release-notes",
    summary: "Chronological changelog and roadmap notes for signed-in users.",
    status: "discovered",
    permissions: []
  },
  {
    id: "credentials",
    name: "Credentials",
    href: "/credentials",
    summary: "Secure connection credentials and vault setup.",
    status: "admin",
    permissions: ["credentials.manage"]
  },
  {
    id: "settings",
    name: "Settings",
    href: "/settings",
    summary: "Platform endpoints, health checks, and configuration.",
    status: "admin",
    permissions: ["platform.admin"]
  }
];

const moduleAccessRules = {
  "delivery-export": ["delivery.read", "delivery.write"],
  "pricing-automation": ["pricing.read", "pricing.write"],
  "integrations": ["integrations.read", "integrations.manage"],
  "automation": ["automation.read", "automation.manage"]
};

// NOTE: The launcher and search are owned entirely by shared.js (LAUNCHER_APPS /
// SEARCH_INDEX / wireLauncher / wireSearch). The previous duplicate copies here
// raced with shared.js to populate #launcherGrid, so they have been removed.

async function init() {
  tickClock();
  setInterval(tickClock, 1000);
  wireHomeAuthForm();
  window.addEventListener("optilens:auth-changed", (event) => {
    state.auth = {
      ...state.auth,
      user: event.detail?.user || null
    };
    applyAuthGate();
    renderHomeAuth();
  });

  state.auth = await loadAuthState();
  applyAuthGate();
  renderHomeAuth();

  if (!state.auth.user) return;

  state.deviceId = await getDashboardDeviceId();

  const [dashboard, modules] = await Promise.all([
    getJson(`/api/dashboard?deviceId=${encodeURIComponent(state.deviceId)}`, fallbackDashboard),
    getJson("/api/modules", { modules: fallbackModules })
  ]);

  state.dashboard = dashboard;
  state.modules = modules.modules || fallbackModules;

  renderApplicationGrid();
  renderCriticalStatusPills();
  renderMetrics();
  wireDashboardActions();
  wireHeaderActions();  // analytics section collapse (home-page specific)
  startDashboardRefresh();
}

async function loadAuthState() {
  const bootstrap = await getJson("/api/auth/bootstrap-state", { needsMigration: false, needsBootstrap: false });
  const me = await getJson("/api/auth/me", { user: null });
  return {
    user: me.user || null,
    needsMigration: Boolean(bootstrap.needsMigration),
    needsBootstrap: Boolean(bootstrap.needsBootstrap)
  };
}

function applyAuthGate() {
  const signedIn = Boolean(state.auth.user);
  document.body.classList.remove("auth-pending");
  document.body.classList.toggle("signed-in", signedIn);
  document.body.classList.toggle("signed-out", !signedIn);
  document.querySelectorAll("[data-auth-required]").forEach((element) => {
    element.hidden = !signedIn;
  });
}

function renderHomeAuth() {
  const user = state.auth.user;
  const signedIn = Boolean(user);
  const name = user?.displayName || user?.username || "there";
  const form = document.querySelector("#homeAuthForm");
  const signedInAction = document.querySelector("#signedInAction");
  const eyebrow = document.querySelector("#welcomeEyebrow");
  const title = document.querySelector("#welcomeTitle");
  const message = document.querySelector("#welcomeMessage");
  const authTitle = document.querySelector("#homeAuthTitle");
  const authCopy = document.querySelector("#homeAuthCopy");
  const submit = document.querySelector("#homeAuthSubmit");
  const displayWrap = document.querySelector("#homeAuthDisplayNameWrap");
  const emailWrap = document.querySelector("#homeAuthEmailWrap");
  const error = document.querySelector("#homeAuthError");

  if (eyebrow) eyebrow.textContent = signedIn ? "Signed in" : "Secure LAN dashboard";
  if (title) title.textContent = signedIn ? `Welcome, ${name}` : "OptiLens Local";
  if (message) {
    message.textContent = signedIn
      ? "Your launch pad is ready. Platform status and configured workflows are available below."
      : "Sign in to access export deliveries, pricing automation, integrations, and internal operations workflows.";
  }

  if (form) form.hidden = signedIn;
  if (signedInAction) signedInAction.hidden = !signedIn;
  if (!form || signedIn) return;

  const needsMigration = state.auth.needsMigration;
  const needsBootstrap = state.auth.needsBootstrap;
  if (authTitle) authTitle.textContent = needsMigration ? "Run migrations" : needsBootstrap ? "Create first admin" : "Sign in";
  if (authCopy) {
    authCopy.textContent = needsMigration
      ? "Authentication tables are missing. Run the auth migration before signing in."
      : needsBootstrap
      ? "Create the first administrator account before using the launch pad."
      : "Use your OptiLens Local account.";
  }
  if (submit) {
    submit.textContent = needsBootstrap ? "Create admin" : "Sign in";
    submit.disabled = needsMigration;
  }
  if (displayWrap) displayWrap.hidden = !needsBootstrap;
  if (emailWrap) emailWrap.hidden = !needsBootstrap;
  if (error) error.textContent = "";
}

function wireHomeAuthForm() {
  const form = document.querySelector("#homeAuthForm");
  if (!form) return;
  form.addEventListener("submit", submitHomeAuth);
}

async function submitHomeAuth(event) {
  event.preventDefault();
  const submit = document.querySelector("#homeAuthSubmit");
  const error = document.querySelector("#homeAuthError");
  const body = {
    username: document.querySelector("#homeAuthUsername").value.trim(),
    password: document.querySelector("#homeAuthPassword").value
  };

  if (state.auth.needsBootstrap) {
    body.displayName = document.querySelector("#homeAuthDisplayName").value.trim() || "Administrator";
    body.email = document.querySelector("#homeAuthEmail").value.trim();
  }

  if (submit) submit.disabled = true;
  if (error) error.textContent = "";

  try {
    const endpoint = state.auth.needsBootstrap ? "/api/auth/bootstrap" : "/api/auth/login";
    const data = await postJson(endpoint, body);
    state.auth.user = data.user;
    state.auth.needsBootstrap = false;
    window.dispatchEvent(new CustomEvent("optilens:auth-changed", { detail: { user: data.user } }));
    window.location.reload();
  } catch (err) {
    if (error) error.textContent = err.message || "Sign in failed.";
  } finally {
    if (submit) submit.disabled = state.auth.needsMigration;
  }
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

  target.innerHTML = tiles.map(tile => {
    const href = dashboardTileHref(tile);
    const tag = href ? "a" : "div";
    const hrefAttribute = href ? ` href="${escapeHtml(href)}"` : "";
    return `
    <${tag} class="analytics-metric ${href ? "is-clickable" : ""} ${tile.isVisible ? "" : "hidden-tile"}" data-tile-key="${escapeHtml(tile.key)}"${hrefAttribute}>
      <div class="a-label">${escapeHtml(tile.title || tile.label)}</div>
      <strong class="a-value">${escapeHtml(tile.value)}</strong>
      <span class="a-detail ${stateClass[tile.state] || "muted"}">${escapeHtml(tile.detail || tile.description || "")}</span>
    </${tag}>
  `;
  }).join("");

  renderDashboardSaveState();
}

function renderCriticalStatusPills() {
  const target = document.querySelector("#criticalStatusPills");
  if (!target) return;

  const criticalNames = ["Private app MSSQL", "Source MSSQL Innovations", "ODBC Connector", "Pricelist DB", "PSQL Innovations"];
  const health = state.dashboard?.integrationHealth || [];
  const critical = health.filter((item) => criticalNames.includes(item.name));

  target.innerHTML = critical.map((item) => `
    <span class="critical-status-pill ${escapeHtml(statusTone(item.state))}" title="${escapeHtml(item.detail || "")}">
      <span>${escapeHtml(item.name.replace(" Innovations", ""))}</span>
      <strong>${escapeHtml(statusLabel(item.state))}</strong>
    </span>
  `).join("");
}

function startDashboardRefresh() {
  if (dashboardRefreshTimer) return;

  dashboardRefreshTimer = setInterval(() => {
    if (!state.auth.user || state.dashboardEditMode) return;
    refreshDashboardSnapshot();
  }, DASHBOARD_REFRESH_MS);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshDashboardSnapshot();
    }
  });

  window.addEventListener("optilens:connection-restored", () => {
    if (state.auth.user && !state.dashboardEditMode) refreshDashboardSnapshot();
  });
}

async function refreshDashboardSnapshot() {
  if (!state.auth.user || !state.deviceId) return;

  try {
    const response = await fetch(`/api/dashboard?deviceId=${encodeURIComponent(state.deviceId)}`, { cache: "no-store" });
    if (!response.ok) return;
    const dashboard = await response.json();
    state.dashboard = dashboard;
    state.modules = dashboard.modules || state.modules;
    renderApplicationGrid();
    renderCriticalStatusPills();
    renderMetrics();
  } catch {
    // Keep the last known snapshot until the next successful refresh.
  }
}

function renderApplicationGrid() {
  const target = document.querySelector("#appAccessGrid");
  if (!target) return;

  const apps = applicationCatalog();
  target.innerHTML = apps.map((app) => {
    const allowed = canAccessApplication(app);
    const tag = allowed ? "a" : "div";
    const href = allowed ? ` href="${escapeHtml(app.href)}"` : "";
    const aria = allowed ? "" : ` aria-disabled="true"`;
    return `
      <${tag} class="app-access-card ${allowed ? "is-allowed" : "is-restricted"}"${href}${aria}>
        <span class="app-access-icon material-symbols-outlined">${escapeHtml(app.icon || "apps")}</span>
        <span class="badge ${escapeHtml(app.status || "planned")}">${escapeHtml(allowed ? "available" : "restricted")}</span>
        <h3>${escapeHtml(app.name)}</h3>
        <p>${escapeHtml(app.summary || "Application workspace.")}</p>
      </${tag}>
    `;
  }).join("");
}

function applicationCatalog() {
  const shellApps = window.OptiLensShell?.apps || [];
  const shellById = new Map(shellApps.map((app) => [app.id, app]));
  const moduleApps = (state.modules || []).map((module) => ({
    ...module,
    icon: shellById.get(module.id)?.icon || moduleIcon(module.id),
    permissions: moduleAccessRules[module.id] || [`${module.id}.read`]
  }));
  const seen = new Set(moduleApps.map((app) => app.id));
  return moduleApps.concat(platformApplications.filter((app) => !seen.has(app.id)).map((app) => {
    const shellApp = shellById.get(app.id);
    return {
      ...app,
      icon: shellApp?.icon || moduleIcon(app.id)
    };
  }));
}

function canAccessApplication(app) {
  const permissions = state.auth.user?.permissions || [];
  if (permissions.includes("platform.admin")) return true;
  if (!app.permissions || app.permissions.length === 0) return true;
  return app.permissions.some((permission) => permissions.includes(permission));
}

function moduleIcon(moduleId) {
  // Google Material Symbols ligature names (rendered via .material-symbols-outlined).
  const icons = {
    "delivery-export": "inventory_2",
    "pricing-automation": "price_change",
    "integrations": "link",
    "automation": "bolt"
  };
  return icons[moduleId] || "apps";
}

function initials(value) {
  return String(value || "")
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("") || "AP";
}

function dashboardTileHref(tile) {
  if (tile.href) return tile.href;
  if (tileDestinations[tile.key]) return tileDestinations[tile.key];
  if (!tile.moduleCode) return "";
  return state.modules.find((module) => module.id === tile.moduleCode)?.href || "";
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
    moduleCode: tile.moduleCode || tile.module_code || "",
    href: tile.href || "",
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
  if (!target) return;
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

function statusLabel(value) {
  return String(value || "unknown")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function statusTone(value) {
  return ["online", "discovered", "ready-for-import", "enabled"].includes(value)
    ? "ok"
    : ["credentials-needed", "setup-needed", "planned"].includes(value)
    ? "warn"
    : "error";
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
    btn.classList.add("material-symbols-outlined");
    btn.textContent = theme === "dark" ? "light_mode" : "dark_mode";
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
