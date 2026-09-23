const crypto = require("node:crypto");
const rxGenerator = require("../rx-generator");
const { normalizeOpticalOrder, unresolvedFields } = require("./normalized-order");

function buildRxCaptureOrder(normalizedOrder, resolution, options = {}) {
  const generator = options.generator || rxGenerator;
  const order = normalizeOpticalOrder(normalizedOrder);
  const issues = unresolvedFields(order);

  const selected = normalizeResolution(resolution);
  const config = generator.loadConfig();
  const catalog = generator.getCatalog();
  const lens = catalog.find((item) => String(item.alias) === selected.lensAlias);
  if (!lens) throw inputError("Select an exact source-validated lens alias before approval.");
  const behaviour = generator.LENS_BEHAVIOUR[lens.mfType];
  if (!behaviour) throw inputError(`RX generation for ${lens.mfType || "this lens"} is not configured from a known-good RX profile.`);

  const frame = buildFrame(order, selected);
  const prescription = buildPrescription(order, behaviour);
  const items = buildItems(selected, frame, generator);
  const identifiers = options.reserveIdentifiers === false
    ? previewIdentifiers(order, selected)
    : generator.nextIdentifiers();
  const customer = {
    labNum: text(selected.labNum || config.defaults.labNum, "Lab number", 30, true),
    custNum: selected.customerNumber,
    custSeqNum: text(selected.customerSequence || config.defaults.custSeqNum, "Customer sequence", 30, true),
    shipName: selected.shipName,
    remoteOperator: text(selected.remoteOperator || config.defaults.remoteOperator, "Remote operator", 80, true)
  };
  const patientName = patientNameForRx(order.patient.name);
  const built = {
    identifiers,
    customer,
    patient: { name: patientName },
    lens: lensForRx(lens),
    behaviour,
    frame,
    prescription,
    items,
    instructions: text(selected.instructions || order.instructions || "", "Instructions", 500, false) || "RX Capture"
  };
  built.filename = generator.filenameFor(identifiers.orderId, patientName, config.output.extension);
  built.content = generator.renderRxText(built, config);

  return {
    order: built,
    resolution: selected,
    issues,
    sha256: crypto.createHash("sha256").update(built.content, "utf8").digest("hex")
  };
}

function normalizeResolution(value) {
  const source = value && typeof value === "object" ? value : {};
  const addonSkus = Array.isArray(source.addonSkus) ? source.addonSkus : [];
  const uniqueAddons = [...new Set(addonSkus.map((item) => text(item, "Add-on", 80, true)))];
  const frameMode = text(source.frameMode, "Frame mode", 20, true).toLowerCase();
  if (!['uncut', 'edged'].includes(frameMode)) throw inputError("Frame mode must be uncut or edged.");
  return {
    customerNumber: text(source.customerNumber, "Customer number", 40, true),
    customerSequence: text(source.customerSequence, "Customer sequence", 30, false),
    shipName: text(source.shipName, "Ship name", 180, true),
    labNum: text(source.labNum, "Lab number", 30, false),
    remoteOperator: text(source.remoteOperator, "Remote operator", 80, false),
    lensAlias: String(source.lensAlias || "").replace(/\D/g, ""),
    coatingSku: source.coatingSku == null || source.coatingSku === "" ? null : text(source.coatingSku, "Coating", 80, true),
    addonSkus: uniqueAddons,
    frameMode,
    frameMounting: text(source.frameMounting || "1", "Frame mounting", 20, true),
    instructions: text(source.instructions, "Instructions", 500, false)
  };
}

function buildPrescription(order, behaviour) {
  const pd = monocularPd(order.pd);
  const eyes = {};
  for (const side of ["od", "os"]) {
    const source = order.prescription[side];
    const sphere = optionalQuarter(source.sphere, `${side.toUpperCase()} sphere`, -20, 20);
    const cylinder = optionalQuarter(source.cylinder, `${side.toUpperCase()} cylinder`, -10, 10);
    const axis = cylinder === 0 ? 0 : optionalInteger(source.axis, `${side.toUpperCase()} axis`, 1, 180);
    const add = behaviour.requiresAdd
      ? optionalPositiveQuarter(source.add, `${side.toUpperCase()} ADD`, 0, 4)
      : 0;
    const segHeight = behaviour.requiresSegHeight
      ? optionalDecimal(order.frame[`segHeight${side === "od" ? "Od" : "Os"}`], 0.1, 50, `${side.toUpperCase()} segment height`)
      : 0;
    eyes[side] = {
      sphere: optionalSigned(sphere), cylinder: optionalSigned(cylinder), axis: optionalText(axis), add: optionalSigned(add),
      near: optionalOneDecimal(pd[side]), far: optionalOneDecimal(pd[side]), segHeight: optionalOneDecimal(segHeight)
    };
  }
  return eyes;
}

function monocularPd(pd) {
  const binocular = optionalDecimal(pd.binocular, 1, 100, "PD");
  if (binocular !== null) return { od: binocular / 2, os: binocular / 2 };
  return {
    od: optionalDecimal(pd.od, 0.1, 100, "OD PD"),
    os: optionalDecimal(pd.os, 0.1, 100, "OS PD")
  };
}

