// Chemistrie clip order recording: CRUD over the chemistry.* schema (see
// database/042-chemistry-clip-module.sql). Usage is an app-owned ledger --
// this module never writes to Innovations; see that migration's header
// note and AGENTS.md's source-system writeback rule.
const sql = require("mssql");
const { getAppPool } = require("./db");

const ORDER_ROLES = ["lens", "bridge", "magnet", "bushing", "spacer", "case", "cloth", "other"];
const ENTRY_METHODS = ["barcode", "voice", "manual"];

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function notFound(message) {
  return Object.assign(new Error(message), { statusCode: 404 });
}

function conflict(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

// column -> { camelCase body key, mssql type, transform }
const ORDER_FIELD_SPECS = [
  ["job_number", "jobNumber", sql.NVarChar(40)],
  ["tray_number", "trayNumber", sql.NVarChar(40)],
  ["optician", "optician", sql.NVarChar(80)],
  ["order_date", "orderDate", sql.Date, (v) => (v ? new Date(v) : null)],
  ["base_curve", "baseCurve", sql.NVarChar(10)],
  ["lens_color", "lensColor", sql.NVarChar(60)],
  ["lens_material", "lensMaterial", sql.NVarChar(60)],
  ["bridge_color", "bridgeColor", sql.NVarChar(30)],
  ["bridge_size_mm", "bridgeSizeMm", sql.Decimal(5, 2), (v) => (v === "" || v == null ? null : Number(v))],
  ["magnet_color", "magnetColor", sql.NVarChar(30)],
  ["magnet_separation_mm", "magnetSeparationMm", sql.Decimal(5, 2), (v) => (v === "" || v == null ? null : Number(v))],
  ["upsize_amount", "upsizeAmount", sql.Decimal(5, 2), (v) => (v === "" || v == null ? null : Number(v))],
  ["edge_work", "edgeWork", sql.NVarChar(20)],
  ["clip_only", "clipOnly", sql.Bit, (v) => !!v],
  ["redrill_only", "redrillOnly", sql.Bit, (v) => !!v],
  ["permanent_crystal", "permanentCrystal", sql.Bit, (v) => !!v],
  ["magnetic_crystal", "magneticCrystal", sql.Bit, (v) => !!v],
  ["round_square", "roundSquare", sql.NVarChar(10)],
  ["comments", "comments", sql.NVarChar(sql.MAX)],
  ["fit_checked", "fitChecked", sql.Bit, (v) => !!v],
  ["fit_notes", "fitNotes", sql.NVarChar(sql.MAX)]
];

function bindOrderFields(request, body) {
  for (const [column, key, type, transform] of ORDER_FIELD_SPECS) {
    const raw = body[key];
    request.input(column, type, transform ? transform(raw) : (raw ?? null));
  }
}

function mapOrderRow(row) {
  return {
    orderId: row.order_id,
    jobNumber: row.job_number,
    trayNumber: row.tray_number,
    patientName: row.patient_name,
    optician: row.optician,
    orderDate: row.order_date,
    baseCurve: row.base_curve,
    lensColor: row.lens_color,
    lensMaterial: row.lens_material,
    bridgeColor: row.bridge_color,
    bridgeSizeMm: row.bridge_size_mm,
    magnetColor: row.magnet_color,
    magnetSeparationMm: row.magnet_separation_mm,
    upsizeAmount: row.upsize_amount,
    edgeWork: row.edge_work,
    clipOnly: !!row.clip_only,
    redrillOnly: !!row.redrill_only,
    permanentCrystal: !!row.permanent_crystal,
    magneticCrystal: !!row.magnetic_crystal,
    roundSquare: row.round_square,
    comments: row.comments,
    fitChecked: !!row.fit_checked,
    fitNotes: row.fit_notes,
    status: row.status,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapItemRow(row) {
  return {
    orderItemId: row.order_item_id,
    orderId: row.order_id,
    innovationsMiscItemId: row.innovations_misc_item_id,
    sku: row.sku,
    itemName: row.item_name,
    itemRole: row.item_role,
    quantity: row.quantity,
    entryMethod: row.entry_method,
    createdAt: row.created_at
  };
}

async function recordEvent(pool, orderId, eventType, eventData, actor) {
  await pool.request()
    .input("order_id", sql.UniqueIdentifier, orderId)
    .input("event_type", sql.NVarChar(40), eventType)
    .input("event_data", sql.NVarChar(sql.MAX), eventData != null ? JSON.stringify(eventData) : null)
    .input("actor", sql.NVarChar(100), actor || null)
    .query(`
      INSERT INTO chemistry.order_events (order_id, event_type, event_data, actor)
      VALUES (@order_id, @event_type, @event_data, @actor)
    `);
}

async function loadOrder(pool, orderId) {
  const orderResult = await pool.request()
    .input("order_id", sql.UniqueIdentifier, orderId)
    .query("SELECT * FROM chemistry.orders WHERE order_id = @order_id");
  const orderRow = orderResult.recordset[0];
  if (!orderRow) throw notFound("Chemistry order not found.");

  const itemsResult = await pool.request()
    .input("order_id", sql.UniqueIdentifier, orderId)
    .query("SELECT * FROM chemistry.order_items WHERE order_id = @order_id ORDER BY created_at");

  const photosResult = await pool.request()
    .input("order_id", sql.UniqueIdentifier, orderId)
    .query("SELECT order_photo_id, file_path, taken_at FROM chemistry.order_photos WHERE order_id = @order_id ORDER BY taken_at");

  return {
    ...mapOrderRow(orderRow),
    items: itemsResult.recordset.map(mapItemRow),
    photos: photosResult.recordset.map((p) => ({ orderPhotoId: p.order_photo_id, filePath: p.file_path, takenAt: p.taken_at }))
  };
}

async function getOrder(orderId) {
  const pool = await getAppPool();
  return loadOrder(pool, orderId);
}

// search: matches patient name, tray number, or job number (contains, case-insensitive).
async function listOrders({ search, limit } = {}) {
  const pool = await getAppPool();
  const top = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const request = pool.request();
  let where = "";
  if (search && String(search).trim()) {
    request.input("search", sql.NVarChar(300), `%${String(search).trim()}%`);
    where = "WHERE patient_name LIKE @search OR tray_number LIKE @search OR job_number LIKE @search";
  }
  const result = await request.query(`
    SELECT TOP (${top}) order_id, job_number, tray_number, patient_name, optician, order_date,
           base_curve, bridge_color, magnet_color, status, created_at
    FROM chemistry.orders
    ${where}
    ORDER BY created_at DESC
  `);
  return result.recordset.map((row) => ({
    orderId: row.order_id,
    jobNumber: row.job_number,
    trayNumber: row.tray_number,
    patientName: row.patient_name,
    optician: row.optician,
    orderDate: row.order_date,
    baseCurve: row.base_curve,
    bridgeColor: row.bridge_color,
    magnetColor: row.magnet_color,
    status: row.status,
    createdAt: row.created_at
  }));
}

async function getDefaultBundleItems() {
  const pool = await getAppPool();
  const result = await pool.request().query(`
    SELECT b.item_role, b.sku, c.name, c.innovations_misc_item_id
    FROM chemistry.default_bundle_items b
    LEFT JOIN chemistry.item_catalog_cache c ON c.sku = b.sku
    WHERE b.is_active = 1
  `);
  return result.recordset.map((row) => ({
    itemRole: row.item_role,
    sku: row.sku,
    name: row.name || null,
    innovationsMiscItemId: row.innovations_misc_item_id || null
  }));
}

async function createOrder(body, actor) {
  if (!body || !String(body.patientName || "").trim()) {
    throw badRequest("patientName is required.");
  }

  const pool = await getAppPool();
  const request = pool.request();
  request.input("patient_name", sql.NVarChar(300), String(body.patientName).trim());
  request.input("created_by", sql.NVarChar(100), actor || null);
  bindOrderFields(request, body);

  const result = await request.query(`
    INSERT INTO chemistry.orders (
      job_number, tray_number, patient_name, optician, order_date,
      base_curve, lens_color, lens_material, bridge_color, bridge_size_mm,
      magnet_color, magnet_separation_mm, upsize_amount, edge_work,
      clip_only, redrill_only, permanent_crystal, magnetic_crystal,
      round_square, comments, fit_checked, fit_notes, created_by
    )
    OUTPUT inserted.order_id
    VALUES (
      @job_number, @tray_number, @patient_name, @optician,
      ISNULL(@order_date, CAST(SYSUTCDATETIME() AS date)),
      @base_curve, @lens_color, @lens_material, @bridge_color, @bridge_size_mm,
      @magnet_color, @magnet_separation_mm, @upsize_amount, @edge_work,
      @clip_only, @redrill_only, @permanent_crystal, @magnetic_crystal,
      @round_square, @comments, @fit_checked, @fit_notes, @created_by
    )
  `);

  const orderId = result.recordset[0].order_id;
  await recordEvent(pool, orderId, "created", { patientName: body.patientName }, actor);

  const bundleItems = await getDefaultBundleItems();
  for (const item of bundleItems) {
    if (!item.innovationsMiscItemId) continue; // catalog not synced yet; skip rather than insert a broken row
    await addOrderItemInternal(pool, orderId, {
      innovationsMiscItemId: item.innovationsMiscItemId,
      sku: item.sku,
      itemName: item.name,
      itemRole: item.itemRole,
      quantity: 1,
      entryMethod: "manual"
    }, actor);
  }

  return loadOrder(pool, orderId);
}

async function requireDraft(pool, orderId) {
  const result = await pool.request()
    .input("order_id", sql.UniqueIdentifier, orderId)
    .query("SELECT status FROM chemistry.orders WHERE order_id = @order_id");
  const row = result.recordset[0];
  if (!row) throw notFound("Chemistry order not found.");
  if (row.status === "locked") throw conflict("Order is locked. Unlock it before editing.");
}

// Replaces every editable field from `body` (fields absent from body are
// written as NULL) -- the page always submits the full edited form, not a
// partial patch.
async function updateOrder(orderId, body, actor) {
  const pool = await getAppPool();
  await requireDraft(pool, orderId);
  if (body.patientName != null && !String(body.patientName).trim()) {
    throw badRequest("patientName cannot be blank.");
  }

  const request = pool.request();
  request.input("order_id", sql.UniqueIdentifier, orderId);
  if (body.patientName != null) request.input("patient_name", sql.NVarChar(300), String(body.patientName).trim());
  bindOrderFields(request, body);

  const setClauses = ORDER_FIELD_SPECS.map(([column]) => `${column} = @${column}`);
  if (body.patientName != null) setClauses.push("patient_name = @patient_name");
  setClauses.push("updated_at = SYSUTCDATETIME()");

  await request.query(`
    UPDATE chemistry.orders
    SET ${setClauses.join(", ")}
    WHERE order_id = @order_id
  `);

  await recordEvent(pool, orderId, "updated", null, actor);
  return loadOrder(pool, orderId);
}

async function lockOrder(orderId, actor) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("order_id", sql.UniqueIdentifier, orderId)
    .input("locked_by", sql.NVarChar(100), actor || null)
    .query(`
      UPDATE chemistry.orders
      SET status = N'locked', locked_at = SYSUTCDATETIME(), locked_by = @locked_by
      WHERE order_id = @order_id AND status = N'draft'
    `);
  if (result.rowsAffected[0] === 0) {
    const exists = await pool.request()
      .input("order_id", sql.UniqueIdentifier, orderId)
      .query("SELECT status FROM chemistry.orders WHERE order_id = @order_id");
    if (!exists.recordset[0]) throw notFound("Chemistry order not found.");
    throw conflict("Order is already locked.");
  }
  await recordEvent(pool, orderId, "locked", null, actor);
  return loadOrder(pool, orderId);
}

async function unlockOrder(orderId, actor) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("order_id", sql.UniqueIdentifier, orderId)
    .query(`
      UPDATE chemistry.orders
      SET status = N'draft', locked_at = NULL, locked_by = NULL
      WHERE order_id = @order_id AND status = N'locked'
    `);
  if (result.rowsAffected[0] === 0) {
    const exists = await pool.request()
      .input("order_id", sql.UniqueIdentifier, orderId)
      .query("SELECT status FROM chemistry.orders WHERE order_id = @order_id");
    if (!exists.recordset[0]) throw notFound("Chemistry order not found.");
    throw conflict("Order is not locked.");
  }
  await recordEvent(pool, orderId, "unlocked", null, actor);
  return loadOrder(pool, orderId);
}

async function addOrderItemInternal(pool, orderId, item, actor) {
  const result = await pool.request()
    .input("order_id", sql.UniqueIdentifier, orderId)
    .input("innovations_misc_item_id", sql.Int, item.innovationsMiscItemId)
    .input("sku", sql.NVarChar(40), item.sku)
    .input("item_name", sql.NVarChar(300), item.itemName)
    .input("item_role", sql.NVarChar(30), item.itemRole)
    .input("quantity", sql.Decimal(9, 2), item.quantity)
    .input("entry_method", sql.NVarChar(20), item.entryMethod)
    .query(`
      INSERT INTO chemistry.order_items (
        order_id, innovations_misc_item_id, sku, item_name, item_role, quantity, entry_method
      )
      OUTPUT inserted.order_item_id
      VALUES (
        @order_id, @innovations_misc_item_id, @sku, @item_name, @item_role, @quantity, @entry_method
      )
    `);
  await recordEvent(pool, orderId, "item_added", { sku: item.sku, quantity: item.quantity, entryMethod: item.entryMethod }, actor);
  return result.recordset[0].order_item_id;
}

async function addOrderItem(orderId, body, actor) {
  if (!body || !String(body.sku || "").trim()) throw badRequest("sku is required.");
  if (!ORDER_ROLES.includes(body.itemRole)) throw badRequest(`itemRole must be one of: ${ORDER_ROLES.join(", ")}`);
  if (!ENTRY_METHODS.includes(body.entryMethod)) throw badRequest(`entryMethod must be one of: ${ENTRY_METHODS.join(", ")}`);
  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) throw badRequest("quantity must be a positive number.");

  const pool = await getAppPool();
  await requireDraft(pool, orderId);

  const catalogResult = await pool.request()
    .input("sku", sql.NVarChar(40), String(body.sku).trim())
    .query("SELECT innovations_misc_item_id, sku, name FROM chemistry.item_catalog_cache WHERE sku = @sku");
  const catalogRow = catalogResult.recordset[0];
  if (!catalogRow) throw notFound(`No catalog item found for SKU ${body.sku}. Has the catalog sync run yet?`);

  await addOrderItemInternal(pool, orderId, {
    innovationsMiscItemId: catalogRow.innovations_misc_item_id,
    sku: catalogRow.sku,
    itemName: body.itemName || catalogRow.name,
    itemRole: body.itemRole,
    quantity,
    entryMethod: body.entryMethod
  }, actor);

  return loadOrder(pool, orderId);
}

