/**
 * shared.js — OptiLens Local common header functionality
 * Injected on every page. Handles: launcher, search palette, theme toggle, back button.
 */

// Icons are Google Material Symbols ligature names (rendered via .material-symbols-outlined).
// Keep shell app metadata in one place so the launcher and search never drift.
const SHELL_APP_CATALOG = [
  { id: "launch-pad",        label: "Launch Pad",        meta: "Home",     icon: "dashboard",     href: "/",                           color: "#1A8A9C", permissions: [] },
  { id: "delivery-export",   label: "Delivery & Export", meta: "Module",   icon: "inventory_2",   href: "/modules/delivery-export",    color: "#C89130", permissions: ["delivery.read", "delivery.write"] },
  { id: "pricing-automation", label: "Pricing",          meta: "Module",   icon: "price_change",  href: "/modules/pricing-automation", color: "#389457", permissions: ["pricing.read", "pricing.write"] },
  { id: "integrations",      label: "Integrations",      meta: "Module",   icon: "link",          href: "/modules/integrations",       color: "#0B1E35", permissions: ["integrations.read", "integrations.manage"] },
  { id: "automation",        label: "Automation",        meta: "Module",   icon: "bolt",          href: "/modules/automation",         color: "#7c3aed", permissions: ["automation.read", "automation.manage"] },
  { id: "business-metrics",  label: "Business Metrics",  meta: "Module",   icon: "monitoring",    href: "/modules/business-metrics",   color: "#b45309", permissions: ["platform.admin"] },
  { id: "release-notes",     label: "Release Notes",     meta: "Roadmap",  icon: "history",       href: "/release-notes",              color: "#6d28d9", permissions: [] },
  { id: "users",             label: "Users",             meta: "Admin",    icon: "group",         href: "/admin/users",                color: "#0B1E35", permissions: ["users.manage"] },
  { id: "credentials",       label: "Credentials",       meta: "Security", icon: "key",           href: "/credentials",                color: "#64748b", permissions: ["credentials.manage"] },
  { id: "settings",          label: "Settings",          meta: "Page",     icon: "settings",      href: "/settings",                   color: "#4b5563", permissions: ["platform.admin"] }
];

const LAUNCHER_APPS = SHELL_APP_CATALOG.map(({ meta, ...app }) => app);

const LAUNCHER_ORDER_STORAGE_KEY = "optilens.launcherOrder";

const SEARCH_INDEX = SHELL_APP_CATALOG.concat([
  { id: "api-health",     label: "API Health",     meta: "Endpoint", icon: "vital_signs", color: "#1A8A9C", href: "/api/health", permissions: [] },
  { id: "dashboard-api",  label: "Dashboard API", meta: "Endpoint", icon: "api",         color: "#1A8A9C", href: "/api/dashboard", permissions: [] },
  { id: "modules-api",    label: "Modules API",   meta: "Endpoint", icon: "view_list",   color: "#1A8A9C", href: "/api/modules", permissions: [] }
]);

const AUTH_STATE = {
  user: null,
  needsMigration: false,
  needsBootstrap: false
};

let DEFERRED_INSTALL_PROMPT = null;
const UPDATE_CHECK_INTERVAL_MS = 60 * 1000;
const UPDATE_STATE = {
  status: null,
  timer: null,
  checking: false,
  applying: false,
  progressTimer: null
};
const CONNECTION_RECOVERY_MS = 5000;
const CONNECTION_STATE = {
  serverReachable: navigator.onLine,
  probing: false,
  timer: null
};
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  DEFERRED_INSTALL_PROMPT = event;
});

// ─── Bootstrap ───────────────────────────────────────────────────────────────

