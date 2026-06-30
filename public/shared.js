/**
 * shared.js — OptiLens Local common header functionality
 * Injected on every page. Handles: launcher, search palette, theme toggle, back button.
 */

// Icons are Google Material Symbols ligature names (rendered via .material-symbols-outlined).
const LAUNCHER_APPS = [
  { label: "Launch Pad",        icon: "dashboard",     href: "/",                          color: "#1A8A9C", permissions: [] },
  { label: "Delivery & Export", icon: "inventory_2",   href: "/modules/delivery-export",   color: "#C89130", permissions: ["delivery.read", "delivery.write"] },
  { label: "Pricing",           icon: "price_change",  href: "/modules/pricing-automation", color: "#389457", permissions: ["pricing.read", "pricing.write"] },
  { label: "Integrations",      icon: "link",          href: "/modules/integrations",       color: "#0B1E35", permissions: ["integrations.read", "integrations.manage"] },
  { label: "Automation",        icon: "bolt",          href: "/modules/automation",          color: "#7c3aed", permissions: ["automation.read", "automation.manage"] },
  { label: "Doc Studio",        icon: "description",   href: "/modules/doc-studio",          color: "#1A8A9C", permissions: ["docstudio.read", "docstudio.write"] },
  { label: "Business Metrics",  icon: "monitoring",    href: "/modules/business-metrics",   color: "#b45309", permissions: ["platform.admin"] },
  { label: "Release Notes",     icon: "history",       href: "/release-notes",              color: "#6d28d9", permissions: [] },
  { label: "Users",             icon: "group",         href: "/admin/users",                 color: "#0B1E35", permissions: ["users.manage"] },
  { label: "Credentials",       icon: "key",           href: "/credentials",                color: "#64748b", permissions: ["credentials.manage"] },
  { label: "Settings",          icon: "settings",      href: "/settings",                   color: "#4b5563", permissions: ["platform.admin"] }
];

const LAUNCHER_ORDER_STORAGE_KEY = "optilens.launcherOrder";

const SEARCH_INDEX = [
  { label: "Dashboard",           meta: "Home",     icon: "dashboard",    color: "#1A8A9C", href: "/", permissions: [] },
  { label: "Delivery & Export",   meta: "Module",   icon: "inventory_2",  color: "#C89130", href: "/modules/delivery-export", permissions: ["delivery.read", "delivery.write"] },
  { label: "Pricing Automation",  meta: "Module",   icon: "price_change", color: "#389457", href: "/modules/pricing-automation", permissions: ["pricing.read", "pricing.write"] },
  { label: "Integrations",        meta: "Module",   icon: "link",         color: "#0B1E35", href: "/modules/integrations", permissions: ["integrations.read", "integrations.manage"] },
  { label: "Automation",          meta: "Module",   icon: "bolt",         color: "#7c3aed", href: "/modules/automation", permissions: ["automation.read", "automation.manage"] },
  { label: "Doc Studio",          meta: "Module",   icon: "description",  color: "#1A8A9C", href: "/modules/doc-studio", permissions: ["docstudio.read", "docstudio.write"] },
  { label: "Business Metrics",    meta: "Module",   icon: "monitoring",   color: "#b45309", href: "/modules/business-metrics", permissions: ["platform.admin"] },
  { label: "Release Notes",        meta: "Roadmap",  icon: "history",      color: "#6d28d9", href: "/release-notes", permissions: [] },
  { label: "Users",               meta: "Admin",    icon: "group",        color: "#0B1E35", href: "/admin/users", permissions: ["users.manage"] },
  { label: "Credentials",         meta: "Security", icon: "key",          color: "#64748b", href: "/credentials", permissions: ["credentials.manage"] },
  { label: "Settings",            meta: "Page",     icon: "settings",     color: "#4b5563", href: "/settings", permissions: ["platform.admin"] },
  { label: "API Health",          meta: "Endpoint", icon: "vital_signs",  color: "#1A8A9C", href: "/api/health", permissions: [] },
  { label: "Dashboard API",       meta: "Endpoint", icon: "api",          color: "#1A8A9C", href: "/api/dashboard", permissions: [] },
  { label: "Modules API",         meta: "Endpoint", icon: "view_list",    color: "#1A8A9C", href: "/api/modules", permissions: [] }
];

