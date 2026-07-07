import {
  $,
  app,
  escapeAttr,
  escapeHtml,
  findPriceInput,
  getCombo,
  isBelowCurrentFloor,
  TIER_DISPLAY,
  state,
  SUP_ABBR,
  SUPPLIER_COLORS,
  sym,
  toast,
} from "./state.js";

export function openAudit(key) {
  const combo = state.comboByKey[key];
  if (!combo) return;
  const wasOpen = $("audit-overlay").classList.contains("open");
  state.currentAuditKey = key;
  const [treatment, tier, material] = key.split("||");
  const display = TIER_DISPLAY[tier] || { grade: tier, name: "" };
  const price = state.prices[key];
  const comboDisabled = app.isComboDisabled(key);
  const disabledSuppliers = state.overrides.suppliers[key] || [];
  const sourceName = (state.sources.sources && state.sources.sources[0]) ? state.sources.sources[0].name : "master catalog";

  const supplierRows = Object.entries(combo.provenance || {}).map(([supplier, provenance]) => {
    const landed = app.landedCalc(provenance.sourceCost, supplier);
    return {
      supplier,
      provenance,
      landed,
      excluded: state.settings.excluded.includes(supplier),
      disabled: disabledSuppliers.includes(supplier),
    };
  }).sort((left, right) => right.landed.landed - left.landed.landed);

  const available = supplierRows.filter((row) => !row.excluded && !row.disabled);
  const anchor = available.length ? available.reduce((left, right) => (right.landed.landed > left.landed.landed ? right : left)) : null;
  const existingWholesale = price && Number.isFinite(Number(price.priceUSD)) ? Number(price.priceUSD) : "";
  const existingRetail = price && Number.isFinite(Number(price.retailUSD)) ? Number(price.retailUSD) : "";
  const belowFloor = isBelowCurrentFloor(price);
  state.auditEditDraft = { key, wholesaleUSD: existingWholesale, retailUSD: existingRetail, retailTouched: false };

  const supplierTable = supplierRows.map((row) => {
    const rowBelowFloor = belowFloor && !row.disabled && !row.excluded && price && row.supplier === anchor?.supplier;
    const status = rowBelowFloor ? '<span class="ast floor-alert">below floor</span>'
      : row.disabled ? '<span class="ast off">disabled</span>'
      : row.excluded ? '<span class="ast off">excluded</span>'
      : (anchor && row.supplier === anchor.supplier) ? '<span class="ast anc">⚓ anchor</span>'
      : (price && row.supplier === price.preferredSupplier) ? '<span class="ast pref">▶ preferred</span>'
      : "";
    const margin = (price && price.priceUSD > 0 && row.landed.landed > 0) ? (price.priceUSD - row.landed.landed) / price.priceUSD : null;
    const marginTag = margin != null
      ? `<span class="mtag ${belowFloor && rowBelowFloor ? "m-below" : app.marginClass(margin)}" title="${(margin * 100).toFixed(1)}% margin at current price${belowFloor && rowBelowFloor ? " · below current floor" : ""}">${(margin * 100).toFixed(0)}%</span>`
      : '<span class="muted">—</span>';
    return `<tr class="${(row.disabled || row.excluded) ? "dim" : ""}${rowBelowFloor ? " below-floor" : ""}">
      <td data-label="Supplier"><span class="dot" style="background:${SUPPLIER_COLORS[row.supplier] || "#888"}"></span>${escapeHtml(SUP_ABBR[row.supplier] || row.supplier)}</td>
      <td data-label="Source row" class="src">${escapeHtml(row.provenance.sourceName)}${row.provenance.rowCount > 1 ? ` <span class="muted">(+${row.provenance.rowCount - 1} more)</span>` : ""}</td>
      <td data-label="FOB" class="num">$${row.provenance.sourceCost.toFixed(2)}</td>
      <td data-label="Freight" class="num">+${(row.landed.freight * 100).toFixed(0)}%</td>
      <td data-label="Landed" class="num">$${row.landed.landed.toFixed(2)}</td>
      <td data-label="Margin" class="num">${marginTag}</td>
      <td data-label="Role">${status}</td>
      <td data-label="Action">
        <button class="mini-btn${row.disabled ? "" : " off"}" type="button" data-action="toggle-disable-supplier" data-key="${escapeAttr(key)}" data-supplier="${escapeAttr(row.supplier)}">${row.disabled ? "enable" : "disable"}</button>
      </td>
    </tr>`;
  }).join("");

  const raw = anchor ? anchor.landed.landed / (1 - state.settings.floorMargin) : 0;
  const suggested = raw && state.settings.rounding ? Math.ceil(raw / state.settings.rounding) * state.settings.rounding : raw;
  const editWholesale = existingWholesale || suggested || "";
  const editRetail = existingRetail || (editWholesale ? Math.round(editWholesale * (1 + state.settings.markup.value / 100) * 100) / 100 : "");
  const deltaAmount = (price && suggested > 0) ? (price.priceUSD - suggested) : null;
  const deltaTag = deltaAmount != null
    ? `<span class="audit-delta ${deltaAmount >= 0 ? "delta-pos" : "delta-neg"}" title="${deltaAmount >= 0 ? "Above" : "Below"} auto-suggested">${deltaAmount >= 0 ? "+" : ""}$${Math.abs(deltaAmount).toFixed(2)}</span>`
    : "";
  const floorStatus = price
    ? (belowFloor
      ? `<span class="audit-floor floor-alert">blocked: ${((price.floorMargin || 0) * 100).toFixed(0)}% < ${Math.round(state.settings.floorMargin * 100)}% floor</span>`
      : '<span class="audit-floor floor-ok">passes current floor</span>')
    : "";
  const calcRows = anchor
    ? `<table class="audit-calc">
        <tr><td>Anchor lab (worst-case)</td><td class="num"><b>${escapeHtml(SUP_ABBR[anchor.supplier] || anchor.supplier)}</b> · landed $${anchor.landed.landed.toFixed(2)}</td></tr>
        <tr><td>÷ (1 − floor ${Math.round(state.settings.floorMargin * 100)}%)</td><td class="num">$${raw.toFixed(2)}</td></tr>
        <tr><td>↑ round up to nearest $${state.settings.rounding}${price && price.smoothed ? " · gap-smoothed" : ""}</td><td class="num">$${suggested.toFixed(2)}</td></tr>
        ${price ? `<tr class="hl"><td>${price.manual ? '<span class="audit-manual-badge">manual</span> ' : ""}Wholesale USD ${deltaTag}</td><td class="num"><b>$${price.priceUSD.toFixed(2)}</b></td></tr>
        <tr><td>Retail (+${state.settings.markup.value}% markup)</td><td class="num">$${(price.retailUSD || 0).toFixed(2)}</td></tr>
        <tr><td>Current floor status</td><td class="num">${floorStatus}</td></tr>
        <tr><td><span class="mtag ${app.marginClass(price.floorMargin || 0)}" title="Worst-case: selling above anchor (${escapeHtml(SUP_ABBR[price.anchorSupplier] || price.anchorSupplier || "—")}) landed cost">⚓ ${((price.floorMargin || 0) * 100).toFixed(0)}%</span> &nbsp; <span class="mtag ${app.marginClass(price.preferredMargin || 0)}" title="Preferred source (${escapeHtml(SUP_ABBR[price.preferredSupplier] || price.preferredSupplier || "—")}) margin">▶ ${((price.preferredMargin || 0) * 100).toFixed(0)}%</span></td><td class="num" style="font-size:9px;color:var(--pl-muted-fg)">worst / preferred</td></tr>` : ""}
      </table>`
    : '<p class="muted">No available supplier remains for this line.</p>';

  $("audit-body").innerHTML = `
    <div class="audit-head">
      <div class="audit-title">${escapeHtml(treatment)} · <b>${escapeHtml(display.grade)}</b> <span class="lensname">${escapeHtml(display.name)}</span> · ${escapeHtml(material)}</div>
      <div class="audit-sub">Source: ${escapeHtml(sourceName)} · ${supplierRows.length} supplier${supplierRows.length !== 1 ? "s" : ""} · ${available.length} available</div>
    </div>

    <div class="audit-section-lbl">Suppliers &amp; landed costs</div>
    <div class="audit-sup-wrap">
      <table class="audit-sup">
        <thead><tr><th>Supplier</th><th>Source row</th><th class="num">FOB</th><th class="num">Freight</th><th class="num">Landed</th><th class="num">Margin</th><th>Role</th><th></th></tr></thead>
        <tbody>${supplierTable}</tbody>
      </table>
    </div>

    <div class="audit-section-lbl">Pricing walkthrough</div>
    <div class="audit-pricing">
      <div class="audit-card">
        <div class="audit-section-title">Calculation</div>
        ${calcRows}
      </div>
      <div class="audit-card audit-edit-card">
        <div class="audit-section-title">Edit price</div>
        <div class="audit-edit-grid">
          <label>Wholesale USD<input type="number" id="audit-wholesale-input" data-audit-field="wholesaleUSD" min="0" step="0.5" value="${editWholesale ? Number(editWholesale).toFixed(2) : ""}"></label>
          <label>Retail USD<input type="number" id="audit-retail-input" data-audit-field="retailUSD" min="0" step="0.5" value="${editRetail ? Number(editRetail).toFixed(2) : ""}"></label>
        </div>
        <div class="audit-edit-note">Edits apply on blur, Enter, or close. Blank retail applies the ${state.settings.markup.value}% markup.</div>
        <div id="audit-draft-summary" class="audit-draft-summary"></div>
      </div>
    </div>

    <div class="audit-basis-note">
      <span class="audit-basis-label">Business basis</span>
      Price covers the <b>most expensive available lab at your floor margin</b> — guaranteeing minimum margin regardless of which lab fills the order.
      <span class="audit-formula-line">CIF = FOB × (1 + freight) · Landed = CIF × (1 + duty + levy + clearance) + brokerage · Price = Landed ÷ (1 − ${Math.round(state.settings.floorMargin * 100)}%) → rounded up to $${state.settings.rounding}</span>
      <span class="audit-formula-line" style="opacity:0.7">Source: <b>${escapeHtml(sourceName)}</b> · VAT excluded (recoverable input credit)</span>
    </div>

    <div class="audit-actions">
      ${comboDisabled
        ? `<button class="pl-btn pl-btn-teal" type="button" data-action="toggle-disable-combo" data-key="${escapeAttr(key)}">↩ Restore line</button>`
        : `<button class="pl-btn pl-btn-danger" type="button" data-action="toggle-disable-combo" data-key="${escapeAttr(key)}">✕ Discontinue</button>`}
      <button class="pl-btn pl-btn-primary" type="button" data-action="close-audit">Save &amp; Close</button>
    </div>`;
  updateAuditDraftSummary();
  if (!wasOpen) resetAuditPanelPosition();
  $("audit-overlay").classList.add("open");
  applyAuditWindowState();
  wireAuditResizeHandle();
}

