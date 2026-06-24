const sql = require("mssql");
const { getAppPool } = require("./db");
const { recordAuditEvent } = require("./audit");

const DOCUMENT_TYPES = new Set(["invoice", "quote", "proforma", "receipt"]);
const FILE_TYPES = new Set(["email", "letter", "signature", "social", "pricelist", "shiplabel", "statement"]);
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

function requiredFileName(payload) {
  return text(payload.fileName || payload.name || payload.documentName || "Untitled Doc Studio file", 220) || "Untitled Doc Studio file";
}

function documentType(value) {
  const type = String(value || "invoice").trim().toLowerCase();
  return DOCUMENT_TYPES.has(type) ? type : "invoice";
}

function fileType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (!FILE_TYPES.has(type)) {
    const error = new Error("Unsupported Doc Studio file type.");
    error.statusCode = 400;
    throw error;
  }
  return type;
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

function publicFile(row, detail = false) {
  const autosaveAt = row.latest_autosave_at ? new Date(row.latest_autosave_at).getTime() : 0;
  const updatedAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
  const useAutosave = detail && autosaveAt > updatedAt && row.latest_autosave_content_json;
  const contentJson = useAutosave ? row.latest_autosave_content_json : row.content_json;
  const renderedHtml = useAutosave ? row.latest_autosave_rendered_html : row.rendered_html;
  const doc = {
    id: row.file_id,
    kind: "file",
    ownerUserId: row.owner_user_id,
    accessLevel: row.access_level || "owner",
    isOwner: Boolean(row.is_owner),
    fileType: row.file_type,
    fileName: row.file_name,
    customerName: row.customer_name || "",
    customerAccount: row.customer_account || "",
    metadata: parseJson(row.metadata_json, {}),
    updatedAt: row.updated_at,
    latestAutosaveAt: row.latest_autosave_at,
    createdAt: row.created_at,
    version: versionFromRow(row),
    hasNewerAutosave: Boolean(useAutosave)
  };

  if (detail) {
    doc.content = parseJson(contentJson, {});
    doc.renderedHtml = renderedHtml || "";
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

function bindFileInputs(request, payload, userId, options = {}) {
  request
    .input("file_type", sql.NVarChar(24), fileType(payload.fileType || payload.type))
    .input("file_name", sql.NVarChar(220), requiredFileName(payload))
    .input("customer_name", sql.NVarChar(220), text(payload.customerName, 220))
    .input("customer_account", sql.NVarChar(120), text(payload.customerAccount, 120))
    .input("metadata_json", sql.NVarChar(sql.MAX), jsonText(payload.metadata, {}))
    .input("content_json", sql.NVarChar(sql.MAX), jsonText(payload.content || payload.contentJson, {}))
    .input("rendered_html", sql.NVarChar(sql.MAX), String(payload.renderedHtml || ""))
    .input("actor_user_id", sql.UniqueIdentifier, userId);

  if (options.includeOwner) {
    request.input("owner_user_id", sql.UniqueIdentifier, userId);
  }
}

async function listFiles(userId, scope = "all-accessible", type = "") {
  const pool = await getAppPool();
  const normalizedScope = ["mine", "shared", "all-accessible"].includes(scope) ? scope : "all-accessible";
  const normalizedType = type ? fileType(type) : "";
  const result = await pool.request()
    .input("user_id", sql.UniqueIdentifier, userId)
    .input("scope", sql.NVarChar(24), normalizedScope)
    .input("file_type", sql.NVarChar(24), normalizedType || null)
    .query(`
      SELECT
        f.file_id,
        f.owner_user_id,
        f.file_type,
        f.file_name,
        f.customer_name,
        f.customer_account,
        f.metadata_json,
        f.created_at,
        f.updated_at,
        f.latest_autosave_at,
        COALESCE(f.latest_autosave_at, f.updated_at, f.created_at) AS sort_at,
        f.file_version,
        CASE WHEN f.owner_user_id = @user_id THEN 1 ELSE 0 END AS is_owner,
        CASE WHEN f.owner_user_id = @user_id THEN N'owner' ELSE s.access_level END AS access_level
      FROM docstudio.files f
      LEFT JOIN docstudio.file_shares s
        ON s.file_id = f.file_id
       AND s.shared_user_id = @user_id
      WHERE f.deleted_at IS NULL
        AND (@file_type IS NULL OR f.file_type = @file_type)
        AND (
          (@scope = N'mine' AND f.owner_user_id = @user_id)
          OR (@scope = N'shared' AND f.owner_user_id <> @user_id AND s.shared_user_id = @user_id)
          OR (@scope = N'all-accessible' AND (f.owner_user_id = @user_id OR s.shared_user_id = @user_id))
        )
      ORDER BY COALESCE(f.latest_autosave_at, f.updated_at, f.created_at) DESC;
    `);

  return { files: result.recordset.map((row) => publicFile(row)) };
}

async function getFile(fileId, userId) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("file_id", sql.UniqueIdentifier, fileId)
    .input("user_id", sql.UniqueIdentifier, userId)
    .query(`
      SELECT
        f.*,
        CASE WHEN f.owner_user_id = @user_id THEN 1 ELSE 0 END AS is_owner,
        CASE WHEN f.owner_user_id = @user_id THEN N'owner' ELSE s.access_level END AS access_level
      FROM docstudio.files f
      LEFT JOIN docstudio.file_shares s
        ON s.file_id = f.file_id
       AND s.shared_user_id = @user_id
      WHERE f.file_id = @file_id
        AND f.deleted_at IS NULL
        AND (f.owner_user_id = @user_id OR s.shared_user_id = @user_id);
    `);

  const row = result.recordset[0];
  if (!row) {
    const error = new Error("Doc Studio file not found.");
    error.statusCode = 404;
    throw error;
  }
  row.shares = await listGenericShares(pool, fileId, row.owner_user_id === userId);
  return { file: publicFile(row, true) };
}

async function createFile(payload, userId) {
  const pool = await getAppPool();
  const request = pool.request();
  bindFileInputs(request, payload, userId, { includeOwner: true });
  const result = await request.query(`
    INSERT INTO docstudio.files (
      owner_user_id,
      file_type,
      file_name,
      customer_name,
      customer_account,
      metadata_json,
      content_json,
      rendered_html,
      created_by_user_id,
      updated_by_user_id
    )
    OUTPUT inserted.*, CAST(1 AS bit) AS is_owner, N'owner' AS access_level
    VALUES (
      @owner_user_id,
      @file_type,
      @file_name,
      @customer_name,
      @customer_account,
      @metadata_json,
      @content_json,
      @rendered_html,
      @actor_user_id,
      @actor_user_id
    );
  `);
  const row = result.recordset[0];
  await auditFile("docstudio.file.created", row.file_id, userId, { fileType: row.file_type });
  row.shares = [];
  return { file: publicFile(row, true) };
}

async function updateFile(fileId, payload, userId) {
  const pool = await getAppPool();
  await requireFileWritable(pool, fileId, userId);
  const request = pool.request()
    .input("file_id", sql.UniqueIdentifier, fileId)
    .input("expected_version", sql.VarBinary(8), versionToBuffer(payload.version));
  bindFileInputs(request, payload, userId);

  const result = await request.query(`
    UPDATE docstudio.files
       SET file_type = @file_type,
           file_name = @file_name,
           customer_name = @customer_name,
           customer_account = @customer_account,
           metadata_json = @metadata_json,
           content_json = @content_json,
           rendered_html = @rendered_html,
           updated_by_user_id = @actor_user_id,
           updated_at = SYSUTCDATETIME()
    OUTPUT
      inserted.*,
      CASE WHEN inserted.owner_user_id = @actor_user_id THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS is_owner,
      CASE WHEN inserted.owner_user_id = @actor_user_id THEN N'owner' ELSE CAST(NULL AS nvarchar(12)) END AS access_level
     WHERE file_id = @file_id
       AND deleted_at IS NULL
       AND file_version = @expected_version;
  `);

  const row = result.recordset[0];
  if (!row) throwConflict();
  row.shares = await listGenericShares(pool, fileId, row.owner_user_id === userId);
  if (!row.access_level) row.access_level = await genericAccessLevel(pool, fileId, userId);
  await auditFile("docstudio.file.updated", fileId, userId, { fileType: row.file_type });
  return { file: publicFile(row, true) };
}

async function autosaveFile(fileId, payload, userId) {
  const pool = await getAppPool();
  await requireFileWritable(pool, fileId, userId);
  const request = pool.request()
    .input("file_id", sql.UniqueIdentifier, fileId)
    .input("expected_version", sql.VarBinary(8), versionToBuffer(payload.version));
  bindFileInputs(request, payload, userId);

  const result = await request.query(`
    UPDATE docstudio.files
       SET file_type = @file_type,
           file_name = @file_name,
           customer_name = @customer_name,
           customer_account = @customer_account,
           metadata_json = @metadata_json,
           latest_autosave_content_json = @content_json,
           latest_autosave_rendered_html = @rendered_html,
           latest_autosave_at = SYSUTCDATETIME()
    OUTPUT
      inserted.*,
      CASE WHEN inserted.owner_user_id = @actor_user_id THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS is_owner,
      CASE WHEN inserted.owner_user_id = @actor_user_id THEN N'owner' ELSE CAST(NULL AS nvarchar(12)) END AS access_level
     WHERE file_id = @file_id
       AND deleted_at IS NULL
       AND file_version = @expected_version;
  `);

  const row = result.recordset[0];
  if (!row) throwConflict();
  row.shares = await listGenericShares(pool, fileId, row.owner_user_id === userId);
  if (!row.access_level) row.access_level = await genericAccessLevel(pool, fileId, userId);
  await auditFile("docstudio.file.autosaved", fileId, userId, { fileType: row.file_type });
  return { file: publicFile(row, true) };
}

async function deleteFile(fileId, userId) {
  const pool = await getAppPool();
  const access = await genericAccessRow(pool, fileId, userId);
  if (!access || !access.isOwner) {
    const error = new Error("Only the owner can delete this file.");
    error.statusCode = 403;
    throw error;
  }

  await pool.request()
    .input("file_id", sql.UniqueIdentifier, fileId)
    .input("actor_user_id", sql.UniqueIdentifier, userId)
    .query(`
      UPDATE docstudio.files
         SET deleted_at = SYSUTCDATETIME(),
             deleted_by_user_id = @actor_user_id
       WHERE file_id = @file_id
         AND deleted_at IS NULL;
    `);
  await auditFile("docstudio.file.deleted", fileId, userId, {});
  return { ok: true };
}

async function updateFileShares(fileId, shares, userId) {
  const pool = await getAppPool();
  const access = await genericAccessRow(pool, fileId, userId);
  if (!access || !access.isOwner) {
    const error = new Error("Only the owner can manage collaborators.");
    error.statusCode = 403;
    throw error;
  }

  const normalized = normalizeShares(shares, userId);
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx)
      .input("file_id", sql.UniqueIdentifier, fileId)
      .query("DELETE FROM docstudio.file_shares WHERE file_id = @file_id;");

    for (const share of normalized) {
      await new sql.Request(tx)
        .input("file_id", sql.UniqueIdentifier, fileId)
        .input("shared_user_id", sql.UniqueIdentifier, share.userId)
        .input("access_level", sql.NVarChar(12), share.accessLevel)
        .input("created_by_user_id", sql.UniqueIdentifier, userId)
        .query(`
          INSERT INTO docstudio.file_shares (
            file_id,
            shared_user_id,
            access_level,
            created_by_user_id
          )
          VALUES (
            @file_id,
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

  await auditFile("docstudio.file.shares_updated", fileId, userId, { count: normalized.length });
  return { shares: await listGenericShares(pool, fileId, true) };
}

async function listAllAccessibleFiles(userId, filters = {}) {
  const pool = await getAppPool();
  const scope = ["mine", "shared", "all-accessible"].includes(filters.scope) ? filters.scope : "all-accessible";
  const result = await pool.request()
    .input("user_id", sql.UniqueIdentifier, userId)
    .input("scope", sql.NVarChar(24), scope)
    .query(`
      SELECT
        f.file_id AS id,
        CAST(N'file' AS nvarchar(16)) AS kind,
        f.owner_user_id,
        f.file_type,
        f.file_name,
        f.customer_name,
        f.customer_account,
        f.metadata_json,
        f.created_at,
        f.updated_at,
        f.latest_autosave_at,
        COALESCE(f.latest_autosave_at, f.updated_at, f.created_at) AS sort_at,
        f.file_version,
        CASE WHEN f.owner_user_id = @user_id THEN 1 ELSE 0 END AS is_owner,
        CASE WHEN f.owner_user_id = @user_id THEN N'owner' ELSE fs.access_level END AS access_level
      FROM docstudio.files f
      LEFT JOIN docstudio.file_shares fs
        ON fs.file_id = f.file_id
       AND fs.shared_user_id = @user_id
      WHERE f.deleted_at IS NULL
        AND (
          (@scope = N'mine' AND f.owner_user_id = @user_id)
          OR (@scope = N'shared' AND f.owner_user_id <> @user_id AND fs.shared_user_id = @user_id)
          OR (@scope = N'all-accessible' AND (f.owner_user_id = @user_id OR fs.shared_user_id = @user_id))
        )
      UNION ALL
      SELECT
        d.document_id AS id,
        CAST(N'billing' AS nvarchar(16)) AS kind,
        d.owner_user_id,
        CAST(N'billing' AS nvarchar(24)) AS file_type,
        d.document_name AS file_name,
        COALESCE(d.customer_company, d.customer_name) AS customer_name,
        d.customer_account,
        (N'{"documentType":"' + STRING_ESCAPE(d.document_type, 'json') + N'","billingNumber":"' + STRING_ESCAPE(ISNULL(d.billing_number, N''), 'json') + N'"}') AS metadata_json,
        d.created_at,
        d.updated_at,
        d.latest_autosave_at,
        COALESCE(d.latest_autosave_at, d.updated_at, d.created_at) AS sort_at,
        d.file_version,
        CASE WHEN d.owner_user_id = @user_id THEN 1 ELSE 0 END AS is_owner,
        CASE WHEN d.owner_user_id = @user_id THEN N'owner' ELSE bs.access_level END AS access_level
      FROM docstudio.billing_documents d
      LEFT JOIN docstudio.billing_document_shares bs
        ON bs.document_id = d.document_id
       AND bs.shared_user_id = @user_id
      WHERE d.deleted_at IS NULL
        AND (
          (@scope = N'mine' AND d.owner_user_id = @user_id)
          OR (@scope = N'shared' AND d.owner_user_id <> @user_id AND bs.shared_user_id = @user_id)
          OR (@scope = N'all-accessible' AND (d.owner_user_id = @user_id OR bs.shared_user_id = @user_id))
        )
      ORDER BY sort_at DESC;
    `);

  return {
    files: result.recordset.map((row) => ({
      id: row.id,
      kind: row.kind,
      fileType: row.file_type,
      fileName: row.file_name,
      ownerUserId: row.owner_user_id,
      isOwner: Boolean(row.is_owner),
      accessLevel: row.access_level || "owner",
      customerName: row.customer_name || "",
      customerAccount: row.customer_account || "",
      metadata: parseJson(row.metadata_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      latestAutosaveAt: row.latest_autosave_at,
      version: versionFromRow(row)
    }))
  };
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

  const normalized = normalizeShares(shares, userId);

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

async function updateUnifiedShares(kind, id, shares, userId) {
  if (kind === "billing") return updateBillingDocumentShares(id, shares, userId);
  return updateFileShares(id, shares, userId);
}

function normalizeShares(shares, userId) {
  const seen = new Set();
  return (Array.isArray(shares) ? shares : [])
    .map((share) => ({
      userId: String(share.userId || "").trim(),
      accessLevel: String(share.accessLevel || "").trim().toLowerCase()
    }))
    .filter((share) => {
      if (!share.userId || !SHARE_LEVELS.has(share.accessLevel) || share.userId === userId || seen.has(share.userId)) return false;
      seen.add(share.userId);
      return true;
    });
}

async function genericAccessRow(pool, fileId, userId) {
  const result = await pool.request()
    .input("file_id", sql.UniqueIdentifier, fileId)
    .input("user_id", sql.UniqueIdentifier, userId)
    .query(`
      SELECT TOP 1
        f.owner_user_id,
        CASE WHEN f.owner_user_id = @user_id THEN 1 ELSE 0 END AS isOwner,
        CASE WHEN f.owner_user_id = @user_id THEN N'owner' ELSE s.access_level END AS accessLevel
      FROM docstudio.files f
      LEFT JOIN docstudio.file_shares s
        ON s.file_id = f.file_id
       AND s.shared_user_id = @user_id
      WHERE f.file_id = @file_id
        AND f.deleted_at IS NULL
        AND (f.owner_user_id = @user_id OR s.shared_user_id = @user_id);
    `);
  const row = result.recordset[0];
  return row ? { isOwner: Boolean(row.isOwner), accessLevel: row.accessLevel || "" } : null;
}

async function genericAccessLevel(pool, fileId, userId) {
  const row = await genericAccessRow(pool, fileId, userId);
  return row?.isOwner ? "owner" : row?.accessLevel || "";
}

async function requireFileWritable(pool, fileId, userId) {
  const access = await genericAccessRow(pool, fileId, userId);
  if (!access) {
    const error = new Error("Doc Studio file not found.");
    error.statusCode = 404;
    throw error;
  }
  if (!access.isOwner && access.accessLevel !== "edit") {
    const error = new Error("You only have view access to this file.");
    error.statusCode = 403;
    throw error;
  }
}

async function listGenericShares(pool, fileId, includeShares) {
  if (!includeShares) return [];
  const result = await pool.request()
    .input("file_id", sql.UniqueIdentifier, fileId)
    .query(`
      SELECT shared_user_id AS userId,
             access_level AS accessLevel,
             created_at AS createdAt
      FROM docstudio.file_shares
      WHERE file_id = @file_id
      ORDER BY created_at ASC;
    `);
  return result.recordset;
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

async function auditFile(eventType, fileId, actorUserId, eventData) {
  try {
    await recordAuditEvent({
      moduleCode: "doc-studio",
      actorUserId,
      eventType,
      entityType: "docstudio.files",
      entityId: String(fileId),
      eventData
    });
  } catch {
    // Document saves should not fail if audit logging is temporarily unavailable.
  }
}

module.exports = {
  autosaveFile,
  autosaveBillingDocument,
  createFile,
  createBillingDocument,
  deleteFile,
  deleteBillingDocument,
  getFile,
  getBillingDocument,
  listAllAccessibleFiles,
  listFiles,
  listBillingDocuments,
  updateFile,
  updateFileShares,
  updateBillingDocument,
  updateBillingDocumentShares,
  updateUnifiedShares
};
