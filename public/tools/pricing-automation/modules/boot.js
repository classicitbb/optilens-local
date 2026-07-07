import { $, app, escapeHtml, setCombos, setCustomers, setSources, state, toast, VIEW_TITLES, VIEWS } from "./state.js";
import { fetchInitialPricingData } from "./api.js";
import "./pricing-engine-client.js";
import "./classification-view.js";
import "./builder-view.js";
import "./saved-lists.js";
import "./audit-view.js";
import "./sources-view.js";
import "./sourcing-view.js";
import "./connectors-view.js";

function setBuilderActionsVisible(visible) {
  document.querySelectorAll(".pl-builder-action").forEach((element) => {
    element.style.display = visible ? "inline-flex" : "none";
  });
}

export function showView(view) {
  VIEWS.forEach((name) => {
    const panel = $(`view-${name}`);
    if (panel) panel.style.display = name === view ? "" : "none";
    const nav = $(`nav-${name}`);
    if (nav) nav.classList.toggle("active", name === view);
  });
  $("topbar-title").textContent = VIEW_TITLES[view] || view;
  setBuilderActionsVisible(view !== "saved");
  if (view === "saved") app.loadSavedList();
  if (view === "sourcing") app.buildSourcingView();
  if (view === "sources") app.buildSourcesView();
  if (view === "connectors") app.buildConnectorsView();
}

async function runAction(target) {
  const action = target.dataset.action;
  if (!action) return;

  if (target.dataset.locked === "1") {
    toast(target.title || "Action blocked until below-floor prices are resolved.");
    app.revealBlockedPriceEntry?.();
    return;
  }

  switch (action) {
    case "show-view":
      showView(target.dataset.view);
      break;
    case "collapse-all":
      app.collapseAll(target.dataset.collapsed === "1");
      break;
    case "auto-price":
      await app.autoPrice();
      break;
    case "reset-prices":
      app.resetPrices();
      break;
    case "preview-pricelist":
      app.showPreview(false);
      break;
    case "export-pricelist":
      app.showPreview(true);
      break;
    case "new-blank-pricelist":
      app.newBlankPricelist();
      break;
    case "save-pricelist":
      await app.savePricelist();
      break;
    case "saveas-pricelist":
      await app.saveAsNewPricelist();
      break;
    case "set-currency":
      app.setCurrency(target.dataset.currency);
      break;
    case "set-mode":
      app.setMode(target.dataset.mode);
      break;
    case "toggle-collapse":
      app.toggleCollapse(target.dataset.treatment);
      break;
    case "open-audit":
      app.openAudit(target.dataset.key);
      break;
    case "close-preview":
      app.closePreview();
      break;
    case "print-preview":
      window.print();
      break;
    case "close-source-rows":
      app.closeSourceRows();
      break;
    case "close-audit":
      app.closeAudit();
      break;
    case "audit-minimize":
      app.toggleAuditMinimize();
      break;
    case "audit-maximize":
      app.toggleAuditMaximize();
      break;
    case "toggle-disable-combo":
      await app.toggleDisableCombo(target.dataset.key);
      break;
    case "toggle-disable-supplier":
      await app.toggleDisableSupplier(target.dataset.key, target.dataset.supplier);
      break;
    case "open-pricelist":
      await app.loadPricelist(target.dataset.id);
      break;
    case "open-pricelist-copy":
      await app.loadPricelistCopy(target.dataset.id);
      break;
    case "delete-pricelist":
      await app.deletePricelist(target.dataset.id);
      break;
    case "toggle-group-visibility":
      app.toggleGroupVisibility(target.dataset.name);
      break;
    case "supplier-move":
      await app.supplierMoveAndReprice(Number(target.dataset.index), Number(target.dataset.dir));
      break;
    case "supplier-exclude":
      await app.supplierToggleExcludeAndReprice(target.dataset.supplier);
      break;
    case "sort-sourcing":
      app.setSourcingSort(target.dataset.field);
      break;
    case "open-source-rows":
      await app.openSourceRows(target.dataset.supplier);
      break;
    case "toggle-source-exclude":
      await app.toggleSourceExclude(target.dataset.supplier);
      break;
    case "set-source-mode":
      await app.setSourceMode(target.dataset.mode);
      break;
    case "unclassify-types":
      await app.unclassifyTypes(target.dataset.encoded, target.dataset.field);
      break;
    case "conn-init":
      await app.connInit();
      break;
    case "conn-unlock":
      await app.connUnlock();
      break;
    case "conn-lock":
      app.connLock();
      break;
    case "cv-save":
      await app.cvSave();
      break;
    case "cv-reveal":
      await app.cvReveal();
      break;
    case "cv-test":
      await app.cvTest();
      break;
    case "cv-pull":
      await app.cvPull();
      break;
    case "conn-save":
      await app.connSave();
      break;
    case "conn-reveal":
      await app.connReveal();
      break;
    case "conn-pull":
      await app.connPull();
      break;
    case "conn-push-dry-run":
      await app.connPushDryRun();
      break;
    default:
      break;
  }
}

