import {
  $,
  ADDONS,
  app,
  currencyRate,
  escapeAttr,
  escapeHtml,
  getCombo,
  getKey,
  isBelowCurrentFloor,
  isComboDisabled,
  marginClass,
  MATERIALS,
  state,
  SUP_ABBR,
  SUPPLIER_COLORS,
  sym,
  syncProtectedActionLocks,
  TIER_DISPLAY,
  TIER_ORDER,
  toast,
  toDisplay,
  TREATMENT_ORDER,
  visibleTreatments,
} from "./state.js";

function activeMaterials(treatment) {
  return MATERIALS.filter((material) => TIER_ORDER.some((tier) => getCombo(treatment, tier, material)));
}

export function populateCustomers() {
  const select = $("customer-select");
  if (!select) return;
  select.innerHTML = '<option value="">— Select customer —</option>';
  state.customers.forEach((customer) => {
    const option = document.createElement("option");
    option.value = customer.account;
    option.textContent = `${customer.name}  (${customer.country || "—"})`;
    select.appendChild(option);
  });
}

export function onCustomerChange() {
  const account = $("customer-select").value;
  state.currentCustomer = state.customers.find((customer) => customer.account === account) || null;
  const pill = $("customer-pill");
  if (!pill) return;
  if (state.currentCustomer) {
    pill.textContent = `${state.currentCustomer.buyingGroup || "—"} · ${state.currentCustomer.priceList || "No list assigned"}`;
    pill.style.display = "";
    if (!$("pricelist-name").value) {
      const date = new Date().toLocaleDateString("en-GB", { month: "short", year: "numeric" });
      $("pricelist-name").value = `${state.currentCustomer.name} – ${date}`;
    }
    app.setCurrency(state.currentCustomer.buyingGroup === "Export" ? "USD" : "BBD");
  } else {
    pill.style.display = "none";
  }
}

export function buildGroupPanel() {
  const element = $("group-visibility");
  if (!element) return;
  element.innerHTML = TREATMENT_ORDER.map((name) => {
    const visible = !state.settings.hiddenGroups.includes(name);
    return `<div class="pl-group-row ${visible ? "" : "hidden"}">
      <span class="pl-group-name" title="${escapeAttr(name)}">${escapeHtml(name)}</span>
      <button class="pl-group-toggle ${visible ? "" : "off"}" type="button" data-action="toggle-group-visibility" data-name="${escapeAttr(name)}">${visible ? "hide" : "show"}</button>
    </div>`;
  }).join("");
}

export function toggleGroupVisibility(name) {
  const index = state.settings.hiddenGroups.indexOf(name);
  if (index >= 0) state.settings.hiddenGroups.splice(index, 1);
  else state.settings.hiddenGroups.push(name);
  buildGroupPanel();
  buildMatrix();
  toast(`${name} ${state.settings.hiddenGroups.includes(name) ? "hidden" : "included"} in this pricelist`);
}

export function buildSupplierPanel() {
  const element = $("sup-legend");
  if (!element) return;
  const count = state.settings.priority.length;
  element.innerHTML = state.settings.priority.map((name, index) => {
    const excluded = state.settings.excluded.includes(name);
    return `<div class="pl-sup-row${excluded ? " excluded" : ""}">
      <span class="sup-dot" style="background:${SUPPLIER_COLORS[name] || "#888"}"></span>
      <span class="sup-name">${escapeHtml(SUP_ABBR[name] || name)}</span>
      <span class="sup-rank">${index === 0 ? "top" : index === count - 1 ? "least" : ""}</span>
      <span class="sup-ctrls">
        <button class="mini" type="button" title="Move up" data-action="supplier-move" data-index="${index}" data-dir="-1" ${index === 0 ? "disabled" : ""}>▲</button>
        <button class="mini" type="button" title="Move down" data-action="supplier-move" data-index="${index}" data-dir="1" ${index === count - 1 ? "disabled" : ""}>▼</button>
        <button class="mini exc ${excluded ? "on" : ""}" type="button" data-action="supplier-exclude" data-supplier="${escapeAttr(name)}">${excluded ? "✕" : "✓"}</button>
      </span>
    </div>`;
  }).join("");
}

export async function supplierMoveAndReprice(index, dir) {
  const target = index + dir;
  if (target < 0 || target >= state.settings.priority.length) return;
  const priority = state.settings.priority;
  [priority[index], priority[target]] = [priority[target], priority[index]];
  buildSupplierPanel();
  await app.rePrice();
}

