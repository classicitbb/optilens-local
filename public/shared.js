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
  if (document.getElementById("launcherOverlay")) return; // already present (index.html)

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

  document.body.insertAdjacentHTML("afterbegin", launcherHtml + searchHtml);
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

// ─── Utility ─────────────────────────────────────────────────────────────────

function esc(v) {
  return String(v)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
