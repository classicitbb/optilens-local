import { ADEPT_CANDIDATE_RE, app, $, categoryClassLabel, encodeTypeKeys, escHtml, MATERIALS, state, SUP_ABBR, toast } from "./state.js";
import { fetchClassificationPreview } from "./api.js";

export function chipOptions(field, value, allowAuto = true) {
  const source = field === "tier" ? state.classifyTiers : field === "treatment" ? state.classifyGroups : state.classifyMaterials;
  const options = [];
  if (allowAuto && field !== "tier") options.push('<option value="__auto">auto</option>');
  options.push('<option value="">missing</option>');
  source.forEach((option) => {
    options.push(`<option value="${escHtml(option)}" ${option === value ? "selected" : ""}>${escHtml(field === "tier" ? categoryClassLabel(option) : option)}</option>`);
  });
  return options.join("");
}

export function classificationChip(kind, label, detail, typeKeys, field, missing) {
  const keys = (typeKeys || []).filter(Boolean);
  const encoded = encodeTypeKeys(keys);
  const value = missing ? "" : (field === "tier" ? detail : label);
  const select = keys.length
    ? `<select class="class-chip-select" data-action="classify-encoded-types" data-encoded="${encoded}" data-field="${field}" title="Set ${escHtml(kind.toLowerCase())} classification">${chipOptions(field, value, true)}</select>`
    : `<span>${escHtml(label)}</span>`;
  const remove = !missing && keys.length
    ? `<button type="button" data-action="unclassify-types" data-encoded="${encodeTypeKeys(keys)}" data-field="${field}" title="Remove ${escHtml(kind.toLowerCase())} classification">\u00d7</button>`
    : "";
  return `<span class="class-chip class-${escHtml(field)}${missing ? " class-missing" : ""}">
    <small>${escHtml(kind)}</small>${select}${detail && field !== "tier" ? `<span class="muted">${escHtml(detail)}</span>` : ""}${remove}
  </span>`;
}

export function typeClassificationChips(type) {
  const keys = [type.typeKey];
  const chips = [];
  if (type.treatmentMissing) {
    chips.push(classificationChip("Group", "Missing classification", "", keys, "treatment", true));
  } else {
    const groups = type.treatmentOverride ? [type.treatmentOverride] : (type.groups || []);
    const label = groups.length ? groups.join(" / ") : "Missing classification";
    chips.push(classificationChip("Group", label, type.treatmentOverridden ? "manual" : "auto", keys, "treatment", !groups.length));
  }
  if (type.tierMissing || !type.tier) {
    chips.push(classificationChip("Category", "Missing classification", "", keys, "tier", true));
  } else {
    chips.push(classificationChip("Category", categoryClassLabel(type.tier), type.tier, keys, "tier", false));
  }
  if (type.materialMissing) {
    chips.push(classificationChip("Material", "Missing classification", "", keys, "material", true));
  } else {
    const materials = type.materialOverride ? [type.materialOverride] : (type.materials || []);
    const label = materials.length ? materials.join(" / ") : "Missing classification";
    chips.push(classificationChip("Material", label, type.materialOverridden ? "manual" : "auto", keys, "material", !materials.length));
  }
  return chips.join("");
}

export function lineClassificationChips(combo) {
  const types = Array.isArray(combo.types) ? combo.types : [];
  const keys = types.map((type) => type.typeKey).filter(Boolean);
  const typeDetail = keys.length > 1 ? `${keys.length} catalog types` : "";
  return [
    classificationChip("Group", combo.treatment || "Missing classification", typeDetail, keys, "treatment", !combo.treatment),
    classificationChip("Category", categoryClassLabel(combo.tier) || "Missing classification", combo.tier || typeDetail, keys, "tier", !combo.tier),
    classificationChip("Material", combo.material || "Missing classification", typeDetail, keys, "material", !combo.material),
  ].join("");
}

export async function loadClassify() {
  try {
    await refreshClassifiedCatalog({ render: true, reprice: false });
  } catch (error) {
    $("classify-body").innerHTML = '<div class="pl-empty-state">Catalog types unavailable. Pull the catalog first, then reopen.</div>';
    $("classify-count").textContent = "";
  }
}

