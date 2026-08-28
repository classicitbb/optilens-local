const crypto = require("node:crypto");
const sql = require("mssql");
const { getAppPool } = require("./db");
const { recordShipmentEvent } = require("./delivery");

const AUTHORISATION_KEY = "classic-visions-signature";

function pngHasAlpha(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 33
    && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && buffer.subarray(12, 16).toString("ascii") === "IHDR"
    && [4, 6].includes(buffer[25]);
}

function validatedSignature(body = {}) {
  const raw = String(body.imageBase64 || "").replace(/^data:image\/png;base64,/, "");
  if (!raw || !/^[A-Za-z0-9+/=]+$/.test(raw)) throw Object.assign(new Error("A transparent PNG signature is required."), { statusCode: 400 });
  const bytes = Buffer.from(raw, "base64");
  if (!bytes.length || bytes.length > 512 * 1024 || !pngHasAlpha(bytes)) {
    throw Object.assign(new Error("Upload a transparent PNG signature smaller than 512 KB."), { statusCode: 400 });
  }
  return bytes;
}

async function getActiveAuthorisation() {
  const pool = await getAppPool();
  const result = await pool.request().input("authorisation_key", AUTHORISATION_KEY).query(`
    SELECT document_authorisation_id AS authorisationId, mime_type AS mimeType, image_bytes AS imageBytes,
      content_hash AS contentHash, uploaded_at AS uploadedAt
    FROM delivery.document_authorisations
    WHERE authorisation_key = @authorisation_key AND removed_at IS NULL
  `);
  return result.recordset[0] || null;
}

async function getActiveAuthorisationMetadata() {
  const item = await getActiveAuthorisation();
  return item && { authorisationId: item.authorisationId, mimeType: item.mimeType, contentHash: item.contentHash, uploadedAt: item.uploadedAt };
}

async function getActiveAuthorisationDataUrl() {
  const item = await getActiveAuthorisation();
  return item ? `data:${item.mimeType};base64,${Buffer.from(item.imageBytes).toString("base64")}` : "";
}

async function saveAuthorisation(body, actorUserId) {
  const imageBytes = validatedSignature(body);
  const pool = await getAppPool();
  const contentHash = crypto.createHash("sha256").update(imageBytes).digest("hex");
  const result = await pool.request()
    .input("authorisation_key", AUTHORISATION_KEY).input("mime_type", "image/png")
    .input("image_bytes", sql.VarBinary(sql.MAX), imageBytes).input("content_hash", contentHash).input("actor", actorUserId)
    .query(`MERGE delivery.document_authorisations AS target
      USING (SELECT @authorisation_key AS authorisation_key) AS src ON target.authorisation_key = src.authorisation_key
      WHEN MATCHED THEN UPDATE SET mime_type=@mime_type, image_bytes=@image_bytes, content_hash=@content_hash, uploaded_by_user_id=@actor, uploaded_at=SYSUTCDATETIME(), removed_by_user_id=NULL, removed_at=NULL
      WHEN NOT MATCHED THEN INSERT (authorisation_key,mime_type,image_bytes,content_hash,uploaded_by_user_id) VALUES (@authorisation_key,@mime_type,@image_bytes,@content_hash,@actor)
      OUTPUT inserted.document_authorisation_id AS authorisationId, inserted.mime_type AS mimeType, inserted.content_hash AS contentHash, inserted.uploaded_at AS uploadedAt;`);
  return result.recordset[0];
}

async function removeAuthorisation(actorUserId) {
  const pool = await getAppPool();
  await pool.request().input("authorisation_key", AUTHORISATION_KEY).input("actor", actorUserId).query(`
    UPDATE delivery.document_authorisations SET removed_by_user_id=@actor, removed_at=SYSUTCDATETIME()
    WHERE authorisation_key=@authorisation_key AND removed_at IS NULL`);
}

async function appendDocumentArchive({ preview, html, status, actorUserId, sourceAuditKey }) {
  const pool = await getAppPool();
  const sessionId = preview.shipmentSessionId || preview.shipment_session_id;
  const refs = (preview.items || []).map((item) => item.ref).filter(Boolean).join(", ");
  const hash = crypto.createHash("sha256").update(html).digest("hex");
  const result = await pool.request()
    .input("document_type", "commercial_invoice").input("document_status", status)
    .input("shipment_session_id", sessionId || null).input("source_shipment_id", preview.shipmentId || null)
    .input("invoice_numbers", preview.invoiceNo || preview.invoiceNumbers || null).input("reference_numbers", refs || null)
    .input("customer_account", preview.customerAccount || null).input("customer_name", preview.consignee?.name || null)
    .input("source_audit_key", sourceAuditKey || null).input("rendered_html", html).input("snapshot_json", JSON.stringify(preview))
    .input("content_hash", hash).input("actor", actorUserId || null)
    .query(`INSERT INTO delivery.document_archive_entries (document_type,document_status,shipment_session_id,source_shipment_id,invoice_numbers,reference_numbers,customer_account,customer_name,source_audit_key,rendered_html,snapshot_json,content_hash,created_by_user_id)
      OUTPUT inserted.document_archive_entry_id AS archiveEntryId, inserted.created_at AS createdAt
      VALUES (@document_type,@document_status,@shipment_session_id,@source_shipment_id,@invoice_numbers,@reference_numbers,@customer_account,@customer_name,@source_audit_key,@rendered_html,@snapshot_json,@content_hash,@actor)`);
  if (sessionId) await recordShipmentEvent(sessionId, "document.archived", { documentType: "commercial_invoice", status, archiveEntryId: result.recordset[0].archiveEntryId, contentHash: hash }, actorUserId);
  return result.recordset[0];
}

async function listDocumentArchive({ search = "", fromDate = "", toDate = "" } = {}) {
  const pool = await getAppPool(); const value = String(search || "").trim();
  const result = await pool.request().input("search", `%${value}%`).input("from", fromDate || null).input("to", toDate || null).query(`
    SELECT TOP (500) document_archive_entry_id AS archiveEntryId, document_type AS documentType, document_status AS documentStatus,
      source_shipment_id AS shipmentId, invoice_numbers AS invoiceNumbers, reference_numbers AS referenceNumbers, customer_account AS customerAccount,
      customer_name AS customerName, source_system AS sourceSystem, source_audit_key AS sourceAuditKey, import_batch_id AS importBatchId, created_at AS createdAt
    FROM delivery.document_archive_entries
    WHERE (@from IS NULL OR created_at >= TRY_CONVERT(date,@from)) AND (@to IS NULL OR created_at < DATEADD(day,1,TRY_CONVERT(date,@to)))
      AND (@search = N'%%' OR source_shipment_id LIKE @search OR invoice_numbers LIKE @search OR reference_numbers LIKE @search OR customer_account LIKE @search OR customer_name LIKE @search)
    ORDER BY created_at DESC`);
  return result.recordset;
}

async function getArchivedDocument(id) {
  const pool = await getAppPool(); const result = await pool.request().input("id", id).query(`SELECT rendered_html AS renderedHtml FROM delivery.document_archive_entries WHERE document_archive_entry_id=@id`);
  return result.recordset[0] || null;
}

module.exports = { appendDocumentArchive, getActiveAuthorisationDataUrl, getActiveAuthorisationMetadata, getArchivedDocument, listDocumentArchive, removeAuthorisation, saveAuthorisation, validatedSignature };
