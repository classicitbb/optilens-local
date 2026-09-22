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
  "frame.supplied",
  "frame.model",
  "frame.color",
  "frame.a",
  "frame.b",
  "frame.dbl",
  "frame.ed",
  "frame.segHeightOd",
  "frame.segHeightOs",
  "lensRequest.lensType",
  "lensRequest.design",
  "lensRequest.material",
  "lensRequest.option",
  "lensRequest.coating",
  "instructions"
];

const TEXT_EYE_FIELDS = ["sphere", "cylinder", "add", "prism", "base"];
const TEXT_PD_FIELDS = ["type", "binocular", "od", "os", "nearOd", "nearOs"];
const TEXT_FRAME_FIELDS = ["model", "color", "a", "b", "dbl", "ed", "segHeightOd", "segHeightOs"];
const TEXT_LENS_FIELDS = ["lensType", "design", "material", "option", "coating"];

function emptyNormalizedOrder() {
  return {
    patient: { name: null, reference: null },
    prescription: {
      od: { sphere: null, cylinder: null, axis: null, add: null, prism: null, base: null },
      os: { sphere: null, cylinder: null, axis: null, add: null, prism: null, base: null }
    },
    pd: { type: null, binocular: null, od: null, os: null, nearOd: null, nearOs: null },
    frame: {
      supplied: null,
      model: null,
      color: null,
      a: null,
      b: null,
      dbl: null,
      ed: null,
      segHeightOd: null,
      segHeightOs: null
    },
    lensRequest: { lensType: null, design: null, material: null, option: null, coating: null },
    instructions: null,
    uncertainFields: [],
    missingFields: []
  };
}

function normalizeOpticalOrder(value) {
  const source = value && typeof value === "object" ? value : {};
  const order = emptyNormalizedOrder();

  order.patient.name = cleanText(source.patient?.name, 200);
  order.patient.reference = cleanText(source.patient?.reference, 160);

  for (const side of ["od", "os"]) {
    for (const field of TEXT_EYE_FIELDS) {
      order.prescription[side][field] = cleanText(source.prescription?.[side]?.[field], 40);
    }
    order.prescription[side].axis = cleanAxis(source.prescription?.[side]?.axis);
  }

  for (const field of TEXT_PD_FIELDS) order.pd[field] = cleanText(source.pd?.[field], 40);
  order.frame.supplied = cleanBoolean(source.frame?.supplied);
  for (const field of TEXT_FRAME_FIELDS) order.frame[field] = cleanText(source.frame?.[field], 80);
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

function cleanAxis(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 180 ? number : null;
}

function cleanBoolean(value) {
  return typeof value === "boolean" ? value : null;
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
    ...normalized.missingFields.filter((field) => valueAtPath(normalized, field) === null),
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
  return missing;
}

function extractionJsonSchema() {
  const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
  const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };
  const nullableInteger = { anyOf: [{ type: "integer", minimum: 1, maximum: 180 }, { type: "null" }] };
  const nullableBoolean = { anyOf: [{ type: "boolean" }, { type: "null" }] };
  const object = (properties) => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });

  return object({
    patient: object({ name: nullableString, reference: nullableString }),
    prescription: object({
      od: object({ sphere: nullableString, cylinder: nullableString, axis: nullableInteger, add: nullableString, prism: nullableString, base: nullableString }),
      os: object({ sphere: nullableString, cylinder: nullableString, axis: nullableInteger, add: nullableString, prism: nullableString, base: nullableString })
    }),
    pd: object({ type: nullableString, binocular: nullableNumber, od: nullableNumber, os: nullableNumber, nearOd: nullableNumber, nearOs: nullableNumber }),
    frame: object({
      supplied: nullableBoolean,
      model: nullableString,
      color: nullableString,
      a: nullableNumber,
      b: nullableNumber,
      dbl: nullableNumber,
      ed: nullableNumber,
      segHeightOd: nullableNumber,
      segHeightOs: nullableNumber
    }),
    lensRequest: object({ lensType: nullableString, design: nullableString, material: nullableString, option: nullableString, coating: nullableString }),
    instructions: nullableString,
    uncertainFields: { type: "array", items: { type: "string", enum: OPTICAL_FIELDS } },
    missingFields: { type: "array", items: { type: "string", enum: OPTICAL_FIELDS } }
  });
}

module.exports = {
  OPTICAL_FIELDS,
  emptyNormalizedOrder,
  extractionJsonSchema,
  criticalMissingFields,
  normalizeOpticalOrder,
  unresolvedFields,
  valueAtPath
};