(function bootstrap() {
  // Apply theme immediately to prevent flash
  applyTheme();
  renderShellHeader();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();

function setup() {
  injectOverlays();
  wireThemeToggle();
  wireLauncher();
  wireSearch();
  wireAuth();
  wireUpdateCheck();
  wireConnectionRecovery();
  wireGlobalAssistant();
}

function exposeShellCatalog() {
  window.OptiLensShell = Object.freeze({
    apps: SHELL_APP_CATALOG,
    getAppById(id) {
      return SHELL_APP_CATALOG.find((app) => app.id === id) || null;
    },
    getAppByHref(href) {
      return SHELL_APP_CATALOG.find((app) => app.href === href) || null;
    }
  });
}

exposeShellCatalog();

// ─── Shell header ────────────────────────────────────────────────────────────

function renderShellHeader() {
  const mount = document.getElementById("app-shell-header");
  if (!mount) return;
  const config = getShellPageConfig();
  const topCenterClasses = ["top-center"];
  const launcherClasses = ["launcher-btn"];
  const helpClasses = ["top-action-btn"];
  const editClasses = ["top-action-btn"];
  const userChipClasses = ["user-chip"];

  if (config.authHideSignedOut) {
    topCenterClasses.push("auth-hide-signed-out");
    launcherClasses.push("auth-hide-signed-out");
    helpClasses.push("auth-hide-signed-out");
    editClasses.push("auth-hide-signed-out");
    userChipClasses.push("auth-hide-signed-out");
  }

  mount.innerHTML = `
  <header class="top">
    <div class="top-left">
      <button class="${launcherClasses.join(" ")}" id="launcherBtn" type="button" aria-label="Open app launcher">
        <span class="material-symbols-outlined">apps</span>
      </button>
      <a class="brand" href="/" aria-label="OptiLens Local home">
        <strong>OptiLens Local</strong>
        <span class="top-sep">·</span>
        <span class="top-crumb">${esc(config.crumb)}</span>
      </a>
    </div>

    <div class="${topCenterClasses.join(" ")}">
      <button class="back-btn" type="button" aria-label="Go back" onclick="history.back()">
        <span class="material-symbols-outlined">arrow_back</span>
      </button>
      <button class="search-bar" id="searchTrigger" type="button" aria-label="Search (Ctrl+K)"${config.searchHref ? ` data-search-href="${esc(config.searchHref)}"` : ""}>
        <span class="material-symbols-outlined">search</span>
        <span class="sb-text">Search modules, wiki, settings…</span>
        <kbd>Ctrl+K</kbd>
      </button>
    </div>

    <div class="top-right">
      <button class="top-action-btn update-check-btn" id="updateCheckBtn" type="button" aria-label="Check for updates" title="Check for updates" hidden>
        <span class="material-symbols-outlined" id="updateCheckIcon">system_update</span>
        <span class="notif-count" id="updateCount" hidden>0</span>
      </button>
      ${config.showNotifications ? `
      <button class="top-action-btn" id="notifBtn" type="button" aria-label="Notifications">
        <span class="material-symbols-outlined">notifications</span>
        <span class="notif-count" id="notifCount" hidden>0</span>
      </button>` : ""}
      ${config.showDashboardEdit ? `
      <button class="${editClasses.join(" ")}" id="dashboardEditToggle" type="button" aria-pressed="false" aria-label="Edit dashboard">
        <span class="material-symbols-outlined">edit</span>
      </button>` : ""}
      <button class="${helpClasses.join(" ")}" type="button" aria-label="Help" onclick="window.open('/api/health','_blank')">
        <span class="material-symbols-outlined">help</span>
      </button>
      <button class="top-action-btn assistant-toggle-btn" id="globalAssistantToggle" type="button" aria-label="OptiLens AI Assistant" title="OptiLens AI Assistant (Ctrl+Shift+A)">
        <span class="material-symbols-outlined">smart_toy</span>
      </button>
      <button class="top-action-btn theme-toggle material-symbols-outlined" id="themeToggle" type="button" aria-pressed="false" aria-label="Switch to dark mode">dark_mode</button>
      <button class="${userChipClasses.join(" ")}" type="button" aria-label="User">
        <span class="user-avatar">IN</span>
        <span class="user-name">Sign in</span>
      </button>
    </div>
  </header>`;
}

function getShellPageConfig() {
  const route = normalizePath(window.location.pathname);
  const routeDefaults = {
    "/": {
      crumb: "Launch Pad",
      authHideSignedOut: true,
      showNotifications: true,
      showDashboardEdit: true
    },
    "/index.html": {
      crumb: "Launch Pad",
      authHideSignedOut: true,
      showNotifications: true,
      showDashboardEdit: true
    },
    "/modules/delivery-export": {
      crumb: "Delivery & Export",
      searchHref: "/"
    },
    "/delivery-export.html": {
      crumb: "Delivery & Export",
      searchHref: "/"
    },
    "/modules/pricing-automation": {
      crumb: "Pricing Automation"
    },
    "/pricing-automation.html": {
      crumb: "Pricing Automation"
    },
    "/tools/pricing-automation/index.html": {
      crumb: "Pricing Automation"
    },
    "/modules/business-metrics": {
      crumb: "Business Metrics"
    },
    "/business-metrics.html": {
      crumb: "Business Metrics"
    },
    "/modules/integrations": {
      crumb: "Integrations"
    },
    "/integrations.html": {
      crumb: "Integrations"
    },
    "/modules/automation": {
      crumb: "Automation"
    },
    "/automation.html": {
      crumb: "Automation"
    },
    "/settings": {
      crumb: "Settings",
      searchHref: "/"
    },
    "/settings.html": {
      crumb: "Settings",
      searchHref: "/"
    },
    "/credentials": {
      crumb: "Credentials"
    },
    "/credentials.html": {
      crumb: "Credentials"
    },
    "/admin/users": {
      crumb: "Users"
    },
    "/admin-users.html": {
      crumb: "Users"
    },
    "/release-notes": {
      crumb: "Release Notes",
      searchHref: "/"
    },
    "/release-notes.html": {
      crumb: "Release Notes",
      searchHref: "/"
    }
  };
  const pageConfig = window.OptiLensPage && typeof window.OptiLensPage === "object"
    ? window.OptiLensPage
    : {};
  return {
    crumb: "OptiLens Local",
    searchHref: "",
    authHideSignedOut: false,
    showNotifications: false,
    showDashboardEdit: false,
    ...routeDefaults[route],
    ...pageConfig
  };
}

function normalizePath(pathname) {
  if (!pathname || pathname === "/") return "/";
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

// ─── Theme ───────────────────────────────────────────────────────────────────

function applyTheme() {
  const saved = localStorage.getItem("optilens.theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved || (prefersDark ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  updateThemeBtn(theme);
}

// "system" clears the stored override so prefers-color-scheme takes over (matches applyTheme's fallback).
function setShellTheme(preference) {
  if (preference === "system") {
    localStorage.removeItem("optilens.theme");
  } else {
    localStorage.setItem("optilens.theme", preference);
  }
  applyTheme();
}

function updateThemeBtn(theme) {
  const btn = document.querySelector("#themeToggle");
  if (!btn) return;
  btn.classList.add("material-symbols-outlined");
  btn.setAttribute("aria-pressed", String(theme === "dark"));
  btn.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
  btn.textContent = theme === "dark" ? "light_mode" : "dark_mode";
}

function wireThemeToggle() {
  const btn = document.querySelector("#themeToggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    setShellTheme(next);
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!localStorage.getItem("optilens.theme")) applyTheme();
  });
}

// ─── Overlay injection ───────────────────────────────────────────────────────

function injectOverlays() {
  const launcherHtml = `
<div class="launcher-overlay" id="launcherOverlay" hidden aria-modal="true" role="dialog" aria-label="App launcher">
  <div class="launcher-panel">
    <div class="launcher-head">
      <h2>Applications</h2>
      <div class="launcher-head-actions">
        <button class="launcher-help" id="launcherHelp" type="button" aria-label="Help / Wiki" title="Help / Wiki">
          <span class="material-symbols-outlined">help</span>
        </button>
        <button class="launcher-close" id="launcherClose" type="button" aria-label="Close launcher">&#x2715;</button>
      </div>
    </div>
    <div class="launcher-grid" id="launcherGrid"></div>
  </div>
</div>`;

  const searchHtml = `
<div class="search-overlay" id="searchOverlay" hidden aria-modal="true" role="dialog" aria-label="Search">
  <div class="search-palette">
    <div class="search-input-wrap">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10 10l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <input class="search-input" id="searchInput" type="search" placeholder="Search modules, settings, endpoints…" autocomplete="off" spellcheck="false">
    </div>
    <div class="search-results" id="searchResults"></div>
  </div>
</div>`;

  const authHtml = `
<div class="auth-overlay" id="authOverlay" hidden aria-modal="true" role="dialog" aria-label="Sign in">
  <form class="auth-panel" id="authForm">
    <div class="launcher-head">
      <h2 id="authTitle">Sign in</h2>
      <button class="launcher-close" id="authClose" type="button" aria-label="Close sign in">&#x2715;</button>
    </div>
    <div class="auth-body">
      <p class="auth-copy" id="authCopy">Use your OptiLens Local account to change data and manage protected modules.</p>
      <label>Username
        <input id="authUsername" name="username" autocomplete="username" required>
      </label>
      <label id="authDisplayNameWrap" hidden>Display name
        <input id="authDisplayName" name="displayName" autocomplete="name">
      </label>
      <label id="authEmailWrap" hidden>Email
        <input id="authEmail" name="email" type="email" autocomplete="email">
      </label>
      <label>Password
        <input id="authPassword" name="password" type="password" autocomplete="current-password" required>
      </label>
      <div class="auth-error" id="authError" role="alert"></div>
      <button class="button primary" id="authSubmit" type="submit">Sign in</button>
    </div>
  </form>
</div>`;

  const accountHtml = `
<div class="auth-overlay" id="accountOverlay" hidden aria-modal="true" role="dialog" aria-label="Account">
  <form class="auth-panel" id="accountForm">
    <div class="launcher-head">
      <h2>Reset Password</h2>
      <button class="launcher-close" id="accountClose" type="button" aria-label="Close account">&#x2715;</button>
    </div>
    <div class="auth-body">
      <p class="auth-copy">Enter your current password and choose a new one.</p>
      <label>Current Password
        <input id="accountOldPassword" name="oldPassword" type="password" autocomplete="current-password" required>
      </label>
      <label>New Password
        <input id="accountNewPassword" name="newPassword" type="password" autocomplete="new-password" required>
      </label>
      <div class="auth-error" id="accountError" role="alert"></div>
      <button class="button primary" id="accountSubmit" type="submit">Change password</button>
    </div>
  </form>
</div>`;

  const updateLogHtml = `
<div class="auth-overlay" id="updateLogOverlay" hidden aria-modal="true" role="dialog" aria-label="Update logs">
  <section class="auth-panel update-log-panel">
    <div class="launcher-head">
      <h2>Update Logs</h2>
      <button class="launcher-close" id="updateLogClose" type="button" aria-label="Close update logs">&#x2715;</button>
    </div>
    <div class="auth-body">
      <pre class="update-log-output" id="updateLogOutput">Loading...</pre>
    </div>
  </section>
</div>`;

  const updateProgressHtml = `
<div class="update-progress-overlay" id="updateProgressOverlay" hidden role="alertdialog" aria-label="Applying update">
  <div class="update-progress-panel">
    <div class="update-progress-head">
      <span class="material-symbols-outlined" id="updateProgressSpinner">sync</span>
      <h3 id="updateProgressTitle">Applying Update</h3>
    </div>
    <div class="update-progress-body">
      <ul class="update-stepper" id="updateStepper">
        <li class="update-step" data-step="applying">
          <span class="update-step-icon material-symbols-outlined">more_horiz</span>
          <span>Applying changes</span>
        </li>
        <li class="update-step" data-step="restarting">
          <span class="update-step-icon material-symbols-outlined">more_horiz</span>
          <span>Restarting service</span>
        </li>
        <li class="update-step" data-step="verifying">
          <span class="update-step-icon material-symbols-outlined">more_horiz</span>
          <span>Verifying session</span>
        </li>
        <li class="update-step" data-step="ready">
          <span class="update-step-icon material-symbols-outlined">more_horiz</span>
          <span>Ready</span>
        </li>
      </ul>
      <div class="update-progress-meter" aria-label="Update progress"><div id="updateProgressBar" class="update-progress-meter-bar" style="width:0%"></div></div>
      <p id="updateProgressMessage" class="muted">Preparing update…</p>
      <pre id="updateProgressLog" class="update-log-output" aria-live="polite"></pre>
      <div class="update-progress-error" id="updateProgressError" hidden></div>
    </div>
    <div class="update-progress-footer" id="updateProgressFooter" hidden>
      <button class="button" id="updateProgressDismiss" type="button">Dismiss</button>
    </div>
  </div>
</div>`;

  const assistantFabHtml = `
<button id="globalAssistantFab" class="global-assistant-fab" type="button" aria-label="OptiLens AI Assistant" title="OptiLens AI Assistant (Ctrl+Shift+A)">
  <span class="material-symbols-outlined">smart_toy</span>
  <span class="fab-badge">AI</span>
</button>`;

  const assistantDrawerHtml = `
<div id="globalAssistantDrawer" class="global-assistant-drawer" hidden role="dialog" aria-label="OptiLens System Assistant">
  <div class="assistant-drawer-header">
    <div class="assistant-drawer-title">
      <span class="material-symbols-outlined assistant-logo-icon">smart_toy</span>
      <div class="assistant-title-text">
        <strong>OptiLens Assistant</strong>
        <span class="assistant-context-chip" id="assistantRouteChip">📍 Page Context</span>
      </div>
    </div>
    <div class="assistant-drawer-actions">
      <button type="button" id="assistantDockToggle" title="Dock Side / Float" class="icon-btn">
        <span class="material-symbols-outlined" id="assistantDockIcon">dock</span>
      </button>
      <button type="button" id="assistantConfigBtn" title="Configure Chat API" class="icon-btn">
        <span class="material-symbols-outlined">settings</span>
      </button>
      <button type="button" id="assistantCloseBtn" title="Close Assistant" class="icon-btn">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>
  </div>

  <div class="assistant-drawer-messages" id="assistantMessages">
    <div class="assistant-msg assistant-msg-ai">
      <div class="msg-avatar"><span class="material-symbols-outlined">smart_toy</span></div>
      <div class="msg-content">
        Hello! I'm your system-wide OptiLens AI Assistant. Ask me anything, navigate modules, or dictate voice commands.
      </div>
    </div>
  </div>

  <div class="assistant-drawer-controls">
    <div class="assistant-quick-chips" id="assistantQuickChips"></div>

    <div class="assistant-input-row">
      <div class="assistant-input-wrap">
        <input type="text" id="assistantInput" placeholder="Ask assistant or dictate voice command..." aria-label="OptiLens Assistant question" autocomplete="off">
        <button type="button" id="assistantMicBtn" class="assistant-mic-btn" title="Voice mic transcription">
          <span class="material-symbols-outlined">mic</span>
        </button>
      </div>
      <button type="button" id="assistantSendBtn" class="assistant-send-btn" title="Send Question">
        <span class="material-symbols-outlined">send</span>
      </button>
    </div>

    <div id="assistantVoiceStatus" class="assistant-voice-status" hidden></div>
  </div>
</div>`;

  let html = "";
  if (!document.getElementById("launcherOverlay")) html += launcherHtml;
  if (!document.getElementById("searchOverlay")) html += searchHtml;
  if (!document.getElementById("authOverlay")) html += authHtml;
  if (!document.getElementById("accountOverlay")) html += accountHtml;
  if (!document.getElementById("updateLogOverlay")) html += updateLogHtml;
  if (!document.getElementById("updateProgressOverlay")) html += updateProgressHtml;
  if (!document.getElementById("globalAssistantFab")) html += assistantFabHtml;
  if (!document.getElementById("globalAssistantDrawer")) html += assistantDrawerHtml;
  if (html) document.body.insertAdjacentHTML("afterbegin", html);
}

// ─── Launcher ────────────────────────────────────────────────────────────────

function wireLauncher() {
  const btn     = document.querySelector("#launcherBtn");
  const overlay = document.querySelector("#launcherOverlay");
  const closeBtn = document.querySelector("#launcherClose");
  const helpBtn = document.querySelector("#launcherHelp");
  const grid    = document.querySelector("#launcherGrid");
  if (!overlay) return;

  renderLauncherApps();
  wireLauncherReordering(grid);

  function open()  { overlay.hidden = false; document.body.style.overflow = "hidden"; btn?.setAttribute("aria-expanded","true"); }
  function close() {
    overlay.classList.add("closing");
    setTimeout(() => {
      overlay.hidden = true;
      overlay.classList.remove("closing");
      document.body.style.overflow = "";
      btn?.setAttribute("aria-expanded","false");
    }, 200);
  }

  btn?.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  helpBtn?.addEventListener("click", () => { close(); window.location.href = "/release-notes"; });
  overlay?.addEventListener("click", e => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !overlay.hidden) close(); });
}

