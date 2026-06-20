/**
 * shared.js — OptiLens Local common header functionality
 * Injected on every page. Handles: launcher, search palette, theme toggle, back button.
 */

const LAUNCHER_APPS = [
  { label: "Launch Pad",        icon: "🏠", href: "/",                          color: "#1A8A9C" },
  { label: "Delivery & Export", icon: "📦", href: "/modules/delivery-export",   color: "#C89130" },
  { label: "Pricing",           icon: "💲", href: "/modules/pricing-automation", color: "#389457" },
  { label: "Integrations",      icon: "🔗", href: "/modules/integrations",       color: "#0B1E35" },
  { label: "Automation",        icon: "⚡", href: "/modules/automation",          color: "#7c3aed" },
  { label: "Doc Studio",        icon: "📄", href: "/modules/doc-studio",          color: "#1A8A9C" },
  { label: "Business Metrics",  icon: "📊", href: "/modules/business-metrics",   color: "#b45309" },
  { label: "Users",             icon: "👤", href: "/admin/users",                 color: "#0B1E35" },
  { label: "Credentials",       icon: "🔐", href: "/credentials",                color: "#64748b" },
  { label: "Settings",          icon: "⚙",  href: "/settings",                   color: "#4b5563" }
];

const SEARCH_INDEX = [
  { label: "Dashboard",           meta: "Home",     icon: "🏠", color: "#1A8A9C", href: "/" },
  { label: "Delivery & Export",   meta: "Module",   icon: "📦", color: "#C89130", href: "/modules/delivery-export" },
  { label: "Pricing Automation",  meta: "Module",   icon: "💲", color: "#389457", href: "/modules/pricing-automation" },
  { label: "Integrations",        meta: "Module",   icon: "🔗", color: "#0B1E35", href: "/modules/integrations" },
  { label: "Automation",          meta: "Module",   icon: "⚡", color: "#7c3aed", href: "/modules/automation" },
  { label: "Doc Studio",          meta: "Module",   icon: "📄", color: "#1A8A9C", href: "/modules/doc-studio" },
  { label: "Business Metrics",    meta: "Module",   icon: "📊", color: "#b45309", href: "/modules/business-metrics" },
  { label: "Users",               meta: "Admin",    icon: "👤", color: "#0B1E35", href: "/admin/users" },
  { label: "Credentials",         meta: "Security", icon: "🔐", color: "#64748b", href: "/credentials" },
  { label: "Settings",            meta: "Page",     icon: "⚙",  color: "#4b5563", href: "/settings" },
  { label: "API Health",          meta: "Endpoint", icon: "🩺", color: "#1A8A9C", href: "/api/health" },
  { label: "Dashboard API",       meta: "Endpoint", icon: "📡", color: "#1A8A9C", href: "/api/dashboard" },
  { label: "Modules API",         meta: "Endpoint", icon: "📋", color: "#1A8A9C", href: "/api/modules" }
];

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
  injectOverlays();
  wireThemeToggle();
  wireLauncher();
  wireSearch();
  wireAuth();
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
  btn.setAttribute("aria-pressed", String(theme === "dark"));
  btn.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
  btn.textContent = theme === "dark" ? "☼" : "☽";
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
    <div class="launcher-foot">
      <button type="button" onclick="history.back()">&#8592; Back to Site</button>
    </div>
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

  let html = "";
  if (!document.getElementById("launcherOverlay")) html += launcherHtml;
  if (!document.getElementById("searchOverlay")) html += searchHtml;
  if (!document.getElementById("authOverlay")) html += authHtml;
  if (html) document.body.insertAdjacentHTML("afterbegin", html);
}

// ─── Launcher ────────────────────────────────────────────────────────────────

function wireLauncher() {
  const btn     = document.querySelector("#launcherBtn");
  const overlay = document.querySelector("#launcherOverlay");
  const closeBtn = document.querySelector("#launcherClose");
  const grid    = document.querySelector("#launcherGrid");
  if (!overlay) return;

  // Populate grid
  if (grid) {
    grid.innerHTML = LAUNCHER_APPS.map(app => `
      <a class="launcher-tile" href="${esc(app.href)}">
        <span class="launcher-icon" style="background:${esc(app.color)}">${app.icon}</span>
        <span>${esc(app.label)}</span>
      </a>`).join("");
  }

  function open()  { overlay.hidden = false; document.body.style.overflow = "hidden"; btn?.setAttribute("aria-expanded","true"); }
  function close() { overlay.hidden = true;  document.body.style.overflow = "";       btn?.setAttribute("aria-expanded","false"); }

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
  function close() { overlay.hidden = true;  document.body.style.overflow = ""; if (input) input.value = ""; }

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
    const hits = q ? SEARCH_INDEX.filter(x => x.label.toLowerCase().includes(q) || x.meta.toLowerCase().includes(q)) : SEARCH_INDEX;
    if (!hits.length) { results.innerHTML = `<div class="search-empty">No results for "${esc(query)}"</div>`; return; }
    results.innerHTML = hits.map(x => `
      <a class="search-result-item" href="${esc(x.href)}">
        <span class="search-result-icon" style="background:${esc(x.color)}">${x.icon}</span>
        ${esc(x.label)}
        <span class="search-result-meta">${esc(x.meta)}</span>
      </a>`).join("");
    results.querySelectorAll("a").forEach(a => a.addEventListener("click", close));
  }
}

// ─── Authentication ─────────────────────────────────────────────────────────

const AUTH_STATE = {
  user: null,
  needsMigration: false,
  needsBootstrap: false
};

function wireAuth() {
  const chips = document.querySelectorAll(".user-chip");
  const overlay = document.querySelector("#authOverlay");
  const form = document.querySelector("#authForm");
  const closeBtn = document.querySelector("#authClose");
  if (!overlay || !form) return;

  window.OptiLensAuth = {
    currentUser: () => AUTH_STATE.user,
    requireSignIn: openAuth
  };

  chips.forEach((chip) => chip.addEventListener("click", () => {
    if (AUTH_STATE.user) {
      if (confirm("Sign out of OptiLens Local?")) signOut();
      return;
    }
    openAuth();
  }));

  closeBtn?.addEventListener("click", closeAuth);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) closeAuth(); });
  form.addEventListener("submit", submitAuth);
  refreshAuthState();
}

async function refreshAuthState() {
  const bootstrap = await authFetch("/api/auth/bootstrap-state").catch(() => ({ needsMigration: false, needsBootstrap: false }));
  AUTH_STATE.needsMigration = Boolean(bootstrap.needsMigration);
  AUTH_STATE.needsBootstrap = Boolean(bootstrap.needsBootstrap);

  const me = await authFetch("/api/auth/me").catch(() => ({ user: null }));
  AUTH_STATE.user = me.user || null;
  renderAuthChip();
}

function renderAuthChip() {
  document.querySelectorAll(".user-chip").forEach((chip) => {
    const avatar = chip.querySelector(".user-avatar");
    const name = chip.querySelector(".user-name");
    if (!avatar || !name) return;

    if (AUTH_STATE.user) {
      avatar.textContent = initials(AUTH_STATE.user.displayName || AUTH_STATE.user.username);
      name.textContent = AUTH_STATE.user.displayName || AUTH_STATE.user.username;
      chip.setAttribute("aria-label", "Signed in user. Click to sign out.");
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
  overlay.hidden = true;
  document.body.style.overflow = "";
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