function wireEvents() {
  document.addEventListener("click", (event) => {
    const actionTarget = event.target.closest("[data-action]");
    if (!actionTarget) {
      if (event.target === $("preview-overlay")) app.closePreview();
      if (event.target === $("source-rows-overlay")) app.closeSourceRows();
      if (event.target === $("audit-overlay")) app.closeAudit();
      return;
    }
    event.preventDefault();
    runAction(actionTarget).catch((error) => toast(error.message || "Action failed"));
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target.matches(".price-input")) {
      app.onCellEdit(target.dataset.key, target.value).catch((error) => toast(error.message || "Price update failed"));
      return;
    }
    if (target.matches(".class-chip-select")) {
      app.classifyEncodedTypes(target.dataset.encoded, target.dataset.field, target.value).catch((error) => toast(error.message || "Classify failed"));
      return;
    }
    if (target.id === "customer-select") {
      app.onCustomerChange();
      return;
    }
    if (["set-floor", "set-markup", "set-fr-tog", "set-fr-vrx", "set-fr-optex", "set-fr-sky", "set-duty", "set-levy", "set-clear", "set-broker"].includes(target.id)) {
      app.autoPrice().catch((error) => toast(error.message || "Auto-price failed"));
      return;
    }
    if (target.id === "classify-unonly" || target.id === "classify-adeptonly") {
      app.renderClassify();
    }
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (target.id === "audit-wholesale-input" || target.id === "audit-retail-input") {
      app.setAuditDraft(target.dataset.auditField, target.value, target.dataset.auditField === "retailUSD");
    }
  });

  document.addEventListener("focusout", (event) => {
    const target = event.target;
    if (target.id === "audit-wholesale-input" || target.id === "audit-retail-input") {
      app.commitAuditDraft();
    }
  });

  document.addEventListener("focusin", (event) => {
    const target = event.target;
    if (target.matches(".price-input")) {
      setTimeout(() => target.select(), 0);
    }
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target.id === "audit-wholesale-input" || target.id === "audit-retail-input") {
      app.auditDraftKeydown(event);
      return;
    }
    if (event.key === "Enter" && target.id === "conn-pass1") {
      event.preventDefault();
      app.connInit().catch((error) => toast(error.message || "Connector setup failed"));
      return;
    }
    if (event.key === "Enter" && target.id === "conn-pass") {
      event.preventDefault();
      app.connUnlock().catch((error) => toast(error.message || "Unlock failed"));
    }
  });
}

export async function boot() {
  try {
    const data = await fetchInitialPricingData();
    setCombos(data.combos);
    setCustomers(data.customers);
    setSources(data.sources);
    state.overrides = { combos: [], suppliers: {} };
    state.classOverrides = { tierByType: {}, treatmentByType: {}, materialByType: {} };
    state.loadError = null;
    app.populateCustomers();
    app.buildSupplierPanel();
    app.buildGroupPanel();
    app.syncSettingsInputs();
    app.buildMatrix();
    app.updateEditingIndicator();
    showView("saved");
  } catch (error) {
    state.loadError = error;
    const message = error.status === 401 || error.status === 403
      ? "Sign in with a pricing account to load the lens grid."
      : (error.message || "Could not load the lens grid.");
    $("matrix-container").innerHTML = `<div class="pl-empty-state">${escapeHtml(message)}</div>`;
    toast(message);
    showView("saved");
  }
}

Object.assign(app, { showView });

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    wireEvents();
    app.initAuditDrag();
    boot();
  }, { once: true });
} else {
  wireEvents();
  app.initAuditDrag();
  boot();
}