// ─── Search ──────────────────────────────────────────────────────────────────

function wireSearch() {
  const trigger = document.querySelector("#searchTrigger");
  const overlay = document.querySelector("#searchOverlay");
  const input   = document.querySelector("#searchInput");
  const results = document.querySelector("#searchResults");
  if (!overlay) return;
  const searchHref = trigger?.dataset.searchHref || "";

  function open()  { overlay.hidden = false; input?.focus(); renderResults(""); document.body.style.overflow = "hidden"; }
  function close() { 
    overlay.classList.add("closing");
    setTimeout(() => {
      overlay.hidden = true;  
      overlay.classList.remove("closing");
      document.body.style.overflow = ""; 
      if (input) input.value = ""; 
    }, 200);
  }

  trigger?.addEventListener("click", () => {
    if (searchHref) {
      window.location.href = searchHref;
      return;
    }
    open();
  });
  overlay?.addEventListener("click", e => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); open(); }
    if (e.key === "Escape" && !overlay?.hidden) close();
  });
  input?.addEventListener("input", () => renderResults(input.value));

  function renderResults(query) {
    if (!results) return;
    const q = query.trim().toLowerCase();
    const visibleIndex = SEARCH_INDEX.filter(canAccessSharedItem);
    const hits = q ? visibleIndex.filter(x => x.label.toLowerCase().includes(q) || x.meta.toLowerCase().includes(q)) : visibleIndex;
    if (!hits.length) { results.innerHTML = `<div class="search-empty">No results for "${esc(query)}"</div>`; return; }
    results.innerHTML = hits.map(x => `
      <a class="search-result-item" href="${esc(x.href)}">
        <span class="search-result-icon material-symbols-outlined" style="background:${esc(x.color)}">${esc(x.icon)}</span>
        ${esc(x.label)}
        <span class="search-result-meta">${esc(x.meta)}</span>
      </a>`).join("");
    results.querySelectorAll("a").forEach(a => a.addEventListener("click", close));
  }
}

// ─── Authentication ─────────────────────────────────────────────────────────

function wireUpdateCheck() {
  const button = document.querySelector("#updateCheckBtn");
  const updateLogOverlay = document.querySelector("#updateLogOverlay");
  const updateLogClose = document.querySelector("#updateLogClose");
  button?.addEventListener("click", async () => {
    if (UPDATE_STATE.applying) return;
    if (UPDATE_STATE.status?.available) {
      await applyAvailableUpdate();
    } else {
      await checkForUpdates({ announce: true });
    }
  });

  window.addEventListener("optilens:auth-changed", () => {
    if (canManageUpdates()) {
      startAutomaticUpdateChecks();
    } else {
      stopAutomaticUpdateChecks();
      renderUpdateControl();
    }
  });

  updateLogClose?.addEventListener("click", closeUpdateLogs);
  updateLogOverlay?.addEventListener("click", (event) => {
    if (event.target === updateLogOverlay) closeUpdateLogs();
  });
}

function canManageUpdates() {
  return (AUTH_STATE.user?.permissions || []).includes("platform.admin");
}