async function removeOrderItem(orderId, orderItemId, actor) {
  const pool = await getAppPool();
  await requireDraft(pool, orderId);

  const result = await pool.request()
    .input("order_id", sql.UniqueIdentifier, orderId)
    .input("order_item_id", sql.UniqueIdentifier, orderItemId)
    .query("DELETE FROM chemistry.order_items WHERE order_item_id = @order_item_id AND order_id = @order_id");
  if (result.rowsAffected[0] === 0) throw notFound("Order item not found.");

  await recordEvent(pool, orderId, "item_removed", { orderItemId }, actor);
  return loadOrder(pool, orderId);
}

async function lookupCatalogItem(sku) {
  if (!sku || !String(sku).trim()) throw badRequest("sku is required.");
  const pool = await getAppPool();
  const result = await pool.request()
    .input("sku", sql.NVarChar(40), String(sku).trim())
    .query("SELECT * FROM chemistry.item_available_qty WHERE sku = @sku");
  const row = result.recordset[0];
  if (!row) throw notFound(`No catalog item found for SKU ${sku}.`);
  return {
    innovationsMiscItemId: row.innovations_misc_item_id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    onHand: row.on_hand,
    usedSinceSync: row.used_since_sync,
    availableQty: row.available_qty,
    lastSyncedAt: row.last_synced_at
  };
}

