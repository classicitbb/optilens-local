const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const sql = require("mssql");
const { getAppPool } = require("../db");
const { extractPrescriptionFromImages, extractPrescriptionFromText, loadRxAiConfig } = require("./openai-extractor");
const { parseAudio, transcribeAudio } = require("./openai-transcriber");
const { applyVoiceRules, customerMismatch } = require("./voice-rules");
const RxVoice = require("../../public/rx-capture-voice");
const { emptyNormalizedOrder, normalizeOpticalOrder, unresolvedFields } = require("./normalized-order");
const { buildRxCaptureOrder, normalizeResolution } = require("./order-builder");
const { guessLens, mergeOwnLensStyles, resolveLensAlias } = require("./alias-resolver");
const { validateOrder } = require("../../public/rx-capture-validation");
const rxGenerator = require("../rx-generator");
const { releaseApprovedRx, stageApprovedRx } = require("./file-delivery");
const { service: fileDropDestinations } = require("../file-drop-destinations");

const ROOT = path.join(__dirname, "..", "..");
const TEMP_ROOT = path.join(ROOT, "data", "rx-capture-temp");
const ALLOWED_MIME_TYPES = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["application/pdf", ".pdf"]
]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 20000;
const TEXT_MODES = ["voice", "text"];
const VOCABULARY_TTL_MS = 24 * 60 * 60 * 1000;

