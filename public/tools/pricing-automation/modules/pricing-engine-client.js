import { app, $, FREIGHT_INPUTS, getKey, normalizeOverrides, state, SUP_ABBR, sym, toDisplay, toUSD, toast } from "./state.js";
import { requestOverride, requestPriceRows } from "./api.js";

export function syncSettingsInputs() {
  const settings = state.settings;
  $("set-floor").value = Math.round(settings.floorMargin * 100);
  $("set-markup").value = settings.markup.value;
  const costModel = settings.costModel;
  if (!costModel) return;
  Object.entries(FREIGHT_INPUTS).forEach(([id, supplier]) => {
    const value = costModel.freightPct[supplier] != null ? costModel.freightPct[supplier] : costModel.freightPct.default;
    if ($(id)) $(id).value = Math.round(value * 100);
  });
  if ($("set-duty")) $("set-duty").value = Math.round((costModel.dutyPct || 0) * 100);
  if ($("set-levy")) $("set-levy").value = Math.round((costModel.leviesPct || 0) * 100);
  if ($("set-clear")) $("set-clear").value = Math.round((costModel.clearancePct || 0) * 100);
  if ($("set-broker")) $("set-broker").value = (costModel.brokeragePerPair || 0).toFixed(2);
}

export function readSettings() {
  const floor = parseFloat($("set-floor").value);
  if (!Number.isNaN(floor) && floor > 0 && floor < 90) {
    state.settings.floorMargin = floor / 100;
    state.settings.minMargin = floor / 100;
  }
  const markup = parseFloat($("set-markup").value);
  if (!Number.isNaN(markup) && markup >= 0) state.settings.markup = { type: "pct", value: markup };
  const costModel = state.settings.costModel || (state.settings.costModel = {
    freightPct: { default: 0.12 },
    dutyPct: 0,
    leviesPct: 0.01,
    clearancePct: 0.03,
    brokeragePerPair: 0.5,
  });
  Object.entries(FREIGHT_INPUTS).forEach(([id, supplier]) => {
    const value = parseFloat($(id)?.value);
    if (!Number.isNaN(value) && value >= 0) costModel.freightPct[supplier] = value / 100;
  });
  const readScaled = (id, scale) => {
    const value = parseFloat($(id)?.value);
    return Number.isNaN(value) ? null : value / scale;
  };
  const duty = readScaled("set-duty", 100);
  if (duty != null) costModel.dutyPct = duty;
  const levy = readScaled("set-levy", 100);
  if (levy != null) costModel.leviesPct = levy;
  const clearance = readScaled("set-clear", 100);
  if (clearance != null) costModel.clearancePct = clearance;
  const brokerage = readScaled("set-broker", 1);
  if (brokerage != null) costModel.brokeragePerPair = brokerage;
}

export function setCurrency(currency) {
  state.currency = currency;
  $("curr-usd").classList.toggle("active", currency === "USD");
  $("curr-bbd").classList.toggle("active", currency === "BBD");
  $("curr-eur")?.classList.toggle("active", currency === "EUR");
  app.buildMatrix();
}

export function setMode(mode) {
  state.priceMode = mode;
  $("mode-ws").classList.toggle("active", mode === "wholesale");
  $("mode-rt").classList.toggle("active", mode === "retail");
  app.buildMatrix();
}

export async function autoPrice() {
  readSettings();
  state.overrides = normalizeOverrides(state.overrides);
  if (app.refreshClassifiedCatalog) {
    await app.refreshClassifiedCatalog({ render: false, reprice: false, build: false });
  }
  const response = await requestPriceRows(state.settings);
  let filled = 0;
  response.rows.forEach((row) => {
    if (!row.available) return;
    state.prices[row.key] = {
      priceUSD: row.priceUSD,
      retailUSD: row.retailUSD,
      anchorSupplier: row.anchorSupplier,
      anchorCost: row.anchorCost,
      floorMargin: row.floorMargin,
      preferredSupplier: row.preferredSupplier,
      preferredCost: row.preferredCost,
      preferredMargin: row.preferredMargin,
      safe: row.safe,
      smoothed: row.smoothed || false,
    };
    filled += 1;
  });
  app.buildMatrix();
  toast(`Priced ${filled} cells · anchor +${Math.round(state.settings.floorMargin * 100)}% floor`);
}

export function resetPrices() {
  if (!confirm("Clear all prices in this pricelist?")) return;
  state.prices = {};
  app.buildMatrix();
  toast("Prices cleared");
}

