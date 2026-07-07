// Standards catalog — the single source of truth for the controlled vocabulary
// used on Classic Visions export paperwork (commercial invoice + CARICOM
// Certificate of Origin) and for the BeSwift form fill. Every option carries:
//   - value:        the canonical/printed value (Incoterms-correct where relevant)
//   - beswiftValue:  the EXACT string BeSwift's dropdown expects (so the
//                    extension can select it without fuzzy matching). When it
//                    equals `value` it's omitted in the fallback below.
//   - label:         human display for our own dropdowns
//   - isDefault:     the pre-selected option
//   - modes:         which transport modes an option applies to (delivery terms)
//
// The DB table delivery.standards_catalog (migration 019) is the editable,
// operator-facing copy; this file is the authoritative seed AND the runtime
// fallback so the app still standardises correctly when the DB is unreachable
// ("Connectors unavailable"). Keep the two in sync — 019's seed mirrors this.

const { getAppPool } = require("./db");

// ---------------------------------------------------------------------------
// Incoterms 2020 — the eleven official rules. `modes` follows ICC: FAS/FOB/CFR/
// CIF are sea & inland-waterway ONLY; the other seven are any mode of transport.
// Classic Visions ships by air, so the air-appropriate default is FCA, not FOB.
// ---------------------------------------------------------------------------
const INCOTERMS_2020 = [
  { code: "EXW", name: "Ex Works", modes: ["any"], needsPlace: "place of delivery" },
  { code: "FCA", name: "Free Carrier", modes: ["any"], needsPlace: "named place of delivery" },
  { code: "CPT", name: "Carriage Paid To", modes: ["any"], needsPlace: "place of destination" },
  { code: "CIP", name: "Carriage and Insurance Paid To", modes: ["any"], needsPlace: "place of destination" },
  { code: "DAP", name: "Delivered at Place", modes: ["any"], needsPlace: "named place of destination" },
  { code: "DPU", name: "Delivered at Place Unloaded", modes: ["any"], needsPlace: "place of destination" },
  { code: "DDP", name: "Delivered Duty Paid", modes: ["any"], needsPlace: "place of destination" },
  { code: "FAS", name: "Free Alongside Ship", modes: ["sea"], needsPlace: "port of loading" },
  { code: "FOB", name: "Free on Board", modes: ["sea"], needsPlace: "port of loading" },
  { code: "CFR", name: "Cost and Freight", modes: ["sea"], needsPlace: "port of destination" },
  { code: "CIF", name: "Cost, Insurance and Freight", modes: ["sea"], needsPlace: "port of destination" }
];

// Which Incoterm is the correct default for a given mode of transport. Air (and
// road/rail/courier/multimodal) -> FCA at the named place of handover. Sea ->
// FOB (Classic Visions' historical term, valid for sea). This is the strict
// Incoterms-2020 correction Russell approved: air shipments stop using FOB.
function incotermForMode(modeOfTransport) {
  const mode = String(modeOfTransport || "").trim().toLowerCase();
  const isSea = /sea|ocean|vessel|inland waterway|water/.test(mode);
  return isSea ? "FOB" : "FCA";
}

// Named place that completes the Incoterm (FCA <place>, FOB <port>). Air handover
// is at the airport of loading; sea at the seaport.
const DEFAULT_PLACES = {
  air: "Grantley Adams International Airport",
  sea: "Bridgetown Port"
};

// Resolve the delivery-terms option for a shipment. `customerOverride` (a stored
// per-customer term) wins if present; otherwise derive the Incoterms-correct
// default from the mode of transport.
function resolveDeliveryTerms({ modeOfTransport, customerOverride } = {}) {
  const override = String(customerOverride || "").trim();
  if (override) return override;
  const code = incotermForMode(modeOfTransport);
  const term = INCOTERMS_2020.find((t) => t.code === code);
  const mode = String(modeOfTransport || "").trim().toLowerCase();
  const place = /sea|ocean|vessel|inland waterway|water/.test(mode) ? DEFAULT_PLACES.sea : DEFAULT_PLACES.air;
  return {
    code: term.code,
    name: term.name,
    // Printed on the commercial invoice's "Terms & conditions of delivery" line.
    printLabel: `${term.code} ${place} (Incoterms 2020)`,
    // Best-known BeSwift dropdown string. FOB was confirmed live; FCA's exact
    // option text on BeSwift is unconfirmed — operator can correct it in the
    // standards_catalog table without a code change.
    beswiftValue: term.name
  };
}