export async function supplierToggleExcludeAndReprice(name) {
  const index = state.settings.excluded.indexOf(name);
  if (index >= 0) state.settings.excluded.splice(index, 1);
  else state.settings.excluded.push(name);
  buildSupplierPanel();
  await app.rePrice();
}

export function buildMatrix() {
  const container = $("matrix-container");
  if (!container) return;
  container.innerHTML = "";
  if (state.loadError) {
    const message = state.loadError.status === 401 || state.loadError.status === 403
      ? "Sign in with a pricing account to load the lens grid."
      : (state.loadError.message || "Could not load the lens grid.");
    container.innerHTML = `<div class="pl-empty-state">${escapeHtml(message)}</div>`;
    return;
  }

  visibleTreatments().forEach((treatment) => {
    const tiers = TIER_ORDER.filter((tier) => MATERIALS.some((material) => getCombo(treatment, tier, material)));
    if (!tiers.length) return;
    const materials = activeMaterials(treatment);
    const isCollapsed = !!state.collapsed[treatment];
    const setCount = tiers.reduce((count, tier) => count + materials.filter((material) => {
      const key = getKey(treatment, tier, material);
      return state.prices[key] && (state.prices[key].priceUSD || 0) > 0;
    }).length, 0);

    const card = document.createElement("div");
    card.className = `matrix-card${isCollapsed ? " collapsed" : ""}`;
    card.innerHTML = `
      <div class="matrix-hdr" data-action="toggle-collapse" data-treatment="${escapeAttr(treatment)}">
        <h3><span class="chev">${isCollapsed ? "▸" : "▾"}</span> ${escapeHtml(treatment)}</h3>
        <small>${isCollapsed ? `${setCount} priced · click to expand` : "Enter sell prices · worst-case & preferred margins shown"}</small>
      </div>`;

    if (isCollapsed) {
      container.appendChild(card);
      return;
    }

    const table = document.createElement("table");
    table.className = "matrix";
    table.innerHTML = `<thead><tr><th class="label-col">Lens Design</th>${materials.map((material) => `<th>${escapeHtml(material)}</th>`).join("")}</tr></thead>`;
    const body = document.createElement("tbody");

    tiers.forEach((tier) => {
      const display = TIER_DISPLAY[tier] || { name: tier, grade: "" };
      const row = document.createElement("tr");
      const label = document.createElement("td");
      label.className = "row-label";
      label.innerHTML = `<span class="tier-grade">${escapeHtml(display.grade)}</span><span class="tier-name">${escapeHtml(display.name)}</span>`;
      row.appendChild(label);

      materials.forEach((material) => {
        const cell = document.createElement("td");
        const combo = getCombo(treatment, tier, material);
        const key = getKey(treatment, tier, material);
        if (!combo) {
          cell.className = "dash-cell";
          cell.textContent = "·";
          row.appendChild(cell);
          return;
        }
        if (isComboDisabled(key)) {
          cell.innerHTML = `<div class="price-cell off">
            <span class="off-tag">discontinued</span>
            <button class="audit-btn" type="button" data-action="open-audit" data-key="${escapeAttr(key)}">🔍</button></div>`;
          row.appendChild(cell);
          return;
        }

        const price = state.prices[key];
        const shownUSD = price ? (state.priceMode === "retail" ? (price.retailUSD || 0) : (price.priceUSD || 0)) : 0;
        const isSet = shownUSD > 0;
        const belowFloor = isBelowCurrentFloor(price);
        const displayValue = isSet ? toDisplay(shownUSD).toFixed(2) : "";
        let infoHtml = "";

        if (price && state.priceMode === "wholesale") {
          const floorMargin = price.floorMargin || 0;
          const preferredMargin = price.preferredMargin || 0;
          const anchorAbbr = SUP_ABBR[price.anchorSupplier] || "";
          const preferredAbbr = SUP_ABBR[price.preferredSupplier] || "";
          const constrained = price.constraintSupplier ? " constrained" : "";
          const floorBadge = belowFloor
            ? '<span class="mtag m-below" title="This row is still below the current floor after auto-pricing.">below floor</span>'
            : "";
          infoHtml = `<div class="cell-info${constrained}${belowFloor ? " below-floor" : ""}">
            ${floorBadge}
            <span class="mtag ${marginClass(floorMargin)}" title="Anchor (${escapeHtml(anchorAbbr)}) worst-case: ${(floorMargin * 100).toFixed(0)}% margin">⚓ ${(floorMargin * 100).toFixed(0)}%</span>
            <span class="mtag ${marginClass(preferredMargin)}" title="Preferred source (${escapeHtml(preferredAbbr)}): ${(preferredMargin * 100).toFixed(0)}% margin">▶ ${(preferredMargin * 100).toFixed(0)}%</span>
          </div>`;
        } else {
          const anchorAbbr = SUP_ABBR[combo.anchorSupplier] || "";
          const dot = SUPPLIER_COLORS[combo.anchorSupplier] || "#888";
          const floorBadge = belowFloor
            ? '<span class="mtag m-below" title="This row is still below the current floor after auto-pricing.">below floor</span>'
            : "";
          infoHtml = `<div class="cell-info${belowFloor ? " below-floor" : ""}">${floorBadge}<span class="cost-hint"><span class="dot" style="background:${dot}"></span>${escapeHtml(anchorAbbr)} ${sym()}${toDisplay(combo.anchorCost || 0).toFixed(2)}</span></div>`;
        }

        cell.classList.toggle("below-floor", belowFloor);
        cell.classList.toggle("save-blocked-cell", state.blockedPriceKey === key);
        cell.innerHTML = `<div class="price-cell${belowFloor ? " below-floor" : ""}">
          <div class="price-input-row${belowFloor ? " below-floor" : ""}">
            <input type="number" class="price-input ${isSet ? "set" : ""} ${price && price.constraintSupplier ? "constrained" : ""}${belowFloor ? " below-floor" : ""}" data-key="${escapeAttr(key)}" value="${displayValue}" placeholder="${sym()}0" min="0" step="0.5">
            <button class="audit-btn" type="button" data-action="open-audit" data-key="${escapeAttr(key)}" title="Audit: sources, costs & price edit" aria-label="Audit this lens line">🔍</button>
          </div>
          ${infoHtml}
        </div>`;
        row.appendChild(cell);
      });

      body.appendChild(row);
    });

    table.appendChild(body);
    card.appendChild(table);
    const legend = document.createElement("div");
    legend.className = "legend";
    legend.innerHTML = "<span>⚓ worst-case margin · ▶ preferred margin</span>"
      + '<span><span class="mtag m-ok">≥45%</span><span class="mtag m-thin">30–44%</span><span class="mtag m-floor">15–29%</span><span class="mtag m-low">&lt;15%</span></span>'
      + '<span><span class="mtag m-below">below floor</span></span>'
      + `<span style="margin-left:auto">Prices in USD · display ${escapeHtml(state.currency)} @ ${currencyRate()} · ${escapeHtml(state.priceMode)}</span>`;
    card.appendChild(legend);
    container.appendChild(card);
  });

  if (!container.children.length) {
    container.innerHTML = state.settings.hiddenGroups.length >= TREATMENT_ORDER.length
      ? '<div class="pl-empty-state">All groupings are hidden for this pricelist. Show at least one grouping in the sidebar.</div>'
      : '<div class="pl-empty-state">No catalog data loaded.</div>';
  }

  syncProtectedActionLocks();
  if (app.refreshAudit) app.refreshAudit();
}