export async function refreshClassifiedCatalog({ render = true, reprice = false, build = true } = {}) {
  const data = await fetchClassificationPreview(state.classOverrides);
  if (data && data.error) throw new Error(data.error);
  state.classifyTypes = data.types || [];
  state.classifyTiers = data.tiers || [];
  state.classifyGroups = data.groups || [];
  state.classifyMaterials = data.materials || MATERIALS;
  if (Array.isArray(data.combos)) {
    state.combos = data.combos;
    state.comboByKey = Object.fromEntries(state.combos.map((combo) => [combo.key, combo]));
  }
  if (reprice && Object.keys(state.prices).length) await app.autoPrice();
  else if (build) app.buildMatrix();
  if (render) renderClassify();
  return data;
}

export function renderClassify() {
  if (!$("classify-body")) return;
  const unclassifiedOnly = $("classify-unonly")?.checked;
  const adeptOnly = $("classify-adeptonly")?.checked;
  const unclassifiedCount = state.classifyTypes.filter((type) => !type.classified).length;
  const adeptCount = state.classifyTypes.filter(isAdeptCandidate).length;
  $("classify-count").textContent = `· ${state.classifyTypes.length} types · ${unclassifiedCount} unclassified · ${adeptCount} ADEPT candidates`;
  let list = unclassifiedOnly ? state.classifyTypes.filter((type) => !type.classified) : state.classifyTypes;
  if (adeptOnly) list = list.filter(isAdeptCandidate);
  if (!list.length) {
    $("classify-body").innerHTML = `<div class="pl-empty-state">${unclassifiedOnly || adeptOnly ? "No types match this filter." : "No catalog types loaded."}</div>`;
    return;
  }
  $("classify-body").innerHTML = list.map((type) => {
    const suppliers = type.suppliers.map((supplier) => SUP_ABBR[supplier] || supplier).join(", ");
    return `<div class="cls-row ${type.classified ? "" : "cls-unclassified"}">
      <div class="cls-main">
        <div class="cls-type">${escHtml(type.mftype)} · <b>${escHtml(type.lenstype)}</b> ${type.tierOverridden && !type.tierMissing ? '<span class="tagpill tagpill-ov">manual</span>' : ""} ${type.materialOverridden && !type.materialMissing ? '<span class="tagpill tagpill-ov">material</span>' : ""}</div>
        <div class="cls-sub muted">${type.rows} rows · ${escHtml(suppliers)}</div>
        <div class="cls-sample muted">${escHtml(type.samples[0] || "")}</div>
      </div>
      <div class="cls-classifications">${typeClassificationChips(type)}</div>
    </div>`;
  }).join("");
}

export function isAdeptCandidate(type) {
  return /adept/i.test(type.tier || "")
    || ADEPT_CANDIDATE_RE.test(`${type.mftype || ""} ${type.lenstype || ""} ${(type.samples || []).join(" ")}`);
}

export async function unclassifyTypes(encodedTypeKeys, field) {
  let typeKeys = [];
  try { typeKeys = JSON.parse(decodeURIComponent(encodedTypeKeys)); } catch { typeKeys = []; }
  if (!typeKeys.length) return toast("No catalog types found for that line");
  return classifyTypeKeys(typeKeys, field, "");
}

export async function classifyEncodedTypes(encodedTypeKeys, field, value) {
  let typeKeys = [];
  try { typeKeys = JSON.parse(decodeURIComponent(encodedTypeKeys)); } catch { typeKeys = []; }
  if (!typeKeys.length) return toast("No catalog types found for that line");
  return classifyTypeKeys(typeKeys, field, value);
}

export async function classifyTypeKeys(typeKeys, field, value) {
  try {
    const bucket = `${field}ByType`;
    if (!state.classOverrides[bucket]) state.classOverrides[bucket] = {};
    typeKeys.forEach((typeKey) => {
      if (value === "__auto") delete state.classOverrides[bucket][typeKey];
      else state.classOverrides[bucket][typeKey] = value || null;
    });
    const data = await refreshClassifiedCatalog({ render: false, reprice: true });
    state.classifyTypes = data.types || state.classifyTypes;
    renderClassify();
    if ($("view-sourcing") && $("view-sourcing").style.display !== "none") app.buildSourcingView();
    toast(`Reclassified · ${(data.combos || []).length} priced combos`);
  } catch (error) {
    toast(`Classify failed: ${error.message}`);
  }
}

Object.assign(app, {
  buildClassificationChips: lineClassificationChips,
  classifyEncodedTypes,
  loadClassify,
  refreshClassifiedCatalog,
  renderClassify,
  unclassifyTypes,
});