// ---------------------------------------------------------------------------
// Curated shortlists. First entry / isDefault is what pre-selects and what the
// BeSwift fill takes when a field "always takes the top option".
// ---------------------------------------------------------------------------
const STANDARDS_FALLBACK = {
  currency: [
    { value: "BARBADOS DOLLAR", label: "Barbados Dollar (BBD)", isDefault: true },
    { value: "UNITED STATES DOLLAR", label: "United States Dollar (USD)" }
  ],
  presentingBank: [
    { value: "Bank of Nova Scotia", label: "Bank of Nova Scotia (Scotiabank)", isDefault: true }
  ],
  packageType: [
    { value: "Bag, plastic", label: "Bag, plastic", isDefault: true, beswiftOptionIndex: 18 },
    { value: "Box, fibreboard", label: "Box, fibreboard" },
    { value: "Carton", label: "Carton" },
    { value: "Case", label: "Case" }
  ],
  countryOfOrigin: [
    { value: "Barbados", label: "Barbados", isDefault: true, beswiftOptionIndex: 3 }
  ],
  modeOfTransport: [
    { value: "Air", label: "Air", isDefault: true },
    { value: "Sea", label: "Sea" }
  ],
  portOfLoading: [
    { value: "GRANTLEY ADAMS INTL. AIRPORT", label: "Grantley Adams Intl. Airport (air)", isDefault: true, modes: ["air"] },
    { value: "BRIDGETOWN PORT", label: "Bridgetown Port (sea)", modes: ["sea"] }
  ],
  unitOfMeasure: [
    { value: "Number of Units", label: "Number of Units", isDefault: true }
  ],
  ruleOfOrigin: [
    { value: "Percentage Value", label: "Percentage Value", isDefault: true }
  ],
  originCriterion: [
    { value: "L", label: "L — wholly produced / qualifying (per company records)", isDefault: true }
  ]
};

// Delivery terms as a selectable list (all 11 Incoterms) with the mode-correct
// default flagged. Used to populate the commercial-invoice delivery-terms picker.
function deliveryTermsOptions(modeOfTransport) {
  const defaultCode = incotermForMode(modeOfTransport);
  return INCOTERMS_2020.map((t) => ({
    value: `${t.code} — ${t.name}`,
    code: t.code,
    label: `${t.code} — ${t.name}`,
    isDefault: t.code === defaultCode,
    modes: t.modes,
    seaOnly: t.modes.length === 1 && t.modes[0] === "sea"
  }));
}

function fallbackDefault(fieldKey) {
  const list = STANDARDS_FALLBACK[fieldKey] || [];
  return (list.find((o) => o.isDefault) || list[0] || null);
}

// DB-backed read with graceful fallback to the constants above. Returns a map of
// fieldKey -> option rows. Never throws on a DB problem — standardisation must
// keep working offline.
async function getStandardsCatalog(fieldKey = null) {
  try {
    const pool = await getAppPool();
    const request = pool.request();
    let where = "WHERE is_active = 1";
    if (fieldKey) {
      request.input("field_key", fieldKey);
      where += " AND field_key = @field_key";
    }
    const result = await request.query(`
      SELECT field_key AS fieldKey, option_value AS value, beswift_value AS beswiftValue,
             display_label AS label, is_default AS isDefault, sort_order AS sortOrder,
             applies_to_modes AS modes, beswift_option_index AS beswiftOptionIndex
      FROM delivery.standards_catalog
      ${where}
      ORDER BY field_key, sort_order, option_value
    `);
    if (result.recordset.length) {
      const grouped = {};
      for (const row of result.recordset) {
        (grouped[row.fieldKey] = grouped[row.fieldKey] || []).push(row);
      }
      return fieldKey ? (grouped[fieldKey] || fallbackList(fieldKey)) : { ...toFallbackShape(), ...grouped };
    }
  } catch {
    // fall through to constants
  }
  return fieldKey ? fallbackList(fieldKey) : toFallbackShape();
}

function fallbackList(fieldKey) {
  if (fieldKey === "deliveryTerms") return deliveryTermsOptions("Air");
  return STANDARDS_FALLBACK[fieldKey] || [];
}

function toFallbackShape() {
  const out = { deliveryTerms: deliveryTermsOptions("Air") };
  for (const key of Object.keys(STANDARDS_FALLBACK)) out[key] = STANDARDS_FALLBACK[key];
  return out;
}

// Maps a catalog field_key to the exact label BeSwift's form uses, so the
// extension can look a positional hint up by the label it already has in hand.
// Only fields whose Vuetify list needs a positional click belong here.
const BESWIFT_LABEL_BY_FIELD = {
  countryOfOrigin: "country of origin",
  packageType: "package type"
};

// Built-in fallback positions, used when the DB (or the payload it feeds) has no
// beswift_option_index. Mirrors the extension's own OPTION_INDEX_HINTS_FALLBACK
// so both sides degrade to the same known-good order if migration 020 hasn't
// been applied yet.
const OPTION_INDEX_HINTS_FALLBACK = { "country of origin": 3, "package type": 18 };

// Resolve label -> 1-based option position for the positional-click fields, from
// the default option's beswift_option_index in the catalog. Never throws: on any
// DB problem (or a NULL index) it falls back to the constants above, so the fill
// still standardises when "Connectors unavailable".
async function getBeswiftOptionIndexHints() {
  const hints = { ...OPTION_INDEX_HINTS_FALLBACK };
  try {
    const catalog = await getStandardsCatalog();
    for (const [fieldKey, label] of Object.entries(BESWIFT_LABEL_BY_FIELD)) {
      const rows = catalog[fieldKey] || [];
      const chosen = rows.find((o) => o.isDefault) || rows[0];
      const idx = Number(chosen?.beswiftOptionIndex);
      if (Number.isInteger(idx) && idx > 0) hints[label] = idx;
    }
  } catch {
    // keep the fallback map
  }
  return hints;
}

module.exports = {
  INCOTERMS_2020,
  incotermForMode,
  resolveDeliveryTerms,
  deliveryTermsOptions,
  getStandardsCatalog,
  getBeswiftOptionIndexHints,
  fallbackDefault,
  STANDARDS_FALLBACK,
  BESWIFT_LABEL_BY_FIELD,
  OPTION_INDEX_HINTS_FALLBACK
};
