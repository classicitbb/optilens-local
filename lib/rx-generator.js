const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data", "rx");
const TEMPLATE_FILE = path.join(ROOT, "templates", "rx-template.txt");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const SEQUENCE_FILE = path.join(DATA_DIR, "sequence.json");
const LOG_FILE = path.join(ROOT, "data", "logs", "rx-generator.jsonl");
const SOURCE_CATALOG_FILE = path.join(DATA_DIR, "catalog.generated.json");

const LENS_BEHAVIOUR = {
  "Single Vision": { lensSvMf: "s", rxType: "S", requiresAdd: false, requiresSegHeight: false },
  Progressive: { lensSvMf: "m", rxType: "P", requiresAdd: true, requiresSegHeight: true },
  Bifocal: { lensSvMf: "m", rxType: "B", requiresAdd: true, requiresSegHeight: true }
};

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function safeText(value, max = 240) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

function loadConfig() {
  const config = readJson(CONFIG_FILE, null);
  if (!config) throw httpError("RX generator configuration is unavailable.", 503);
  return config;
}

function loadCatalog() {
  const records = readJson(SOURCE_CATALOG_FILE, null);
  if (!Array.isArray(records) || !records.length) {
    throw httpError("RX source catalogue is unavailable. Run npm run rx:sync-catalog before generating files.", 503);
  }
  return records.filter((record) => /^\d{13}$/.test(String(record.alias || "")));
}

function loadItems(name) {
  const items = readJson(path.join(DATA_DIR, `${name}.generated.json`), []);
  return Array.isArray(items) ? items.filter((item) => item.active !== false) : [];
}

function getCatalog() { return loadCatalog(); }
function getCoatings() { return loadItems("coatings"); }
function getAddons() { return loadItems("addons"); }