export function toggleCollapse(treatment) {
  state.collapsed[treatment] = !state.collapsed[treatment];
  buildMatrix();
}

export function collapseAll(collapsed) {
  visibleTreatments().forEach((treatment) => {
    state.collapsed[treatment] = collapsed;
  });
  buildMatrix();
}

export function showPreview(forPrint = false) {
  const unsafe = app.unsafePriceEntries();
  if (unsafe.length) {
    revealBlockedPriceEntry();
    toast(`Cannot preview: ${unsafe.length} price${unsafe.length === 1 ? "" : "s"} below margin floor`);
    return;
  }
  const listName = $("pricelist-name").value || "RX Lens Prices";
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const field = (price) => (state.priceMode === "retail" ? (price.retailUSD || 0) : (price.priceUSD || 0));

  const customerLine = state.currentCustomer
    ? `<div class="pl-info-bar">
        <div class="pl-info-cell"><div class="pl-info-label">Prepared for</div><div class="pl-info-value">${escapeHtml(state.currentCustomer.name)}</div></div>
        <div class="pl-info-cell"><div class="pl-info-label">Account</div><div class="pl-info-value">${escapeHtml(state.currentCustomer.account || "—")}</div></div>
        <div class="pl-info-cell"><div class="pl-info-label">Currency</div><div class="pl-info-value">${escapeHtml(state.currency)}</div></div>
        <div class="pl-info-cell"><div class="pl-info-label">Pricing basis</div><div class="pl-info-value">${state.priceMode === "retail" ? "Retail" : "Wholesale"} · per pair</div></div>
      </div>`
    : `<div class="pl-info-bar">
        <div class="pl-info-cell"><div class="pl-info-label">Document</div><div class="pl-info-value">${escapeHtml(listName)}</div></div>
        <div class="pl-info-cell"><div class="pl-info-label">Currency</div><div class="pl-info-value">${escapeHtml(state.currency)}</div></div>
        <div class="pl-info-cell"><div class="pl-info-label">Pricing basis</div><div class="pl-info-value">${state.priceMode === "retail" ? "Retail" : "Wholesale"} · per pair</div></div>
      </div>`;

  let sections = "";
  visibleTreatments().forEach((treatment) => {
    const tiers = TIER_ORDER.filter((tier) => MATERIALS.some((material) => {
      const key = getKey(treatment, tier, material);
      const price = state.prices[key];
      return price && !isComboDisabled(key) && field(price) > 0;
    }));
    if (!tiers.length) return;
    const materials = MATERIALS.filter((material) => tiers.some((tier) => {
      const key = getKey(treatment, tier, material);
      const price = state.prices[key];
      return price && !isComboDisabled(key) && field(price) > 0;
    }));
    let rows = "";
    tiers.forEach((tier) => {
      const display = TIER_DISPLAY[tier] || { grade: tier, name: "" };
      const cells = materials.map((material) => {
        const key = getKey(treatment, tier, material);
        const price = isComboDisabled(key) ? null : state.prices[key];
        const value = price ? field(price) : 0;
        return value > 0
          ? `<td><strong>${sym()}${toDisplay(value).toFixed(2)}</strong></td>`
          : '<td class="pl-dash">—</td>';
      }).join("");
      rows += `<tr><td class="pl-design"><span class="pl-grade">${escapeHtml(display.grade)}</span><span class="pl-lensname">${escapeHtml(display.name)}</span></td>${cells}</tr>`;
    });
    sections += `
      <div class="pl-section">
        <div class="pl-sec-hdr"><span>${escapeHtml(treatment.toUpperCase())}</span><span class="pl-sec-sub">${sym()} · per pair · VAT excl.</span></div>
        <table class="pl-table">
          <thead><tr><th>Lens Design</th>${materials.map((material) => `<th>${escapeHtml(material)}</th>`).join("")}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  });
  if (!sections) sections = '<div class="pl-empty-state">No prices set yet — run Auto-Price first.</div>';

  const addonRows = ADDONS.map((addon) =>
    `<div class="pl-addon-row"><span>${escapeHtml(addon.label)}</span><span><strong>${sym()}${toDisplay(addon.price).toFixed(2)}</strong></span></div>`
  ).join("");

  $("preview-body").innerHTML = `
    <div class="pl-doc">
      <div class="pl-lh">
        <div class="pl-lh-left">
          <div class="pl-lh-logo"><img src="/assets/logo/logo_navy.svg" alt="Classic Visions"></div>
          <div>
            <div class="pl-lh-brand">Classic Visions</div>
            <div class="pl-lh-tagline">Optical · Caribbean & Export</div>
          </div>
        </div>
        <div class="pl-lh-right">
          <div class="pl-lh-doc-type">RX Lens Prices</div>
          <div class="pl-lh-date">${escapeHtml(today)} · Valid until further notice</div>
        </div>
      </div>

      ${customerLine}
      ${sections}

      <div class="pl-section" style="page-break-inside:avoid">
        <div class="pl-sec-hdr"><span>AR Coatings & Lens Treatments</span><span class="pl-sec-sub">${sym()} · add to base price</span></div>
        <div class="pl-addons-grid">${addonRows}</div>
      </div>

      <div class="pl-doc-footer">
        <span>All prices in <strong>${escapeHtml(state.currency)}</strong>. Subject to change without notice. Confirm availability at time of order.</span>
        <span><strong>Classic Visions</strong> · classicvisions.net · classicvorders@gmail.com</span>
      </div>
    </div>`;

  $("preview-overlay").classList.add("open");
  if (forPrint) setTimeout(() => window.print(), 320);
}

export function closePreview() {
  $("preview-overlay").classList.remove("open");
}

Object.assign(app, {
  buildGroupPanel,
  buildMatrix,
  buildSupplierPanel,
  closePreview,
  collapseAll,
  onCustomerChange,
  populateCustomers,
  showPreview,
  supplierMoveAndReprice,
  supplierToggleExcludeAndReprice,
  toggleCollapse,
  toggleGroupVisibility,
});
