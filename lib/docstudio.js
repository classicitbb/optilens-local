const sql = require("mssql");
const { getAppPool } = require("./db");
const { recordAuditEvent } = require("./audit");

const DOCUMENT_TYPES = new Set(["invoice", "quote", "proforma", "receipt"]);
const PAPER_SIZES = new Set(["letter", "a4"]);
const SHARE_LEVELS = new Set(["view", "edit"]);

function versionFromRow(row) {
  const value = row?.file_version_hex || row?.version || row?.file_version || "";
  if (Buffer.isBuffer(value)) return value.toString("hex").toUpperCase();
  const textValue = String(value || "").trim();
  const hex = textValue.startsWith("0x") ? textValue.slice(2) : textValue;
  if (/^[0-9a-fA-F]{16}$/.test(hex)) return hex.toUpperCase();
  if (textValue.length === 8) return Buffer.from(textValue, "latin1").toString("hex").toUpperCase();
  return "";
}

function versionToBuffer(version) {
  const value = String(version || "").trim();
  if (!/^[0-9a-fA-F]{16}$/.test(value)) {
    const error = new Error("This document has changed. Reload it before saving.");
    error.statusCode = 409;
    throw error;
  }
  return Buffer.from(value, "hex");
}

function text(value, max = 220) {
  const clean = String(value || "").trim();
  return clean ? clean.slice(0, max) : null;
}

function requiredName(payload) {
  return text(payload.documentName || payload.name || payload.billingNumber || "Untitled billing file", 220) || "Untitled billing file";
}

function documentType(value) {
  const type = String(value || "invoice").trim().toLowerCase();
  return DOCUMENT_TYPES.has(type) ? type : "invoice";
}

function paperSize(value) {
  const size = String(value || "letter").trim().toLowerCase();
  return PAPER_SIZES.has(size) ? size : "letter";
}