function seededRandom(seed) {
  let state = 0x811c9dc5;
  for (const char of String(seed || `${Date.now()}-${crypto.randomUUID()}`)) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function choose(items, random) { return items[Math.floor(random() * items.length)]; }
function randomBetween(min, max, random, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round((min + random() * (max - min)) * factor) / factor;
}
function number(value, label, min, max) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) throw httpError(`${label} must be between ${min} and ${max}.`);
  return result;
}
function isQuarter(value) { return Math.abs(value * 4 - Math.round(value * 4)) < 0.00001; }
function formatSigned(value) {
  const numberValue = Number(value) || 0;
  return `${numberValue >= 0 ? "+" : ""}${numberValue.toFixed(2)}`;
}
function formatOne(value) { return Number(value).toFixed(1); }
function normalizePatient(value) {
  const name = safeText(value, 120).toUpperCase();
  if (!/^[A-Z][A-Z '\-]+,\s*[A-Z][A-Z '\-]+$/.test(name)) throw httpError("Patient names must use LASTNAME, FIRSTNAME.");
  return name.replace(/,\s+/, ", ");
}
function filenameFor(orderId, patient, extension) {
  const stem = patient.replace(/[^A-Z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  return `${orderId}_${stem}${extension.startsWith(".") ? extension : `.${extension}`}`;
}
function normalizeExtension(value, fallback) {
  const extension = safeText(value || fallback, 12);
  if (!/^\.[A-Za-z0-9]{1,10}$/.test(extension)) throw httpError("Output extension must be a simple extension such as .rx.");
  return extension.toLowerCase();
}

function makePrescription(payload, config, random, behaviour) {
  const mode = payload?.mode || "plano";
  const pdOd = number(payload?.pdOd ?? config.prescription.defaultMonocularPd, "OD PD", 0.1, 100);
  const pdOs = number(payload?.pdOs ?? config.prescription.defaultMonocularPd, "OS PD", 0.1, 100);
  const makeEye = (eye) => {
    if (mode === "plano") return { sphere: "+0.00", cylinder: "+0.00", axis: "0", add: "+0.00", near: formatOne(eye === "od" ? pdOd : pdOs), far: formatOne(eye === "od" ? pdOd : pdOs), segHeight: "0.0" };
    if (mode === "random") {
      const sphere = Math.round(randomBetween(config.prescription.sphereMin, config.prescription.sphereMax, random) * 4) / 4;
      const cylinder = choose(config.prescription.cylinders, random);
      const add = behaviour.requiresAdd ? choose(config.prescription.adds.filter((item) => item > 0), random) : 0;
      return { sphere: formatSigned(sphere), cylinder: formatSigned(cylinder), axis: String(cylinder === 0 ? 0 : randomBetween(1, 180, random)), add: formatSigned(add), near: formatOne(eye === "od" ? pdOd : pdOs), far: formatOne(eye === "od" ? pdOd : pdOs), segHeight: behaviour.requiresSegHeight ? formatOne(choose(config.prescription.segmentHeights, random)) : "0.0" };
    }
    const source = payload?.[eye] || {};
    const sphere = number(source.sphere, `${eye.toUpperCase()} sphere`, -20, 20);
    const cylinder = number(source.cylinder, `${eye.toUpperCase()} cylinder`, -10, 10);
    const axis = number(source.axis, `${eye.toUpperCase()} axis`, 0, 180);
    const add = number(source.add ?? 0, `${eye.toUpperCase()} add`, 0, 4);
    const segHeight = number(source.segHeight ?? 0, `${eye.toUpperCase()} segment height`, 0, 50);
    if (!isQuarter(sphere) || !isQuarter(cylinder) || !isQuarter(add)) throw httpError("Sphere, cylinder, and ADD must be in 0.25 steps.");
    if (cylinder === 0 && axis !== 0) throw httpError(`${eye.toUpperCase()} axis must be 0 when cylinder is 0.00.`);
    if (behaviour.requiresAdd && add <= 0) throw httpError(`${eye.toUpperCase()} ADD is required for ${payload?.lensType || "this lens"}.`);
    if (behaviour.requiresSegHeight && segHeight <= 0) throw httpError(`${eye.toUpperCase()} segment height is required for this lens.`);
    return { sphere: formatSigned(sphere), cylinder: formatSigned(cylinder), axis: String(Math.round(axis)), add: formatSigned(add), near: formatOne(eye === "od" ? pdOd : pdOs), far: formatOne(eye === "od" ? pdOd : pdOs), segHeight: formatOne(segHeight) };
  };
  return { od: makeEye("od"), os: makeEye("os") };
}

function makeFrame(payload, config, random) {
  const mode = payload?.mode || "uncut";
  const dimensions = mode === "random" ? {
    a: randomBetween(config.frame.aMin, config.frame.aMax, random, 1),
    b: randomBetween(config.frame.bMin, config.frame.bMax, random, 1),
    dbl: randomBetween(config.frame.dblMin, config.frame.dblMax, random, 1)
  } : {
    a: number(payload?.a ?? 55, "Frame A", 0.1, 100),
    b: number(payload?.b ?? 38, "Frame B", 0.1, 100),
    dbl: number(payload?.dbl ?? 15, "Frame DBL", 0.1, 100)
  };
  const edged = mode === "edged";
  return { source: edged ? "FRAME TRACE" : "NO TRACE - UNCUT", status: "ENCLOSED", tracing: edged ? "FRAME TRACE" : "NO TRACE", model: safeText(payload?.model || "SOCA 1922", 80), color: safeText(payload?.color || "4", 40), a: formatOne(dimensions.a), b: formatOne(dimensions.b), dbl: formatOne(dimensions.dbl), radAngle: formatOne(number(payload?.radAngle ?? 45, "Frame radius angle", 0, 180)), mounting: safeText(payload?.mounting || "1", 20), dress: safeText(payload?.dress || "DRESS", 40), edge: edged ? "EDGED" : "UNCUT", edged };
}

function selectLens(payload, catalog, random, usedAliases) {
  const mode = payload?.mode || "random";
  const category = safeText(payload?.catalog || "");
  const supplier = safeText(payload?.supplier || "");
  const option = safeText(payload?.option || "");
  const supplierMatches = (item) => supplier === "TOG"
    ? ["TOG Rx Lab", "TOG USA"].some((value) => (item.suppliers || []).includes(value))
    : (item.suppliers || []).includes(supplier);
  const constrained = (item) => {
    if (category && category !== "All valid lenses" && item.category !== category) return false;
    if (supplier && supplier !== "All supported labs" && !supplierMatches(item)) return false;
    if (option && option !== "All lens options" && item.colorDescription !== option) return false;
    return true;
  };
  let candidates = catalog.filter(constrained);
  if (mode === "fixed") {
    const alias = String(payload?.alias || "").replace(/\D/g, "");
    const found = catalog.find((item) => item.alias === alias);
    if (!found) throw httpError("Select a valid 13-digit lens alias from the catalogue.");
    if (!constrained(found)) throw httpError("The selected alias does not match the current lens supplier, type, and option constraints.");
    return found;
  }
  candidates = candidates.filter((item) => LENS_BEHAVIOUR[item.mfType]);
  if (!candidates.length) throw httpError("No source-validated aliases with a configured RX profile match the selected catalogue.");
  if (payload?.unique && usedAliases.size) candidates = candidates.filter((item) => !usedAliases.has(item.alias));
  if (!candidates.length) throw httpError("The selected catalogue does not contain enough unique aliases for this batch.");
  return choose(candidates, random);
}

function selectItems(payload, coatings, addons, frame, random) {
  const items = [];
  if ((payload?.coating?.mode || "none") !== "none") {
    const coating = payload.coating.mode === "random" ? choose(coatings, random) : coatings.find((item) => item.sku === payload.coating.sku);
    if (!coating) throw httpError("Select a valid coating.");
    items.push({ ...coating, quantity: coating.quantity || 1, side: coating.side || "NONE", partRx: coating.partRx || "Y" });
  }
  for (const sku of Array.isArray(payload?.addons?.skus) ? payload.addons.skus : []) {
    const addon = addons.find((item) => item.sku === sku);
    if (!addon) throw httpError("An unknown add-on was selected.");
    items.push(addon);
  }
  if (frame.edged && !items.some((item) => /edge to fit/i.test(item.description))) {
    const edged = addons.find((item) => /edge to fit/i.test(item.description));
    if (!edged) throw httpError("The required EDGED add-on is not configured.", 503);
    items.push(edged);
  }
  return items.map((item) => ({ sku: safeText(item.sku, 80), source: safeText(item.source, 80), description: safeText(item.description, 160), quantity: String(Number(item.quantity || 1)), side: safeText(item.side || "NONE", 30), partRx: safeText(item.partRx || "Y", 10), kind: safeText(item.kind || "", 30) }));
}

function nextIdentifiers() {
  const sequence = readJson(SEQUENCE_FILE, { nextOrderId: 80000001, nextGkOrder: 60000001 });
  const identifiers = { orderId: String(sequence.nextOrderId), gkOrder: String(sequence.nextGkOrder), guid: crypto.randomBytes(20).toString("hex") };
  sequence.nextOrderId = Number(sequence.nextOrderId) + 1;
  sequence.nextGkOrder = Number(sequence.nextGkOrder) + 1;
  atomicWrite(SEQUENCE_FILE, `${JSON.stringify(sequence, null, 2)}\n`);
  return identifiers;
}

function previewIdentifiers(random, index) {
  const number = () => String(Math.floor(10000000 + random() * 89999999));
  const guid = crypto.createHash("sha1").update(`${random()}-${index}`).digest("hex");
  return { orderId: number(), gkOrder: number(), guid };
}

function makePatient(payload, index, random) {
  const mode = payload?.mode || "random";
  if (mode === "fixed") return normalizePatient(payload?.name);
  if (mode === "list") {
    const names = String(payload?.names || "").split(/\r?\n|;/).map((item) => item.trim()).filter(Boolean).map(normalizePatient);
    if (!names.length) throw httpError("Provide at least one patient name.");
    return names[index % names.length];
  }
  const names = readJson(path.join(DATA_DIR, "names.json"), []);
  if (!names.length) throw httpError("The RX test-name list is unavailable.", 503);
  return normalizePatient(choose(names, random));
}

function formatDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function renderRxText(order, config) {
  let template;
  try { template = fs.readFileSync(TEMPLATE_FILE, "utf8"); } catch { throw httpError("RX template is unavailable.", 503); }
  const itemBlocks = order.items.map((item) => ["item_start", `sku:${item.sku}`, `item_source:${item.source}`, `item_description:${item.description}`, `item_quantity:${item.quantity}`, `item_side:${item.side}`, `item_part_rx:${item.partRx}`, "item_end"].join("\n")).join("\n");
  const values = {
    file_version: config.defaults.fileVersion, agent_name: config.defaults.agentName, agent_version: config.defaults.agentVersion,
    lab_num: order.customer.labNum, cust_num: order.customer.custNum, cust_seq_num: order.customer.custSeqNum, date_ordered: formatDate(), remote_operator: order.customer.remoteOperator,
    instructions: order.instructions, order_id: order.identifiers.orderId, gk_order: order.identifiers.gkOrder, gk_guid: order.identifiers.guid,
    patient_name: order.patient.name, ship_name: order.customer.shipName, rx_eye: config.defaults.rxEye,
    frame_source: order.frame.source, frame_status: order.frame.status, frame_tracing: order.frame.tracing, frame_model: order.frame.model, frame_color: order.frame.color,
    frame_a: order.frame.a, frame_b: order.frame.b, frame_dbl: order.frame.dbl, frame_rad_angle: order.frame.radAngle, frame_mounting: order.frame.mounting, frame_dress: order.frame.dress, frame_edge: order.frame.edge,
    od_color_code: order.lens.colorCode, od_color_desc: order.lens.colorDescription, od_material_code: order.lens.materialCode, od_material_desc: order.lens.materialDescription, od_style_code: order.lens.styleCode, od_style_desc: order.lens.styleDescription,
    os_color_code: order.lens.colorCode, os_color_desc: order.lens.colorDescription, os_material_code: order.lens.materialCode, os_material_desc: order.lens.materialDescription, os_style_code: order.lens.styleCode, os_style_desc: order.lens.styleDescription,
    item_blocks: itemBlocks, lens_sv_mf: order.behaviour.lensSvMf, rx_type: order.behaviour.rxType, rx_dispense: order.behaviour.rxType,
    od_sphere: order.prescription.od.sphere, od_cylinder: order.prescription.od.cylinder, od_axis: order.prescription.od.axis, od_add: order.prescription.od.add, od_near: order.prescription.od.near, od_far: order.prescription.od.far, od_seg_height: order.prescription.od.segHeight,
    os_sphere: order.prescription.os.sphere, os_cylinder: order.prescription.os.cylinder, os_axis: order.prescription.os.axis, os_add: order.prescription.os.add, os_near: order.prescription.os.near, os_far: order.prescription.os.far, os_seg_height: order.prescription.os.segHeight,
    seg_height_qual: order.behaviour.requiresSegHeight ? "1" : "0"
  };
  const raw = template.replace(/\{([a-z_]+)\}/g, (_, key) => values[key] ?? "");
  return raw.replace(/\r?\n/g, config.output.lineEnding === "CRLF" ? "\r\n" : "\n");
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, file);
}

function appendLog(event, details) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`, "utf8");
}

function buildOrders(payload, { reserveIdentifiers = true } = {}) {
  const config = loadConfig();
  const batchSize = Number(payload?.batchSize ?? 1);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > config.output.maxBatchSize) throw httpError(`Batch size must be a whole number between 1 and ${config.output.maxBatchSize}.`);
  const catalog = getCatalog();
  const coatings = getCoatings();
  const addons = getAddons();
  const random = seededRandom(payload?.randomSeed || crypto.randomUUID());
  const usedAliases = new Set();
  const orders = [];
  for (let index = 0; index < batchSize; index += 1) {
    const lens = selectLens(payload?.lens, catalog, random, usedAliases);
    usedAliases.add(lens.alias);
    const behaviour = LENS_BEHAVIOUR[lens.mfType];
    if (!behaviour) {
      throw httpError(`RX generation for ${lens.mfType} is not configured from a known-good RX profile.`);
    }
    const frame = makeFrame(payload?.frame, config, random);
    const prescription = makePrescription(payload?.prescription, config, random, behaviour);
    const patient = makePatient(payload?.patient, index, random);
    const identifiers = reserveIdentifiers ? nextIdentifiers() : previewIdentifiers(random, index);
    const customer = {
      labNum: safeText(payload?.labNum || config.defaults.labNum, 30), custNum: safeText(payload?.customer?.custNum || config.defaults.custNum, 40), custSeqNum: safeText(payload?.customer?.custSeqNum || config.defaults.custSeqNum, 30),
      shipName: safeText(payload?.customer?.shipName || config.defaults.shipName, 180), remoteOperator: safeText(payload?.remoteOperator || config.defaults.remoteOperator, 80)
    };
    if (!customer.labNum || !customer.custNum || !customer.custSeqNum || !customer.shipName || !customer.remoteOperator) throw httpError("Order settings cannot be blank.");
    const order = { identifiers, customer, patient: { name: patient }, lens, behaviour, frame, prescription, items: selectItems(payload, coatings, addons, frame, random), instructions: safeText(payload?.instructions ?? config.defaults.instructions, 500) || "test only" };
    order.filename = filenameFor(identifiers.orderId, patient, normalizeExtension(payload?.extension, config.output.extension));
    order.content = renderRxText(order, config);
    orders.push(order);
  }
  return { config, orders };
}

function preview(payload) {
  const { orders } = buildOrders({ ...payload, batchSize: 1 }, { reserveIdentifiers: false });
  const order = orders[0];
  return { success: true, filename: order.filename, content: order.content, summary: summarise(order) };
}

function summarise(order) {
  return { orderId: order.identifiers.orderId, patient: order.patient.name, lens: `${order.lens.alias} · ${order.lens.materialDescription} / ${order.lens.styleDescription}`, coating: order.items.find((item) => item.kind === "coating")?.description || "None", frame: order.frame.edge, od: `${order.prescription.od.sphere} ${order.prescription.od.cylinder} × ${order.prescription.od.axis} ADD ${order.prescription.od.add}`, os: `${order.prescription.os.sphere} ${order.prescription.os.cylinder} × ${order.prescription.os.axis} ADD ${order.prescription.os.add}` };
}

function generate(payload, actor) {
  const { config, orders } = buildOrders(payload);
  const stageDir = path.resolve(ROOT, config.folders.staging);
  const generated = orders.map((order) => {
    const destination = path.join(stageDir, order.filename);
    if (fs.existsSync(destination)) throw httpError(`A staged RX file named ${order.filename} already exists.`, 409);
    atomicWrite(destination, order.content);
    appendLog("rx_generated", { orderId: order.identifiers.orderId, filename: order.filename, batchSize: orders.length, user: actor?.username || "unknown" });
    return { filename: order.filename, content: order.content, summary: summarise(order) };
  });
  return { success: true, generated, batchSize: generated.length };
}

function release(payload, actor) {
  const config = loadConfig();
  const names = Array.isArray(payload?.filenames) ? payload.filenames : [];
  if (!names.length) throw httpError("Select one or more staged files to release.");
  if (!config.folders.incoming) throw httpError("Incoming-folder release is disabled until an administrator configures data/rx/config.json.", 409);
  const stageDir = path.resolve(ROOT, config.folders.staging);
  const archiveDir = path.resolve(ROOT, config.folders.archive);
  const incomingDir = path.resolve(ROOT, config.folders.incoming);
  const released = names.map((name) => {
    const filename = path.basename(String(name));
    if (filename !== name || !filename.endsWith(config.output.extension)) throw httpError("Invalid staged filename.");
    const staged = path.join(stageDir, filename);
    if (!fs.existsSync(staged)) throw httpError(`Staged file ${filename} was not found.`, 404);
    const content = fs.readFileSync(staged);
    atomicWrite(path.join(incomingDir, filename), content);
    atomicWrite(path.join(archiveDir, filename), content);
    appendLog("rx_released", { filename, user: actor?.username || "unknown", success: true });
    return filename;
  });
  return { success: true, released };
}

// A standards-compliant store-only ZIP writer keeps batch download dependency-free.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.filename, "utf8");
    const content = Buffer.from(file.content, "utf8");
    const crc = crc32(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(0, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(content.length, 18); header.writeUInt32LE(content.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, content);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8); directory.writeUInt16LE(0, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(content.length, 20); directory.writeUInt32LE(content.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + content.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

// Internals additionally exported for lib/rx-order-submitter.js (real CV web
// orders reuse the exact same template rendering, identifier sequence, and
// per-vision-type behaviour the test generator has already proven).
module.exports = { getCatalog, getCoatings, getAddons, preview, generate, release, zip, renderRxText, loadConfig, nextIdentifiers, LENS_BEHAVIOUR, atomicWrite, filenameFor, formatDate };