function startAutomaticUpdateChecks() {
  if (!canManageUpdates()) return;
  checkForUpdates();
  if (!UPDATE_STATE.timer) {
    UPDATE_STATE.timer = setInterval(() => checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
  }
}

function stopAutomaticUpdateChecks() {
  if (UPDATE_STATE.timer) clearInterval(UPDATE_STATE.timer);
  UPDATE_STATE.timer = null;
  UPDATE_STATE.status = null;
  UPDATE_STATE.checking = false;
  UPDATE_STATE.applying = false;
}

async function checkForUpdates({ announce = false } = {}) {
  if (!canManageUpdates() || UPDATE_STATE.checking || UPDATE_STATE.applying) return;
  const wasAvailable = Boolean(UPDATE_STATE.status?.available);
  UPDATE_STATE.checking = true;
  renderUpdateControl();

  try {
    UPDATE_STATE.status = await authFetch("/api/system/updates");
    if (UPDATE_STATE.status.available && (!wasAvailable || announce)) {
      const areas = (UPDATE_STATE.status.changedAreas || []).map((area) => area.label).join(", ");
      showUpdateNotice(`Update ready${areas ? `: ${areas}.` : "."} Select the update button to apply it.`);
    } else if (announce) {
      showUpdateNotice("OptiLens Local is already up to date.");
    }
  } catch (error) {
    if (announce) showUpdateNotice(`Update check failed: ${error.message}`);
  } finally {
    UPDATE_STATE.checking = false;
    renderUpdateControl();
  }
}

function renderUpdateControl() {
  const button = document.querySelector("#updateCheckBtn");
  const icon = document.querySelector("#updateCheckIcon");
  const count = document.querySelector("#updateCount");
  if (!button || !icon || !count) return;

  const status = UPDATE_STATE.status;
  const visible = canManageUpdates();
  button.hidden = !visible;
  if (!visible) return;

  button.disabled = UPDATE_STATE.checking || UPDATE_STATE.applying;
  if (UPDATE_STATE.applying) {
    icon.textContent = "sync";
    button.title = "Applying update";
    button.setAttribute("aria-label", "Applying update");
    count.hidden = true;
    return;
  }
  if (status?.available) {
    icon.textContent = "system_update_alt";
    const changeCount = status.changedAreas?.length || 1;
    count.textContent = String(changeCount);
    count.hidden = false;
    button.title = "Apply updates";
    button.setAttribute("aria-label", "Apply updates");
    return;
  }

  icon.textContent = "system_update";
  count.hidden = true;
  button.title = UPDATE_STATE.checking ? "Checking for updates" : "Check for updates";
  button.setAttribute("aria-label", button.title);
}

async function applyAvailableUpdate() {
  UPDATE_STATE.applying = true;
  renderUpdateControl();
  const previousStartedAt = UPDATE_STATE.status?.running?.startedAt || "";
  const needsRestart = UPDATE_STATE.status?.plan?.restartService;

  try {
    const result = await authFetch("/api/system/updates/apply", { method: "POST" });

    if (!result.applying) {
      // Browser-only update — no service restart needed.
      showUpdateProgress("applying");
      setUpdateStep("applying", "done");
      setUpdateStep("restarting", "done", "No restart needed");
      setUpdateStep("verifying", "active");
      // Brief pause to let any file-serving caches expire, then verify.
      await new Promise((resolve) => setTimeout(resolve, 800));
      try {
        await refreshAuthState();
        setUpdateStep("verifying", "done");
        setUpdateStep("ready", "done", "Update applied");
        setUpdateProgressTitle("Update Complete");
        stopUpdateProgressSpinner();
        await new Promise((resolve) => setTimeout(resolve, 1200));
        dismissUpdateProgress();
        window.dispatchEvent(new CustomEvent("optilens:connection-restored"));
      } catch {
        // Auth recovery failed on browser-only update — fall back to reload.
        dismissUpdateProgress();
        window.location.reload();
      }
      return;
    }

    // Full service restart path.
    showUpdateProgress("applying");
    startUpdateProgressPolling();
    await waitForUpdatedService(previousStartedAt);
  } catch (error) {
    UPDATE_STATE.applying = false;
    stopUpdateProgressPolling();
    showUpdateProgressError(error.message || "Update was not applied.");
    renderUpdateControl();
  }
}

async function waitForUpdatedService(previousStartedAt) {
  const DEADLINE_MS = 180000; // 3 minutes
  const deadline = Date.now() + DEADLINE_MS;
  let pollInterval = 1000;
  const BACKOFF_AFTER_MS = 30000;
  const backoffAt = Date.now() + BACKOFF_AFTER_MS;
  let serviceRestarted = false;

  // Phase 1: Wait for the old service to go down and a new one to come up.
  setUpdateStep("applying", "done");
  setUpdateStep("restarting", "active");

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    if (Date.now() > backoffAt) pollInterval = 3000;

    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      if (!response.ok) continue;
      const health = await response.json();
      if (health.application?.startedAt && health.application.startedAt !== previousStartedAt) {
        serviceRestarted = true;
        break;
      }
    } catch {
      // Expected while the old service stops and the replacement starts.
    }
  }

  if (!serviceRestarted) {
    setUpdateStep("restarting", "error", "Timed out");
    throw new Error("The updated service did not become healthy within three minutes. Check data/local-update.log.");
  }

  // Phase 2: Verify the authenticated session survived the restart.
  setUpdateStep("restarting", "done");
  setUpdateStep("verifying", "active");

  try {
    await refreshAuthState();
    setUpdateStep("verifying", "done");
  } catch {
    // Session did not survive — the user will need to re-authenticate
    // after we reload, but we still complete the update.
    setUpdateStep("verifying", "done", "Session refreshed");
  }

  // Phase 3: All done — show success and dismiss.
  setUpdateStep("ready", "done", "Update applied");
  setUpdateProgressTitle("Update Complete");
  stopUpdateProgressSpinner();

  UPDATE_STATE.applying = false;
  stopUpdateProgressPolling();
  UPDATE_STATE.status = null;
  renderUpdateControl();

  // Brief pause so the user sees the success state.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // If auth is still valid, do an in-place soft recovery. Otherwise reload.
  if (AUTH_STATE.user) {
    dismissUpdateProgress();
    window.dispatchEvent(new CustomEvent("optilens:connection-restored"));
    // Re-check for any further updates that arrived with the pull.
    checkForUpdates();
  } else {
    dismissUpdateProgress();
    window.location.reload();
  }
}

// ─── Update progress overlay helpers ─────────────────────────────────────────

function showUpdateProgress(initialStep) {
  const overlay = document.querySelector("#updateProgressOverlay");
  if (!overlay) return;

  // Reset all steps to pending.
  overlay.querySelectorAll(".update-step").forEach((step) => {
    step.className = "update-step";
    const icon = step.querySelector(".update-step-icon");
    if (icon) icon.textContent = "more_horiz";
    // Reset label to default.
    const label = step.querySelector("span:not(.update-step-icon)");
    if (label) label.textContent = step.dataset.step === "applying" ? "Applying changes"
      : step.dataset.step === "restarting" ? "Restarting service"
      : step.dataset.step === "verifying" ? "Verifying session"
      : "Ready";
  });

  // Reset error and footer.
  const errorEl = overlay.querySelector("#updateProgressError");
  if (errorEl) { errorEl.hidden = true; errorEl.textContent = ""; }
  const footer = overlay.querySelector("#updateProgressFooter");
  if (footer) footer.hidden = true;
  const bar = overlay.querySelector("#updateProgressBar");
  if (bar) bar.style.width = "0%";
  const message = overlay.querySelector("#updateProgressMessage");
  if (message) message.textContent = "Preparing update…";
  const log = overlay.querySelector("#updateProgressLog");
  if (log) log.textContent = "";

  // Reset title and spinner.
  setUpdateProgressTitle("Applying Update");
  const spinner = overlay.querySelector("#updateProgressSpinner");
  if (spinner) {
    spinner.textContent = "sync";
    spinner.style.animation = "";
  }

  overlay.classList.remove("closing");
  overlay.hidden = false;
  document.body.style.overflow = "hidden";

  if (initialStep) setUpdateStep(initialStep, "active");

  // Wire dismiss button.
  const dismiss = overlay.querySelector("#updateProgressDismiss");
  if (dismiss) {
    dismiss.onclick = () => {
      dismissUpdateProgress();
      if (UPDATE_STATE.applying) {
        // Update is still running in the background; just hide the overlay.
        showUpdateNotice("Update is running in the background. This page will refresh when ready.");
      }
    };
  }
}

function setUpdateStep(stepName, state, labelOverride) {
  const overlay = document.querySelector("#updateProgressOverlay");
  if (!overlay) return;
  const step = overlay.querySelector(`.update-step[data-step="${stepName}"]`);
  if (!step) return;

  step.className = `update-step ${state}`;
  const icon = step.querySelector(".update-step-icon");
  if (icon) {
    if (state === "done") icon.textContent = "check";
    else if (state === "error") icon.textContent = "close";
    else if (state === "active") icon.textContent = "more_horiz";
    else icon.textContent = "more_horiz";
  }

  if (labelOverride) {
    const label = step.querySelector("span:not(.update-step-icon)");
    if (label) label.textContent = labelOverride;
  }
}

function setUpdateProgressTitle(title) {
  const el = document.querySelector("#updateProgressTitle");
  if (el) el.textContent = title;
}

function stopUpdateProgressSpinner() {
  const spinner = document.querySelector("#updateProgressSpinner");
  if (spinner) {
    spinner.textContent = "check_circle";
    spinner.style.animation = "none";
  }
}

function showUpdateProgressError(message) {
  const overlay = document.querySelector("#updateProgressOverlay");
  if (!overlay || overlay.hidden) {
    // Overlay wasn't shown yet — use the toast notice.
    showUpdateNotice(`Update was not applied: ${message}`);
    return;
  }

  const errorEl = overlay.querySelector("#updateProgressError");
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  // Show dismiss button so the user can close the overlay.
  const footer = overlay.querySelector("#updateProgressFooter");
  if (footer) footer.hidden = false;

  setUpdateProgressTitle("Update Failed");
  const spinner = document.querySelector("#updateProgressSpinner");
  if (spinner) {
    spinner.textContent = "error";
    spinner.style.animation = "none";
  }
}