export function closeAudit() {
  state.currentAuditKey = null;
  commitAuditDraft(false);
  state.auditEditDraft = null;
  $("audit-overlay").classList.remove("open");
  resetAuditPanelPosition();
}

export function refreshAudit() {
  if (state.currentAuditKey && $("audit-overlay").classList.contains("open")) openAudit(state.currentAuditKey);
}

export function setAuditDraft(field, value, retailTouched = false) {
  if (!state.auditEditDraft) return;
  const number = parseFloat(value);
  state.auditEditDraft[field] = Number.isFinite(number) && number > 0 ? number : null;
  if (retailTouched) state.auditEditDraft.retailTouched = true;
  updateAuditDraftSummary();
}

export function syncAuditDraftFromInputs() {
  if (!state.auditEditDraft?.key) return;
  const wholesaleInput = $("audit-wholesale-input");
  const retailInput = $("audit-retail-input");
  const existing = state.prices[state.auditEditDraft.key] || {};
  if (wholesaleInput) {
    const wholesale = parseFloat(wholesaleInput.value);
    state.auditEditDraft.wholesaleUSD = Number.isFinite(wholesale) && wholesale > 0 ? wholesale : null;
  }
  if (retailInput) {
    const retail = parseFloat(retailInput.value);
    const normalized = Number.isFinite(retail) && retail > 0 ? retail : null;
    state.auditEditDraft.retailUSD = normalized;
    if (normalized != null && Math.abs(normalized - Number(existing.retailUSD || 0)) > 0.004) state.auditEditDraft.retailTouched = true;
  }
}

