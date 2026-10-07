const OPTICAL_FIELDS = [
  "patient.name",
  "patient.reference",
  "prescription.od.sphere",
  "prescription.od.cylinder",
  "prescription.od.axis",
  "prescription.od.add",
  "prescription.od.prism",
  "prescription.od.base",
  "prescription.os.sphere",
  "prescription.os.cylinder",
  "prescription.os.axis",
  "prescription.os.add",
  "prescription.os.prism",
  "prescription.os.base",
  "pd.type",
  "pd.binocular",
  "pd.od",
  "pd.os",
  "pd.nearOd",
  "pd.nearOs",
  "pd.nearBinocular",
  "frame.supplied",
  "frame.status",
  "frame.mounting",
  "frame.model",
  "frame.color",
  "frame.a",
  "frame.b",
  "frame.dbl",
  "frame.ed",
  "frame.segHeightOd",
  "frame.segHeightOs",
  "lensRequest.lensType",
  "lensRequest.materialGroup",
  "lensRequest.style",
  "lensRequest.design",
  "lensRequest.material",
  "lensRequest.option",
  "lensRequest.coating",
  "lensRequest.coatingSku",
  "lensRequest.catalogAlias",
  "instructions"
];

const TEXT_EYE_FIELDS = ["sphere", "cylinder", "add", "prism", "base"];
const TEXT_PD_FIELDS = ["type", "binocular", "od", "os", "nearOd", "nearOs", "nearBinocular"];
const TEXT_FRAME_FIELDS = ["model", "color", "a", "b", "dbl", "ed", "segHeightOd", "segHeightOs"];
const TEXT_LENS_FIELDS = ["materialGroup", "lensType", "style", "design", "material", "option", "coating", "coatingSku", "catalogAlias"];

function emptyNormalizedOrder() {
  return {
    patient: { name: null, reference: null },
    prescription: {
      od: { sphere: null, cylinder: null, axis: null, add: null, prism: null, base: null },
      os: { sphere: null, cylinder: null, axis: null, add: null, prism: null, base: null }
    },
    pd: { type: null, binocular: null, od: null, os: null, nearOd: null, nearOs: null, nearBinocular: null },
    frame: {
      supplied: null,
      status: "TO_BE_TRACED",
      mounting: null,
      model: null,
      color: null,
      a: null,
      b: null,
      dbl: null,
      ed: null,
      segHeightOd: null,
      segHeightOs: null
    },
    lensRequest: { materialGroup: null, lensType: null, style: null, design: null, material: null, option: null, coating: null, coatingSku: null, catalogAlias: null },
    instructions: null,
    uncertainFields: [],
    missingFields: []
  };
}

function normalizeOpticalOrder(value) {
  const source = value && typeof value === "object" ? value : {};
  const order = emptyNormalizedOrder();

  order.patient.name = normalizePatientName(source.patient?.name);
  order.patient.reference = cleanText(source.patient?.reference, 160)?.toUpperCase() || null;

  for (const side of ["od", "os"]) {
    for (const field of TEXT_EYE_FIELDS) {
      order.prescription[side][field] = cleanText(source.prescription?.[side]?.[field], 40);
    }
    order.prescription[side].axis = cleanAxis(source.prescription?.[side]?.axis);
  }

  for (const field of TEXT_PD_FIELDS) order.pd[field] = cleanText(source.pd?.[field], 40);
  order.frame.status = cleanFrameStatus(source.frame?.status) || "TO_BE_TRACED";
  order.frame.supplied = cleanBoolean(source.frame?.supplied);
  if (order.frame.supplied === null) order.frame.supplied = order.frame.status !== "UNCUT";
  for (const field of TEXT_FRAME_FIELDS) order.frame[field] = cleanText(source.frame?.[field], 80);
  order.frame.mounting = cleanMounting(source.frame?.mounting);
  for (const field of TEXT_LENS_FIELDS) order.lensRequest[field] = cleanText(source.lensRequest?.[field], 160);
  order.instructions = cleanText(source.instructions, 2000);
  order.uncertainFields = cleanFieldList(source.uncertainFields);
  order.missingFields = cleanFieldList(source.missingFields);
  return order;
}