function createRxCaptureService(dependencies = {}) {
  const getPool = dependencies.getAppPool || getAppPool;
  const extract = dependencies.extractPrescriptionFromImages || extractPrescriptionFromImages;
  const extractText = dependencies.extractPrescriptionFromText || extractPrescriptionFromText;
  const transcribe = dependencies.transcribeAudio || transcribeAudio;
  const aiConfig = dependencies.loadRxAiConfig || loadRxAiConfig;
  const now = dependencies.now || (() => new Date());
  let vocabularyCache = null;
  const schedule = dependencies.schedule || ((task) => setImmediate(task));
  const buildOrder = dependencies.buildRxCaptureOrder || buildRxCaptureOrder;
  const getCatalog = dependencies.getCatalog || rxGenerator.getCatalog;
  const getCoatings = dependencies.getCoatings || rxGenerator.getCoatings;
  const resolveDestination = dependencies.resolveDestination || fileDropDestinations.resolveDestination;

  async function listOrders(actor, limit = 30) {
    const pool = await getPool();
    const result = await pool.request()
      .input("user_id", sql.UniqueIdentifier, actor.userId)
      .input("limit", sql.Int, clampLimit(limit))
      .query(`
        SELECT TOP (@limit)
          capture_order_id, status, created_by_user_id, created_by_username,
          created_by_display_name, patient_name, extracted_json, validated_json,
          resolution_json, approved_snapshot_json, generated_filename, staging_path,
          created_at, last_updated_at, approved_by, approved_at, released_by,
          released_at, error_message, source_image_deleted_at, customer_id,
          customer_account, customer_name, review_confirmed_at, review_confirmed_by, input_mode
        FROM rx_capture.orders
        WHERE created_by_user_id = @user_id
        ORDER BY created_at DESC;
      `);
    return result.recordset.map(publicOrder);
  }

  async function getOrder(orderId, actor) {
    const row = await ownedOrder(orderId, actor);
    return publicOrder(row);
  }

  async function createOrder(payload, actor) {
    if (payload?.manual === true) return createManualOrder(payload, actor);
    // One capture uses exactly one input: photos or a checked transcript.
    if (payload?.transcript !== undefined && payload?.images !== undefined) {
      throw httpError("Submit either prescription photos or a dictation, not both.", 400);
    }
    if (payload?.transcript !== undefined) return createTextOrder(payload, actor);
    const orderId = crypto.randomUUID();
    const images = parseImages(payload?.images);
    const customer = normalizeSelectedCustomer(payload?.customer);
    const savedImages = await saveTemporaryImages(orderId, images);
    const now = new Date();
    try {
      const pool = await getPool();
      await pool.request()
        .input("capture_order_id", sql.UniqueIdentifier, orderId)
        .input("status", sql.NVarChar(40), "PROCESSING")
        .input("created_by_user_id", sql.UniqueIdentifier, actor.userId)
        .input("created_by_username", sql.NVarChar(160), actor.username || "")
        .input("created_by_display_name", sql.NVarChar(200), actor.displayName || actor.username || "")
        .input("customer_id", sql.Int, customer.id)
        .input("customer_account", sql.NVarChar(80), customer.account)
        .input("customer_name", sql.NVarChar(300), customer.name)
        .input("source_image_paths_json", sql.NVarChar(sql.MAX), JSON.stringify(savedImages.map((image) => image.path)))
        .input("created_at", sql.DateTime2, now)
        .query(`
          INSERT INTO rx_capture.orders (
            capture_order_id, status, created_by_user_id, created_by_username,
            created_by_display_name, customer_id, customer_account, customer_name,
            source_image_paths_json, input_mode, created_at, last_updated_at
          ) VALUES (
            @capture_order_id, @status, @created_by_user_id, @created_by_username,
            @created_by_display_name, @customer_id, @customer_account, @customer_name,
            @source_image_paths_json, N'photo', @created_at, @created_at
          );
        `);
      await recordEvent(pool, orderId, actor, "ORDER_CREATED", { inputMode: "photo", imageCount: savedImages.length, customerId: customer.id });
      await recordEvent(pool, orderId, actor, "IMAGE_UPLOADED", { imageCount: savedImages.length });
    } catch (error) {
      await deleteFiles(savedImages.map((image) => image.path));
      throw error;
    }

    schedule(() => processOrder(orderId, actor).catch(() => {}));
    return getOrder(orderId, actor);
  }

  // An RX keyed in without a photo: no images, no extraction, straight to an
  // empty draft the employee fills and submits like any other capture.
  async function createManualOrder(payload, actor) {
    const orderId = crypto.randomUUID();
    const customer = normalizeSelectedCustomer(payload?.customer);
    const draft = { ...emptyNormalizedOrder(), lensGuessed: false };
    draft.lensRequest.materialGroup = "1";
    const now = new Date();
    const pool = await getPool();
    await pool.request()
      .input("capture_order_id", sql.UniqueIdentifier, orderId)
      .input("status", sql.NVarChar(40), "READY_FOR_REVIEW")
      .input("created_by_user_id", sql.UniqueIdentifier, actor.userId)
      .input("created_by_username", sql.NVarChar(160), actor.username || "")
      .input("created_by_display_name", sql.NVarChar(200), actor.displayName || actor.username || "")
      .input("customer_id", sql.Int, customer.id)
      .input("customer_account", sql.NVarChar(80), customer.account)
      .input("customer_name", sql.NVarChar(300), customer.name)
      .input("draft_json", sql.NVarChar(sql.MAX), JSON.stringify(draft))
      .input("created_at", sql.DateTime2, now)
      .query(`
        INSERT INTO rx_capture.orders (
          capture_order_id, status, created_by_user_id, created_by_username,
          created_by_display_name, customer_id, customer_account, customer_name,
          extracted_json, validated_json, input_mode, created_at, last_updated_at
        ) VALUES (
          @capture_order_id, @status, @created_by_user_id, @created_by_username,
          @created_by_display_name, @customer_id, @customer_account, @customer_name,
          @draft_json, @draft_json, N'manual', @created_at, @created_at
        );
      `);
    await recordEvent(pool, orderId, actor, "ORDER_CREATED", { manual: true, inputMode: "manual", customerId: customer.id });
    return getOrder(orderId, actor);
  }

  // Voice or typed intake: the employee has already checked the segmented
  // transcript on the capture page, so that text is the only source and is
  // extracted like a photo. Transcript text never goes into event payloads.
  async function createTextOrder(payload, actor) {
    const transcript = parseTranscript(payload.transcript);
    const customer = normalizeSelectedCustomer(payload?.customer);
    const orderId = crypto.randomUUID();
    const inputMode = transcript.clipCount > 0 ? "voice" : "text";
    const pool = await getPool();
    await pool.request()
      .input("capture_order_id", sql.UniqueIdentifier, orderId)
      .input("status", sql.NVarChar(40), "PROCESSING")
      .input("created_by_user_id", sql.UniqueIdentifier, actor.userId)
      .input("created_by_username", sql.NVarChar(160), actor.username || "")
      .input("created_by_display_name", sql.NVarChar(200), actor.displayName || actor.username || "")
      .input("customer_id", sql.Int, customer.id)
      .input("customer_account", sql.NVarChar(80), customer.account)
      .input("customer_name", sql.NVarChar(300), customer.name)
      .input("input_mode", sql.NVarChar(20), inputMode)
      .input("transcript_raw_json", sql.NVarChar(sql.MAX), JSON.stringify({ raw: transcript.raw, clipCount: transcript.clipCount }))
      .input("transcript_edited_json", sql.NVarChar(sql.MAX), JSON.stringify(transcript.segments))
      .input("created_at", sql.DateTime2, now())
      .query(`
        INSERT INTO rx_capture.orders (
          capture_order_id, status, created_by_user_id, created_by_username,
          created_by_display_name, customer_id, customer_account, customer_name,
          input_mode, transcript_raw_json, transcript_edited_json, created_at, last_updated_at
        ) VALUES (
          @capture_order_id, @status, @created_by_user_id, @created_by_username,
          @created_by_display_name, @customer_id, @customer_account, @customer_name,
          @input_mode, @transcript_raw_json, @transcript_edited_json, @created_at, @created_at
        );
      `);
    await recordEvent(pool, orderId, actor, "ORDER_CREATED", {
      inputMode,
      clipCount: transcript.clipCount,
      segmentCount: Object.values(transcript.segments).filter(Boolean).length,
      customerId: customer.id
    });
    schedule(() => processOrder(orderId, actor).catch(() => {}));
    return getOrder(orderId, actor);
  }

  // Speech to text only; nothing is stored. The employee checks the returned
  // pieces on the capture page before anything is extracted.
  async function transcribeDictation(payload) {
    const audio = parseAudio(payload?.audio, payload?.durationMs);
    const text = await transcribe(audio, { vocabulary: await lensVocabulary() });
    if (retainAudio()) await saveRetainedAudio(audio);
    return { text, pieces: RxVoice.splitTranscript(text) };
  }

  function voiceStatus() {
    let configured = false;
    try { configured = Boolean(aiConfig().apiKey); } catch { configured = false; }
    return configured
      ? { available: true, reason: null }
      : { available: false, reason: "Voice transcription is not configured on the server. Ask an administrator to add the RX Capture AI key." };
  }

  // Lens names used in the last 90 days, most used first, topped up from the
  // catalogue. Rebuilt once a day.
  async function lensVocabulary() {
    if (vocabularyCache && now().getTime() - vocabularyCache.at < VOCABULARY_TTL_MS) return vocabularyCache.terms;
    const terms = [];
    try {
      const pool = await getPool();
      const result = await pool.request().query(`
        SELECT TOP (100) term
        FROM (
          SELECT JSON_VALUE(validated_json, '$.lensRequest.style') AS term FROM rx_capture.orders WHERE created_at >= DATEADD(day, -90, SYSUTCDATETIME())
          UNION ALL SELECT JSON_VALUE(validated_json, '$.lensRequest.option') FROM rx_capture.orders WHERE created_at >= DATEADD(day, -90, SYSUTCDATETIME())
          UNION ALL SELECT JSON_VALUE(validated_json, '$.lensRequest.material') FROM rx_capture.orders WHERE created_at >= DATEADD(day, -90, SYSUTCDATETIME())
        ) used
        WHERE term IS NOT NULL AND LEN(term) > 1
        GROUP BY term
        ORDER BY COUNT(*) DESC;
      `);
      terms.push(...result.recordset.map((row) => row.term));
    } catch { /* the catalogue below still gives a usable list */ }
    try {
      for (const item of getCatalog() || []) {
        if (terms.length >= 100) break;
        for (const term of [item.styleDescription, item.colorDescription]) if (term && !terms.includes(term)) terms.push(term);
      }
    } catch { /* no catalogue: the fixed optical vocabulary is still used */ }
    vocabularyCache = { at: now().getTime(), terms: terms.slice(0, 100) };
    return vocabularyCache.terms;
  }

  // The customer dropdown before typing: this employee's frequent customers
  // first, topped up with the team's, over the last 90 days.
  async function frequentCustomers(actor) {
    const pool = await getPool();
    const result = await pool.request()
      .input("user_id", sql.UniqueIdentifier, actor.userId)
      .query(`
        SELECT customer_id, MAX(customer_account) AS customer_account, MAX(customer_name) AS customer_name,
          SUM(CASE WHEN created_by_user_id = @user_id THEN 1 ELSE 0 END) AS own_count,
          COUNT(*) AS team_count,
          MAX(CASE WHEN created_by_user_id = @user_id THEN created_at END) AS own_last_at,
          MAX(created_at) AS team_last_at
        FROM rx_capture.orders
        WHERE customer_id IS NOT NULL AND created_at >= DATEADD(day, -90, SYSUTCDATETIME())
        GROUP BY customer_id;
      `);
    return rankFrequentCustomers(result.recordset, now());
  }

  async function updateOrder(orderId, payload, actor) {
    const existing = await ownedOrder(orderId, actor);
    assertEditable(existing);
    const { errors } = validateOrder(payload?.normalizedOrder);
    if (errors.length) throw httpError(`Fix these values before saving: ${errors.slice(0, 3).map((item) => item.message).join(" ")}`, 422);
    const normalized = normalizeOpticalOrder(payload?.normalizedOrder);
    const issues = unresolvedFields(normalized);
    normalized.missingFields = issues.missingFields;
    normalized.uncertainFields = issues.uncertainFields;
    // A capture is an editable Innovations draft. Visible warnings guide the
    // employee, but do not turn a partially legible prescription into a dead-end.
    const status = "READY_FOR_REVIEW";
    const pool = await getPool();
    const updated = await pool.request()
      .input("capture_order_id", sql.UniqueIdentifier, existing.capture_order_id)
      .input("user_id", sql.UniqueIdentifier, actor.userId)
      .input("status", sql.NVarChar(40), status)
      .input("patient_name", sql.NVarChar(200), normalized.patient.name)
      .input("validated_json", sql.NVarChar(sql.MAX), JSON.stringify(normalized))
      .input("review_confirmed_by", sql.UniqueIdentifier, actor.userId)
      .query(`
        UPDATE rx_capture.orders
        SET status = @status,
            patient_name = @patient_name,
            validated_json = @validated_json,
            resolution_json = NULL,
            lens_alias = NULL,
            review_confirmed_at = SYSUTCDATETIME(),
            review_confirmed_by = @review_confirmed_by,
            last_updated_at = SYSUTCDATETIME(),
            error_message = NULL
        WHERE capture_order_id = @capture_order_id
          AND created_by_user_id = @user_id
          AND status NOT IN (N'APPROVED', N'RX_GENERATED', N'STAGED', N'RELEASED');
      `);
    if (!updated.rowsAffected[0]) throw httpError("This RX Capture order changed before it could be saved. Reload it and try again.", 409);
    await recordEvent(pool, orderId, actor, "EMPLOYEE_UPDATED", { status });
    if (status === "READY_FOR_REVIEW") await recordEvent(pool, orderId, actor, "READY_FOR_REVIEW", {});
    return getOrder(orderId, actor);
  }

  async function reprocessOrder(orderId, actor) {
    const existing = await ownedOrder(orderId, actor);
    assertEditable(existing);
    // Voice and typed orders re-extract from the stored checked transcript,
    // which is never deleted; photo orders need their temporary images.
    if (TEXT_MODES.includes(existing.input_mode)) {
      if (!existing.transcript_edited_json) throw httpError("The dictation for this order is no longer available. Create a new capture.", 409);
    } else {
      const paths = parseStoredPaths(existing.source_image_paths_json).filter((filePath) => fs.existsSync(filePath));
      if (!paths.length) throw httpError("The source image is no longer available. Create a new capture.", 409);
    }
    const pool = await getPool();
    await pool.request()
      .input("capture_order_id", sql.UniqueIdentifier, orderId)
      .input("user_id", sql.UniqueIdentifier, actor.userId)
      .query(`
        UPDATE rx_capture.orders
        SET status = N'PROCESSING', error_message = NULL, resolution_json = NULL,
            lens_alias = NULL, review_confirmed_at = NULL, review_confirmed_by = NULL,
            last_updated_at = SYSUTCDATETIME()
        WHERE capture_order_id = @capture_order_id AND created_by_user_id = @user_id
          AND status NOT IN (N'APPROVED', N'RX_GENERATED', N'STAGED', N'RELEASED');
      `);
    schedule(() => processOrder(orderId, actor).catch(() => {}));
    return getOrder(orderId, actor);
  }

  async function saveResolution(orderId, payload, actor) {
    const existing = await ownedOrder(orderId, actor);
    if (existing.status !== "READY_FOR_REVIEW") throw httpError("Only a ready-for-review order can be configured.", 409);
    if (!existing.review_confirmed_at) throw httpError("Save the structured review before configuring production values.", 409);
    const normalized = parseJson(existing.validated_json);
    const account = await submissionAccount(orderId, actor);
    const resolved = normalizeResolution(resolutionDefaults(payload?.resolution, { existing, normalized, actor, mappedCustomerNumber: account.customerNumber }));
    const preview = buildOrder(normalized, resolved, { reserveIdentifiers: false });
    const pool = await getPool();
    await pool.request()
      .input("capture_order_id", sql.UniqueIdentifier, existing.capture_order_id)
      .input("user_id", sql.UniqueIdentifier, actor.userId)
      .input("resolution_json", sql.NVarChar(sql.MAX), JSON.stringify(resolved))
      .input("lens_alias", sql.NVarChar(13), resolved.lensAlias)
      .input("instructions", sql.NVarChar(sql.MAX), resolved.instructions || normalized.instructions || null)
      .query(`
        UPDATE rx_capture.orders
        SET resolution_json = @resolution_json,
            lens_alias = @lens_alias,
            instructions = @instructions,
            last_updated_at = SYSUTCDATETIME()
        WHERE capture_order_id = @capture_order_id
          AND created_by_user_id = @user_id
          AND status = N'READY_FOR_REVIEW';
      `);
    await recordEvent(pool, orderId, actor, "ORDER_RESOLVED", {
      lensAlias: resolved.lensAlias,
      frameMode: resolved.frameMode,
      previewSha256: preview.sha256
    });
    return getOrder(orderId, actor);
  }

  async function suggestAlias(orderId, actor) {
    const existing = await ownedOrder(orderId, actor);
    const normalized = parseJson(existing.validated_json) || parseJson(existing.extracted_json);
    if (!normalized) throw httpError("The prescription has not been extracted yet.", 409);
    return { ...resolveLensAlias(normalized, getCatalog()), guess: guessLens(parseJson(existing.extracted_json)?.lensRequest, mergeOwnLensStyles(getCatalog())) };
  }

  async function listCoatings() {
    return getCoatings().map((item) => ({
      sku: String(item.sku || ""),
      description: String(item.description || ""),
      groupName: String(item.groupName || "Coatings")
    })).filter((item) => item.sku && item.description);
  }

  async function listCatalog() {
    return mergeOwnLensStyles(getCatalog())
      .filter((item) => item && item.active !== false && /^\d{13}$/.test(String(item.alias || "")))
      .map((item) => ({
        alias: String(item.alias),
        materialGroupCode: String(item.materialGroupCode || "1"),
        materialGroup: String(item.materialGroup || "Resin"),
        material: String(item.materialDescription || ""),
        lensType: String(item.mfType || item.category || ""),
        style: String(item.displayStyle || item.styleDescription || ""),
        option: String(item.colorDescription || ""),
        label: [item.mfType || item.category, item.materialDescription, item.displayStyle || item.styleDescription, item.colorDescription].filter(Boolean).join(" · "),
        customerSupplied: Boolean(item.customerSupplied)
      }));
  }

  async function submissionAccount(orderId, actor) {
    const existing = await ownedOrder(orderId, actor);
    const pool = await getPool();
    const result = await pool.request()
      .input("customer_account", sql.NVarChar(80), existing.customer_account)
      .query(`SELECT innovations_customer_number FROM rx_capture.innovations_account_mappings WHERE customer_account = @customer_account;`);
    const mapped = result.recordset[0]?.innovations_customer_number || null;
    let labNum = null;
    try { labNum = rxGenerator.loadConfig().defaults?.labNum || null; } catch { /* shown only for confirmation */ }
    return { customerAccount: existing.customer_account, customerNumber: mapped || existing.customer_account || null, mapped: Boolean(mapped), labNum };
  }

  async function listApprovalQueue() {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT TOP (100)
        capture_order_id, status, created_by_user_id, created_by_username,
        created_by_display_name, patient_name, extracted_json, validated_json,
        resolution_json, approved_snapshot_json, generated_filename, staging_path,
        created_at, last_updated_at, approved_by, approved_at, released_by,
        released_at, error_message, source_image_deleted_at, customer_id,
        customer_account, customer_name, review_confirmed_at, review_confirmed_by
      FROM rx_capture.orders
      WHERE status IN (N'READY_FOR_REVIEW', N'RX_GENERATED', N'STAGED')
      ORDER BY last_updated_at ASC;
    `);
    return result.recordset.map(publicOrder);
  }

  async function approveOrder(orderId, actor) {
    const pool = await getPool();
    const existing = await orderById(pool, orderId);
    if (!existing || existing.status !== "READY_FOR_REVIEW") throw httpError("This RX Capture order is not awaiting approval.", 409);
    const normalized = parseJson(existing.validated_json);
    const resolution = parseJson(existing.resolution_json);
    if (!resolution) throw httpError("The employee must complete exact lens, customer, and frame selections before approval.", 409);
    const prior = await pool.request()
      .input("capture_order_id", sql.UniqueIdentifier, existing.capture_order_id)
      .query(`SELECT generated_filename FROM rx_capture.order_generations WHERE capture_order_id = @capture_order_id;`);
    if (prior.recordset[0]) {
      throw httpError(`This order was already submitted to Innovations as ${prior.recordset[0].generated_filename}. Make further changes in Innovations or create a new capture.`, 409);
    }
    const built = buildOrder(normalized, resolution);
    const snapshot = JSON.stringify({
      normalizedOrder: normalizeOpticalOrder(normalized),
      resolution: built.resolution,
      order: { ...built.order, content: undefined },
      sha256: built.sha256
    });
    const transaction = pool.transaction();
    await transaction.begin();
    try {
      const request = new sql.Request(transaction);
      const updated = await request
        .input("capture_order_id", sql.UniqueIdentifier, existing.capture_order_id)
        .input("approved_by", sql.UniqueIdentifier, actor.userId)
        .input("generated_filename", sql.NVarChar(260), built.order.filename)
        .input("approved_snapshot_json", sql.NVarChar(sql.MAX), snapshot)
        .query(`
          UPDATE rx_capture.orders
          SET status = N'RX_GENERATED',
              approved_by = @approved_by,
              approved_at = SYSUTCDATETIME(),
              generated_filename = @generated_filename,
              approved_snapshot_json = @approved_snapshot_json,
              last_updated_at = SYSUTCDATETIME(),
              error_message = NULL
          WHERE capture_order_id = @capture_order_id
            AND status = N'READY_FOR_REVIEW';
        `);
      if (!updated.rowsAffected[0]) throw httpError("This RX Capture order changed before approval could finish.", 409);
      await new sql.Request(transaction)
        .input("capture_order_id", sql.UniqueIdentifier, existing.capture_order_id)
        .input("generated_filename", sql.NVarChar(260), built.order.filename)
        .input("content_sha256", sql.Char(64), built.sha256)
        .input("rx_content", sql.NVarChar(sql.MAX), built.order.content)
        .input("snapshot_json", sql.NVarChar(sql.MAX), snapshot)
        .input("generated_by_user_id", sql.UniqueIdentifier, actor.userId)
        .query(`
          INSERT INTO rx_capture.order_generations (
            capture_order_id, generated_filename, content_sha256, rx_content, snapshot_json, generated_by_user_id
          ) VALUES (
            @capture_order_id, @generated_filename, @content_sha256, @rx_content, @snapshot_json, @generated_by_user_id
          );
        `);
      await recordEventInTransaction(transaction, orderId, actor, "RX_GENERATED", {
        filename: built.order.filename,
        sha256: built.sha256
      });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback().catch(() => {});
      throw error;
    }
    return getApprovalOrder(orderId);
  }

  async function stageOrder(orderId, actor) {
    const pool = await getPool();
    const existing = await orderById(pool, orderId);
    if (!existing) throw httpError("RX Capture order was not found.", 404);
    if (existing.status === "STAGED") return getApprovalOrder(orderId);
    if (existing.status !== "RX_GENERATED") throw httpError("Only an approved generated RX Capture order can be staged.", 409);
    const generated = await pool.request()
      .input("capture_order_id", sql.UniqueIdentifier, existing.capture_order_id)
      .query(`SELECT generated_filename, content_sha256, rx_content FROM rx_capture.order_generations WHERE capture_order_id = @capture_order_id;`);
    const record = generated.recordset[0];
    if (!record) throw httpError("The approved RX generation record is unavailable.", 409);
    const config = rxGenerator.loadConfig();
    const filename = String(record.generated_filename || "");
    const content = Buffer.from(record.rx_content, "utf8");
    const staged = stageApprovedRx({ root: ROOT, config, filename, content, expectedHash: record.content_sha256 });
    const updated = await pool.request()
      .input("capture_order_id", sql.UniqueIdentifier, existing.capture_order_id)
      .input("staging_path", sql.NVarChar(1000), staged.stagingPath)
      .query(`
        UPDATE rx_capture.orders
        SET status = N'STAGED', staging_path = @staging_path, last_updated_at = SYSUTCDATETIME()
        WHERE capture_order_id = @capture_order_id AND status = N'RX_GENERATED';
        UPDATE rx_capture.order_generations SET staged_at = SYSUTCDATETIME()
        WHERE capture_order_id = @capture_order_id;
      `);
    if (!updated.rowsAffected[0]) throw httpError("This RX Capture order changed before staging could finish.", 409);
    await recordEvent(pool, orderId, actor, "RX_STAGED", { filename, sha256: staged.sha256 });
    return getApprovalOrder(orderId);
  }

  async function releaseOrder(orderId, actor) {
    const pool = await getPool();
    const existing = await orderById(pool, orderId);
    if (!existing) throw httpError("RX Capture order was not found.", 404);
    if (existing.status === "RELEASED") return getApprovalOrder(orderId);
    if (existing.status !== "STAGED") throw httpError("Only an approved staged RX Capture order can be released to Innovations.", 409);
    const generated = await pool.request()
      .input("capture_order_id", sql.UniqueIdentifier, existing.capture_order_id)
      .query(`SELECT generated_filename, content_sha256 FROM rx_capture.order_generations WHERE capture_order_id = @capture_order_id;`);
    const record = generated.recordset[0];
    if (!record) throw httpError("The approved RX generation record is unavailable.", 409);

    const destination = await resolveDestination({ customerAccount: existing.customer_account, purposeCode: "rx_capture" });
    const generatorConfig = rxGenerator.loadConfig();
    const releaseConfig = destination
      ? { ...generatorConfig, folders: { ...generatorConfig.folders, incoming: destination.folderPath } }
      : generatorConfig;
    const released = releaseApprovedRx({
      root: ROOT,
      config: releaseConfig,
      filename: String(record.generated_filename || ""),
      expectedHash: String(record.content_sha256 || "")
    });

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      const updated = await new sql.Request(transaction)
        .input("capture_order_id", sql.UniqueIdentifier, existing.capture_order_id)
        .input("released_by", sql.UniqueIdentifier, actor.userId)
        .query(`
          UPDATE rx_capture.orders
          SET status = N'RELEASED',
              released_by = @released_by,
              released_at = SYSUTCDATETIME(),
              last_updated_at = SYSUTCDATETIME(),
              error_message = NULL
          WHERE capture_order_id = @capture_order_id AND status = N'STAGED';
        `);
      if (!updated.rowsAffected[0]) throw httpError("This RX Capture order changed before release could finish.", 409);
      await recordEventInTransaction(transaction, orderId, actor, "RX_RELEASED_TO_INNOVATIONS", {
        ...released,
        reconciled: Boolean(released.incomingReused),
        destinationId: destination?.destinationId || null,
        destinationName: destination?.destinationName || "configured default"
      });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback().catch(() => {});
      throw error;
    }
    return getApprovalOrder(orderId);
  }

  // Work is deliberately persisted before it is scheduled. If the Node
  // process stops after that write, replaying a PROCESSING order is safe: the
  // order id is stable, extraction replaces only its own draft, and no RX file
  // can be generated from this state. This gives the single-process app a
  // durable recovery path without introducing another worker service.
  async function recoverProcessingOrders() {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT TOP (50) capture_order_id, created_by_user_id, created_by_username, created_by_display_name
      FROM rx_capture.orders
      WHERE status = N'PROCESSING'
      ORDER BY created_at ASC;
    `);
    const recovered = [];
    for (const row of result.recordset) {
      const orderId = String(row.capture_order_id || "");
      if (!isUuid(orderId)) continue;
      const actor = {
        userId: row.created_by_user_id,
        username: row.created_by_username || "",
        displayName: row.created_by_display_name || row.created_by_username || ""
      };
      recovered.push(orderId);
      schedule(() => processOrder(orderId, actor).catch(() => {}));
    }
    return recovered;
  }

  async function submitOrder(orderId, actor) {
    const owned = await ownedOrder(orderId, actor);
    if (owned.status !== "READY_FOR_REVIEW") {
      throw httpError("Save the reviewed draft and its lens selection before submitting it to Innovations.", 409);
    }
    const generated = await approveOrder(orderId, actor);
    if (generated.status !== "RX_GENERATED") throw httpError("The RX draft could not be generated.", 409);
    const staged = await stageOrder(orderId, actor);
    if (staged.status !== "STAGED") throw httpError("The RX draft could not be staged.", 409);
    return releaseOrder(orderId, actor);
  }

  async function processOrder(orderId, actor) {
    const pool = await getPool();
    const row = await orderById(pool, orderId);
    if (!row) return;
    const imagePaths = parseStoredPaths(row.source_image_paths_json);
    const textMode = TEXT_MODES.includes(row.input_mode);
    try {
      await recordEvent(pool, orderId, actor, "AI_EXTRACTION_STARTED", textMode ? { inputMode: row.input_mode } : { imageCount: imagePaths.length });
      let extracted;
      if (textMode) {
        const segments = RxVoice.cleanSegments(parseJson(row.transcript_edited_json));
        const sourceText = RxVoice.segmentsToText(segments);
        const proposal = await extractText(sourceText);
        extracted = normalizeOpticalOrder(proposal.order);
        const checked = applyVoiceRules(extracted, proposal.evidence, sourceText);
        extracted.uncertainFields = [...new Set([...extracted.uncertainFields, ...checked.uncertainFields])];
        const mismatch = customerMismatch(proposal.spokenCustomer, row.customer_id ? { name: row.customer_name, account: row.customer_account } : null);
        Object.assign(extracted, { voiceFlags: checked.flags, voiceNotes: mismatch ? [mismatch] : [] });
      } else {
        const images = await Promise.all(imagePaths.map(loadTemporaryImage));
        extracted = normalizeOpticalOrder(await extract(images));
      }
      const issues = unresolvedFields(extracted);
      extracted.missingFields = issues.missingFields;
      extracted.uncertainFields = issues.uncertainFields;
      // extracted_json keeps the printed wording as evidence; the editable draft
      // starts from the closest catalogue lens so the employee corrects a guess.
      const normalized = applyLensGuess(extracted, guessLens(extracted.lensRequest, mergeOwnLensStyles(getCatalog())));
      const status = issues.hasIssues ? "NEEDS_INFO" : "READY_FOR_REVIEW";
      await pool.request()
        .input("capture_order_id", sql.UniqueIdentifier, orderId)
        .input("status", sql.NVarChar(40), status)
        .input("patient_name", sql.NVarChar(200), normalized.patient.name)
        .input("extracted_json", sql.NVarChar(sql.MAX), JSON.stringify(extracted))
        .input("validated_json", sql.NVarChar(sql.MAX), JSON.stringify(normalized))
        .query(`
          UPDATE rx_capture.orders
          SET status = @status,
              patient_name = @patient_name,
              extracted_json = @extracted_json,
              validated_json = @validated_json,
              resolution_json = NULL,
              lens_alias = NULL,
              review_confirmed_at = NULL,
              review_confirmed_by = NULL,
              last_updated_at = SYSUTCDATETIME(),
              error_message = NULL
          WHERE capture_order_id = @capture_order_id;
        `);
      await recordEvent(pool, orderId, actor, "AI_EXTRACTION_COMPLETED", { status });
      if (status === "READY_FOR_REVIEW") await recordEvent(pool, orderId, actor, "READY_FOR_REVIEW", {});
      if (!textMode && !retainImages()) {
        await deleteFiles(imagePaths);
        await pool.request()
          .input("capture_order_id", sql.UniqueIdentifier, orderId)
          .query(`
            UPDATE rx_capture.orders
            SET source_image_paths_json = NULL,
                source_image_deleted_at = SYSUTCDATETIME(),
                last_updated_at = SYSUTCDATETIME()
            WHERE capture_order_id = @capture_order_id;
          `);
      }
    } catch (error) {
      const message = safeProcessingError(error);
      await pool.request()
        .input("capture_order_id", sql.UniqueIdentifier, orderId)
        .input("error_message", sql.NVarChar(500), message)
        .query(`
          UPDATE rx_capture.orders
          SET status = N'FAILED', error_message = @error_message, last_updated_at = SYSUTCDATETIME()
          WHERE capture_order_id = @capture_order_id;
        `);
      await recordEvent(pool, orderId, actor, "AI_EXTRACTION_FAILED", { category: failureCategory(error) });
    }
  }

  async function ownedOrder(orderId, actor) {
    if (!isUuid(orderId)) throw httpError("RX Capture order was not found.", 404);
    const pool = await getPool();
    const result = await pool.request()
      .input("capture_order_id", sql.UniqueIdentifier, orderId)
      .input("user_id", sql.UniqueIdentifier, actor.userId)
      .query(`
        SELECT capture_order_id, status, created_by_user_id, created_by_username,
          created_by_display_name, patient_name, source_image_paths_json,
          source_image_deleted_at, extracted_json, validated_json, resolution_json,
          approved_snapshot_json, generated_filename, staging_path, created_at,
          last_updated_at, approved_by, approved_at, released_by, released_at,
          error_message, customer_id, customer_account, customer_name,
          review_confirmed_at, review_confirmed_by, input_mode, transcript_edited_json
        FROM rx_capture.orders
        WHERE capture_order_id = @capture_order_id AND created_by_user_id = @user_id;
      `);
    if (!result.recordset[0]) throw httpError("RX Capture order was not found.", 404);
    return result.recordset[0];
  }

  async function getApprovalOrder(orderId) {
    const pool = await getPool();
    const row = await orderById(pool, orderId);
    if (!row) throw httpError("RX Capture order was not found.", 404);
    return publicOrder(row);
  }

  return { approveOrder, createOrder, frequentCustomers, getApprovalOrder, getOrder, listApprovalQueue, listCatalog, listCoatings, listOrders, processOrder, recoverProcessingOrders, releaseOrder, reprocessOrder, saveResolution, stageOrder, submissionAccount, submitOrder, suggestAlias, transcribeDictation, updateOrder, voiceStatus };
}