export function updateAuditDraftSummary() {
  const element = $("audit-draft-summary");
  if (!element || !state.auditEditDraft?.key) return;
  const existing = state.prices[state.auditEditDraft.key] || {};
  const currentWholesale = Number(existing.priceUSD) > 0 ? Number(existing.priceUSD) : null;
  const currentRetail = Number(existing.retailUSD) > 0 ? Number(existing.retailUSD) : null;
  const draftWholesale = Number.isFinite(Number(state.auditEditDraft.wholesaleUSD)) && Number(state.auditEditDraft.wholesaleUSD) > 0
    ? Number(state.auditEditDraft.wholesaleUSD)
    : null;
  const draftRetail = state.auditEditDraft.retailTouched && Number.isFinite(Number(state.auditEditDraft.retailUSD)) && Number(state.auditEditDraft.retailUSD) > 0
    ? Number(state.auditEditDraft.retailUSD)
    : currentRetail;
  const wholesaleDelta = (currentWholesale != null && draftWholesale != null) ? draftWholesale - currentWholesale : null;
  const retailDelta = (currentRetail != null && draftRetail != null) ? draftRetail - currentRetail : null;
  const combo = state.comboByKey[state.auditEditDraft.key];
  const decision = draftWholesale != null ? app.manualPriceDecision(combo, draftWholesale, existing.constraintSupplier || null) : null;
  const floorMessage = decision && draftWholesale != null
    ? (decision.ok
      ? '<span class="audit-floor floor-ok">passes current floor</span>'
      : decision.allowUnsafe
        ? '<span class="audit-floor floor-alert">below floor at every supplier · confirm to save</span>'
        : `<span class="audit-floor floor-alert">blocked: ${Math.round((decision.anchorMargin || 0) * 100)}% < ${Math.round(state.settings.floorMargin * 100)}% floor</span>`)
    : "";
  element.innerHTML = `
    <div><b>Wholesale</b> ${currentWholesale != null ? `was ${sym()}${currentWholesale.toFixed(2)}` : "was —"} ${draftWholesale != null ? `, now ${sym()}${draftWholesale.toFixed(2)}` : ", now —"}${wholesaleDelta != null ? ` (${wholesaleDelta >= 0 ? "+" : ""}${sym()}${Math.abs(wholesaleDelta).toFixed(2)})` : ""}</div>
    <div><b>Retail</b> ${currentRetail != null ? `was ${sym()}${currentRetail.toFixed(2)}` : "was —"} ${draftRetail != null ? `, now ${sym()}${draftRetail.toFixed(2)}` : ", now —"}${retailDelta != null ? ` (${retailDelta >= 0 ? "+" : ""}${sym()}${Math.abs(retailDelta).toFixed(2)})` : ""}</div>
    ${floorMessage}
  `;
}

