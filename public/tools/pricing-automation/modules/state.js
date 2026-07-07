export const app = {};

export const BBD_RATE = 2.0;

export const MATERIALS = ["1.50", "1.56", "POLY", "TRIVEX", "1.60", "1.67", "1.74"];

export const TIER_DISPLAY = {
  "Progressive - Best": { grade: "Best", name: "Endless Steady" },
  "Progressive - Better": { grade: "Better", name: "Essential Steady" },
  "Progressive - Good": { grade: "Good", name: "Classic PAL" },
  "Progressive - Adept": { grade: "Adept / Conventional", name: "Conventional PAL" },
  "Specific Use - Office": { grade: "Office", name: "Endless Office" },
  "Specific Use - Sport": { grade: "Sport", name: "Endless Sport" },
  "Anti-Fatigue": { grade: "Anti-Fatigue", name: "Endless Anti-Fatigue" },
  "Single Vision - HD": { grade: "Single Vision", name: "Endless SV" },
  "Single Vision - Regular": { grade: "Single Vision", name: "Conventional Single Vision" },
  "Specific Use - Bifocal": { grade: "Bifocal", name: "Endless BF" },
  "Specific Use - Adept Bifocal": { grade: "Adept Bifocal / Conventional", name: "Conventional BF/TF" },
};

export const TIER_ORDER = [
  "Progressive - Best",
  "Progressive - Better",
  "Progressive - Good",
  "Progressive - Adept",
  "Specific Use - Office",
  "Specific Use - Sport",
  "Anti-Fatigue",
  "Single Vision - HD",
  "Single Vision - Regular",
  "Specific Use - Bifocal",
  "Specific Use - Adept Bifocal",
];

export const ADEPT_CANDIDATE_RE = /\b(physio|ovation|shoreview|ideal|qlds|omnilux|image|accolade|small fit|brilliance|comfort|precise|novel|flat top|round|executive|trifocal|c25|c28|d45|nupolar ft28)\b/i;

export const TREATMENT_ORDER = [
  "Clear",
  "UV420",
  "Photochromic - Gray",
  "Photochromic - Brown",
  "Trans Gen S\u2122",
  "Trans\u00ae XtrActive\u00ae New Gen",
  "Trans\u00ae XtrActive\u00ae Polarized",
  "Polarized",
];

export const SUPPLIER_COLORS = {
  "TOG Rx Lab": "#1A8A9C",
  "Vision Rx Lab": "#2563eb",
  "Optex Laboratories": "#C89130",
  SkyLab: "#9333ea",
  Essilor: "#16a34a",
  "Essilor Lab": "#15803d",
  Hoya: "#dc2626",
  "East Optical": "#ea580c",
  Younger: "#ca8a04",
  "Shore Lens": "#0891b2",
  "Lab-Tech": "#7c3aed",
  "Quest Optical": "#db2777",
  "IOT America": "#475569",
  "Youli Optics": "#65a30d",
  "TOG USA": "#0d9488",
};

export const SUP_ABBR = {
  "TOG Rx Lab": "TOG",
  "Vision Rx Lab": "VisionRx",
  "Optex Laboratories": "Optex",
  SkyLab: "SkyLab",
  Essilor: "Essilor",
  "Essilor Lab": "EssLab",
  Hoya: "Hoya",
  "East Optical": "East",
  Younger: "Younger",
  "Shore Lens": "Shore",
  "Lab-Tech": "LabTech",
  "Quest Optical": "Quest",
  "IOT America": "IOT",
  "Youli Optics": "Youli",
  "TOG USA": "TOG-US",
};

export const DEFAULT_PRIORITY = [
  "TOG Rx Lab",
  "Vision Rx Lab",
  "Optex Laboratories",
  "SkyLab",
  "Essilor",
  "Essilor Lab",
  "Hoya",
  "East Optical",
  "Younger",
  "Shore Lens",
  "Lab-Tech",
  "Quest Optical",
  "IOT America",
  "Youli Optics",
  "TOG USA",
];

export const ADDONS = [
  { label: "Super AR+ (Blue Hue)", price: 25 },
  { label: "Standard AR (Green Hue)", price: 20 },
  { label: "Solid Tint", price: 5 },
  { label: "Gradient Tint", price: 12 },
  { label: "Edging (per lens)", price: 10 },
  { label: "Hi-Power Sphere (over \u00b18.0)", price: 10 },
  { label: "Hi-Power Cyl (over -3.0)", price: 15 },
  { label: "Prism (per 4\u00b0 per lens)", price: 5 },
];

export const FREIGHT_INPUTS = {
  "set-fr-tog": "TOG Rx Lab",
  "set-fr-vrx": "Vision Rx Lab",
  "set-fr-optex": "Optex Laboratories",
  "set-fr-sky": "SkyLab",
};

export const VIEWS = ["builder", "saved", "sourcing", "sources", "connectors"];

export const VIEW_TITLES = {
  builder: "Build Pricelist",
  saved: "Saved Pricelists",
  sourcing: "Sourcing Review",
  sources: "Data Sources",
  connectors: "Connectors",
};