function dismissUpdateProgress() {
  const overlay = document.querySelector("#updateProgressOverlay");
  if (!overlay || overlay.hidden) return;
  overlay.classList.add("closing");
  setTimeout(() => {
    overlay.hidden = true;
    overlay.classList.remove("closing");
    document.body.style.overflow = "";
  }, 300);
}

function showUpdateNotice(message) {
  let notice = document.querySelector("#updateNotice");
  if (!notice) {
    notice = document.createElement("div");
    notice.id = "updateNotice";
    notice.className = "update-notice";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    document.body.appendChild(notice);
  }
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(showUpdateNotice.timer);
  showUpdateNotice.timer = setTimeout(() => { notice.hidden = true; }, 7000);
}

async function openUpdateLogs() {
  const overlay = document.querySelector("#updateLogOverlay");
  const output = document.querySelector("#updateLogOutput");
  if (!overlay || !output) return;
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
  output.textContent = "Loading update logs...";

  try {
    const data = await authFetch("/api/system/updates/logs");
    const logs = data.logs || [];
    output.textContent = logs.map((log) => {
      const header = `${log.path} · ${log.exists ? `${formatBytes(log.size)} · updated ${log.updatedAt || "unknown"}` : "not created yet"}`;
      const body = log.exists
        ? `${log.truncated ? "[Showing tail]\n" : ""}${log.text || "[No content]"}`
        : "No log file exists yet for this source.";
      return `${header}\n${"=".repeat(Math.min(header.length, 80))}\n${body}`;
    }).join("\n\n");
  } catch (error) {
    output.textContent = `Could not load update logs: ${error.message || error}`;
  }
}

function closeUpdateLogs() {
  const overlay = document.querySelector("#updateLogOverlay");
  if (!overlay) return;
  overlay.classList.add("closing");
  setTimeout(() => {
    overlay.hidden = true;
    overlay.classList.remove("closing");
    document.body.style.overflow = "";
  }, 200);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function wireConnectionRecovery() {
  const probe = () => probeServerConnection();
  window.addEventListener("offline", () => setServerConnectionState(false));
  window.addEventListener("online", probe);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) probe();
  });
  CONNECTION_STATE.timer = setInterval(probe, CONNECTION_RECOVERY_MS);
  probe();
}

async function probeServerConnection() {
  if (CONNECTION_STATE.probing || !navigator.onLine) return;
  CONNECTION_STATE.probing = true;
  const wasReachable = CONNECTION_STATE.serverReachable;
  try {
    const response = await fetch("/api/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) throw new Error(`Health check returned ${response.status}.`);
    setServerConnectionState(true);
    if (!wasReachable) {
      await refreshAuthState();
      window.dispatchEvent(new CustomEvent("optilens:connection-restored"));
    }
  } catch {
    setServerConnectionState(false);
  } finally {
    CONNECTION_STATE.probing = false;
  }
}

function setServerConnectionState(reachable) {
  let notice = document.querySelector("#connectionNotice");
  if (CONNECTION_STATE.serverReachable === reachable && notice) return;
  CONNECTION_STATE.serverReachable = reachable;
  if (!notice) {
    notice = document.createElement("div");
    notice.id = "connectionNotice";
    notice.className = "connection-notice";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    document.body.appendChild(notice);
  }
  notice.hidden = reachable;
  notice.textContent = "Connection to OptiLens Local was interrupted. Reconnecting automatically…";
}

function wireAuth() {
  const overlay = document.querySelector("#authOverlay");
  const form = document.querySelector("#authForm");
  const closeBtn = document.querySelector("#authClose");
  if (!overlay || !form) return;

  window.OptiLensAuth = {
    currentUser: () => AUTH_STATE.user,
    requireSignIn: openAuth
  };

  // Wrap each user-chip in a relative-positioned container and attach dropdown
  document.querySelectorAll(".user-chip").forEach((chip) => {
    // Wrap if not already wrapped
    if (!chip.parentElement.classList.contains("user-chip-wrap")) {
      const wrap = document.createElement("div");
      wrap.className = "user-chip-wrap";
      chip.parentNode.insertBefore(wrap, chip);
      wrap.appendChild(chip);
    }
    const wrap = chip.parentElement;

    // Add caret to chip if missing
    if (!chip.querySelector(".user-chip-caret")) {
      const caret = document.createElement("span");
      caret.className = "user-chip-caret";
      caret.setAttribute("aria-hidden", "true");
      caret.textContent = "▾";
      chip.appendChild(caret);
    }

    // Build dropdown
    let dropdown = wrap.querySelector(".user-dropdown");
    if (!dropdown) {
      dropdown = document.createElement("div");
      dropdown.className = "user-dropdown";
      dropdown.setAttribute("hidden", "");
      dropdown.setAttribute("role", "menu");
      wrap.appendChild(dropdown);
    }

    function openDropdown() {
      renderUserDropdown(chip, dropdown);
      dropdown.hidden = false;
      dropdown.classList.remove("closing");
      chip.setAttribute("aria-expanded", "true");
    }

    function closeDropdown() {
      dropdown.classList.add("closing");
      setTimeout(() => {
        dropdown.hidden = true;
        dropdown.classList.remove("closing");
        chip.setAttribute("aria-expanded", "false");
      }, 150);
    }

    function toggleDropdown() {
      if (!dropdown.hidden) { closeDropdown(); return; }
      if (!AUTH_STATE.user) { openAuth(); return; }
      openDropdown();
    }

    chip.setAttribute("aria-expanded", "false");
    chip.setAttribute("aria-haspopup", "menu");
    chip.addEventListener("click", (e) => { e.stopPropagation(); toggleDropdown(); });

    // Close on outside click
    document.addEventListener("click", (e) => {
      if (!dropdown.hidden && !wrap.contains(e.target)) closeDropdown();
    });

    // Close on Escape
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !dropdown.hidden) closeDropdown();
    });
  });

  closeBtn?.addEventListener("click", closeAuth);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) closeAuth(); });
  form.addEventListener("submit", submitAuth);

  const accountOverlay = document.querySelector("#accountOverlay");
  const accountForm = document.querySelector("#accountForm");
  const accountCloseBtn = document.querySelector("#accountClose");

  if (accountOverlay) {
    accountCloseBtn?.addEventListener("click", closeAccount);
    accountOverlay.addEventListener("click", (event) => { if (event.target === accountOverlay) closeAccount(); });
    accountForm?.addEventListener("submit", submitChangePassword);
  }

  refreshAuthState();
}

const THEME_OPTIONS = [
  { value: "light", label: "Theme · Light", icon: "light_mode" },
  { value: "dark", label: "Theme · Dark", icon: "dark_mode" },
  { value: "system", label: "Theme · System", icon: "computer" }
];