export function auditDraftKeydown(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    commitAuditDraft();
    event.currentTarget.blur();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeAudit();
  }
}

export function commitAuditDraft(reopenOnChange = true) {
  if (!state.auditEditDraft?.key) return;
  const key = state.auditEditDraft.key;
  const wasOpen = $("audit-overlay").classList.contains("open");
  const before = state.prices[key] ? JSON.stringify(state.prices[key]) : "";
  syncAuditDraftFromInputs();
  updateAuditDraftSummary();
  applyAuditEdits();
  const after = state.prices[key] ? JSON.stringify(state.prices[key]) : "";
  if (reopenOnChange && wasOpen && state.currentAuditKey === key && before !== after) openAudit(key);
}

export function applyAuditEdits() {
  if (!state.auditEditDraft?.key) return;
  const combo = state.comboByKey[state.auditEditDraft.key];
  if (!combo) return;
  const existing = state.prices[state.auditEditDraft.key] || {};
  const wholesale = state.auditEditDraft.wholesaleUSD;
  const retail = state.auditEditDraft.retailUSD;
  const wholesaleChanged = Number.isFinite(Number(wholesale)) && Math.abs(Number(wholesale) - Number(existing.priceUSD || 0)) > 0.004;
  const retailChanged = state.auditEditDraft.retailTouched && Number.isFinite(Number(retail)) && Math.abs(Number(retail) - Number(existing.retailUSD || 0)) > 0.004;
  if (!wholesaleChanged && !retailChanged) return;

  if (wholesaleChanged) {
    const decision = app.manualPriceDecision(combo, Number(wholesale), existing.constraintSupplier || null);
    let constraintSupplier = decision.constraintSupplier || null;
    if (decision.needsConfirmation) {
      const accepted = decision.constraintSupplier
        ? confirm(
          `$${Number(wholesale).toFixed(2)} does not clear the ${Math.round(state.settings.floorMargin * 100)}% anchor floor.\n\n` +
          `Source only from ${decision.constraintSupplier} at ${Math.round(decision.margin * 100)}% margin?\n\n` +
          "OK = save as source-constrained · Cancel = keep existing price"
        )
        : confirm(
          `$${Number(wholesale).toFixed(2)} is below the floor at every approved supplier.\n\n` +
          "OK = save anyway as a manual below-floor override · Cancel = keep existing price"
        );
      if (!accepted) return;
    } else if (!decision.ok) {
      alert(decision.message || "Price not saved: it would not make money.");
      return;
    }
    if (!app.storeManual(
      state.auditEditDraft.key,
      Number(wholesale),
      combo,
      constraintSupplier,
      { allowUnsafe: !!decision.allowUnsafe && !decision.constraintSupplier }
    )) return;
  } else if (!state.prices[state.auditEditDraft.key]) {
    state.prices[state.auditEditDraft.key] = {};
  }

  if (retailChanged) {
    state.prices[state.auditEditDraft.key].retailUSD = Number(retail);
    state.prices[state.auditEditDraft.key].manual = true;
  }
  app.buildMatrix();
  app.updateEditingIndicator();
  toast("Audit price edits saved");
}