export const state = {
  combos: [],
  comboByKey: {},
  customers: [],
  prices: {},
  currency: "USD",
  priceMode: "wholesale",
  currentCustomer: null,
  currentPricelistId: null,
  currentPricelistName: null,
  currentAuditKey: null,
  auditWindowMode: "normal",
  auditWindowBounds: null,
  auditResizeState: null,
  loadError: null,
  overrides: createDefaultOverrides(),
  classOverrides: createDefaultClassOverrides(),
  sources: { sources: [], live: [] },
  collapsed: {},
  auditDrag: null,
  auditEditDraft: null,
  blockedPriceKey: null,
  sourcingSort: { field: "flag", dir: "desc" },
  settings: createDefaultSettings(),
  classifyTypes: [],
  classifyTiers: [],
  classifyGroups: [],
  classifyMaterials: [],
  connToken: null,
  connStatus: null,
};

export const $ = (id) => document.getElementById(id);
export const sym = () => (state.currency === "BBD" ? "B$" : "$");
export const toDisplay = (usd) => (state.currency === "BBD" ? usd * BBD_RATE : usd);
export const toUSD = (value) => (state.currency === "BBD" ? value / BBD_RATE : value);
export const getKey = (treatment, tier, material) => `${treatment}||${tier}||${material}`;
export const getCombo = (treatment, tier, material) => state.comboByKey[getKey(treatment, tier, material)];
export const jsArg = (value) => String(value == null ? "" : value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createDefaultSettings() {
  return {
    floorMargin: 0.15,
    minMargin: 0.15,
    rounding: 0.5,
    wholesaleFloor: 10,
    priority: DEFAULT_PRIORITY.slice(),
    excluded: [],
    markup: { type: "pct", value: 100 },
    smooth: true,
    costModel: {
      freightPct: {
        default: 0.12,
        "TOG Rx Lab": 0.12,
        "Vision Rx Lab": 0.12,
        "Optex Laboratories": 0.1,
        SkyLab: 0.1,
      },
      dutyPct: 0,
      leviesPct: 0.01,
      clearancePct: 0.03,
      brokeragePerPair: 0.5,
    },
    hiddenGroups: [],
  };
}

export function createDefaultOverrides() {
  return { combos: [], suppliers: {} };
}

export function createDefaultClassOverrides() {
  return { tierByType: {}, treatmentByType: {}, materialByType: {} };
}

export function normalizeClassOverrides(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    tierByType: { ...(input.tierByType || {}) },
    treatmentByType: { ...(input.treatmentByType || {}) },
    materialByType: { ...(input.materialByType || {}) },
  };
}

export function normalizeOverrides(value) {
  const input = value && typeof value === "object" ? value : {};
  const suppliers = {};
  Object.entries(input.suppliers || {}).forEach(([key, list]) => {
    if (!Array.isArray(list)) return;
    const clean = Array.from(new Set(list.filter(Boolean).map(String)));
    if (clean.length) suppliers[key] = clean;
  });
  return {
    combos: Array.from(new Set(Array.isArray(input.combos) ? input.combos.filter(Boolean).map(String) : [])),
    suppliers,
  };
}

export function normalizeSettings(value) {
  const base = createDefaultSettings();
  if (!value || typeof value !== "object") return base;
  const merged = { ...base, ...deepClone(value) };
  merged.markup = { ...base.markup, ...(value.markup || {}) };
  merged.costModel = { ...base.costModel, ...(value.costModel || {}) };
  merged.costModel.freightPct = {
    ...base.costModel.freightPct,
    ...((value.costModel && value.costModel.freightPct) || {}),
  };
  if (!Array.isArray(merged.priority)) merged.priority = DEFAULT_PRIORITY.slice();
  if (!Array.isArray(merged.excluded)) merged.excluded = [];
  if (!Array.isArray(merged.hiddenGroups)) merged.hiddenGroups = [];
  return merged;
}

export function ensureSettingsShape() {
  if (!Array.isArray(state.settings.hiddenGroups)) state.settings.hiddenGroups = [];
  if (!Array.isArray(state.settings.priority)) state.settings.priority = DEFAULT_PRIORITY.slice();
  if (!Array.isArray(state.settings.excluded)) state.settings.excluded = [];
  state.overrides = normalizeOverrides(state.overrides);
}

export function isGroupVisible(treatment) {
  ensureSettingsShape();
  return !state.settings.hiddenGroups.includes(treatment);
}

export function visibleTreatments() {
  return TREATMENT_ORDER.filter(isGroupVisible);
}

export function visiblePriceEntries() {
  return Object.entries(state.prices).filter(([key]) => isGroupVisible(key.split("||")[0]) && !isComboDisabled(key));
}

export function unsafePriceEntries() {
  return visiblePriceEntries().filter(([, price]) => !isPriceProfitable(price));
}

export function isComboDisabled(key) {
  return normalizeOverrides(state.overrides).combos.includes(key);
}