function renderUserDropdown(chip, dropdown) {
  const user = AUTH_STATE.user;
  const name = user ? (user.displayName || user.username) : "";
  const role = user ? (user.role || "User") : "";
  const activeTheme = localStorage.getItem("optilens.theme") || "system";

  dropdown.innerHTML = `
    <div class="user-dropdown-header">
      <div class="user-dropdown-name">${esc(name)}</div>
      <div class="user-dropdown-role">${esc(role)}</div>
    </div>
    <div class="user-dropdown-divider"></div>
    <a class="user-dropdown-item" href="/release-notes" role="menuitem">
      <span class="material-symbols-outlined" style="font-size:14px">history_edu</span>
      Release notes
    </a>
    <button class="user-dropdown-item" id="ddResetPassword" type="button" role="menuitem">
      <span class="material-symbols-outlined" style="font-size:14px">lock_reset</span>
      Reset password
    </button>
    ${canManageUpdates() ? `
    <button class="user-dropdown-item" id="ddOpenCodex" type="button" role="menuitem">
      <span class="material-symbols-outlined" style="font-size:14px">terminal</span>
      Edit with Codex
    </button>` : ""}
    <button class="user-dropdown-item" id="ddInstallApp" type="button" role="menuitem" hidden>
      <span class="material-symbols-outlined" style="font-size:14px">install_desktop</span>
      Install app
    </button>
    ${canManageUpdates() ? `
    <button class="user-dropdown-item" id="ddUpdateLogs" type="button" role="menuitem">
      <span class="material-symbols-outlined" style="font-size:14px">article</span>
      View update logs
    </button>
    <button class="user-dropdown-item danger" id="ddStopApp" type="button" role="menuitem">
      <span class="material-symbols-outlined" style="font-size:14px">power_settings_new</span>
      Stop app
    </button>` : ""}
    <div class="user-dropdown-divider"></div>
    <div class="user-dropdown-theme-group" role="group" aria-label="Theme">
      ${THEME_OPTIONS.map((opt) => `
        <button class="user-dropdown-item${opt.value === activeTheme ? " active" : ""}" type="button" role="menuitemradio" aria-checked="${opt.value === activeTheme}" data-theme-option="${opt.value}">
          <span class="material-symbols-outlined" style="font-size:14px">${opt.icon}</span>
          ${opt.label}
        </button>`).join("")}
    </div>
    <div class="user-dropdown-divider"></div>
    <button class="user-dropdown-item danger" id="ddSignOut" type="button" role="menuitem">
      <span class="material-symbols-outlined" style="font-size:14px">logout</span>
      Sign out
    </button>`;

  dropdown.querySelector("#ddResetPassword").addEventListener("click", () => {
    closeAllDropdowns();
    openAccount();
  });

  const installBtn = dropdown.querySelector("#ddInstallApp");
  if (installBtn && DEFERRED_INSTALL_PROMPT) {
    installBtn.hidden = false;
    installBtn.addEventListener("click", async () => {
      closeAllDropdowns();
      DEFERRED_INSTALL_PROMPT.prompt();
      await DEFERRED_INSTALL_PROMPT.userChoice.catch(() => {});
      DEFERRED_INSTALL_PROMPT = null;
    });
  }

  dropdown.querySelector("#ddUpdateLogs")?.addEventListener("click", () => {
    closeAllDropdowns();
    openUpdateLogs();
  });

  dropdown.querySelector("#ddOpenCodex")?.addEventListener("click", async () => {
    closeAllDropdowns();
    try {
      const result = await authFetch("/api/system/host/codex", { method: "POST" });
      showUpdateNotice(result.message || "Codex is opening in the OptiLens Local repository.");
    } catch (error) {
      showUpdateNotice(`Could not open Codex: ${error.message || error}`);
    }
  });

  dropdown.querySelector("#ddStopApp")?.addEventListener("click", async () => {
    closeAllDropdowns();
    if (!confirm("Stop OptiLens Local on this host? The app stays offline until the shortcut, tray monitor, or watchdog starts it again.")) return;
    try {
      const result = await authFetch("/api/system/host/stop", { method: "POST" });
      showUpdateNotice(result.message || "Stopping OptiLens Local.");
      setTimeout(() => setServerConnectionState(false), 1000);
    } catch (error) {
      showUpdateNotice(`Could not stop OptiLens Local: ${error.message || error}`);
    }
  });

  dropdown.querySelectorAll("[data-theme-option]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setShellTheme(btn.dataset.themeOption);
      closeAllDropdowns();
    });
  });

  dropdown.querySelector("#ddSignOut").addEventListener("click", () => {
    closeAllDropdowns();
    if (confirm("Sign out of OptiLens Local?")) signOut();
  });
}

function closeAllDropdowns() {
  document.querySelectorAll(".user-dropdown").forEach((d) => {
    if (!d.hidden) {
      d.classList.add("closing");
      setTimeout(() => { d.hidden = true; d.classList.remove("closing"); }, 150);
    }
  });
  document.querySelectorAll(".user-chip").forEach((c) => c.setAttribute("aria-expanded", "false"));
}

async function refreshAuthState() {
  const bootstrap = await authFetch("/api/auth/bootstrap-state").catch(() => ({ needsMigration: false, needsBootstrap: false }));
  AUTH_STATE.needsMigration = Boolean(bootstrap.needsMigration);
  AUTH_STATE.needsBootstrap = Boolean(bootstrap.needsBootstrap);

  const me = await authFetch("/api/auth/me").catch(() => ({ user: null }));
  AUTH_STATE.user = me.user || null;
  renderAuthChip();
  renderLauncherApps();
  window.dispatchEvent(new CustomEvent("optilens:auth-changed", {
    detail: {
      user: AUTH_STATE.user,
      needsMigration: AUTH_STATE.needsMigration,
      needsBootstrap: AUTH_STATE.needsBootstrap
    }
  }));
}

function renderLauncherApps() {
  const grid = document.querySelector("#launcherGrid");
  if (!grid) return;

  grid.innerHTML = getOrderedLauncherApps().filter(canAccessSharedItem).map(app => `
    <a class="launcher-tile" href="${esc(app.href)}" data-launcher-key="${esc(launcherAppKey(app))}">
      <span class="launcher-icon material-symbols-outlined" style="color:${esc(launcherTileColor(app))}">${esc(app.icon)}</span>
      <span class="launcher-tile-label">${esc(app.label)}</span>
    </a>`).join("");
}

function wireLauncherReordering(grid) {
  if (!grid || grid.dataset.reorderWired === "true") return;
  grid.dataset.reorderWired = "true";

  let dragState = null;

  grid.addEventListener("pointerdown", (event) => {
    const tile = event.target.closest(".launcher-tile");
    if (!tile || !grid.contains(tile) || event.button !== 0) return;
    startLauncherDrag(tile, event.clientX, event.clientY, event.pointerId);
  });

  grid.addEventListener("mousedown", (event) => {
    if (dragState) return;
    const tile = event.target.closest(".launcher-tile");
    if (!tile || !grid.contains(tile) || event.button !== 0) return;
    startLauncherDrag(tile, event.clientX, event.clientY, "mouse");
  });

  document.addEventListener("pointermove", (event) => moveLauncherDrag(event, event.pointerId));
  document.addEventListener("mousemove", (event) => moveLauncherDrag(event, "mouse"));
  document.addEventListener("pointerup", (event) => finishLauncherDrag(event, event.pointerId));
  document.addEventListener("mouseup", (event) => finishLauncherDrag(event, "mouse"));
  document.addEventListener("pointercancel", (event) => finishLauncherDrag(event, event.pointerId));

  grid.addEventListener("click", (event) => {
    if (grid.dataset.suppressNextClick !== "true") return;
    event.preventDefault();
    event.stopPropagation();
    delete grid.dataset.suppressNextClick;
  }, true);

  function startLauncherDrag(tile, clientX, clientY, pointerId) {
    dragState = {
      pointerId,
      tile,
      startX: clientX,
      startY: clientY,
      dragging: false
    };
  }

  function moveLauncherDrag(event, pointerId) {
    if (!dragState || dragState.pointerId !== pointerId) return;

    const distance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
    if (!dragState.dragging && distance < 6) return;

    if (!dragState.dragging) {
      dragState.dragging = true;
      dragState.tile.classList.add("is-dragging");
      grid.classList.add("is-reordering");
      if (pointerId !== "mouse") dragState.tile.setPointerCapture?.(pointerId);
    }

    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".launcher-tile");
    if (!target || target === dragState.tile || !grid.contains(target)) return;

    const tiles = Array.from(grid.querySelectorAll(".launcher-tile"));
    const draggedIndex = tiles.indexOf(dragState.tile);
    const targetIndex = tiles.indexOf(target);
    if (draggedIndex < 0 || targetIndex < 0) return;

    grid.insertBefore(dragState.tile, draggedIndex < targetIndex ? target.nextSibling : target);
  }

  function finishLauncherDrag(event, pointerId) {
    if (!dragState || dragState.pointerId !== pointerId) return;
    const wasDragging = dragState.dragging;
    if (pointerId !== "mouse") dragState.tile.releasePointerCapture?.(pointerId);
    dragState.tile.classList.remove("is-dragging");
    grid.classList.remove("is-reordering");

    if (wasDragging) {
      event.preventDefault();
      saveLauncherOrder(grid);
      grid.dataset.suppressNextClick = "true";
      setTimeout(() => { delete grid.dataset.suppressNextClick; }, 0);
    }

    dragState = null;
  }
}

function getOrderedLauncherApps() {
  const order = getLauncherOrder();
  if (!order.length) return LAUNCHER_APPS;

  const orderIndex = new Map(order.map((key, index) => [key, index]));
  return [...LAUNCHER_APPS].sort((a, b) => {
    const aIndex = orderIndex.has(launcherAppKey(a)) ? orderIndex.get(launcherAppKey(a)) : Number.MAX_SAFE_INTEGER;
    const bIndex = orderIndex.has(launcherAppKey(b)) ? orderIndex.get(launcherAppKey(b)) : Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return LAUNCHER_APPS.indexOf(a) - LAUNCHER_APPS.indexOf(b);
  });
}