export function resetAuditPanelPosition() {
  const panel = document.querySelector(".audit-panel");
  if (!panel) return;
  panel.classList.remove("is-dragging");
  panel.style.position = "";
  panel.style.left = "";
  panel.style.top = "";
  panel.style.margin = "";
}

export function applyAuditWindowState() {
  const panel = document.querySelector(".audit-panel");
  const body = document.querySelector("#audit-body");
  const resize = document.querySelector(".audit-resize-handle");
  if (!panel) return;
  panel.classList.toggle("is-minimized", state.auditWindowMode === "minimized");
  panel.classList.toggle("is-maximized", state.auditWindowMode === "maximized");

  if (state.auditWindowMode === "maximized") {
    if (!state.auditWindowBounds) {
      state.auditWindowBounds = {
        position: panel.style.position || "",
        left: panel.style.left || "",
        top: panel.style.top || "",
        width: panel.style.width || "",
        maxWidth: panel.style.maxWidth || "",
        height: panel.style.height || "",
        maxHeight: panel.style.maxHeight || "",
        margin: panel.style.margin || "",
      };
    }
    panel.style.position = "fixed";
    panel.style.left = "12px";
    panel.style.top = "12px";
    panel.style.width = "calc(100vw - 24px)";
    panel.style.maxWidth = "calc(100vw - 24px)";
    panel.style.height = "calc(100dvh - 24px)";
    panel.style.maxHeight = "calc(100dvh - 24px)";
    panel.style.margin = "0";
    if (body) body.style.display = "";
    if (resize) resize.style.display = "";
    return;
  }

  if (state.auditWindowMode === "minimized") {
    if (!state.auditWindowBounds) {
      state.auditWindowBounds = {
        position: panel.style.position || "",
        left: panel.style.left || "",
        top: panel.style.top || "",
        width: panel.style.width || "",
        maxWidth: panel.style.maxWidth || "",
        height: panel.style.height || "",
        maxHeight: panel.style.maxHeight || "",
        margin: panel.style.margin || "",
      };
    }
    panel.style.position = "fixed";
    panel.style.height = "56px";
    panel.style.maxHeight = "56px";
    if (body) body.style.display = "none";
    if (resize) resize.style.display = "none";
    return;
  }

  if (state.auditWindowBounds) {
    panel.style.position = state.auditWindowBounds.position;
    panel.style.left = state.auditWindowBounds.left;
    panel.style.top = state.auditWindowBounds.top;
    panel.style.width = state.auditWindowBounds.width;
    panel.style.maxWidth = state.auditWindowBounds.maxWidth;
    panel.style.height = state.auditWindowBounds.height;
    panel.style.maxHeight = state.auditWindowBounds.maxHeight;
    panel.style.margin = state.auditWindowBounds.margin;
  } else {
    panel.style.position = "";
    panel.style.left = "";
    panel.style.top = "";
    panel.style.width = "";
    panel.style.maxWidth = "";
    panel.style.height = "";
    panel.style.maxHeight = "";
    panel.style.margin = "";
  }
  if (body) body.style.display = "";
  if (resize) resize.style.display = "";
}