function jsonText(value, fallback = {}) {
  if (typeof value === "string") return value;
  return JSON.stringify(value === undefined || value === null ? fallback : value);
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function publicDocument(row, detail = false) {
  const autosaveAt = row.latest_autosave_at ? new Date(row.latest_autosave_at).getTime() : 0;
  const updatedAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
  const useAutosave = detail && autosaveAt > updatedAt && row.latest_autosave_content_json;
  const contentJson = useAutosave ? row.latest_autosave_content_json : row.content_json;
  const renderedHtml = useAutosave ? row.latest_autosave_rendered_html : row.rendered_html;
  const totalsJson = useAutosave ? row.latest_autosave_totals_json : row.totals_json;

  const doc = {
    id: row.document_id,
    ownerUserId: row.owner_user_id,
    accessLevel: row.access_level || "owner",
    isOwner: Boolean(row.is_owner),
    documentType: row.document_type,
    documentName: row.document_name,
    billingNumber: row.billing_number || "",
    customerName: row.customer_name || "",
    customerCompany: row.customer_company || "",
    customerAccount: row.customer_account || "",
    paperSize: row.paper_size || "letter",
    status: row.status || "saved",
    updatedAt: row.updated_at,
    latestAutosaveAt: row.latest_autosave_at,
    createdAt: row.created_at,
    version: versionFromRow(row),
    hasNewerAutosave: Boolean(useAutosave)
  };

  if (detail) {
    doc.content = parseJson(contentJson, {});
    doc.renderedHtml = renderedHtml || "";
    doc.totals = parseJson(totalsJson, {});
    doc.shares = Array.isArray(row.shares) ? row.shares : [];
  }

  return doc;
}

function bindDocumentInputs(request, payload, userId, options = {}) {
  const content = jsonText(payload.content || payload.contentJson, {});
  const totals = jsonText(payload.totals || payload.totalsJson, {});

  request
    .input("document_type", sql.NVarChar(24), documentType(payload.documentType || payload.billType))
    .input("document_name", sql.NVarChar(220), requiredName(payload))
    .input("billing_number", sql.NVarChar(80), text(payload.billingNumber || payload.blNumber, 80))
    .input("customer_name", sql.NVarChar(220), text(payload.customerName || payload.blToName, 220))
    .input("customer_company", sql.NVarChar(220), text(payload.customerCompany || payload.blToCompany, 220))
    .input("customer_account", sql.NVarChar(120), text(payload.customerAccount || payload.selectedBillingCustomer, 120))
    .input("paper_size", sql.NVarChar(12), paperSize(payload.paperSize || payload.billPaperSize))
    .input("content_json", sql.NVarChar(sql.MAX), content)
    .input("rendered_html", sql.NVarChar(sql.MAX), String(payload.renderedHtml || ""))
    .input("totals_json", sql.NVarChar(sql.MAX), totals)
    .input("actor_user_id", sql.UniqueIdentifier, userId);

  if (options.includeOwner) {
    request.input("owner_user_id", sql.UniqueIdentifier, userId);
  }
}

async function listBillingDocuments(userId, scope = "all-accessible") {
  const pool = await getAppPool();
  const normalizedScope = ["mine", "shared", "all-accessible"].includes(scope) ? scope : "all-accessible";
  const result = await pool.request()
    .input("user_id", sql.UniqueIdentifier, userId)
    .input("scope", sql.NVarChar(24), normalizedScope)
    .query(`
      SELECT
        d.document_id,
        d.owner_user_id,
        d.document_type,
        d.document_name,
        d.billing_number,
        d.customer_name,
        d.customer_company,
        d.customer_account,
        d.paper_size,
        d.status,
        d.created_at,
        d.updated_at,
        d.latest_autosave_at,
        d.file_version,
        CASE WHEN d.owner_user_id = @user_id THEN 1 ELSE 0 END AS is_owner,
        CASE WHEN d.owner_user_id = @user_id THEN N'owner' ELSE s.access_level END AS access_level
      FROM docstudio.billing_documents d
      LEFT JOIN docstudio.billing_document_shares s
        ON s.document_id = d.document_id
       AND s.shared_user_id = @user_id
      WHERE d.deleted_at IS NULL
        AND (
          (@scope = N'mine' AND d.owner_user_id = @user_id)
          OR (@scope = N'shared' AND d.owner_user_id <> @user_id AND s.shared_user_id = @user_id)
          OR (@scope = N'all-accessible' AND (d.owner_user_id = @user_id OR s.shared_user_id = @user_id))
        )
      ORDER BY COALESCE(d.latest_autosave_at, d.updated_at, d.created_at) DESC;
    `);

  return { documents: result.recordset.map((row) => publicDocument(row)) };
}

async function getBillingDocument(documentId, userId) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("document_id", sql.UniqueIdentifier, documentId)
    .input("user_id", sql.UniqueIdentifier, userId)
    .query(`
      SELECT
        d.*,
        CASE WHEN d.owner_user_id = @user_id THEN 1 ELSE 0 END AS is_owner,
        CASE WHEN d.owner_user_id = @user_id THEN N'owner' ELSE s.access_level END AS access_level
      FROM docstudio.billing_documents d
      LEFT JOIN docstudio.billing_document_shares s
        ON s.document_id = d.document_id
       AND s.shared_user_id = @user_id
      WHERE d.document_id = @document_id
        AND d.deleted_at IS NULL
        AND (d.owner_user_id = @user_id OR s.shared_user_id = @user_id);
    `);

  const row = result.recordset[0];
  if (!row) {
    const error = new Error("Billing document not found.");
    error.statusCode = 404;
    throw error;
  }

  row.shares = await listShares(pool, documentId, row.owner_user_id === userId);
  return { document: publicDocument(row, true) };
}

async function createBillingDocument(payload, userId) {
  const pool = await getAppPool();
  const request = pool.request();
  bindDocumentInputs(request, payload, userId, { includeOwner: true });
  const result = await request.query(`
    INSERT INTO docstudio.billing_documents (
      owner_user_id,
      document_type,
      document_name,
      billing_number,
      customer_name,
      customer_company,
      customer_account,
      paper_size,
      content_json,
      rendered_html,
      totals_json,
      created_by_user_id,
      updated_by_user_id
    )
    OUTPUT
      inserted.*,
      CAST(1 AS bit) AS is_owner,
      N'owner' AS access_level
    VALUES (
      @owner_user_id,
      @document_type,
      @document_name,
      @billing_number,
      @customer_name,
      @customer_company,
      @customer_account,
      @paper_size,
      @content_json,
      @rendered_html,
      @totals_json,
      @actor_user_id,
      @actor_user_id
    );
  `);
  const row = result.recordset[0];
  await auditDoc("docstudio.billing.created", row.document_id, userId, { documentType: row.document_type });
  row.shares = [];
  return { document: publicDocument(row, true) };
}