const AUTH_STATE = {
  user: null,
  needsMigration: false,
  needsBootstrap: false
};

// ─── Bootstrap ───────────────────────────────────────────────────────────────

(function bootstrap() {
  // Apply theme immediately to prevent flash
  applyTheme();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();

function setup() {
  ensureMaterialSymbolsFont();
  normalizeHeaderIcons();
  injectOverlays();
  wireThemeToggle();
  wireLauncher();
  wireSearch();
  wireAuth();
}

// ─── Material Symbols font ─────────────────────────────────────────────────────

// shared.js renders Material Symbols icons (launcher tiles, search results, theme
// toggle) on every page. Ensure the font stylesheet is present even on pages whose
// markup doesn't include it, so ligature names don't render as raw text.
function ensureMaterialSymbolsFont() {
  if (document.querySelector('link[href*="Material+Symbols+Outlined"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200";
  document.head.appendChild(link);
}

// Normalize legacy SVG header icons to Material Symbols so every page matches the
// launchpad header. Only swaps buttons that still contain an <svg>; pages already
// migrated (e.g. index.html) are left untouched.
function normalizeHeaderIcons() {
  const swap = (el, icon) => {
    if (!el) return;
    const svg = el.querySelector("svg");
    if (!svg) return;
    const span = document.createElement("span");
    span.className = "material-symbols-outlined";
    span.textContent = icon;
    svg.replaceWith(span);
  };
  swap(document.querySelector("#launcherBtn"), "apps");
  swap(document.querySelector(".back-btn"), "arrow_back");
  swap(document.querySelector("#searchTrigger"), "search");
  swap(document.querySelector('.top-action-btn[aria-label="Help"]'), "help");
  swap(document.querySelector('.top-action-btn[aria-label="Notifications"]'), "notifications");
}

// ─── Theme ───────────────────────────────────────────────────────────────────

function applyTheme() {
  const saved = localStorage.getItem("optilens.theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved || (prefersDark ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  updateThemeBtn(theme);
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
    localStorage.setItem("optilens.theme", next);
    document.documentElement.dataset.theme = next;
    updateThemeBtn(next);
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
      <button class="launcher-close" id="launcherClose" type="button" aria-label="Close launcher">&#x2715;</button>
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

  let html = "";
  if (!document.getElementById("launcherOverlay")) html += launcherHtml;
  if (!document.getElementById("searchOverlay")) html += searchHtml;
  if (!document.getElementById("authOverlay")) html += authHtml;
  if (!document.getElementById("accountOverlay")) html += accountHtml;
  if (html) document.body.insertAdjacentHTML("afterbegin", html);
}

// ─── Launcher ────────────────────────────────────────────────────────────────

function wireLauncher() {
  const btn     = document.querySelector("#launcherBtn");
  const overlay = document.querySelector("#launcherOverlay");
  const closeBtn = document.querySelector("#launcherClose");
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

  trigger?.addEventListener("click", open);
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

function renderUserDropdown(chip, dropdown) {
  const user = AUTH_STATE.user;
  const name = user ? (user.displayName || user.username) : "";
  const role = user ? (user.role || "User") : "";
  dropdown.innerHTML = `
    <div class="user-dropdown-header">
      <div class="user-dropdown-name">${esc(name)}</div>
      <div class="user-dropdown-role">${esc(role)}</div>
    </div>
    <div class="user-dropdown-divider"></div>
    <button class="user-dropdown-item" id="ddResetPassword" type="button" role="menuitem">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.4"/>
        <path d="M5 7h4M7 5v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
      Reset password
    </button>
    <button class="user-dropdown-item danger" id="ddSignOut" type="button" role="menuitem">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M5 2H2.5A1.5 1.5 0 001 3.5v7A1.5 1.5 0 002.5 12H5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        <path d="M9 9.5L12 7l-3-2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M12 7H5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
      Sign out
    </button>`;

  dropdown.querySelector("#ddResetPassword").addEventListener("click", () => {
    closeAllDropdowns();
    openAccount();
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
      <span class="launcher-icon material-symbols-outlined" style="background:${esc(app.color)}">${esc(app.icon)}</span>
      <span>${esc(app.label)}</span>
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
