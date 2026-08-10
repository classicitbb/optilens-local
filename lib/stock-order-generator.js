/**
 * stock-order-generator.js — builds and delivers Innova `.stockhashref`
 * files for SKU-identified STOCK orders (finished or semi-finished lenses
 * ordered by SKU, no prescription attached).
 *
 * This is a completely separate order type from `.rx`/RXI patient
 * prescription orders (lib/rx-generator.js, lib/rx-order-submitter.js,
 * lib/innova-api-client.js's process_rxi). Deliberately standalone — no
 * dependency on rx-generator.js or its prescription/lens-catalog logic, and
 * its own identifier sequence (data/rx/stock-sequence.json) so the two
 * pipelines never share mutable state. The only thing they have in common
 * is the lab account they both submit to (same file under
 * data/rx/config.json: labNum/agentName/shipName/folders.incoming) — because
 * Innova's Incoming share is a single drop folder for both file types,
 * told apart only by extension.
 *
 * The InnovaAPI spec (docs/innova api - prototype.htm) has no endpoint for
 * stock/SKU orders — /process_rxi is RXI-only — so `.stockhashref` orders
 * have exactly one transport: dropping the finished file into Innova's
 * watched Incoming share (config.folders.incoming,
 * \\INNOVA-SVR\Innovations\Incoming). See docs/innova-stockhashref-format.md
 * for the field-by-field format notes.
 *
 * item_source per Russell (2026-08-10): FLENS = finished lens, SLENS =
 * semi-finished lens. Still caller-supplied per item, not inferred — there
 * is no stock-item catalog yet to look it up from.
 *
 * Same staging → release split as rx-generator.js: generate() only ever
 * writes to the local stock staging folder. release() is the one function
 * that touches the real Incoming share, and it must be called explicitly —
 * nothing here auto-releases, because that share is a live third-party
 * lab's order intake, not a sandbox.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const TEMPLATE_FILE = path.join(ROOT, "templates", "stock-order-template.txt");
const CONFIG_FILE = path.join(ROOT, "data", "rx", "config.json");
const SEQUENCE_FILE = path.join(ROOT, "data", "rx", "stock-sequence.json");
const LOG_FILE = path.join(ROOT, "data", "logs", "stock-order-generator.jsonl");

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function safeText(value, max = 240) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, file);
}

function formatDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function filenameFor(orderId, patient, extension) {
  const stem = String(patient).replace(/[^A-Z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  return `${orderId}_${stem}${extension.startsWith(".") ? extension : `.${extension}`}`;
}

/** Own counter, deliberately separate from rx-generator.js's sequence.json
 * (data/rx/sequence.json) — stock and Rx order IDs never share state, and
 * a distinct starting range (90000001/70000001) keeps them visually
 * distinguishable from Rx order IDs (80000001/60000001) in the Incoming
 * folder or Innova's own order log. */
function nextIdentifiers() {
  const sequence = readJson(SEQUENCE_FILE, { nextOrderId: 90000001, nextGkOrder: 70000001 });
  const identifiers = { orderId: String(sequence.nextOrderId), gkOrder: String(sequence.nextGkOrder), guid: crypto.randomBytes(20).toString("hex") };
  sequence.nextOrderId = Number(sequence.nextOrderId) + 1;
  sequence.nextGkOrder = Number(sequence.nextGkOrder) + 1;
  atomicWrite(SEQUENCE_FILE, `${JSON.stringify(sequence, null, 2)}\n`);
  return identifiers;
}

function loadConfig() {
  const config = readJson(CONFIG_FILE, null);
  if (!config) throw httpError("Lab configuration is unavailable (data/rx/config.json).", 503);
  if (!config.stockOrder) throw httpError("Stock order defaults are not configured (data/rx/config.json → stockOrder).", 503);
  if (!config.folders?.stockStaging || !config.folders?.stockArchive) {
    throw httpError("Stock order staging/archive folders are not configured (data/rx/config.json → folders.stockStaging / stockArchive).", 503);
  }
  return config;
}

const VALID_SOURCES = new Set(["FLENS", "SLENS"]); // FLENS = finished lens, SLENS = semi-finished lens

/** Build the item_start/item_end blocks. Every field is caller-supplied —
 * this module never guesses a SKU, source, or description. */
function buildItems(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  if (!items.length) throw httpError("A stock order needs at least one item.");
  return items.map((raw, index) => {
    const sku = safeText(raw?.sku, 40);
    if (!/^\d{6,20}$/.test(sku)) throw httpError(`Item ${index + 1}: sku must be a numeric Innova SKU.`);
    const source = safeText(raw?.source, 20).toUpperCase();
    if (!VALID_SOURCES.has(source)) throw httpError(`Item ${index + 1}: source must be FLENS (finished lens) or SLENS (semi-finished lens) — got "${raw?.source ?? ""}".`);
    const description = safeText(raw?.description, 200);
    if (!description) throw httpError(`Item ${index + 1}: description is required.`);
    const quantity = Number(raw?.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1) throw httpError(`Item ${index + 1}: quantity must be a positive whole number.`);
    const partRx = safeText(raw?.partRx || "Y", 10);
    return {
      sku, source, description,
      quantity: String(quantity),
      comment: safeText(raw?.comment, 200),
      partRx,
    };
  });
}