async function updateBillingDocument(documentId, payload, userId) {
  const pool = await getAppPool();
  await requireWritable(pool, documentId, userId);
  const request = pool.request()
    .input("document_id", sql.UniqueIdentifier, documentId)
    .input("expected_version", sql.VarBinary(8), versionToBuffer(payload.version));
  bindDocumentInputs(request, payload, userId);

  const result = await request.query(`
    UPDATE docstudio.billing_documents
       SET document_type = @document_type,
           document_name = @document_name,
           billing_number = @billing_number,
           customer_name = @customer_name,
           customer_company = @customer_company,
           customer_account = @customer_account,
           paper_size = @paper_size,
           status = N'saved',
           content_json = @content_json,
           rendered_html = @rendered_html,
           totals_json = @totals_json,
           updated_by_user_id = @actor_user_id,
           updated_at = SYSUTCDATETIME()
    OUTPUT
      inserted.*,
      CASE WHEN inserted.owner_user_id = @actor_user_id THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS is_owner,
      CASE WHEN inserted.owner_user_id = @actor_user_id THEN N'owner' ELSE CAST(NULL AS nvarchar(12)) END AS access_level
     WHERE document_id = @document_id
       AND deleted_at IS NULL
       AND file_version = @expected_version;
  `);

  const row = result.recordset[0];
  if (!row) throwConflict();
  row.shares = await listShares(pool, documentId, row.owner_user_id === userId);
  if (!row.access_level) row.access_level = await accessLevel(pool, documentId, userId);
  await auditDoc("docstudio.billing.updated", documentId, userId, { documentType: row.document_type });
  return { document: publicDocument(row, true) };
}

async function autosaveBillingDocument(documentId, payload, userId) {
  const pool = await getAppPool();
  await requireWritable(pool, documentId, userId);
  const request = pool.request()
    .input("document_id", sql.UniqueIdentifier, documentId)
    .input("expected_version", sql.VarBinary(8), versionToBuffer(payload.version));
  bindDocumentInputs(request, payload, userId);

  const result = await request.query(`
    UPDATE docstudio.billing_documents
       SET document_type = @document_type,
           document_name = @document_name,
           billing_number = @billing_number,
           customer_name = @customer_name,
           customer_company = @customer_company,
           customer_account = @customer_account,
           paper_size = @paper_size,
           latest_autosave_content_json = @content_json,
           latest_autosave_rendered_html = @rendered_html,
           latest_autosave_totals_json = @totals_json,
           latest_autosave_at = SYSUTCDATETIME()
    OUTPUT
      inserted.*,
      CASE WHEN inserted.owner_user_id = @actor_user_id THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS is_owner,
      CASE WHEN inserted.owner_user_id = @actor_user_id THEN N'owner' ELSE CAST(NULL AS nvarchar(12)) END AS access_level
     WHERE document_id = @document_id
       AND deleted_at IS NULL
       AND file_version = @expected_version;
  `);

  const row = result.recordset[0];
  if (!row) throwConflict();
  row.shares = await listShares(pool, documentId, row.owner_user_id === userId);
  if (!row.access_level) row.access_level = await accessLevel(pool, documentId, userId);
  return { document: publicDocument(row, true) };
}

async function deleteBillingDocument(documentId, userId) {
  const pool = await getAppPool();
  const access = await accessRow(pool, documentId, userId);
  if (!access || !access.isOwner) {
    const error = new Error("Only the owner can delete this billing file.");
    error.statusCode = 403;
    throw error;
  }

  await pool.request()
    .input("document_id", sql.UniqueIdentifier, documentId)
    .input("actor_user_id", sql.UniqueIdentifier, userId)
    .query(`
      UPDATE docstudio.billing_documents
         SET deleted_at = SYSUTCDATETIME(),
             deleted_by_user_id = @actor_user_id
       WHERE document_id = @document_id
         AND deleted_at IS NULL;
    `);
  await auditDoc("docstudio.billing.deleted", documentId, userId, {});
  return { ok: true };
}