async function orderById(pool, orderId) {
  const result = await pool.request()
    .input("capture_order_id", sql.UniqueIdentifier, orderId)
    .query("SELECT * FROM rx_capture.orders WHERE capture_order_id = @capture_order_id;");
  return result.recordset[0] || null;
}

async function recordEvent(pool, orderId, actor, event, details) {
  await pool.request()
    .input("capture_order_id", sql.UniqueIdentifier, orderId)
    .input("actor_user_id", sql.UniqueIdentifier, actor?.userId || null)
    .input("actor_username", sql.NVarChar(160), actor?.username || "system")
    .input("event_code", sql.NVarChar(60), event)
    .input("details_json", sql.NVarChar(sql.MAX), JSON.stringify(details || {}))
    .query(`
      INSERT INTO rx_capture.order_events (
        capture_order_id, actor_user_id, actor_username, event_code, details_json
      ) VALUES (
        @capture_order_id, @actor_user_id, @actor_username, @event_code, @details_json
      );
    `);
}

async function recordEventInTransaction(transaction, orderId, actor, event, details) {
  await new sql.Request(transaction)
    .input("capture_order_id", sql.UniqueIdentifier, orderId)
    .input("actor_user_id", sql.UniqueIdentifier, actor?.userId || null)
    .input("actor_username", sql.NVarChar(160), actor?.username || "system")
    .input("event_code", sql.NVarChar(60), event)
    .input("details_json", sql.NVarChar(sql.MAX), JSON.stringify(details || {}))
    .query(`
      INSERT INTO rx_capture.order_events (
        capture_order_id, actor_user_id, actor_username, event_code, details_json
      ) VALUES (
        @capture_order_id, @actor_user_id, @actor_username, @event_code, @details_json
      );
    `);
}