export function toggleAuditMinimize() {
  state.auditWindowMode = state.auditWindowMode === "minimized" ? "normal" : "minimized";
  applyAuditWindowState();
}

export function toggleAuditMaximize() {
  state.auditWindowMode = state.auditWindowMode === "maximized" ? "normal" : "maximized";
  applyAuditWindowState();
}

export function wireAuditResizeHandle() {}

export function initAuditDrag() {
  const handle = $("audit-drag-handle");
  const panel = document.querySelector(".audit-panel");
  if (!handle || !panel) return;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    const rect = panel.getBoundingClientRect();
    panel.style.position = "fixed";
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.margin = "0";
    panel.classList.add("is-dragging");
    state.auditDrag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!state.auditDrag || state.auditDrag.pointerId !== event.pointerId) return;
    const panelRect = panel.getBoundingClientRect();
    const pad = 8;
    const maxLeft = Math.max(pad, window.innerWidth - panelRect.width - pad);
    const maxTop = Math.max(pad, window.innerHeight - panelRect.height - pad);
    const left = Math.min(Math.max(pad, event.clientX - state.auditDrag.offsetX), maxLeft);
    const top = Math.min(Math.max(pad, event.clientY - state.auditDrag.offsetY), maxTop);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  });
  const endDrag = (event) => {
    if (!state.auditDrag || state.auditDrag.pointerId !== event.pointerId) return;
    state.auditDrag = null;
    panel.classList.remove("is-dragging");
    try { handle.releasePointerCapture(event.pointerId); } catch {}
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}

export async function persistOverrides() {
  state.overrides = state.overrides;
}

export async function toggleDisableCombo(key) {
  commitAuditDraft(false);
  const index = state.overrides.combos.indexOf(key);
  if (index >= 0) state.overrides.combos.splice(index, 1);
  else state.overrides.combos.push(key);
  await persistOverrides();
  await app.rePrice();
  openAudit(key);
}

export async function toggleDisableSupplier(key, supplier) {
  commitAuditDraft(false);
  const list = state.overrides.suppliers[key] || (state.overrides.suppliers[key] = []);
  const index = list.indexOf(supplier);
  if (index >= 0) list.splice(index, 1);
  else list.push(supplier);
  if (!list.length) delete state.overrides.suppliers[key];
  await persistOverrides();
  await app.rePrice();
  openAudit(key);
}

Object.assign(app, {
  applyAuditEdits,
  auditDraftKeydown,
  closeAudit,
  commitAuditDraft,
  initAuditDrag,
  openAudit,
  refreshAudit,
  setAuditDraft,
  toggleAuditMaximize,
  toggleAuditMinimize,
  toggleDisableCombo,
  toggleDisableSupplier,
});