async function searchCatalog(term, limit) {
  const pool = await getAppPool();
  const top = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const result = await pool.request()
    .input("term", sql.NVarChar(300), `%${String(term || "").trim()}%`)
    .query(`
      SELECT TOP (${top}) * FROM chemistry.item_available_qty
      WHERE sku LIKE @term OR name LIKE @term
      ORDER BY name
    `);
  return result.recordset.map((row) => ({
    innovationsMiscItemId: row.innovations_misc_item_id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    availableQty: row.available_qty
  }));
}

const LENS_CATEGORIES = [
  "1 SOLID SNAPON",
  "2 GRADIENT SNAPON",
  "3 Chemistrie+ Readers",
  "4 MIRROR SNAPON",
  "5 Chemistrie plus blue layer"
];

function mapCatalogOptionRow(row) {
  return { sku: row.sku, name: row.name, category: row.category, onHand: row.on_hand };
}

// Options for the clip-parameter pickers on the order form. Sourced from the
// same read-only Innovations catalog cache as barcode/manual SKU entry --
// lens/bridge/magnet/spacer are real MiscItems SKUs, not free-standing
// attributes, so there is no separate options table to maintain here.
// Magnets and spacers share one Innovations group ("MAGNETS"); they're split
// by name since the shop only stocks/uses round magnets (square excluded)
// while spacers come in both.
async function getClipPartOptions() {
  const pool = await getAppPool();

  const lensRequest = pool.request();
  const lensParams = LENS_CATEGORIES.map((cat, i) => {
    lensRequest.input(`lens_cat_${i}`, sql.NVarChar(120), cat);
    return `@lens_cat_${i}`;
  });
  const lensResult = await lensRequest.query(`
    SELECT sku, name, category, on_hand FROM chemistry.item_catalog_cache
    WHERE category IN (${lensParams.join(", ")})
    ORDER BY category, name
  `);

  const bridgeResult = await pool.request().query(`
    SELECT sku, name, category, on_hand FROM chemistry.item_catalog_cache
    WHERE category = N'BRIDGES'
    ORDER BY name
  `);

  const magnetResult = await pool.request().query(`
    SELECT sku, name, category, on_hand FROM chemistry.item_catalog_cache
    WHERE category = N'MAGNETS' AND name NOT LIKE '%SPACER%' AND name NOT LIKE '%SQUARE%'
    ORDER BY name
  `);

  const spacerResult = await pool.request().query(`
    SELECT sku, name, category, on_hand FROM chemistry.item_catalog_cache
    WHERE category = N'MAGNETS' AND name LIKE '%SPACER%'
    ORDER BY name
  `);

  return {
    lens: lensResult.recordset.map(mapCatalogOptionRow),
    bridge: bridgeResult.recordset.map(mapCatalogOptionRow),
    magnet: magnetResult.recordset.map(mapCatalogOptionRow),
    spacer: spacerResult.recordset.map(mapCatalogOptionRow)
  };
}

module.exports = {
  ORDER_ROLES,
  ENTRY_METHODS,
  getOrder,
  listOrders,
  getDefaultBundleItems,
  createOrder,
  updateOrder,
  lockOrder,
  unlockOrder,
  addOrderItem,
  removeOrderItem,
  lookupCatalogItem,
  searchCatalog,
  getClipPartOptions
};