function parseImages(images) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 2) throw httpError("Select one or two prescription images.", 400);
  let total = 0;
  return images.map((image) => {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(image?.dataUrl || ""));
    const mimeType = String(match?.[1] || "").toLowerCase();
    if (!match || !ALLOWED_MIME_TYPES.has(mimeType)) throw httpError("Use a JPEG, PNG, WebP, or GIF image, or a PDF.", 415);
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw httpError("Each image or PDF must be 8 MB or smaller.", 413);
    if (!matchesImageSignature(buffer, mimeType)) throw httpError("The uploaded file does not match its file format.", 415);
    total += buffer.length;
    if (total > MAX_TOTAL_BYTES) throw httpError("The combined image upload must be 16 MB or smaller.", 413);
    return { buffer, mimeType, extension: ALLOWED_MIME_TYPES.get(mimeType) };
  });
}

function matchesImageSignature(buffer, mimeType) {
  if (mimeType === "image/jpeg") return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === "image/png") return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/webp") return buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  if (mimeType === "image/gif") return buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"));
  if (mimeType === "application/pdf") return buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  return false;
}

async function saveTemporaryImages(orderId, images) {
  await fs.promises.mkdir(TEMP_ROOT, { recursive: true });
  const saved = [];
  try {
    for (let index = 0; index < images.length; index += 1) {
      const filePath = path.join(TEMP_ROOT, `${orderId}-${index + 1}-${crypto.randomBytes(6).toString("hex")}${images[index].extension}`);
      await fs.promises.writeFile(filePath, images[index].buffer, { mode: 0o600, flag: "wx" });
      saved.push({ path: filePath, mimeType: images[index].mimeType });
    }
    return saved;
  } catch (error) {
    await deleteFiles(saved.map((image) => image.path));
    throw error;
  }
}