function buildFrame(order, resolution) {
  const frame = order.frame || {};
  const edged = resolution.frameMode === "edged";
  return {
    source: "NO TRACE - UNCUT",
    status: edged ? "ENCLOSED" : "UNCUT",
    tracing: "NO TRACE",
    model: text(frame.model || (edged ? "" : "UNCUT"), "Frame model", 80, edged),
    color: text(frame.color || "1", "Frame color", 40, true),
    a: edged ? oneDecimal(decimal(frame.a, "Frame A", 0.1, 100)) : optionalOneDecimal(optionalDecimal(frame.a, 0.1, 100, "Frame A")),
    b: edged ? oneDecimal(decimal(frame.b, "Frame B", 0.1, 100)) : optionalOneDecimal(optionalDecimal(frame.b, 0.1, 100, "Frame B")),
    dbl: edged ? oneDecimal(decimal(frame.dbl, "Frame DBL", 0.1, 100)) : optionalOneDecimal(optionalDecimal(frame.dbl, 0.1, 100, "Frame DBL")),
    radAngle: "45.0",
    mounting: resolution.frameMounting,
    dress: "DRESS",
    edge: edged ? "EDGED" : "UNCUT",
    edged
  };
}

function buildItems(resolution, frame, generator) {
  const items = [];
  const coatings = generator.getCoatings();
  const addons = generator.getAddons();
  if (resolution.coatingSku) {
    const coating = coatings.find((item) => String(item.sku) === resolution.coatingSku);
    if (!coating) throw inputError("Select an exact source-validated coating.");
    items.push(toRxItem(coating));
  }
  for (const sku of resolution.addonSkus) {
    const addon = addons.find((item) => String(item.sku) === sku);
    if (!addon) throw inputError("Select exact source-validated add-ons.");
    items.push(toRxItem(addon));
  }
  if (frame.edged && !items.some((item) => item.description === "EDGE TO FIT")) {
    const edging = addons.find((item) => String(item.description).trim().toUpperCase() === "EDGE TO FIT");
    if (!edging) throw inputError("The required EDGE TO FIT add-on is not configured.", 503);
    items.push(toRxItem(edging));
  }
  return items;
}

function lensForRx(lens) {
  return {
    alias: String(lens.alias),
    colorCode: text(lens.colorCode, "Lens color code", 80, true),
    colorDescription: text(lens.colorDescription, "Lens option", 160, true),
    materialCode: text(lens.materialCode, "Lens material code", 80, true),
    materialDescription: text(lens.materialDescription, "Lens material", 160, true),
    styleCode: text(lens.styleCode, "Lens style code", 80, true),
    styleDescription: text(lens.styleDescription, "Lens style", 160, true)
  };
}

function toRxItem(item) {
  return {
    sku: text(item.sku, "Item SKU", 80, true),
    source: text(item.source || "", "Item source", 80, false),
    description: text(item.description, "Item description", 160, true),
    quantity: String(Number(item.quantity || 1)),
    side: text(item.side || "NONE", "Item side", 30, true),
    partRx: text(item.partRx || "Y", "Item RX flag", 10, true),
    kind: text(item.kind || "", "Item kind", 30, false)
  };
}

function patientNameForRx(value) {
  const name = text(value, "Patient name", 120, true).toUpperCase();
  if (!/^[A-Z][A-Z '\-]+,\s*[A-Z][A-Z '\-]+$/.test(name)) throw inputError("Patient names must use LASTNAME, FIRSTNAME.");
  return name.replace(/,\s+/, ", ");
}

function previewIdentifiers(order, resolution) {
  const hash = crypto.createHash("sha256").update(JSON.stringify({ order, resolution })).digest("hex");
  return { orderId: `PREVIEW-${hash.slice(0, 8)}`, gkOrder: `PREVIEW-${hash.slice(8, 16)}`, guid: hash.slice(0, 40) };
}

function text(value, label, max, required) {
  const result = String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
  if (required && !result) throw inputError(`${label} is required.`);
  return result;
}

function decimal(value, label, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw inputError(`${label} must be between ${min} and ${max}.`);
  return number;
}

function optionalDecimal(value, min, max, label = "PD") {
  if (value === null || value === undefined || value === "") return null;
  return decimal(value, label, min, max);
}

function optionalQuarter(value, label, min, max) {
  if (value === null || value === undefined || value === "") return null;
  return quarter(value, label, min, max);
}

function optionalPositiveQuarter(value, label, min, max) {
  if (value === null || value === undefined || value === "") return null;
  return positiveQuarter(value, label, min, max);
}

function optionalInteger(value, label, min, max) {
  if (value === null || value === undefined || value === "") return null;
  return integer(value, label, min, max);
}

function quarter(value, label, min, max) {
  const number = decimal(value, label, min, max);
  if (Math.abs(number * 4 - Math.round(number * 4)) > 0.00001) throw inputError(`${label} must be in 0.25 steps.`);
  return number;
}

function positiveQuarter(value, label, min, max) {
  const number = quarter(value, label, min, max);
  if (number <= 0) throw inputError(`${label} must be greater than 0.`);
  return number;
}

function integer(value, label, min, max) {
  const number = decimal(value, label, min, max);
  if (!Number.isInteger(number)) throw inputError(`${label} must be a whole number.`);
  return number;
}

function signed(value) { return `${value >= 0 ? "+" : ""}${Number(value).toFixed(2)}`; }
function oneDecimal(value) { return Number(value).toFixed(1); }
function optionalSigned(value) { return value === null ? "" : signed(value); }
function optionalOneDecimal(value) { return value === null ? "" : oneDecimal(value); }
function optionalText(value) { return value === null ? "" : String(value); }
function inputError(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

module.exports = { buildRxCaptureOrder, normalizeResolution };