function getLauncherOrder() {
  try {
    const value = JSON.parse(localStorage.getItem(LAUNCHER_ORDER_STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value.filter((key) => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function saveLauncherOrder(grid) {
  const visibleKeys = Array.from(grid.querySelectorAll(".launcher-tile"))
    .map((tile) => tile.dataset.launcherKey)
    .filter(Boolean);
  const visibleKeySet = new Set(visibleKeys);
  const hiddenKeys = getOrderedLauncherApps()
    .map(launcherAppKey)
    .filter((key) => !visibleKeySet.has(key));
  localStorage.setItem(LAUNCHER_ORDER_STORAGE_KEY, JSON.stringify([...visibleKeys, ...hiddenKeys]));
}

function launcherAppKey(app) {
  return app.href;
}

// The launcher's dark glass tiles color the icon glyph directly (no background
// swatch), so near-black catalog colors need a brighter stand-in to stay legible.
const LAUNCHER_ICON_COLOR_OVERRIDES = {
  integrations: "#3b6ea8",
  users: "#5b8fd6"
};

function launcherTileColor(app) {
  return LAUNCHER_ICON_COLOR_OVERRIDES[app.id] || app.color;
}

function canAccessSharedItem(item) {
  const required = item.permissions || [];
  if (!required.length) return true;
  const permissions = AUTH_STATE.user?.permissions || [];
  if (permissions.includes("platform.admin")) return true;
  return required.some((permission) => permissions.includes(permission));
}

function renderAuthChip() {
  document.querySelectorAll(".user-chip").forEach((chip) => {
    const avatar = chip.querySelector(".user-avatar");
    const name = chip.querySelector(".user-name");
    if (!avatar || !name) return;

    if (AUTH_STATE.user) {
      avatar.textContent = initials(AUTH_STATE.user.displayName || AUTH_STATE.user.username);
      name.textContent = AUTH_STATE.user.displayName || AUTH_STATE.user.username;
      chip.setAttribute("aria-label", `Signed in as ${AUTH_STATE.user.displayName || AUTH_STATE.user.username}. Click for account options.`);
    } else {
      avatar.textContent = "IN";
      name.textContent = AUTH_STATE.needsMigration ? "Run Migrations" : AUTH_STATE.needsBootstrap ? "Create Admin" : "Sign in";
      chip.setAttribute("aria-label", AUTH_STATE.needsMigration ? "Run migrations before signing in" : AUTH_STATE.needsBootstrap ? "Create first admin user" : "Sign in");
    }
  });
}

function openAuth() {
  const overlay = document.querySelector("#authOverlay");
  const title = document.querySelector("#authTitle");
  const copy = document.querySelector("#authCopy");
  const submit = document.querySelector("#authSubmit");
  const displayWrap = document.querySelector("#authDisplayNameWrap");
  const emailWrap = document.querySelector("#authEmailWrap");
  const username = document.querySelector("#authUsername");
  const password = document.querySelector("#authPassword");
  const error = document.querySelector("#authError");
  if (!overlay) return;

  title.textContent = AUTH_STATE.needsMigration ? "Run migrations" : AUTH_STATE.needsBootstrap ? "Create first admin" : "Sign in";
  copy.textContent = AUTH_STATE.needsMigration
    ? "Authentication tables are missing. Run /api/admin/migrate, restart if needed, then sign in with optilens / optilens."
    : AUTH_STATE.needsBootstrap
    ? "Create the first administrator account. This can only be done before any password credential exists."
    : "Use your OptiLens Local account to change data and manage protected modules.";
  submit.textContent = AUTH_STATE.needsBootstrap ? "Create admin" : "Sign in";
  submit.disabled = AUTH_STATE.needsMigration;
  displayWrap.hidden = !AUTH_STATE.needsBootstrap;
  emailWrap.hidden = !AUTH_STATE.needsBootstrap;
  error.textContent = "";
  password.value = "";
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => username?.focus(), 0);
}

function closeAuth() {
  const overlay = document.querySelector("#authOverlay");
  if (!overlay) return;
  overlay.classList.add("closing");
  setTimeout(() => {
    overlay.hidden = true;
    overlay.classList.remove("closing");
    document.body.style.overflow = "";
  }, 200);
}

function openAccount() {
  const overlay = document.querySelector("#accountOverlay");
  const oldPassword = document.querySelector("#accountOldPassword");
  const newPassword = document.querySelector("#accountNewPassword");
  const error = document.querySelector("#accountError");
  if (!overlay) return;
  oldPassword.value = "";
  newPassword.value = "";
  error.textContent = "";
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => oldPassword?.focus(), 0);
}

function closeAccount() {
  const overlay = document.querySelector("#accountOverlay");
  if (!overlay) return;
  overlay.classList.add("closing");
  setTimeout(() => {
    overlay.hidden = true;
    overlay.classList.remove("closing");
    document.body.style.overflow = "";
  }, 200);
}

async function submitAuth(event) {
  event.preventDefault();
  const submit = document.querySelector("#authSubmit");
  const error = document.querySelector("#authError");
  const body = {
    username: document.querySelector("#authUsername").value.trim(),
    password: document.querySelector("#authPassword").value
  };

  if (AUTH_STATE.needsBootstrap) {
    body.displayName = document.querySelector("#authDisplayName").value.trim() || "Administrator";
    body.email = document.querySelector("#authEmail").value.trim();
  }

  submit.disabled = true;
  error.textContent = "";

  try {
    const endpoint = AUTH_STATE.needsBootstrap ? "/api/auth/bootstrap" : "/api/auth/login";
    const data = await authFetch(endpoint, { method: "POST", body });
    AUTH_STATE.user = data.user;
    AUTH_STATE.needsBootstrap = false;
    renderAuthChip();
    closeAuth();
    window.dispatchEvent(new CustomEvent("optilens:auth-changed", { detail: { user: data.user } }));
    window.location.reload();
  } catch (err) {
    error.textContent = err.message || "Sign in failed.";
  } finally {
    submit.disabled = false;
  }
}

async function submitChangePassword(event) {
  event.preventDefault();
  const submit = document.querySelector("#accountSubmit");
  const error = document.querySelector("#accountError");
  const body = {
    oldPassword: document.querySelector("#accountOldPassword").value,
    newPassword: document.querySelector("#accountNewPassword").value
  };

  submit.disabled = true;
  error.textContent = "";

  try {
    await authFetch("/api/auth/change-password", { method: "POST", body });
    alert("Password changed successfully.");
    closeAccount();
  } catch (err) {
    error.textContent = err.message || "Change password failed.";
  } finally {
    submit.disabled = false;
  }
}

async function signOut() {
  await authFetch("/api/auth/logout", { method: "POST" }).catch(() => ({}));
  AUTH_STATE.user = null;
  renderAuthChip();
  window.location.reload();
}

async function authFetch(url, options = {}) {
  const fetchOptions = {
    method: options.method || "GET",
    headers: { ...(options.headers || {}) },
    cache: "no-store"
  };

  if (options.body !== undefined) {
    fetchOptions.headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, fetchOptions);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function initials(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "IN";
  return parts.slice(0, 2).map((part) => part[0].toUpperCase()).join("");
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function esc(v) {
  return String(v)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// ─── Global System Assistant ──────────────────────────────────────────────────

const GLOBAL_ASSISTANT_STATE = {
  isOpen: false,
  isDocked: false,
  listening: false,
  asking: false,
  history: []
};

function wireGlobalAssistant() {
  const toggleBtn = document.querySelector("#globalAssistantToggle");
  const fabBtn = document.querySelector("#globalAssistantFab");
  const drawer = document.querySelector("#globalAssistantDrawer");
  const closeBtn = document.querySelector("#assistantCloseBtn");
  const dockBtn = document.querySelector("#assistantDockToggle");
  const configBtn = document.querySelector("#assistantConfigBtn");
  const input = document.querySelector("#assistantInput");
  const sendBtn = document.querySelector("#assistantSendBtn");
  const micBtn = document.querySelector("#assistantMicBtn");
  const chipContainer = document.querySelector("#assistantQuickChips");
  const routeChip = document.querySelector("#assistantRouteChip");

  if (!drawer) return;

  function updateRouteChip() {
    if (routeChip) {
      const p = window.location.pathname;
      routeChip.textContent = `📍 ${p === "/" ? "Home" : p}`;
    }
  }

  function renderQuickChips() {
    if (!chipContainer) return;
    const p = window.location.pathname;
    let chips = ["Check system health", "Run diagnostics", "Go to Delivery & Export", "Go to Business Metrics"];

    if (p.includes("business-metrics")) {
      chips = ["What should I write off first?", "Check dead stock value", "Check system health", "Go to Delivery & Export"];
    } else if (p.includes("delivery-export")) {
      chips = ["Check active shipments", "Go to Business Metrics", "Check system health", "Run diagnostics"];
    } else if (p.includes("automation")) {
      chips = ["Check supplier mailboxes", "Check BeSwift status", "Check system health", "Go to Pricing Automation"];
    }

    chipContainer.innerHTML = chips.map(q => `<button type="button" class="assistant-chip" data-q="${esc(q)}">${esc(q)}</button>`).join("");
    chipContainer.querySelectorAll("[data-q]").forEach(btn => {
      btn.addEventListener("click", () => {
        if (input) input.value = btn.dataset.q;
        sendGlobalAssistantQuestion();
      });
    });
  }

  function toggleAssistant(show) {
    GLOBAL_ASSISTANT_STATE.isOpen = typeof show === "boolean" ? show : !GLOBAL_ASSISTANT_STATE.isOpen;
    if (GLOBAL_ASSISTANT_STATE.isOpen) {
      drawer.removeAttribute("hidden");
      updateRouteChip();
      renderQuickChips();
      if (input) input.focus();
    } else {
      drawer.setAttribute("hidden", "");
    }
  }

  if (toggleBtn) toggleBtn.addEventListener("click", () => toggleAssistant());
  if (fabBtn) fabBtn.addEventListener("click", () => toggleAssistant());
  if (closeBtn) closeBtn.addEventListener("click", () => toggleAssistant(false));

  if (dockBtn) {
    dockBtn.addEventListener("click", () => {
      GLOBAL_ASSISTANT_STATE.isDocked = !GLOBAL_ASSISTANT_STATE.isDocked;
      drawer.classList.toggle("is-docked", GLOBAL_ASSISTANT_STATE.isDocked);
    });
  }

  if (configBtn) {
    configBtn.addEventListener("click", () => {
      window.location.href = "/settings.html";
    });
  }

  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      toggleAssistant();
    }
  });

  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendGlobalAssistantQuestion();
    });
  }
  if (sendBtn) sendBtn.addEventListener("click", sendGlobalAssistantQuestion);
  if (micBtn) micBtn.addEventListener("click", toggleGlobalMic);

  const msgContainer = document.querySelector("#assistantMessages");
  if (msgContainer) {
    msgContainer.addEventListener("click", async (e) => {
      const btn = e.target.closest(".action-exec-btn");
      if (!btn) return;
      const action = btn.dataset.action;
      const params = JSON.parse(btn.dataset.params || "{}");
      btn.disabled = true;
      btn.textContent = "Executing...";

      try {
        if (action === "navigate_to" && params.url) {
          window.location.href = params.url;
          return;
        }

        const res = await authFetch("/api/assistant/execute-action", {
          method: "POST",
          body: { action, params }
        });

        appendAssistantMessage("ai", `✅ **Action Executed Successfully**\n\`\`\`json\n${JSON.stringify(res.result || res, null, 2)}\n\`\`\``);
      } catch (err) {
        appendAssistantMessage("ai", `❌ **Action Execution Failed**: ${err.message || err}`);
      }
    });
  }
}