async function loadTemporaryImage(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(TEMP_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw httpError("Stored image reference is invalid.", 500);
  const extension = path.extname(resolved).toLowerCase();
  const mimeType = [...ALLOWED_MIME_TYPES.entries()].find(([, ext]) => ext === extension)?.[0];
  if (!mimeType) throw httpError("Stored image format is unsupported.", 415);
  return { buffer: await fs.promises.readFile(resolved), mimeType };
}

async function deleteFiles(paths) {
  await Promise.all(paths.map((filePath) => fs.promises.unlink(filePath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  })));
}

function publicOrder(row) {
  const extracted = parseJson(row.extracted_json);
  const validated = parseJson(row.validated_json);
  return {
    id: String(row.capture_order_id),
    status: row.status,
    createdByUserId: String(row.created_by_user_id),
    createdByUsername: row.created_by_username,
    createdByDisplayName: row.created_by_display_name,
    patientName: row.patient_name || validated?.patient?.name || extracted?.patient?.name || null,
    customer: row.customer_id ? { id: row.customer_id, account: row.customer_account, name: row.customer_name } : null,
    extractedOrder: extracted,
    normalizedOrder: validated || extracted,
    resolution: parseJson(row.resolution_json),
    approvedSnapshot: parseJson(row.approved_snapshot_json),
    generatedFilename: row.generated_filename || null,
    stagingPath: row.staging_path ? path.basename(row.staging_path) : null,
    createdAt: row.created_at,
    lastUpdatedAt: row.last_updated_at,
    approvedBy: row.approved_by || null,
    approvedAt: row.approved_at || null,
    releasedBy: row.released_by || null,
    releasedAt: row.released_at || null,
    errorMessage: row.error_message || null,
    sourceImageDeletedAt: row.source_image_deleted_at || null,
    reviewConfirmedAt: row.review_confirmed_at || null,
    reviewConfirmedBy: row.review_confirmed_by || null,
    inputMode: row.input_mode || null,
    transcript: row.transcript_edited_json ? RxVoice.cleanSegments(parseJson(row.transcript_edited_json)) : null
  };
}