async function updateBillingDocumentShares(documentId, shares, userId) {
  const pool = await getAppPool();
  const access = await accessRow(pool, documentId, userId);
  if (!access || !access.isOwner) {
    const error = new Error("Only the owner can manage collaborators.");
    error.statusCode = 403;
    throw error;
  }

  const normalized = Array.isArray(shares)
    ? shares
      .map((share) => ({
        userId: String(share.userId || "").trim(),
        accessLevel: String(share.accessLevel || "").trim().toLowerCase()
      }))
      .filter((share) => share.userId && SHARE_LEVELS.has(share.accessLevel) && share.userId !== userId)
    : [];

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx)
      .input("document_id", sql.UniqueIdentifier, documentId)
      .query("DELETE FROM docstudio.billing_document_shares WHERE document_id = @document_id;");

    for (const share of normalized) {
      await new sql.Request(tx)
        .input("document_id", sql.UniqueIdentifier, documentId)
        .input("shared_user_id", sql.UniqueIdentifier, share.userId)
        .input("access_level", sql.NVarChar(12), share.accessLevel)
        .input("created_by_user_id", sql.UniqueIdentifier, userId)
        .query(`
          INSERT INTO docstudio.billing_document_shares (
            document_id,
            shared_user_id,
            access_level,
            created_by_user_id
          )
          VALUES (
            @document_id,
            @shared_user_id,
            @access_level,
            @created_by_user_id
          );
        `);
    }
    await tx.commit();
  } catch (error) {
    try { await tx.rollback(); } catch {}
    throw error;
  }

  await auditDoc("docstudio.billing.shares_updated", documentId, userId, { count: normalized.length });
  return { shares: await listShares(pool, documentId, true) };
}

async function accessRow(pool, documentId, userId) {
  const result = await pool.request()
    .input("document_id", sql.UniqueIdentifier, documentId)
    .input("user_id", sql.UniqueIdentifier, userId)
    .query(`
      SELECT TOP 1
        d.owner_user_id,
        CASE WHEN d.owner_user_id = @user_id THEN 1 ELSE 0 END AS isOwner,
        CASE WHEN d.owner_user_id = @user_id THEN N'owner' ELSE s.access_level END AS accessLevel
      FROM docstudio.billing_documents d
      LEFT JOIN docstudio.billing_document_shares s
        ON s.document_id = d.document_id
       AND s.shared_user_id = @user_id
      WHERE d.document_id = @document_id
        AND d.deleted_at IS NULL
        AND (d.owner_user_id = @user_id OR s.shared_user_id = @user_id);
    `);
  const row = result.recordset[0];
  return row ? { isOwner: Boolean(row.isOwner), accessLevel: row.accessLevel || "" } : null;
}

async function accessLevel(pool, documentId, userId) {
  const row = await accessRow(pool, documentId, userId);
  return row?.isOwner ? "owner" : row?.accessLevel || "";
}

async function requireWritable(pool, documentId, userId) {
  const access = await accessRow(pool, documentId, userId);
  if (!access) {
    const error = new Error("Billing document not found.");
    error.statusCode = 404;
    throw error;
  }
  if (!access.isOwner && access.accessLevel !== "edit") {
    const error = new Error("You only have view access to this billing file.");
    error.statusCode = 403;
    throw error;
  }
}

async function listShares(pool, documentId, includeShares) {
  if (!includeShares) return [];
  const result = await pool.request()
    .input("document_id", sql.UniqueIdentifier, documentId)
    .query(`
      SELECT shared_user_id AS userId,
             access_level AS accessLevel,
             created_at AS createdAt
      FROM docstudio.billing_document_shares
      WHERE document_id = @document_id
      ORDER BY created_at ASC;
    `);
  return result.recordset;
}

function throwConflict() {
  const error = new Error("This billing file changed in another session. Reload it before saving.");
  error.statusCode = 409;
  throw error;
}

async function auditDoc(eventType, documentId, actorUserId, eventData) {
  try {
    await recordAuditEvent({
      moduleCode: "doc-studio",
      actorUserId,
      eventType,
      entityType: "docstudio.billing_documents",
      entityId: String(documentId),
      eventData
    });
  } catch {
    // Document saves should not fail if audit logging is temporarily unavailable.
  }
}

module.exports = {
  autosaveBillingDocument,
  createBillingDocument,
  deleteBillingDocument,
  getBillingDocument,
  listBillingDocuments,
  updateBillingDocument,
  updateBillingDocumentShares
};