export async function onCellEdit(key, rawValue) {
  const number = parseFloat(rawValue);
  if (Number.isNaN(number) || number <= 0) {
    delete state.prices[key];
    app.buildMatrix();
    return;
  }
  const enteredUSD = toUSD(number);
  if (state.priceMode === "retail") {
    const price = state.prices[key] || {};
    price.retailUSD = enteredUSD;
    state.prices[key] = price;
    app.buildMatrix();
    return;
  }
  if (app.refreshClassifiedCatalog) {
    await app.refreshClassifiedCatalog({ render: false, reprice: false, build: false });
  }
  const evaluation = await requestOverride(key, enteredUSD, state.settings);
  const combo = state.comboByKey[key];
  if (evaluation.ok) {
    storeManual(key, enteredUSD, combo, null);
    app.buildMatrix();
    return;
  }
  if (evaluation.needsConfirmation) {
    const displayValue = `${sym()}${toDisplay(enteredUSD).toFixed(2)}`;
    let accepted = false;
    let toastMessage = "";
    if (evaluation.constraint) {
      accepted = confirm(
        `${displayValue} doesn't clear your ${Math.round(state.settings.minMargin * 100)}% floor against the most expensive lab ` +
        `(anchor margin ${Math.round(evaluation.anchorMargin * 100)}%).\n\n` +
        `Source only from ${evaluation.constraint.supplier} (or cheaper) at ${Math.round(evaluation.constraint.margin * 100)}% margin?\n\n` +
        "OK = accept as source-constrained · Cancel = revert"
      );
      toastMessage = `Line constrained to ${SUP_ABBR[evaluation.constraint.supplier] || evaluation.constraint.supplier}`;
    } else if (evaluation.allowUnsafe) {
      accepted = confirm(
        `${displayValue} is below the floor at every approved supplier.\n\n` +
        "OK = save anyway as a manual below-floor override · Cancel = revert"
      );
      toastMessage = "Saved as a manual below-floor override";
    }
    if (accepted && storeManual(key, enteredUSD, combo, evaluation.constraint?.supplier || null, { allowUnsafe: !!evaluation.allowUnsafe && !evaluation.constraint })) {
      toast(toastMessage);
    }
    app.buildMatrix();
    return;
  }
  alert(evaluation.message || "That price is not allowed.");
  app.buildMatrix();
}

export function manualPriceDecision(combo, enteredUSD, existingConstraint = null) {
  const disabledSuppliers = state.overrides.suppliers[combo?.key] || [];
  const suppliers = Object.entries(combo ? (combo.suppliers || {}) : {})
    .filter(([supplier]) => !state.settings.excluded.includes(supplier))
    .filter(([supplier]) => !disabledSuppliers.includes(supplier))
    .map(([supplier, fob]) => ({ supplier, fob: Number(fob), landed: landedCalc(Number(fob), supplier).landed }))
    .filter((entry) => entry.landed > 0 && Number.isFinite(entry.landed));
  if (!suppliers.length || !(enteredUSD > 0)) return { ok: false, message: "No available supplier remains for that price." };
  const marginFor = (entry) => (enteredUSD - entry.landed) / enteredUSD;
  const anchor = suppliers.reduce((current, candidate) => (candidate.landed > current.landed ? candidate : current));
  const anchorMargin = marginFor(anchor);
  if (anchorMargin >= state.settings.floorMargin - 1e-6) return { ok: true, constraintSupplier: null, allowUnsafe: false };
  if (existingConstraint) {
    const existing = suppliers.find((entry) => entry.supplier === existingConstraint);
    if (existing && marginFor(existing) >= state.settings.minMargin - 1e-6) {
      return { ok: true, constraintSupplier: existingConstraint, allowUnsafe: false };
    }
  }
  const acceptable = suppliers
    .filter((entry) => marginFor(entry) >= state.settings.minMargin - 1e-6)
    .sort((left, right) => left.landed - right.landed);
  if (acceptable.length) {
    return {
      ok: false,
      needsConfirmation: true,
      constraintSupplier: acceptable[0].supplier,
      margin: marginFor(acceptable[0]),
      anchorMargin,
      allowUnsafe: false,
    };
  }
  return {
    ok: false,
    needsConfirmation: true,
    allowUnsafe: true,
    anchorMargin,
    message: `That price is below the ${Math.round(state.settings.minMargin * 100)}% floor at every available supplier. Save anyway as a manual below-floor override?`,
  };
}