function cleanText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizePatientName(value) {
  const name = cleanText(value, 200);
  if (!name) return null;
  if (name.includes(",")) {
    const [last, ...first] = name.split(",");
    const given = first.join(" ").trim();
    return (given ? `${last.trim()}, ${given}` : last.trim()).toUpperCase();
  }
  const words = name.split(/\s+/);
  if (words.length < 2) return name.toUpperCase();
  const last = words.pop();
  return `${last}, ${words.join(" ")}`.toUpperCase();
}

function cleanAxis(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 180 ? number : null;
}

// Innovations frame_mounting codes as offered on the form: 1 metal, 2 plastic, 3 rimless / grooved.
function cleanMounting(value) {
  const code = String(value ?? "").trim();
  return ["1", "2", "3"].includes(code) ? code : null;
}

function cleanBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function cleanFrameStatus(value) {
  const status = String(value || "").trim().toUpperCase().replace(/[ -]+/g, "_");
  return ["TO_BE_TRACED", "MEASURED", "UNCUT"].includes(status) ? status : null;
}

function cleanFieldList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter((item) => OPTICAL_FIELDS.includes(item)))];
}

function valueAtPath(order, path) {
  return path.split(".").reduce((value, key) => value?.[key], order);
}

function unresolvedFields(order) {
  const normalized = normalizeOpticalOrder(order);
  const missingFields = [...new Set([
    ...normalized.missingFields.filter((field) => valueAtPath(normalized, field) === null && isRequiredMissingField(normalized, field)),
    ...criticalMissingFields(normalized)
  ])];
  return {
    missingFields,
    uncertainFields: normalized.uncertainFields,
    hasIssues: missingFields.length > 0 || normalized.uncertainFields.length > 0
  };
}

function criticalMissingFields(order) {
  const missing = [];
  for (const path of ["patient.name", "prescription.od.sphere", "prescription.os.sphere"]) {
    if (valueAtPath(order, path) === null) missing.push(path);
  }
  if (order.pd.binocular === null) {
    if (order.pd.od === null) missing.push("pd.od");
    if (order.pd.os === null) missing.push("pd.os");
  }
  for (const side of ["od", "os"]) {
    const cylinder = order.prescription[side].cylinder;
    const numericCylinder = cylinder !== null && /^[+-]?\d+(?:\.\d+)?$/.test(cylinder) ? Number(cylinder) : 0;
    if (numericCylinder !== 0 && order.prescription[side].axis === null) missing.push(`prescription.${side}.axis`);
  }
  if (requiresAddPower(order)) {
    for (const side of ["od", "os"]) {
      if (order.prescription[side].add === null) missing.push(`prescription.${side}.add`);
    }
  }
  return missing;
}

function isRequiredMissingField(order, field) {
  if (/^(?:frame|lensRequest)\./.test(field)) return false;
  if (/^prescription\.(?:od|os)\.(?:prism|base)$/.test(field)) return false;
  if (/^prescription\.(?:od|os)\.add$/.test(field)) return requiresAddPower(order);
  return true;
}

function requiresAddPower(order) {
  const lensDescription = [order.lensRequest?.lensType, order.lensRequest?.design]
    .filter(Boolean)
    .join(" ");
  if (/\b(?:single[ -]?vision|sv)\b/i.test(lensDescription)) return false;
  return /\b(?:progressive|bifocal|trifocal|multifocal|occupational)\b/i.test(lensDescription);
}

// Rules applied to a fresh extraction, never to what the employee edits.
// A zero cylinder with no axis is left blank, not filled in as 0.00. A PD over
// 42 mm is both eyes together, so it is split into one PD per eye (the near PD
// the same way, when two binocular PDs are given).
const BINOCULAR_PD_OVER = 42;
const ZERO_CYLINDER = /^(?:[+-]?0+(?:[.,]0+)?|sph|dsph|ds|plano|pl)$/i;

function applyCaptureRules(order, flags = {}) {
  dropZeroCylinders(order, flags);
  splitBinocularPds(order, flags);
  return order;
}

function dropZeroCylinders(order, flags) {
  for (const side of ["od", "os"]) {
    const eye = order.prescription[side];
    if (eye.sphere === null || eye.axis !== null || eye.cylinder === null) continue;
    if (!ZERO_CYLINDER.test(String(eye.cylinder).trim())) continue;
    eye.cylinder = null;
    for (const field of ["cylinder", "axis"]) forgetField(order, flags, `prescription.${side}.${field}`);
  }
}

