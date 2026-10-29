const { getAppPool } = require("./db");

const CODE_MAX = 40;
const DESCRIPTION_MAX = 500;
const ALIASES_MAX = 1000;
const MAX_INVOICE_TARIFFS = 40;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// Codes are kept exactly as typed (only surrounding whitespace is trimmed):
// punctuation and length vary between 4 and 14 digits and must not be padded.
function validateTariffInput(input = {}) {
  const tariffCode = clean(input.tariffCode);
  const description = clean(input.description);
  const searchAliases = clean(input.searchAliases);
  if (!tariffCode) throw httpError("Tariff code is required.");
  if (tariffCode.length > CODE_MAX) throw httpError(`Tariff code must be ${CODE_MAX} characters or fewer.`);
  if (!/^[0-9][0-9 .\-/]*$/.test(tariffCode)) throw httpError("Tariff code may only contain digits, dots, dashes and spaces.");
  if (!description) throw httpError("Description is required.");
  if (description.length > DESCRIPTION_MAX) throw httpError(`Description must be ${DESCRIPTION_MAX} characters or fewer.`);
  if (searchAliases.length > ALIASES_MAX) throw httpError(`Search keywords must be ${ALIASES_MAX} characters or fewer.`);
  const verificationStatus = input.verificationStatus === "verified" ? "verified" : "unverified";
  return { tariffCode, description, searchAliases, verificationStatus };
}

function shapeRow(row) {
  return { ...row, isActive: Boolean(row.isActive), isPinned: Boolean(row.isPinned) };
}

const SELECT_SQL = `
  SELECT
    t.tariff_id AS id,
    t.tariff_code AS tariffCode,
    t.description,
    ISNULL(t.search_aliases, N'') AS searchAliases,
    t.verification_status AS verificationStatus,
    t.is_active AS isActive,
    t.is_pinned AS isPinned,
    t.display_order AS displayOrder,
    t.created_at AS createdAt,
    t.updated_at AS updatedAt,
    (SELECT COUNT(*) FROM delivery.commercial_invoice_tariffs u WHERE u.tariff_id = t.tariff_id) AS usageCount
  FROM delivery.tariff_codes t
`;

async function listTariffCodes({ includeInactive = false } = {}) {
  const pool = await getAppPool();
  const result = await pool.request().query(`
    ${SELECT_SQL}
    ${includeInactive ? "" : "WHERE t.is_active = 1"}
    ORDER BY t.is_pinned DESC, t.display_order, t.tariff_code
  `);
  return result.recordset.map(shapeRow);
}

async function getTariffCode(id) {
  if (!GUID_PATTERN.test(String(id || ""))) throw httpError("Tariff code not found.", 404);
  const pool = await getAppPool();
  const result = await pool.request().input("id", id).query(`${SELECT_SQL} WHERE t.tariff_id = @id`);
  const row = result.recordset[0];
  if (!row) throw httpError("Tariff code not found.", 404);
  return shapeRow(row);
}

async function assertCodeFree(pool, tariffCode, exceptId = null) {
  const result = await pool.request().input("code", tariffCode).input("id", exceptId).query(`
    SELECT TOP 1 tariff_id FROM delivery.tariff_codes
    WHERE tariff_code = @code AND (@id IS NULL OR tariff_id <> @id)
  `);
  if (result.recordset.length) throw httpError(`Tariff code ${tariffCode} is already in the library.`, 409);
}

function parseOrder(value, fallback) {
  if (value === undefined || value === null || value === "" || !Number.isFinite(Number(value))) return fallback;
  return Math.trunc(Number(value));
}

async function createTariffCode(input, actorUserId = null) {
  const data = validateTariffInput(input);
  const pool = await getAppPool();
  await assertCodeFree(pool, data.tariffCode);
  const next = await pool.request().query("SELECT ISNULL(MAX(display_order), 0) + 10 AS nextOrder FROM delivery.tariff_codes");
  const result = await pool.request()
    .input("code", data.tariffCode)
    .input("description", data.description)
    .input("aliases", data.searchAliases || null)
    .input("status", data.verificationStatus)
    .input("pinned", input.isPinned ? 1 : 0)
    .input("order", parseOrder(input.displayOrder, next.recordset[0].nextOrder))
    .input("actor", actorUserId)
    .query(`
      INSERT INTO delivery.tariff_codes (tariff_code, description, search_aliases, verification_status, is_pinned, display_order, created_by_user_id, updated_by_user_id)
      OUTPUT inserted.tariff_id AS id
      VALUES (@code, @description, @aliases, @status, @pinned, @order, @actor, @actor)
    `);
  return getTariffCode(result.recordset[0].id);
}