export function storeManual(key, enteredUSD, combo, constraintSupplier, options = {}) {
  const allowUnsafe = !!options.allowUnsafe;
  const disabledSuppliers = state.overrides.suppliers[key] || [];
  const suppliers = Object.entries(combo ? (combo.suppliers || {}) : {})
    .filter(([supplier]) => !state.settings.excluded.includes(supplier))
    .filter(([supplier]) => !disabledSuppliers.includes(supplier))
    .map(([supplier, fob]) => ({ supplier, fob: Number(fob), landed: landedCalc(Number(fob), supplier).landed }))
    .filter((entry) => entry.landed > 0 && Number.isFinite(entry.landed));

  const anchorEntry = suppliers.length
    ? suppliers.reduce((current, candidate) => (candidate.landed > current.landed ? candidate : current))
    : null;
  const anchorLanded = anchorEntry ? anchorEntry.landed : 0;
  const floorMargin = (anchorLanded > 0 && enteredUSD > 0) ? (enteredUSD - anchorLanded) / enteredUSD : 0;

  let preferredSupplier = null;
  for (const supplier of state.settings.priority) {
    if (combo && combo.suppliers[supplier] != null && !state.settings.excluded.includes(supplier) && !disabledSuppliers.includes(supplier)) {
      preferredSupplier = supplier;
      break;
    }
  }
  const preferredEntry = preferredSupplier
    ? (suppliers.find((entry) => entry.supplier === preferredSupplier) || anchorEntry)
    : anchorEntry;
  const preferredLanded = preferredEntry ? preferredEntry.landed : anchorLanded;
  const preferredMargin = (preferredLanded > 0 && enteredUSD > 0) ? (enteredUSD - preferredLanded) / enteredUSD : 0;

  const effectiveSupplier = constraintSupplier || preferredSupplier;
  const effectiveEntry = constraintSupplier
    ? (suppliers.find((entry) => entry.supplier === constraintSupplier) || null)
    : preferredEntry;
  const effectiveLanded = effectiveEntry ? effectiveEntry.landed : preferredLanded;
  const effectiveMargin = (effectiveLanded > 0 && enteredUSD > 0) ? (enteredUSD - effectiveLanded) / enteredUSD : preferredMargin;

  const allowedMargin = constraintSupplier ? effectiveMargin : floorMargin;
  const requiredMargin = constraintSupplier ? state.settings.minMargin : state.settings.floorMargin;
  if (!allowUnsafe && !(allowedMargin >= requiredMargin - 1e-6)) {
    alert(`Price not saved: it does not clear the ${Math.round(requiredMargin * 100)}% margin floor.`);
    return false;
  }

  state.prices[key] = {
    priceUSD: enteredUSD,
    retailUSD: Math.round(enteredUSD * (1 + state.settings.markup.value / 100) * 100) / 100,
    anchorSupplier: anchorEntry ? anchorEntry.supplier : (combo ? combo.anchorSupplier : null),
    anchorCost: anchorLanded,
    floorMargin,
    preferredSupplier: effectiveSupplier,
    preferredCost: effectiveLanded,
    preferredMargin: effectiveMargin,
    safe: allowUnsafe ? false : allowedMargin >= requiredMargin - 1e-6,
    manual: true,
    constraintSupplier: constraintSupplier || null,
  };
  return true;
}

export function landedCalc(fob, supplier) {
  const costModel = state.settings.costModel;
  if (!costModel) return { freight: 0, cif: fob, uplift: 0, landed: fob };
  const freight = (costModel.freightPct[supplier] != null ? costModel.freightPct[supplier] : costModel.freightPct.default) || 0;
  const cif = fob * (1 + freight);
  const uplift = (costModel.dutyPct || 0) + (costModel.leviesPct || 0) + (costModel.clearancePct || 0);
  const landed = Math.round((cif * (1 + uplift) + (costModel.brokeragePerPair || 0)) * 100) / 100;
  return { freight, cif: Math.round(cif * 100) / 100, uplift, landed };
}

export function rePrice() {
  return Object.keys(state.prices).length ? autoPrice() : app.buildMatrix();
}

Object.assign(app, {
  autoPrice,
  landedCalc,
  manualPriceDecision,
  onCellEdit,
  rePrice,
  resetPrices,
  setCurrency,
  setMode,
  storeManual,
  syncSettingsInputs,
});