function splitBinocularPds(order, flags) {
  splitPd(order, flags, "binocular", "od", "os");
  splitPd(order, flags, "nearBinocular", "nearOd", "nearOs");
}

function splitPd(order, flags, wholeKey, odKey, osKey) {
  const pd = order.pd;
  const number = (key) => {
    const value = pd[key] === null || pd[key] === undefined || String(pd[key]).trim() === "" ? NaN : Number(pd[key]);
    return Number.isFinite(value) ? value : null;
  };
  const od = number(odKey);
  const os = number(osKey);
  let whole = number(wholeKey);
  let source = `pd.${wholeKey}`;
  if (whole === null) {
    // A single value over 42 mm in one eye field can only be a binocular PD.
    if (od !== null && od > BINOCULAR_PD_OVER && os === null) { whole = od; source = `pd.${odKey}`; pd[odKey] = null; }
    else if (os !== null && os > BINOCULAR_PD_OVER && od === null) { whole = os; source = `pd.${osKey}`; pd[osKey] = null; }
  }
  if (whole === null || whole <= BINOCULAR_PD_OVER) return;
  if (source === `pd.${wholeKey}` && od !== null && os !== null) return;
  const half = (Math.round((whole / 2) * 10) / 10).toFixed(1);
  const filled = [];
  for (const key of [odKey, osKey]) {
    if (pd[key] === null || pd[key] === undefined || String(pd[key]).trim() === "") { pd[key] = half; filled.push(`pd.${key}`); }
  }
  const doubt = flags[source] || null;
  const doubtful = Boolean(doubt) || order.uncertainFields.includes(source);
  if (source === `pd.${wholeKey}`) { pd[wholeKey] = null; forgetField(order, flags, source); }
  if (doubtful) {
    for (const path of filled) {
      if (!order.uncertainFields.includes(path)) order.uncertainFields.push(path);
      if (doubt && !flags[path]) flags[path] = doubt;
    }
  }
}

function forgetField(order, flags, path) {
  order.uncertainFields = order.uncertainFields.filter((item) => item !== path);
  order.missingFields = order.missingFields.filter((item) => item !== path);
  delete flags[path];
}

function extractionJsonSchema() {
  const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
  const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };
  const nullableInteger = { anyOf: [{ type: "integer", minimum: 1, maximum: 180 }, { type: "null" }] };
  const nullableBoolean = { anyOf: [{ type: "boolean" }, { type: "null" }] };
  const nullableFrameStatus = { anyOf: [{ type: "string", enum: ["TO_BE_TRACED", "MEASURED", "UNCUT"] }, { type: "null" }] };
  const object = (properties) => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });

  return object({
    patient: object({ name: nullableString, reference: nullableString }),
    prescription: object({
      od: object({ sphere: nullableString, cylinder: nullableString, axis: nullableInteger, add: nullableString, prism: nullableString, base: nullableString }),
      os: object({ sphere: nullableString, cylinder: nullableString, axis: nullableInteger, add: nullableString, prism: nullableString, base: nullableString })
    }),
    pd: object({ type: nullableString, binocular: nullableNumber, od: nullableNumber, os: nullableNumber, nearOd: nullableNumber, nearOs: nullableNumber, nearBinocular: nullableNumber }),
    frame: object({
      supplied: nullableBoolean,
      status: nullableFrameStatus,
      model: nullableString,
      color: nullableString,
      a: nullableNumber,
      b: nullableNumber,
      dbl: nullableNumber,
      ed: nullableNumber,
      segHeightOd: nullableNumber,
      segHeightOs: nullableNumber
    }),
    // These three UI-only catalogue fields are deliberately omitted here. The
    // image extractor remains source-neutral and cannot fabricate selections.
    lensRequest: object({ lensType: nullableString, design: nullableString, material: nullableString, option: nullableString, coating: nullableString }),
    instructions: nullableString,
    uncertainFields: { type: "array", items: { type: "string", enum: OPTICAL_FIELDS } },
    missingFields: { type: "array", items: { type: "string", enum: OPTICAL_FIELDS } }
  });
}

module.exports = {
  OPTICAL_FIELDS,
  applyCaptureRules,
  emptyNormalizedOrder,
  extractionJsonSchema,
  criticalMissingFields,
  normalizeOpticalOrder,
  normalizePatientName,
  requiresAddPower,
  unresolvedFields,
  valueAtPath
};
