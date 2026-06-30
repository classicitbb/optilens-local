const SETTINGS_REFRESH_MS = 30000;
let settingsRefreshTimer = null;

initSettings();

async function initSettings() {
  await refreshDashboardHealth();
  const accessImport = await getJson("/api/access-import/dry-run", { tables: [] });
  renderAccessImport(accessImport.tables || []);
  startSettingsRefresh();
  // Theme + launcher handled by shared.js (loaded before settings.js)
}

function startSettingsRefresh() {
  if (settingsRefreshTimer) return;
  settingsRefreshTimer = setInterval(() => {
    refreshDashboardHealth();
  }, SETTINGS_REFRESH_MS);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshDashboardHealth();
    }
  });
}

async function refreshDashboardHealth() {
  try {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    if (!response.ok) return;
    const dashboard = await response.json();
    renderHealth(dashboard.integrationHealth || []);
  } catch {
    // Preserve the last successful health snapshot.
  }
}

function renderHealth(items) {
  const target = document.querySelector("#healthList");
  if (!target) return;
  if (!items.length) {
    target.innerHTML = `<article class="setup-card"><span class="badge">No data</span><h3>No integration status available</h3><p>Could not load integration health from the dashboard API.</p></article>`;
    return;
  }
  target.innerHTML = items.map(item => `
    <article class="setup-card">
      <span class="badge ${escapeHtml(item.state)}">${escapeHtml(item.state)}</span>
      <h3>${escapeHtml(item.name)}</h3>
      <p>${escapeHtml(item.detail)}</p>
    </article>
  `).join("");
}

function renderAccessImport(tables) {
  const target = document.querySelector("#accessImportRows");
  if (!target) return;
  target.innerHTML = tables.map(table => `
    <tr>
      <td>${escapeHtml(table.table)}</td>
      <td>${table.row_count === null || table.row_count === undefined ? "-" : Number(table.row_count).toLocaleString()}</td>
      <td><span class="badge">${escapeHtml(table.migration_treatment || "review")}</span></td>
    </tr>
  `).join("") || `<tr><td colspan="3">Run the Access import dry-run script to populate this section.</td></tr>`;
}

async function getJson(url, fallback) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return fallback;
    return res.json();
  } catch { return fallback; }
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
    btn.textContent = theme === "dark" ? "☼" : "☽";
  }
}

function wireThemeToggle() {
  document.querySelector("#themeToggle")?.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("optilens.theme", next);
    applyTheme();
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