function renderItemBlocks(items) {
  return items.map((item) => [
    "item_start",
    `sku:${item.sku}`,
    `item_source:${item.source}`,
    `item_description:${item.description}`,
    `item_quantity:${item.quantity}`,
    `item_comment:${item.comment}`,
    `item_part_rx:${item.partRx}`,
    "item_end",
  ].join("\n")).join("\n");
}

function renderStockOrderText(order, config) {
  let template;
  try { template = fs.readFileSync(TEMPLATE_FILE, "utf8"); } catch { throw httpError("Stock order template is unavailable.", 503); }
  const values = {
    file_version: config.stockOrder.fileVersion,
    agent_name: config.defaults.agentName,
    agent_version: config.defaults.agentVersion,
    lab_num: order.customer.labNum,
    cust_num: order.customer.custNum,
    cust_seq_num: order.customer.custSeqNum,
    date_ordered: formatDate(),
    instructions: order.instructions,
    order_id: order.identifiers.orderId,
    gk_order: order.identifiers.gkOrder,
    gk_guid: order.identifiers.guid,
    customer_po_num: order.poNum,
    patient_name: order.patientName,
    ship_name: order.customer.shipName,
    rx_eye: config.stockOrder.rxEye,
    frame_tracing: config.stockOrder.frameTracing,
    frame_rad_angle: config.stockOrder.frameRadAngle,
    item_blocks: renderItemBlocks(order.items),
    seg_height_qual: config.stockOrder.segHeightQual ?? "1",
  };
  const raw = template.replace(/\{([a-z_]+)\}/g, (_, key) => values[key] ?? "");
  return raw.replace(/\r?\n/g, config.output?.lineEnding === "CRLF" ? "\r\n" : "\n");
}

function buildStockOrder(payload, config, { reserveIdentifiers = true } = {}) {
  const customer = {
    labNum: safeText(payload?.customer?.labNum || config.defaults.labNum, 30),
    custNum: safeText(payload?.customer?.custNum, 40),
    custSeqNum: safeText(payload?.customer?.custSeqNum || config.defaults.custSeqNum, 30),
    shipName: safeText(payload?.customer?.shipName || config.defaults.shipName, 180),
  };
  if (!customer.labNum || !customer.custNum || !customer.custSeqNum || !customer.shipName) {
    throw httpError("Stock order customer.custNum is required (labNum/custSeqNum/shipName fall back to config defaults).");
  }
  const patientName = safeText(payload?.patientName || "Stock Order", 120);
  const identifiers = reserveIdentifiers ? nextIdentifiers() : { orderId: "PREVIEW", gkOrder: "PREVIEW", guid: crypto.randomBytes(20).toString("hex") };
  const order = {
    identifiers,
    customer,
    poNum: safeText(payload?.poNum, 40),
    patientName,
    items: buildItems(payload?.items),
    instructions: safeText(payload?.instructions, 500),
  };
  order.filename = filenameFor(identifiers.orderId, patientName, config.stockOrder.extension || ".stockhashref");
  order.content = renderStockOrderText(order, config);
  return order;
}

function appendLog(event, details) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`, "utf8");
}

function preview(payload) {
  const config = loadConfig();
  const order = buildStockOrder(payload, config, { reserveIdentifiers: false });
  return { success: true, filename: order.filename, content: order.content };
}

/** Writes ONLY to the local staging folder. Never touches the Incoming share. */
function generate(payload, actor) {
  const config = loadConfig();
  const order = buildStockOrder(payload, config);
  const stageDir = path.resolve(ROOT, config.folders.stockStaging);
  const destination = path.join(stageDir, order.filename);
  if (fs.existsSync(destination)) throw httpError(`A staged stock order named ${order.filename} already exists.`, 409);
  atomicWrite(destination, order.content);
  appendLog("stock_order_generated", { orderId: order.identifiers.orderId, filename: order.filename, custNum: order.customer.custNum, itemCount: order.items.length, user: actor?.username || "unknown" });
  return { success: true, filename: order.filename, content: order.content };
}

/**
 * Copies a staged file into the real Incoming share (and a local archive
 * copy). This is the one function in this module with an external
 * side effect — Innova's system will pick up and process whatever lands
 * in config.folders.incoming. Call it deliberately, one file at a time.
 */
function release(payload, actor) {
  const config = loadConfig();
  const names = Array.isArray(payload?.filenames) ? payload.filenames : [];
  if (!names.length) throw httpError("Select one or more staged stock orders to release.");
  if (!config.folders.incoming) throw httpError("Incoming-folder release is disabled until data/rx/config.json → folders.incoming is set.", 409);
  const stageDir = path.resolve(ROOT, config.folders.stockStaging);
  const archiveDir = path.resolve(ROOT, config.folders.stockArchive);
  const incomingDir = path.resolve(ROOT, config.folders.incoming);
  const extension = config.stockOrder.extension || ".stockhashref";
  const released = names.map((name) => {
    const filename = path.basename(String(name));
    if (filename !== name || !filename.endsWith(extension)) throw httpError("Invalid staged filename.");
    const staged = path.join(stageDir, filename);
    if (!fs.existsSync(staged)) throw httpError(`Staged file ${filename} was not found.`, 404);
    const content = fs.readFileSync(staged);
    atomicWrite(path.join(incomingDir, filename), content);
    atomicWrite(path.join(archiveDir, filename), content);
    appendLog("stock_order_released", { filename, user: actor?.username || "unknown", success: true, incomingDir });
    return filename;
  });
  return { success: true, released };
}

module.exports = { preview, generate, release, renderStockOrderText, buildStockOrder };