function parseTranscript(value) {
  const source = value && typeof value === "object" ? value : {};
  const segments = RxVoice.cleanSegments(source.segments);
  const total = Object.values(segments).join("").length;
  if (!total) throw httpError("The dictation is empty. Record or type the prescription first.", 400);
  if (total > MAX_TRANSCRIPT_CHARS) throw httpError("The dictation is too long for one prescription.", 413);
  const clips = Number(source.clipCount);
  const clipCount = Number.isInteger(clips) ? Math.max(0, Math.min(50, clips)) : 0;
  return { segments, clipCount, raw: String(source.raw || "").slice(0, MAX_TRANSCRIPT_CHARS) };
}

// Frequency with a recency boost, so a customer ordering this week outranks
// one that ordered often months ago. Own history first, the team's fills the rest.
function rankFrequentCustomers(rows, now = new Date(), limit = 8) {
  const score = (count, lastAt) => {
    if (!count || !lastAt) return 0;
    const days = Math.max(0, (now.getTime() - new Date(lastAt).getTime()) / 86400000);
    return Number(count) + 3 * Math.exp(-days / 14);
  };
  const customer = (row) => ({ id: Number(row.customer_id), account: String(row.customer_account || "").trim(), name: String(row.customer_name || "").trim() });
  const valid = (rows || []).filter((row) => Number(row.customer_id) > 0 && row.customer_name);
  const own = valid.filter((row) => Number(row.own_count) > 0)
    .sort((left, right) => score(right.own_count, right.own_last_at) - score(left.own_count, left.own_last_at));
  const picked = own.slice(0, limit).map(customer);
  const team = valid.filter((row) => !picked.some((item) => item.id === Number(row.customer_id)))
    .sort((left, right) => score(right.team_count, right.team_last_at) - score(left.team_count, left.team_last_at));
  return [...picked, ...team.slice(0, limit - picked.length).map(customer)];
}

