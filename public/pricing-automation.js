const pricingState = {
  rules: [],
  calculations: []
};

initPricing();

async function initPricing() {
  wireThemeToggle();
  applyTheme();
  wireTabs();
  wirePricingActions();
  await refreshPricing();
}

function wireTabs() {
  document.querySelectorAll(".workflow-tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      const tabId = button.dataset.tab;
      document.querySelectorAll(".workflow-tabs button").forEach((item) => item.classList.toggle("active", item === button));
      document.querySelectorAll(".workflow-panel").forEach((panel) => panel.classList.toggle("active", panel.id === tabId));
    });
  });
}

function wirePricingActions() {
  document.querySelector("#refreshPricingBtn")?.addEventListener("click", refreshPricing);
  document.querySelector("#saveRuleBtn")?.addEventListener("click", saveRule);
  document.querySelector("#calculatePriceBtn")?.addEventListener("click", calculatePrice);
}

async function refreshPricing() {
  const [rules, calculations] = await Promise.all([
    getJson("/api/pricing/rules", { rules: [] }),
    getJson("/api/pricing/calculations", { calculations: [] })
  ]);

  pricingState.rules = rules.rules || [];
  pricingState.calculations = calculations.calculations || [];
  renderRules();
  renderHistory();
}

async function saveRule() {
  await postJson("/api/pricing/rules", {
    ruleName: value("#ruleNameInput"),
    customerAccount: value("#ruleCustomerInput"),
    productCode: value("#ruleProductInput"),
    basePrice: value("#ruleBasePriceInput"),
    markupPercent: value("#ruleMarkupInput"),
    fixedAdjustment: value("#ruleAdjustmentInput"),
    minPrice: value("#ruleMinInput"),
    roundingIncrement: value("#ruleRoundInput")
  });

  clearRuleInputs();
  await refreshPricing();
}

async function calculatePrice() {
  const result = await postJson("/api/pricing/calculate", {
    customerAccount: value("#calcCustomerAccount"),
    productCode: value("#calcProductCode"),
    sourceReference: value("#calcSourceReference"),
    inputPrice: value("#calcInputPrice")
  });

  renderResult(result);
  await refreshPricing();
}

function renderResult(result) {
  const target = document.querySelector("#pricingResult");
  if (!target) return;

  const calculation = result.calculation || {};
  const rule = result.selectedRule || {};
  target.innerHTML = `
    <strong>${formatMoney(calculation.calculated_price)}</strong>
    <span>${rule.rule_name ? `Matched ${escapeHtml(rule.rule_name)}` : "No matching rule; saved direct calculation."}</span>
  `;
}

function renderRules() {
  const target = document.querySelector("#pricingRulesRows");
  if (!target) return;

  target.innerHTML = pricingState.rules.map((rule) => `
    <tr>
      <td>${escapeHtml(rule.rule_name)}</td>
      <td>${escapeHtml(rule.customer_account || "Any")}</td>
      <td>${escapeHtml(rule.product_code || "Any")}</td>
      <td>${formatMoney(rule.base_price)}</td>
      <td>${formatPercent(rule.markup_percent)}</td>
      <td>${formatMoney(rule.fixed_adjustment)}</td>
      <td>${escapeHtml(rule.priority)}</td>
    </tr>
  `).join("") || `<tr><td colspan="7">No pricing rules yet.</td></tr>`;
}

function renderHistory() {
  const target = document.querySelector("#pricingHistoryRows");
  if (!target) return;

  target.innerHTML = pricingState.calculations.map((item) => `
    <tr>
      <td>${formatDate(item.created_at)}</td>
      <td>${escapeHtml(item.rule_name || "Direct")}</td>
      <td>${escapeHtml(item.customer_account || "")}</td>
      <td>${escapeHtml(item.product_code || "")}</td>
      <td>${escapeHtml(item.source_reference || "")}</td>
      <td>${formatMoney(item.input_price)}</td>
      <td>${formatMoney(item.calculated_price)}</td>
    </tr>
  `).join("") || `<tr><td colspan="7">No pricing calculations yet.</td></tr>`;
}

function clearRuleInputs() {
  ["#ruleNameInput", "#ruleCustomerInput", "#ruleProductInput", "#ruleBasePriceInput", "#ruleMinInput"].forEach((selector) => {
    const input = document.querySelector(selector);
    if (input) input.value = "";
  });
  document.querySelector("#ruleMarkupInput").value = "0";
  document.querySelector("#ruleAdjustmentInput").value = "0";
  document.querySelector("#ruleRoundInput").value = "0.01";
}

async function getJson(url, fallback) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();
    return response.ok ? data : { ...fallback, error: data.error || "Request failed" };
  } catch (error) {
    return { ...fallback, error: error.message };
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function value(selector) {
  return document.querySelector(selector)?.value.trim() || "";
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

function formatPercent(value) {
  if (value === null || value === undefined || value === "") return "";
  return `${Number(value).toLocaleString()}%`;
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
    btn.textContent = theme === "dark" ? "Light" : "Dark";
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