async function updateTariffCode(id, input, actorUserId = null) {
  const existing = await getTariffCode(id);
  const data = validateTariffInput({ ...existing, ...input });
  const pool = await getAppPool();
  await assertCodeFree(pool, data.tariffCode, id);
  const isActive = input.isActive === undefined ? existing.isActive : Boolean(input.isActive);
  const isPinned = input.isPinned === undefined ? existing.isPinned : Boolean(input.isPinned);
  await pool.request()
    .input("id", id)
    .input("code", data.tariffCode)
    .input("description", data.description)
    .input("aliases", data.searchAliases || null)
    .input("status", data.verificationStatus)
    .input("active", isActive ? 1 : 0)
    .input("pinned", isPinned ? 1 : 0)
    .input("order", parseOrder(input.displayOrder, existing.displayOrder))
    .input("actor", actorUserId)
    .query(`
      UPDATE delivery.tariff_codes
      SET tariff_code = @code, description = @description, search_aliases = @aliases,
          verification_status = @status, is_active = @active, is_pinned = @pinned,
          display_order = @order, updated_by_user_id = @actor, updated_at = SYSUTCDATETIME()
      WHERE tariff_id = @id
    `);
  return getTariffCode(id);
}

// Hard delete only when no invoice has ever referenced the entry; otherwise the
// caller is told to deactivate. Invoice snapshots are unaffected either way.
async function deleteTariffCode(id) {
  const existing = await getTariffCode(id);
  if (existing.usageCount > 0) {
    throw httpError("This tariff has been used on invoices and cannot be deleted. Deactivate it instead.", 409);
  }
  const pool = await getAppPool();
  await pool.request().input("id", id).query("DELETE FROM delivery.tariff_codes WHERE tariff_id = @id");
  return { deleted: true, id };
}

async function getInvoiceTariffs(sessionId) {
  const pool = await getAppPool();
  const result = await pool.request().input("sid", sessionId).query(`
    SELECT tariff_id AS tariffId, tariff_code AS tariffCode, description
    FROM delivery.commercial_invoice_tariffs
    WHERE shipment_session_id = @sid
    ORDER BY position
  `);
  return result.recordset;
}

// Normalises a submitted selection: trims, validates, drops duplicate codes and
// keeps the order the user chose.
function normalizeInvoiceTariffs(items) {
  if (!Array.isArray(items)) throw httpError("Tariff selections must be a list.");
  const seen = new Set();
  const rows = [];
  for (const item of items) {
    const tariffCode = clean(item?.tariffCode);
    const description = clean(item?.description);
    if (!tariffCode) throw httpError("Each tariff needs a code.");
    if (tariffCode.length > CODE_MAX) throw httpError(`Tariff code must be ${CODE_MAX} characters or fewer.`);
    if (!description) throw httpError(`Tariff ${tariffCode} needs a description.`);
    if (description.length > DESCRIPTION_MAX) throw httpError(`Description must be ${DESCRIPTION_MAX} characters or fewer.`);
    const key = tariffCode.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ tariffId: GUID_PATTERN.test(String(item?.tariffId || "")) ? item.tariffId : null, tariffCode, description });
  }
  if (rows.length > MAX_INVOICE_TARIFFS) throw httpError(`An invoice can carry at most ${MAX_INVOICE_TARIFFS} tariff lines.`);
  return rows;
}

// Replaces the invoice's selection with snapshots of the code and description
// as the user saw them, so later library edits never alter the invoice.
async function saveInvoiceTariffs(sessionId, items, actorUserId = null) {
  const rows = normalizeInvoiceTariffs(items);
  const pool = await getAppPool();
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    await transaction.request().input("sid", sessionId).query("DELETE FROM delivery.commercial_invoice_tariffs WHERE shipment_session_id = @sid");
    for (const [index, row] of rows.entries()) {
      await transaction.request()
        .input("sid", sessionId)
        .input("position", index + 1)
        .input("tariff_id", row.tariffId)
        .input("code", row.tariffCode)
        .input("description", row.description)
        .input("actor", actorUserId)
        .query(`
          INSERT INTO delivery.commercial_invoice_tariffs (shipment_session_id, position, tariff_id, tariff_code, description, created_by_user_id)
          VALUES (@sid, @position, @tariff_id, @code, @description, @actor)
        `);
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  }
  return getInvoiceTariffs(sessionId);
}

module.exports = {
  validateTariffInput,
  normalizeInvoiceTariffs,
  listTariffCodes,
  getTariffCode,
  createTariffCode,
  updateTariffCode,
  deleteTariffCode,
  getInvoiceTariffs,
  saveInvoiceTariffs
};