export function marginClass(margin) {
  return margin >= 0.45 ? "m-ok" : margin >= 0.3 ? "m-thin" : margin >= 0.15 ? "m-floor" : "m-low";
}

export function isPriceProfitable(price) {
  if (!price || !(Number(price.priceUSD) > 0)) return false;
  if (price.constraintSupplier) return Number(price.preferredMargin) >= state.settings.minMargin - 1e-6;
  return price.safe !== false && Number(price.floorMargin) >= state.settings.floorMargin - 1e-6;
}

export function isBelowCurrentFloor(price) {
  return !!price && Number(price.priceUSD) > 0 && !isPriceProfitable(price);
}

export function firstUnsafePriceEntry() {
  return unsafePriceEntries()[0] || null;
}

export function findPriceInput(key) {
  return Array.from(document.querySelectorAll(".price-input")).find((element) => element.dataset.key === key) || null;
}

export function flashBlockedPriceEntry(key) {
  const input = findPriceInput(key);
  if (!input) return false;
  const cell = input.closest("td");
  if (!cell) return false;
  clearTimeout(cell._blockedFlashTimer);
  cell.classList.remove("save-blocked-cell");
  void cell.offsetWidth;
  cell.classList.add("save-blocked-cell");
  cell.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  input.focus({ preventScroll: true });
  cell._blockedFlashTimer = setTimeout(() => cell.classList.remove("save-blocked-cell"), 2600);
  return true;
}

export function revealBlockedPriceEntry() {
  const unsafe = unsafePriceEntries();
  if (!unsafe.length) return null;
  const [key] = unsafe[0];
  const treatment = key.split("||")[0];
  state.blockedPriceKey = key;
  $("audit-overlay")?.classList.remove("open");
  $("preview-overlay")?.classList.remove("open");
  if (app.showView) app.showView("builder");
  if (state.collapsed[treatment]) state.collapsed[treatment] = false;
  if (app.buildMatrix) app.buildMatrix();
  requestAnimationFrame(() => requestAnimationFrame(() => flashBlockedPriceEntry(key)));
  return unsafe;
}

export function syncProtectedActionLocks() {
  const unsafe = unsafePriceEntries();
  if (!unsafe.length) state.blockedPriceKey = null;
  else if (!state.blockedPriceKey || !unsafe.some(([key]) => key === state.blockedPriceKey)) state.blockedPriceKey = unsafe[0][0];
  const locked = unsafe.length > 0;
  const suffix = locked ? `Blocked until ${unsafe.length} price${unsafe.length === 1 ? "" : "s"} clear the margin floor.` : "";
  const ids = ["pricing-preview-btn", "pricing-export-btn", "pricing-saveas-btn", "pricing-publish-btn"];
  ids.forEach((id) => {
    const element = $(id);
    if (!element) return;
    element.classList.toggle("action-locked", locked);
    element.setAttribute("aria-disabled", locked ? "true" : "false");
    element.dataset.locked = locked ? "1" : "0";
    if (locked) {
      element.title = suffix;
    } else if (id === "pricing-preview-btn") {
      element.title = "Preview the current pricelist.";
    } else if (id === "pricing-export-btn") {
      element.title = "Export / print the current pricelist.";
    } else if (id === "pricing-saveas-btn") {
      element.title = "Create a separate new copy.";
    } else if (id === "pricing-publish-btn") {
      element.title = "Publish prices as a dry run.";
    }
  });
}

export function toast(message) {
  const element = $("toast");
  if (!element) return;
  element.textContent = message;
  element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 2600);
}

export function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function escHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

export const escapeAttr = escapeHtml;

export function encodeTypeKeys(keys) {
  return encodeURIComponent(JSON.stringify((keys || []).filter(Boolean)));
}

export function jsAttrArg(value) {
  return escHtml(jsArg(value));
}

export function categoryClassLabel(tier) {
  if (!tier) return "";
  if (/best/i.test(tier)) return "Best";
  if (/better/i.test(tier)) return "Better";
  if (/good/i.test(tier)) return "Good";
  if (/adept/i.test(tier)) return /bifocal/i.test(tier) ? "Adept Bifocal / Conventional" : "Adept / Conventional";
  if (/regular/i.test(tier)) return "Conventional";
  const display = TIER_DISPLAY[tier];
  return display ? display.grade : tier;
}

export function tierGrade(tier) {
  const display = TIER_DISPLAY[tier];
  return display ? `${display.grade} (${display.name})` : (tier || "\u2014");
}

export function setCombos(combos) {
  state.combos = Array.isArray(combos) ? combos : [];
  state.comboByKey = Object.fromEntries(state.combos.map((combo) => [combo.key, combo]));
}

export function setCustomers(customers) {
  state.customers = Array.isArray(customers) ? customers : [];
}

export function setSources(sources) {
  state.sources = sources || { sources: [], live: [] };
}

Object.assign(app, {
  categoryClassLabel,
  isComboDisabled,
  marginClass,
  revealBlockedPriceEntry,
  syncProtectedActionLocks,
  unsafePriceEntries,
  visiblePriceEntries,
});