async function sendGlobalAssistantQuestion() {
  const input = document.querySelector("#assistantInput");
  const q = input ? input.value.trim() : "";
  if (!q || GLOBAL_ASSISTANT_STATE.asking) return;

  GLOBAL_ASSISTANT_STATE.asking = true;
  if (input) input.value = "";

  appendAssistantMessage("user", q);
  GLOBAL_ASSISTANT_STATE.history.push({ role: "user", content: q });

  const loadingId = appendAssistantMessage("ai", "Thinking...");

  try {
    const res = await authFetch("/api/assistant/ask", {
      method: "POST",
      body: {
        question: q,
        route: window.location.pathname,
        history: GLOBAL_ASSISTANT_STATE.history
      }
    });

    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();

    GLOBAL_ASSISTANT_STATE.history.push({ role: "assistant", content: res.answer || "" });

    appendAssistantMessage("ai", res.answer || "No response.", res.actionProposal);
  } catch (err) {
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();
    appendAssistantMessage("ai", `⚠️ Error: ${err.message || err}`);
  } finally {
    GLOBAL_ASSISTANT_STATE.asking = false;
  }
}

function appendAssistantMessage(role, text, actionProposal = null) {
  const container = document.querySelector("#assistantMessages");
  if (!container) return;

  const msgId = "msg_" + Math.random().toString(36).substr(2, 9);
  const div = document.createElement("div");
  div.className = `assistant-msg assistant-msg-${role}`;
  div.id = msgId;

  const icon = role === "ai" ? "smart_toy" : "person";
  let contentHtml = esc(text).replace(/\n/g, "<br>");

  if (actionProposal) {
    contentHtml += `
      <div class="assistant-action-card">
        <div class="action-card-header">
          <span class="material-symbols-outlined">bolt</span>
          <strong>${esc(actionProposal.label || actionProposal.action)}</strong>
        </div>
        <p class="action-card-desc">${esc(actionProposal.description || "")}</p>
        <button type="button" class="action-exec-btn" data-action="${esc(actionProposal.action)}" data-params='${esc(JSON.stringify(actionProposal.params || {}))}'>
          Execute Action
        </button>
      </div>`;
  }

  div.innerHTML = `
    <div class="msg-avatar"><span class="material-symbols-outlined">${icon}</span></div>
    <div class="msg-content">${contentHtml}</div>
  `;

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return msgId;
}

function toggleGlobalMic() {
  const micBtn = document.querySelector("#assistantMicBtn");
  const statusEl = document.querySelector("#assistantVoiceStatus");
  const input = document.querySelector("#assistantInput");

  if (GLOBAL_ASSISTANT_STATE.listening) {
    if (GLOBAL_ASSISTANT_STATE.recognition) {
      try { GLOBAL_ASSISTANT_STATE.recognition.stop(); } catch (_) {}
    }
    GLOBAL_ASSISTANT_STATE.listening = false;
    if (micBtn) micBtn.classList.remove("is-listening");
    if (statusEl) statusEl.hidden = true;
    return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    try {
      const rec = new SpeechRecognition();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = "en-US";
      const baseText = input ? input.value.trim() + " " : "";

      rec.onstart = () => {
        GLOBAL_ASSISTANT_STATE.listening = true;
        if (micBtn) micBtn.classList.add("is-listening");
        if (statusEl) {
          statusEl.hidden = false;
          statusEl.textContent = "🎙 Listening... Speak your request.";
        }
      };

      rec.onresult = (e) => {
        let transcript = "";
        for (let i = e.resultIndex; i < e.results.length; ++i) {
          transcript += e.results[i][0].transcript;
        }
        if (input) input.value = baseText + transcript;
      };

      rec.onerror = () => {
        GLOBAL_ASSISTANT_STATE.listening = false;
        if (micBtn) micBtn.classList.remove("is-listening");
        if (statusEl) statusEl.hidden = true;
      };

      rec.onend = () => {
        GLOBAL_ASSISTANT_STATE.listening = false;
        if (micBtn) micBtn.classList.remove("is-listening");
        if (statusEl) statusEl.hidden = true;
      };

      GLOBAL_ASSISTANT_STATE.recognition = rec;
      rec.start();
    } catch (_) {}
  }
}

function startUpdateProgressPolling() {
  if (UPDATE_STATE.progressTimer) clearInterval(UPDATE_STATE.progressTimer);
  const poll = async () => {
    try {
      const status = await authFetch("/api/system/updates");
      const run = status.updateRun;
      if (run) {
        const bar = document.querySelector("#updateProgressBar");
        if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(run.percent) || 0))}%`;
        const message = document.querySelector("#updateProgressMessage");
        if (message) message.textContent = run.message || run.phase || "Updating…";
        if (run.status === "failed") showUpdateProgressError(run.error || run.message || "Update failed.");
      }
      const logs = await authFetch("/api/system/updates/logs");
      const updateLog = (logs.logs || []).find((log) => String(log.path).endsWith("data/local-update.log"));
      const output = document.querySelector("#updateProgressLog");
      if (output && updateLog) output.textContent = updateLog.text || "";
    } catch { /* expected while the service restarts */ }
  };
  poll();
  UPDATE_STATE.progressTimer = setInterval(poll, 1000);
}

function stopUpdateProgressPolling() {
  if (UPDATE_STATE.progressTimer) clearInterval(UPDATE_STATE.progressTimer);
  UPDATE_STATE.progressTimer = null;
}