function retainAudio() {
  return ["1", "true", "yes", "on"].includes(String(process.env.RX_CAPTURE_RETAIN_AUDIO || "").toLowerCase());
}

async function saveRetainedAudio(audio) {
  await fs.promises.mkdir(TEMP_ROOT, { recursive: true });
  const filePath = path.join(TEMP_ROOT, `audio-${crypto.randomUUID()}.${audio.extension}`);
  await fs.promises.writeFile(filePath, audio.buffer, { mode: 0o600, flag: "wx" });
}

function normalizeSelectedCustomer(value) {
  const source = value && typeof value === "object" ? value : {};
  const id = Number(source.id);
  const account = String(source.account || "").trim();
  const name = String(source.name || "").trim();
  if (!Number.isInteger(id) || id <= 0 || !account || !name) {
    throw httpError("Select an ERP customer before submitting the prescription.", 400);
  }
  return { id, account: account.slice(0, 80), name: name.slice(0, 300) };
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function parseStoredPaths(value) {
  const paths = parseJson(value);
  return Array.isArray(paths) ? paths.filter((item) => typeof item === "string") : [];
}

function retainImages() {
  return ["1", "true", "yes", "on"].includes(String(process.env.RX_CAPTURE_RETAIN_IMAGES || "").toLowerCase());
}

function safeProcessingError(error) {
  if ([400, 409, 413, 415, 502, 503, 504].includes(error?.statusCode)) return String(error.message).slice(0, 500);
  return "Prescription extraction failed. Try again or create a new capture.";
}

function failureCategory(error) {
  if (error?.statusCode) return `http_${error.statusCode}`;
  return error?.code ? String(error.code).slice(0, 80) : "processing_error";
}

function clampLimit(value) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(1, Math.min(100, number)) : 30;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

// Once an RX file exists the order is a record of what went to Innovations;
// reopening it would let a second generation be attempted for the same order.
const LOCKED_STATUSES = ["APPROVED", "RX_GENERATED", "STAGED", "RELEASED"];

function assertEditable(order) {
  if (LOCKED_STATUSES.includes(order.status)) {
    throw httpError("This RX has already been submitted to Innovations and can no longer be changed here. Make further changes in Innovations or create a new capture.", 409);
  }
}

function applyLensGuess(order, guess) {
  const draft = JSON.parse(JSON.stringify(order));
  draft.lensRequest = { ...draft.lensRequest, materialGroup: "1", material: null, lensType: null, style: null, option: null, catalogAlias: null };
  if (guess) Object.assign(draft.lensRequest, { material: guess.material, lensType: guess.lensType, style: guess.style, option: guess.option, catalogAlias: guess.alias });
  draft.lensGuessed = Boolean(guess);
  return draft;
}

// Nothing is chosen at submission: the Innovations header comes from the
// account picked before upload, the frame section of the reviewed draft, and
// the configured defaults (lab 1177, sequence 1). EDGE TO FIT is added by the
// builder for edged jobs; other add-ons are not taken at capture.
function resolutionDefaults(requested, { existing, normalized, actor, mappedCustomerNumber }) {
  return {
    frameMounting: normalized?.frame?.mounting || "2",
    addonSkus: [],
    customerNumber: mappedCustomerNumber || existing.customer_account || "",
    shipName: existing.customer_name,
    frameMode: normalized?.frame?.status === "UNCUT" ? "uncut" : "edged",
    coatingSku: normalized?.lensRequest?.coatingSku || null,
    lensAlias: normalized?.lensRequest?.catalogAlias || "",
    remoteOperator: actor.username || actor.displayName || "",
    instructions: normalized?.instructions || ""
  };
}

module.exports = { applyLensGuess, createRxCaptureService, matchesImageSignature, parseImages, parseTranscript, publicOrder, rankFrequentCustomers, resolutionDefaults };
