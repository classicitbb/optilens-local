const crypto = require("node:crypto");
const sql = require("mssql");
const { getAppPool, getSourcePool } = require("./db");
const { getShipmentSession } = require("./delivery");
const { findVaultEntry, fieldMap } = require("./credential-vault");
const { getCustomerParameters } = require("./customer-parameters");
const { getCatalogEntries, touchCatalogEntries, learnCatalogEntry, normalizeName } = require("./co-item-catalog");
const { resolveDeliveryTerms } = require("./standards-catalog");

const CONFIG = {
  company: {
    name: "Classic Visions",
    // Confirmed live in BeSwift (training.beswift.gov.bb): switching Applicant
    // Type to "Other" exposes a TIN dropdown with exactly one option, which
    // auto-fills Name "Classic Vision" and Address "Uplands, Bridgetown" — this
    // is that TIN, i.e. the value the extension must select there.
    tin: "1111000000013",
    address: "Uplands Factory, St John",
    city: "Bridgetown",
    parish: "St. John",
    country: "Barbados",
    contacts: [
      { name: "Randall Hunte", mobile: "012462342975", email: "info@classicvisions.net" },
      { name: "Lisa Jordan", mobile: "+12462408090", email: "lisa@classicvisions.net" }
    ]
  },
  defaults: {
    regime: "Export",
    serviceType: "Certificate of Origin - CARICOM",
    portOfLoading: "GRANTLEY ADAMS INTL. AIRPORT",
    modeOfTransport: "Air",
    deliveryTerms: "Free on Board",
    currency: "BARBADOS DOLLAR",
    presentingBank: "Bank of Nova Scotia",
    commodityType: "Manufactured",
    countryOfOrigin: "Barbados",
    ruleOfOrigin: "Percentage Value",
    // Confirmed live: the real BeSwift dropdown option is the bare letter "L",
    // not a descriptive string — typing the long form finds no match and the
    // field is left blank. "46.9% per company records" is Russell's own note on
    // what "L" means, kept here for context only.
    originCriterion: "L",
    packageType: "Bag, plastic",
    unitOfMeasure: "Number of Units",
    cubeUnit: "Cubic metre",
    shippingMarksTemplate: "CLASSIC VISIONS/{ACCOUNT}/SHP{SHIPMENTID}"
  },
  carriers: {
    dimDivisorCm3PerKg: 5000,
    boxes: [
      { code: "DHL-FLYER", name: "DHL Express Flyer", carrier: "DHL", lengthCm: 40.0, widthCm: 30.0, heightCm: 3.0, cubeM3: 0.0036, maxKg: 2.0, tareKg: 0.06 },
      { code: "DHL-BOX2", name: "DHL Box 2", carrier: "DHL", lengthCm: 33.7, widthCm: 18.2, heightCm: 10.0, cubeM3: 0.00613, maxKg: 1.0, tareKg: 0.18 },
      { code: "DHL-BOX3", name: "DHL Box 3", carrier: "DHL", lengthCm: 33.7, widthCm: 32.2, heightCm: 10.0, cubeM3: 0.01085, maxKg: 2.0, tareKg: 0.3 },
      { code: "DHL-BOX4", name: "DHL Box 4", carrier: "DHL", lengthCm: 33.7, widthCm: 33.2, heightCm: 18.0, cubeM3: 0.02014, maxKg: 5.0, tareKg: 0.45 },
      { code: "DHL-BOX5", name: "DHL Box 5", carrier: "DHL", lengthCm: 33.7, widthCm: 33.2, heightCm: 34.5, cubeM3: 0.0386, maxKg: 10.0, tareKg: 0.7 },
      { code: "FEDEX-SM", name: "FedEx Small Box", carrier: "FedEx", lengthCm: 27.6, widthCm: 31.1, heightCm: 3.8, cubeM3: 0.00326, maxKg: 9.0, tareKg: 0.2 },
      { code: "FEDEX-MED", name: "FedEx Medium Box", carrier: "FedEx", lengthCm: 29.2, widthCm: 33.0, heightCm: 6.0, cubeM3: 0.00578, maxKg: 9.0, tareKg: 0.3 }
    ],
    boxSuggestion: [
      { maxJobs: 4, box: "DHL-FLYER" },
      { maxJobs: 8, box: "DHL-BOX2" },
      { maxJobs: 18, box: "DHL-BOX3" },
      { maxJobs: 40, box: "DHL-BOX4" },
      { maxJobs: 999, box: "DHL-BOX5" }
    ]
  },
  weights: {
    lensPairUncut: 0.09,
    accessory: 0.1,
    jobPackagingEnvelope: 0.025
  },
  hsCodes: {
    lensOther: { code: "90015000", description: "Spectacle lenses of other materials" },
    lensGlass: { code: "90014000", description: "Spectacle lenses of glass" }
  },
  glMapping: {
    lens: ["0700-013", "0700-016", "0700-011", "0700-080", "0700-070", "0700-000", "0700", "0600-020"],
    extras: ["0700-030", "0700-031", "0700-101", "0700-100", "0700-014", "0700-091"],
    frames: [],
    accessories: ["0700-200"],
    freight: ["0700-090"],
    glassKeywords: ["glass", "crown"],
    extrasKeywords: ["lab extras", "power charge", "high power", "hi-power", "edging", "hardcoat", "tints", "specialty"]
  },
  ports: {
    "Grenada": "GDGND",
    "Saint Lucia": "LCUVF",
    "St Vincent and The Grenadines": "VCSVD",
    "Jamaica": "JMKIN",
    "Antigua and Barbuda": "AGANU",
    "Dominica": "DMDOM",
    "Saint Kitts and Nevis": "KNSKB",
    "TRINIDAD & TOBAGO": "TTPOS",
    "Guyana": "GYGEO",
    "Dominican Republic": "DOSDQ"
  },
  carriersByMethod: {
    "16": "DHL", "19": "DHL", "11": "DHL", "12": "DHL", "13": "DHL", "14": "DHL",
    "15": "DHL", "18": "DHL", "20": "DHL", "17": "FedEx", "1": "DHL"
  },
  carrierPicklist: {
    DHL: "DHL Air",
    FedEx: "FedEx Express"
  }
};

// BeSwift's own Country dropdown (confirmed live) always spells out "Saint"
// in full (e.g. "SAINT VINCENT AND THE GRENADINES", "SAINT KITTS AND NEVIS"),
// while Innovations' Countries table (and therefore CONFIG.ports' keys, which
// must stay in sync with that raw DB spelling) abbreviates it as "St" for some
// countries (e.g. "St Vincent and The Grenadines") but not others. Typing the
// abbreviated form into BeSwift's live-filtered Country field finds nothing
// ("No data available", confirmed live) and leaves the required field blank.
// Apply this only when producing the BeSwift-facing payload value, never to
// the destCountry used for the CONFIG.ports[destCountry] lookup above/below,
// since that lookup's keys intentionally match the raw DB spelling.
function toBeswiftCountryName(name) {
  const value = text(name);
  if (!value) return value;
  return value.replace(/\bSt\.?\s+/i, "Saint ");
}

function detectCarrier(shippingMethodName, shippingMethodId) {
  const name = String(shippingMethodName || "").toUpperCase();
  if (name.includes("FEDEX")) return "FedEx";
  if (name.includes("DHL")) return "DHL";
  return CONFIG.carriersByMethod[String(shippingMethodId)] || "DHL";
}

async function getCoForShipment(sessionId) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("shipment_session_id", sessionId)
    .query(`
      SELECT TOP (1)
        co_application_id AS coApplicationId,
        shipment_session_id AS shipmentSessionId,
        portal_environment AS portalEnvironment,
        app_status AS status,
        payload_json AS payloadJson,
        editable_json AS editableJson,
        warnings_json AS warningsJson,
        created_at AS createdAt,
        updated_at AS updatedAt,
        queued_at AS queuedAt,
        filled_at AS filledAt
      FROM delivery.co_applications
      WHERE shipment_session_id = @shipment_session_id
      ORDER BY COALESCE(updated_at, created_at) DESC
    `);

  const application = result.recordset[0] ? hydrateApplication(result.recordset[0]) : null;
  return {
    application,
    jobs: application ? await listAutomationJobs(application.coApplicationId) : []
  };
}

async function prepareCoDraft(sessionId, draftInput = {}, actorUserId = null) {
  const session = await getShipmentSession(sessionId);
  if (!session.source_shipment_id) {
    const error = new Error("Select or start a shipment with an Innovations ShipmentID before preparing a BeSwift certificate.");
    error.statusCode = 400;
    throw error;
  }

  const generated = await buildPayloadFromShipment(session, draftInput);
  const editable = mergeEditablePayload(generated.payload, draftInput);
  await learnFromItems(editable.items, actorUserId);
  const warnings = [...generated.warnings, ...validateEditablePayload(editable)];
  const portalEnvironment = normalizeEnvironment(draftInput.portalEnvironment);
  const pool = await getAppPool();
  const existing = await pool.request()
    .input("shipment_session_id", sessionId)
    .query(`
      SELECT TOP (1) co_application_id
      FROM delivery.co_applications
      WHERE shipment_session_id = @shipment_session_id
      ORDER BY COALESCE(updated_at, created_at) DESC
    `);

  const payloadJson = JSON.stringify(generated.payload);
  const editableJson = JSON.stringify(editable);
  const warningsJson = JSON.stringify(warnings);

  const request = pool.request()
    .input("shipment_session_id", sessionId)
    .input("portal_environment", portalEnvironment)
    .input("payload_json", payloadJson)
    .input("editable_json", editableJson)
    .input("warnings_json", warningsJson)
    .input("actor_user_id", actorUserId);

  const result = existing.recordset.length
    ? await request
      .input("co_application_id", existing.recordset[0].co_application_id)
      .query(`
        UPDATE delivery.co_applications
        SET portal_environment = @portal_environment,
            app_status = N'draft',
            payload_json = @payload_json,
            editable_json = @editable_json,
            warnings_json = @warnings_json,
            updated_by_user_id = @actor_user_id,
            updated_at = SYSUTCDATETIME()
        OUTPUT
          inserted.co_application_id AS coApplicationId,
          inserted.shipment_session_id AS shipmentSessionId,
          inserted.portal_environment AS portalEnvironment,
          inserted.app_status AS status,
          inserted.payload_json AS payloadJson,
          inserted.editable_json AS editableJson,
          inserted.warnings_json AS warningsJson,
          inserted.created_at AS createdAt,
          inserted.updated_at AS updatedAt,
          inserted.queued_at AS queuedAt,
          inserted.filled_at AS filledAt
        WHERE co_application_id = @co_application_id
      `)
    : await request.query(`
        INSERT INTO delivery.co_applications (
          shipment_session_id,
          portal_environment,
          payload_json,
          editable_json,
          warnings_json,
          created_by_user_id,
          updated_by_user_id
        )
        OUTPUT
          inserted.co_application_id AS coApplicationId,
          inserted.shipment_session_id AS shipmentSessionId,
          inserted.portal_environment AS portalEnvironment,
          inserted.app_status AS status,
          inserted.payload_json AS payloadJson,
          inserted.editable_json AS editableJson,
          inserted.warnings_json AS warningsJson,
          inserted.created_at AS createdAt,
          inserted.updated_at AS updatedAt,
          inserted.queued_at AS queuedAt,
          inserted.filled_at AS filledAt
        VALUES (
          @shipment_session_id,
          @portal_environment,
          @payload_json,
          @editable_json,
          @warnings_json,
          @actor_user_id,
          @actor_user_id
        )
      `);

  return hydrateApplication(result.recordset[0]);
}

async function saveCoDraft(coApplicationId, draftInput = {}, actorUserId = null) {
  const current = await getApplicationById(coApplicationId);
  const payload = current.payload;
  const editable = mergeEditablePayload(payload, draftInput);
  await learnFromItems(editable.items, actorUserId);
  const warnings = validateEditablePayload(editable);
  const pool = await getAppPool();
  const result = await pool.request()
    .input("co_application_id", coApplicationId)
    .input("portal_environment", normalizeEnvironment(draftInput.portalEnvironment || current.portalEnvironment))
    .input("editable_json", JSON.stringify(editable))
    .input("warnings_json", JSON.stringify(warnings))
    .input("actor_user_id", actorUserId)
    .query(`
      UPDATE delivery.co_applications
      SET portal_environment = @portal_environment,
          app_status = N'draft',
          editable_json = @editable_json,
          warnings_json = @warnings_json,
          updated_by_user_id = @actor_user_id,
          updated_at = SYSUTCDATETIME()
      OUTPUT
        inserted.co_application_id AS coApplicationId,
        inserted.shipment_session_id AS shipmentSessionId,
        inserted.portal_environment AS portalEnvironment,
        inserted.app_status AS status,
        inserted.payload_json AS payloadJson,
        inserted.editable_json AS editableJson,
        inserted.warnings_json AS warningsJson,
        inserted.created_at AS createdAt,
        inserted.updated_at AS updatedAt,
        inserted.queued_at AS queuedAt,
        inserted.filled_at AS filledAt
      WHERE co_application_id = @co_application_id
    `);

  if (draftInput.actualGrossKg) {
    await recordWeightLog(current.shipmentSessionId, editable, actorUserId);
  }

  return hydrateApplication(result.recordset[0]);
}

async function createAutomationJob(coApplicationId, actorUserId = null) {
  const application = await getApplicationById(coApplicationId);
  const claimCode = crypto.randomBytes(18).toString("base64url");
  const payloadSnapshot = {
    coApplicationId: application.coApplicationId,
    shipmentSessionId: application.shipmentSessionId,
    portalEnvironment: application.portalEnvironment,
    payload: application.editable,
    warnings: application.warnings
  };
  const pool = await getAppPool();
  const result = await pool.request()
    .input("co_application_id", coApplicationId)
    .input("claim_code", claimCode)
    .input("portal_environment", application.portalEnvironment)
    .input("payload_snapshot_json", JSON.stringify(payloadSnapshot))
    .input("created_by_user_id", actorUserId)
    .query(`
      INSERT INTO delivery.co_automation_jobs (
        co_application_id,
        claim_code,
        portal_environment,
        payload_snapshot_json,
        log_json,
        created_by_user_id,
        expires_at
      )
      OUTPUT
        inserted.automation_job_id AS automationJobId,
        inserted.co_application_id AS coApplicationId,
        inserted.claim_code AS claimCode,
        inserted.portal_environment AS portalEnvironment,
        inserted.job_status AS status,
        inserted.log_json AS logJson,
        inserted.error_message AS errorMessage,
        inserted.created_at AS createdAt,
        inserted.expires_at AS expiresAt,
        inserted.claimed_at AS claimedAt,
        inserted.completed_at AS completedAt
      VALUES (
        @co_application_id,
        @claim_code,
        @portal_environment,
        @payload_snapshot_json,
        N'[]',
        @created_by_user_id,
        DATEADD(hour, 2, SYSUTCDATETIME())
      );

      UPDATE delivery.co_applications
      SET app_status = N'queued',
          queued_at = SYSUTCDATETIME(),
          updated_at = SYSUTCDATETIME()
      WHERE co_application_id = @co_application_id;
    `);

  return hydrateJob(result.recordset[0]);
}

async function claimAutomationJob(claimCode) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("claim_code", String(claimCode || "").trim())
    .query(`
      UPDATE delivery.co_automation_jobs
      SET job_status = N'claimed',
          claimed_at = SYSUTCDATETIME(),
          log_json = JSON_MODIFY(COALESCE(log_json, N'[]'), 'append $', JSON_QUERY(N'{"status":"claimed"}'))
      OUTPUT
        inserted.automation_job_id AS automationJobId,
        inserted.co_application_id AS coApplicationId,
        inserted.claim_code AS claimCode,
        inserted.portal_environment AS portalEnvironment,
        inserted.job_status AS status,
        inserted.payload_snapshot_json AS payloadSnapshotJson,
        inserted.log_json AS logJson,
        inserted.error_message AS errorMessage,
        inserted.created_at AS createdAt,
        inserted.expires_at AS expiresAt,
        inserted.claimed_at AS claimedAt,
        inserted.completed_at AS completedAt
      WHERE claim_code = @claim_code
        AND expires_at > SYSUTCDATETIME()
        AND (
          job_status = N'queued'
          OR (job_status = N'claimed' AND claimed_at < DATEADD(minute, -10, SYSUTCDATETIME()))
        )
    `);

  if (!result.recordset.length) {
    const error = new Error("Automation job was not found, already claimed, or expired.");
    error.statusCode = 404;
    throw error;
  }

  const job = hydrateJob(result.recordset[0]);
  const portal = getBeSwiftPortalCredentials(job.portalEnvironment);
  return {
    job,
    portal,
    payload: parseJson(result.recordset[0].payloadSnapshotJson, {})
  };
}

async function updateAutomationJobStatus(jobId, body = {}) {
  const status = normalizeJobStatus(body.status);
  const logEntry = {
    at: new Date().toISOString(),
    status,
    message: String(body.message || "").slice(0, 1000),
    details: body.details || null
  };
  const completed = ["filled_review", "error", "cancelled"].includes(status);
  const pool = await getAppPool();
  const result = await pool.request()
    .input("automation_job_id", jobId)
    .input("job_status", status)
    .input("error_message", status === "error" ? String(body.message || "Automation failed.") : null)
    .input("log_entry", JSON.stringify(logEntry))
    .query(`
      UPDATE delivery.co_automation_jobs
      SET job_status = @job_status,
          error_message = @error_message,
          log_json = JSON_MODIFY(COALESCE(log_json, N'[]'), 'append $', JSON_QUERY(@log_entry)),
          completed_at = CASE WHEN ${completed ? "1" : "0"} = 1 THEN SYSUTCDATETIME() ELSE completed_at END
      OUTPUT
        inserted.automation_job_id AS automationJobId,
        inserted.co_application_id AS coApplicationId,
        inserted.claim_code AS claimCode,
        inserted.portal_environment AS portalEnvironment,
        inserted.job_status AS status,
        inserted.log_json AS logJson,
        inserted.error_message AS errorMessage,
        inserted.created_at AS createdAt,
        inserted.expires_at AS expiresAt,
        inserted.claimed_at AS claimedAt,
        inserted.completed_at AS completedAt
      WHERE automation_job_id = @automation_job_id
    `);

  if (!result.recordset.length) {
    const error = new Error("Automation job not found.");
    error.statusCode = 404;
    throw error;
  }

  const job = hydrateJob(result.recordset[0]);
  if (completed) {
    await pool.request()
      .input("co_application_id", job.coApplicationId)
      .input("app_status", status)
      .query(`
        UPDATE delivery.co_applications
        SET app_status = @app_status,
            filled_at = CASE WHEN @app_status = N'filled_review' THEN SYSUTCDATETIME() ELSE filled_at END,
            updated_at = SYSUTCDATETIME()
        WHERE co_application_id = @co_application_id
      `);
  }
  return job;
}

// Read-only status/log lookup for a running job, keyed by automation_job_id
// (a GUID, same low-friction bearer-style access pattern as the claim code
// itself). Used by the extension's popup (direct fetch, no mixed-content
// issue from a chrome-extension:// origin) and by an operator/tooling tab
// polling progress without mutating anything — safe to call repeatedly.
async function getAutomationJobStatus(automationJobId) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("automation_job_id", String(automationJobId || "").trim())
    .query(`
      SELECT
        automation_job_id AS automationJobId,
        co_application_id AS coApplicationId,
        claim_code AS claimCode,
        portal_environment AS portalEnvironment,
        job_status AS status,
        log_json AS logJson,
        error_message AS errorMessage,
        created_at AS createdAt,
        expires_at AS expiresAt,
        claimed_at AS claimedAt,
        completed_at AS completedAt
      FROM delivery.co_automation_jobs
      WHERE automation_job_id = @automation_job_id
    `);

  if (!result.recordset.length) {
    const error = new Error("Automation job not found.");
    error.statusCode = 404;
    throw error;
  }

  return hydrateJob(result.recordset[0]);
}

// Signals a job paused via pauseForInteraction() in content.js to continue.
// Only transitions a job that is actually 'paused' (guards against a stale
// double-click or a resume sent against a job that already moved on/failed);
// appends a 'resume_signal' log entry so content.js's poll loop can tell a
// fresh signal apart from the earlier 'paused' entry by timestamp/status.
async function resumeAutomationJob(automationJobId, message = "") {
  const logEntry = {
    at: new Date().toISOString(),
    status: "resume_signal",
    message: String(message || "Resumed by operator.").slice(0, 1000),
    details: null
  };
  const pool = await getAppPool();
  const result = await pool.request()
    .input("automation_job_id", String(automationJobId || "").trim())
    .input("job_status", "filling")
    .input("log_entry", JSON.stringify(logEntry))
    .query(`
      UPDATE delivery.co_automation_jobs
      SET job_status = @job_status,
          log_json = JSON_MODIFY(COALESCE(log_json, N'[]'), 'append $', JSON_QUERY(@log_entry))
      OUTPUT
        inserted.automation_job_id AS automationJobId,
        inserted.co_application_id AS coApplicationId,
        inserted.claim_code AS claimCode,
        inserted.portal_environment AS portalEnvironment,
        inserted.job_status AS status,
        inserted.log_json AS logJson,
        inserted.error_message AS errorMessage,
        inserted.created_at AS createdAt,
        inserted.expires_at AS expiresAt,
        inserted.claimed_at AS claimedAt,
        inserted.completed_at AS completedAt
      WHERE automation_job_id = @automation_job_id
        AND job_status = N'paused'
    `);

  if (!result.recordset.length) {
    const error = new Error("Job is not currently paused (already resumed, finished, or not found).");
    error.statusCode = 409;
    throw error;
  }

  return hydrateJob(result.recordset[0]);
}

// Beta: records an operator's error + resolution note for a stuck field during
// the BeSwift fill. Inserts a durable, queryable row (mined later by an AI
// coder to refine selectors/logic) and best-effort mirrors a compact entry
// into the job's own log_json for in-context history. Never throws on the
// mirror step — capturing the resolution is the point; the log echo is a bonus.
async function recordFillResolution(automationJobId, body = {}) {
  const jobId = String(automationJobId || "").trim() || null;
  const clip = (value) => {
    const text = value === undefined || value === null ? null : String(value);
    return text === null ? null : text.slice(0, 4000);
  };
  const entry = {
    field: clip(body.field),
    section: clip(body.section),
    expectedValue: clip(body.expected ?? body.expectedValue),
    actualValue: clip(body.actual ?? body.actualValue),
    fixAction: clip(body.fix ?? body.fixAction),
    rootCause: clip(body.rootCause),
    note: clip(body.note),
    source: clip(body.source) || "beta"
  };

  const pool = await getAppPool();

  // Look up the co_application_id for this job so resolutions can be grouped by
  // application too — best-effort, leave null if the job can't be found.
  let coApplicationId = null;
  if (jobId) {
    const lookup = await pool.request()
      .input("automation_job_id", jobId)
      .query("SELECT TOP (1) co_application_id AS coApplicationId FROM delivery.co_automation_jobs WHERE automation_job_id = @automation_job_id")
      .catch(() => ({ recordset: [] }));
    coApplicationId = lookup.recordset[0]?.coApplicationId || null;
  }

  const inserted = await pool.request()
    .input("automation_job_id", jobId)
    .input("co_application_id", coApplicationId)
    .input("field", entry.field)
    .input("section", entry.section)
    .input("expected_value", entry.expectedValue)
    .input("actual_value", entry.actualValue)
    .input("fix_action", entry.fixAction)
    .input("root_cause", entry.rootCause)
    .input("note", entry.note)
    .input("source", entry.source)
    .query(`
      INSERT INTO delivery.co_fill_resolutions
        (automation_job_id, co_application_id, field, section, expected_value, actual_value, fix_action, root_cause, note, source)
      OUTPUT
        inserted.co_fill_resolution_id AS id,
        inserted.automation_job_id AS automationJobId,
        inserted.co_application_id AS coApplicationId,
        inserted.field AS field,
        inserted.section AS section,
        inserted.expected_value AS expectedValue,
        inserted.actual_value AS actualValue,
        inserted.fix_action AS fixAction,
        inserted.root_cause AS rootCause,
        inserted.note AS note,
        inserted.source AS source,
        inserted.resolved AS resolved,
        inserted.created_at AS createdAt
      VALUES
        (@automation_job_id, @co_application_id, @field, @section, @expected_value, @actual_value, @fix_action, @root_cause, @note, @source)
    `);

  if (jobId) {
    const logEntry = {
      at: new Date().toISOString(),
      status: "resolution",
      message: `Operator resolution${entry.field ? ` for "${entry.field}"` : ""}: ${entry.fixAction || entry.note || "(no detail)"}`.slice(0, 1000),
      details: entry
    };
    await pool.request()
      .input("automation_job_id", jobId)
      .input("log_entry", JSON.stringify(logEntry))
      .query(`
        UPDATE delivery.co_automation_jobs
        SET log_json = JSON_MODIFY(COALESCE(log_json, N'[]'), 'append $', JSON_QUERY(@log_entry))
        WHERE automation_job_id = @automation_job_id
      `)
      .catch(() => {}); // mirror is best-effort
  }

  return hydrateResolution(inserted.recordset[0]);
}

// Beta: read-only aggregated list of captured resolutions, newest first, for
// an AI refinement pass. Optional ?field= / ?automationJobId= narrowing.
async function listFillResolutions(filter = {}) {
  const field = String(filter.field || "").trim();
  const jobId = String(filter.automationJobId || "").trim();
  const limit = Math.min(Math.max(parseInt(filter.limit, 10) || 200, 1), 1000);

  const pool = await getAppPool();
  const request = pool.request()
    .input("field", field || null)
    .input("automation_job_id", jobId || null);
  const result = await request.query(`
    SELECT TOP (${limit})
      co_fill_resolution_id AS id,
      automation_job_id AS automationJobId,
      co_application_id AS coApplicationId,
      field,
      section,
      expected_value AS expectedValue,
      actual_value AS actualValue,
      fix_action AS fixAction,
      root_cause AS rootCause,
      note,
      source,
      resolved,
      created_at AS createdAt
    FROM delivery.co_fill_resolutions
    WHERE (@field IS NULL OR field = @field)
      AND (@automation_job_id IS NULL OR automation_job_id = @automation_job_id)
    ORDER BY created_at DESC
  `);
  return result.recordset.map(hydrateResolution);
}

function hydrateResolution(row) {
  if (!row) return null;
  return {
    id: row.id,
    automationJobId: row.automationJobId || null,
    coApplicationId: row.coApplicationId || null,
    field: row.field || "",
    section: row.section || "",
    expectedValue: row.expectedValue || "",
    actualValue: row.actualValue || "",
    fixAction: row.fixAction || "",
    rootCause: row.rootCause || "",
    note: row.note || "",
    source: row.source || "",
    resolved: Boolean(row.resolved),
    createdAt: row.createdAt
  };
}

async function listAutomationJobs(coApplicationId) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("co_application_id", coApplicationId)
    .query(`
      SELECT TOP (20)
        automation_job_id AS automationJobId,
        co_application_id AS coApplicationId,
        claim_code AS claimCode,
        portal_environment AS portalEnvironment,
        job_status AS status,
        log_json AS logJson,
        error_message AS errorMessage,
        created_at AS createdAt,
        expires_at AS expiresAt,
        claimed_at AS claimedAt,
        completed_at AS completedAt
      FROM delivery.co_automation_jobs
      WHERE co_application_id = @co_application_id
      ORDER BY created_at DESC
    `);
  return result.recordset.map(hydrateJob);
}

async function getShipmentSourceData(session) {
  const sourcePool = await getSourcePool();
  const shipmentId = String(session.source_shipment_id || "").trim();
  const header = await sourcePool.request()
    .input("shipmentId", sql.Int, parseInt(shipmentId, 10))
    .query(`
      SELECT TOP (1)
        s.ShipmentID,
        s.ShippingMethodID,
        s.TrackingNumber,
        s.ShippedTime,
        s.RecordCreated,
        sm.ShippingMethodName,
        cu.CustomerID,
        cu.AccountNumber,
        cu.CustomerName,
        cu.PhoneNumber,
        cu.GeneralEmailAddress,
        cu.TaxRegNumber,
        ca.Line1,
        ca.Line2,
        ca.Locality,
        ca.PostCode,
        co.CountryName,
        ct.FirstName,
        ct.Surname,
        ct.EmailAddress AS ContactEmail,
        ct.PhoneNumber AS ContactPhone
      FROM dbo.Shipments s
      JOIN dbo.ShippingMethods sm ON sm.ShippingMethodID = s.ShippingMethodID
      JOIN dbo.Customers cu ON cu.CustomerID = s.ShipToID
      LEFT JOIN dbo.CustomerAddresses ca ON ca.CustomerID = cu.CustomerID
      LEFT JOIN dbo.Countries co ON co.CountryID = ca.CountryID
      LEFT JOIN dbo.Contacts ct ON ct.CustomerID = cu.CustomerID AND ct.PrimaryContact = 1
      WHERE s.ShipmentID = @shipmentId
      ORDER BY ca.AddressType DESC
    `);

  if (!header.recordset.length) {
    const error = new Error(`Innovations shipment ${shipmentId} was not found.`);
    error.statusCode = 404;
    throw error;
  }

  const linesResult = await sourcePool.request()
    .input("shipmentId", sql.Int, parseInt(shipmentId, 10))
    .query(`
      SELECT
        si.OrderID,
        o.CustomerOrdReference,
        o.CustomerPOReference,
        o.PatientID,
        o.OrderType,
        ot.OrderTypeName,
        i.InvoiceID,
        i.InvoiceTime,
        i.NoCharge,
        sj.RxNumber,
        il.Description,
        il.SKU,
        il.GLAccountNumber,
        il.Quantity,
        il.InvoicePrice,
        il.Suppressed,
        il.LineNumber,
        il.Chirality,
        il.CategoryType
      FROM dbo.ShipmentItems si
      JOIN dbo.Orders o ON o.OrderID = si.OrderID
      LEFT JOIN dbo.OrderTypes ot ON ot.OrderType = o.OrderType
      LEFT JOIN dbo.Invoices i ON i.OrderID = o.OrderID AND i.Status <> 99
      LEFT JOIN dbo.FinARSalesJournal sj ON sj.InvoiceID = i.InvoiceID AND sj.OrderID = o.OrderID
      LEFT JOIN dbo.InvoiceLines il ON il.InvoiceID = i.InvoiceID AND il.Suppressed = 0
      WHERE si.ShipmentID = @shipmentId
      ORDER BY si.OrderID, il.LineNumber
    `);

  if (!linesResult.recordset.length) {
    const error = new Error(`No orders or invoice lines were found for Innovations shipment ${shipmentId}.`);
    error.statusCode = 404;
    throw error;
  }

  return {
    header: header.recordset[0],
    lines: linesResult.recordset
  };
}

async function buildPayloadFromShipment(session, draftInput = {}) {
  const shipmentId = String(session.source_shipment_id || "").trim();
  const { header: h, lines } = await getShipmentSourceData(session);
  const warnings = [];
  const composed = await composeShipmentItems(lines, warnings, { certificateOnly: true });
  const { items, jobCount } = composed;
  const box = selectBox(jobCount, draftInput.boxCode);
  const itemsWeight = round(items.reduce((sum, item) => sum + Number(item.weightKg || 0), 0), 3);
  const grossKg = round(itemsWeight + Number(box.tareKg || 0), 3);
  const dimKg = round((box.lengthCm * box.widthCm * box.heightCm) / CONFIG.carriers.dimDivisorCm3PerKg, 3);
  const destCountry = text(h.CountryName);
  const customerParams = await getCustomerParameters(h.AccountNumber);
  const portDischarge = text(customerParams?.portOfDischarge) || CONFIG.ports[destCountry] || "";
  // Delivery terms are standardised to Incoterms 2020: air shipments default to
  // FCA (not FOB, which is sea-only), unless the customer has a stored override.
  // The extension fill needs BeSwift's exact dropdown string (beswiftValue).
  const deliveryTermsInfo = resolveDeliveryTerms({
    modeOfTransport: CONFIG.defaults.modeOfTransport,
    customerOverride: text(customerParams?.deliveryTerms)
  });
  const deliveryTerms = typeof deliveryTermsInfo === "string" ? deliveryTermsInfo : deliveryTermsInfo.beswiftValue;
  const carrierBase = detectCarrier(h.ShippingMethodName, h.ShippingMethodID);
  const carrier = CONFIG.carrierPicklist[carrierBase] || carrierBase;
  const importerAddr = [h.Line1, h.Line2, h.Locality, h.PostCode].map(text).filter(Boolean).join(", ");
  const contactName = [h.FirstName, h.Surname].map(text).filter(Boolean).join(" ");
  const marks = CONFIG.defaults.shippingMarksTemplate
    .replace("{ACCOUNT}", text(h.AccountNumber))
    .replace("{SHIPMENTID}", shipmentId)
    .slice(0, 35);

  if (!portDischarge) warnings.push(`No default BeSwift port mapping for ${destCountry || "destination country"}.`);
  if (!text(h.ContactEmail)) warnings.push("Importer contact email was not found in Innovations.");
  if (!text(h.TrackingNumber) && !draftInput.trackingNumber) warnings.push("Tracking/AWB is not in Innovations; enter it before queueing automation.");

  const payload = {
    generatedAt: new Date().toISOString(),
    shipmentId: Number(shipmentId),
    shipmentSessionId: session.shipment_session_id,
    applicantReference: `SHP-${shipmentId}`,
    regime: CONFIG.defaults.regime,
    serviceType: CONFIG.defaults.serviceType,
    // Confirmed live: Applicant Type defaults to "Personal" (prefilled with the
    // logged-in BeSwift user's own individual TIN/name), but Classic Visions
    // must file as "Other" (a company), which exposes CONFIG.company.tin's
    // single dropdown option and auto-fills Name/Address/Country/Parish from it.
    applicantType: "Other",
    applicant: CONFIG.company,
    importer: {
      name: [contactName, text(h.CustomerName)].filter(Boolean).join(" - "),
      company: text(h.CustomerName),
      address: importerAddr,
      country: toBeswiftCountryName(destCountry),
      phone: text(h.ContactPhone || h.PhoneNumber),
      email: text(h.ContactEmail || h.GeneralEmailAddress)
    },
    consigneeSameAsImporter: true,
    producer: { sameAsExporter: true, name: CONFIG.company.name, country: "Barbados" },
    transport: {
      countryOfIssue: "Barbados",
      portOfLoading: CONFIG.defaults.portOfLoading,
      countryOfDestination: toBeswiftCountryName(destCountry),
      portOfDischarge: portDischarge,
      modeOfTransport: CONFIG.defaults.modeOfTransport,
      carrier,
      shippingMarks: marks,
      shippingDate: dateOnly(h.ShippedTime) || dateOnly(new Date(Date.now() + 86400000)),
      deliveryTerms,
      trackingNumber: text(h.TrackingNumber)
    },
    bank: {
      name: text(customerParams?.bankName),
      accountName: text(customerParams?.bankAccountName),
      accountNumber: text(customerParams?.bankAccountNumber),
      swiftBic: text(customerParams?.bankSwiftBic),
      routingNumber: text(customerParams?.bankRoutingNumber),
      branchAddress: text(customerParams?.bankBranchAddress)
    },
    invoiceDetails: {
      currency: CONFIG.defaults.currency,
      customerOrderNo: String(shipmentId),
      presentingBank: CONFIG.defaults.presentingBank,
      cubeQuantity: box.cubeM3,
      cubeUnit: CONFIG.defaults.cubeUnit,
      packingCost: 0,
      freightCost: round(composed.freightTotal, 2),
      insuranceCost: 0,
      otherCost: 0,
      invoiceNumbers: [...composed.invoiceNos].join(", "),
      invoiceDate: [...composed.invoiceDates].sort().at(-1) || ""
    },
    packaging: {
      box: box.code,
      boxName: box.name,
      numberOfPackages: 1,
      packageType: CONFIG.defaults.packageType,
      suggestedGrossKg: grossKg,
      dimWeightKg: dimKg,
      chargeableKgIfActualLower: dimKg,
      actualGrossKg: ""
    },
    origin: {
      countryOfOrigin: CONFIG.defaults.countryOfOrigin,
      commodityType: CONFIG.defaults.commodityType,
      ruleOfOrigin: CONFIG.defaults.ruleOfOrigin,
      originCriterion: CONFIG.defaults.originCriterion,
      notes: ""
    },
    jobs: jobCount,
    items
  };

  return { payload, warnings };
}

async function getCommercialInvoicePreview(sessionId) {
  const session = await getShipmentSession(sessionId);
  if (!session.source_shipment_id) {
    const error = new Error("Select or start a shipment with an Innovations ShipmentID before previewing a commercial invoice.");
    error.statusCode = 400;
    throw error;
  }

  const shipmentId = String(session.source_shipment_id || "").trim();
  const { header: h, lines } = await getShipmentSourceData(session);
  const warnings = [];
  const composed = await composeShipmentItems(lines, warnings, { certificateOnly: false });
  const applicationData = await getCoForShipment(sessionId).catch(() => ({ application: null }));
  const editable = applicationData.application?.editable || {};
  const customerParams = await getCustomerParameters(h.AccountNumber);
  const destCountry = text(h.CountryName);
  const portDischarge = text(editable.transport?.portOfDischarge)
    || text(customerParams?.portOfDischarge)
    || CONFIG.ports[destCountry]
    || "";
  // Commercial invoice prints the Incoterms-2020-correct label (e.g.
  // "FCA Grantley Adams International Airport (Incoterms 2020)"). An explicit
  // edit or a stored customer term still wins over the derived default.
  const ciMode = text(editable.transport?.modeOfTransport) || CONFIG.defaults.modeOfTransport;
  const deliveryTermsInfo = resolveDeliveryTerms({
    modeOfTransport: ciMode,
    customerOverride: text(editable.transport?.deliveryTerms) || text(customerParams?.deliveryTerms)
  });
  const deliveryTerms = typeof deliveryTermsInfo === "string" ? deliveryTermsInfo : deliveryTermsInfo.printLabel;
  const carrierBase = detectCarrier(h.ShippingMethodName, h.ShippingMethodID);
  const carrier = text(editable.transport?.carrier) || CONFIG.carrierPicklist[carrierBase] || carrierBase;
  const invoiceDetails = editable.invoiceDetails || {};
  const packaging = editable.packaging || {};
  const overrides = await getCommercialInvoiceLineOverrides(sessionId);
  const items = composed.items.map((item, index) => {
    const lineKey = item.lineKey || commercialInvoiceLineKey([
      item.name,
      item.unitCost,
      item.hsCode,
      item.countryOfOrigin,
      item.ref || item.invoiceNumber || item.customerReference || ""
    ]);
    const override = overrides.get(lineKey) || {};
    const unitPrice = round(numberFromText(override.unitPriceText, item.unitCost || 0), 2);
    const quantity = numberFromText(override.quantityText, item.quantity || 0);
    const amount = round(numberFromText(override.amountText, unitPrice * quantity), 2);
    return {
      lineKey,
      lineNumber: override.lineNumberText || index + 1,
      ref: override.refText || item.ref || item.invoiceNumber || item.customerReference || "",
      invoiceNumber: item.invoiceNumber || "",
      catalogName: item.name,
      specification: override.specificationText || item.name,
      sourceName: item.sourceName || item.name,
      hsCode: formatHsCode(override.hsCodeText || item.hsCode),
      hsDescription: item.hsDescription || "",
      origin: override.originText || item.countryOfOrigin || CONFIG.defaults.countryOfOrigin,
      quantity,
      unitPrice,
      amount,
      uom: item.uom || "",
      certificateEligible: Boolean(item.certificateEligible)
    };
  });
  const subTotal = round(items.reduce((sum, item) => sum + Number(item.amount || 0), 0), 2);
  const freight = round(invoiceDetails.freightCost ?? composed.freightTotal, 2);
  const packing = round(invoiceDetails.packingCost ?? 0, 2);
  const insurance = round(invoiceDetails.insuranceCost ?? 0, 2);
  const other = round(invoiceDetails.otherCost ?? 0, 2);
  const origins = [...new Set(items.map((item) => item.origin).filter(Boolean))];
  const tariffHeadings = [];
  const tariffKeys = new Set();
  for (const item of items) {
    if (!text(item.hsCode)) continue;
    const heading = text(item.hsDescription) || "Rx spectacle lenses of other materials";
    const key = `${heading}\u241F${item.hsCode}`;
    if (tariffKeys.has(key)) continue;
    tariffKeys.add(key);
    tariffHeadings.push({ heading: heading.toUpperCase(), hsCode: item.hsCode });
  }
  const contactName = [h.FirstName, h.Surname].map(text).filter(Boolean).join(" ");
  const importerAddr = [h.Line1, h.Line2, h.Locality, h.PostCode].map(text).filter(Boolean).join(", ");

  return {
    generatedAt: new Date().toISOString(),
    shipmentId: Number(shipmentId),
    invoiceNo: shipmentId,
    invoiceDate: text(invoiceDetails.invoiceDate) || [...composed.invoiceDates].sort().at(-1) || dateOnly(new Date()),
    customerOrderNo: [...composed.orderRefs].join(", ") || shipmentId,
    poNumbers: [...composed.orderRefs].join(", "),
    seller: {
      name: CONFIG.company.name,
      addressLines: ["Uplands", "St. John Barbados"],
      phone: "+1 (246) 433 4928"
    },
    consignee: {
      name: text(h.CustomerName),
      contact: contactName,
      address: importerAddr,
      country: destCountry,
      phone: text(h.ContactPhone || h.PhoneNumber),
      email: text(h.ContactEmail || h.GeneralEmailAddress),
      account: text(h.AccountNumber)
    },
    buyer: "",
    presentingBank: text(invoiceDetails.presentingBank) || CONFIG.defaults.presentingBank,
    countryOfOriginOfGoods: origins.length === 1 ? origins[0] : origins.length ? "Multiple" : CONFIG.defaults.countryOfOrigin,
    deliveryTerms,
    tariffHeadings,
    declarationText: (tariffHeadings[0]?.heading || "Rx spectacle lenses of other materials").toUpperCase(),
    declarationHsCode: items.find((item) => item.hsCode)?.hsCode || formatHsCode(CONFIG.hsCodes.lensOther.code),
    currency: CONFIG.defaults.currency,
    transport: {
      portOfLoading: CONFIG.defaults.portOfLoading,
      countryOfDestination: destCountry,
      mode: CONFIG.defaults.modeOfTransport,
      carrier,
      trackingNumber: text(editable.transport?.trackingNumber || h.TrackingNumber),
      marksAndNumbers: text(editable.transport?.shippingMarks) || CONFIG.defaults.shippingMarksTemplate
        .replace("{ACCOUNT}", text(h.AccountNumber))
        .replace("{SHIPMENTID}", shipmentId)
    },
    packaging: {
      numberOfPackages: Number(packaging.numberOfPackages || 1),
      packageType: packaging.packageType || CONFIG.defaults.packageType,
      grossWeight: packaging.actualGrossKg || "",
      cube: invoiceDetails.cubeQuantity || ""
    },
    items,
    itemCount: items.length,
    noChargeNote: "** No Charge Item",
    certificationText: "It is hereby certified that this Invoice shows the actual price of the goods described, that no other Invoice has been or will be issued and that all particulars are true and correct.",
    totals: {
      subTotal,
      packaging: packing,
      freight,
      other,
      insurance,
      invoiceTotal: round(subTotal + packing + freight + other + insurance, 2)
    },
    compliance: commercialInvoiceCompliance({
      seller: CONFIG.company.name,
      consigneeName: text(h.CustomerName),
      consigneeAddress: importerAddr,
      consigneeCountry: destCountry,
      invoiceNo: shipmentId,
      invoiceDate: text(invoiceDetails.invoiceDate) || [...composed.invoiceDates].sort().at(-1) || "",
      countryOfOrigin: origins.length ? origins[0] : "",
      deliveryTerms,
      currency: CONFIG.defaults.currency,
      grossWeight: packaging.actualGrossKg || "",
      packageType: packaging.packageType || CONFIG.defaults.packageType,
      items
    }),
    warnings
  };
}

// Commercial-invoice standardisation check against the CARICOM/Barbados required
// fields (mirrors the official CARICOM invoice form) plus the export reminders
// from Barbados Customs / Export Barbados guidance. `ready` is true only when
// every required field is present; `reminders` are always-on process notes.
function commercialInvoiceCompliance(d) {
  const present = (v) => Boolean(String(v ?? "").trim());
  const items = Array.isArray(d.items) ? d.items : [];
  const checks = [
    { key: "seller", label: "Seller name & address", ok: present(d.seller) },
    { key: "consignee", label: "Consignee name, address & country", ok: present(d.consigneeName) && present(d.consigneeAddress) && present(d.consigneeCountry) },
    { key: "invoiceNo", label: "Invoice number", ok: present(d.invoiceNo) },
    { key: "invoiceDate", label: "Invoice date", ok: present(d.invoiceDate) },
    { key: "countryOfOrigin", label: "Country of origin of goods", ok: present(d.countryOfOrigin) },
    { key: "deliveryTerms", label: "Delivery terms (Incoterms 2020)", ok: present(d.deliveryTerms) },
    { key: "currency", label: "Currency", ok: present(d.currency) },
    { key: "packages", label: "Number & kind of packages", ok: present(d.packageType) },
    { key: "grossWeight", label: "Gross weight", ok: present(d.grossWeight) },
    { key: "lineItems", label: "At least one item line", ok: items.length > 0 },
    {
      key: "itemDetail",
      label: "Each line has description, HS code, quantity & unit price",
      ok: items.length > 0 && items.every((it) =>
        present(it.specification) && present(it.hsCode) && Number(it.quantity) > 0 && Number(it.unitPrice) >= 0)
    }
  ];
  const missing = checks.filter((c) => !c.ok).map((c) => c.label);
  return {
    ready: missing.length === 0,
    checks,
    missing,
    reminders: [
      "CARICOM: present a minimum of 5 copies of the commercial invoice (up to 8) to the Certification Officer for stamping.",
      "For CARICOM preferential treatment, pair this invoice with a stamped CARICOM Certificate of Origin.",
      "Barbados Customs export: the C-63 form and the relevant Central Bank forms accompany the shipment."
    ]
  };
}

async function getCommercialInvoiceLineOverrides(sessionId) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("shipment_session_id", sessionId)
    .query(`
      SELECT
        line_key AS lineKey,
        line_number_text AS lineNumberText,
        ref_text AS refText,
        specification_text AS specificationText,
        hs_code_text AS hsCodeText,
        origin_text AS originText,
        quantity_text AS quantityText,
        unit_price_text AS unitPriceText,
        amount_text AS amountText
      FROM delivery.commercial_invoice_line_overrides
      WHERE shipment_session_id = @shipment_session_id
    `);
  return new Map(result.recordset.map((row) => [row.lineKey, row]));
}

async function saveCommercialInvoiceLineOverrides(sessionId, lines = [], actorUserId = null) {
  await getShipmentSession(sessionId);
  const pool = await getAppPool();
  for (const line of lines || []) {
    const lineKey = text(line.lineKey);
    if (!lineKey) continue;
    await pool.request()
      .input("shipment_session_id", sessionId)
      .input("line_key", lineKey)
      .input("line_number_text", nullableOverrideText(line.lineNumber))
      .input("ref_text", nullableOverrideText(line.ref))
      .input("specification_text", nullableOverrideText(line.specification))
      .input("hs_code_text", nullableOverrideText(line.hsCode))
      .input("origin_text", nullableOverrideText(line.origin))
      .input("quantity_text", nullableOverrideText(line.quantity))
      .input("unit_price_text", nullableOverrideText(line.unitPrice))
      .input("amount_text", nullableOverrideText(line.amount))
      .input("actor_user_id", actorUserId)
      .query(`
        MERGE delivery.commercial_invoice_line_overrides AS target
        USING (
          SELECT @shipment_session_id AS shipment_session_id, @line_key AS line_key
        ) AS src
        ON target.shipment_session_id = src.shipment_session_id AND target.line_key = src.line_key
        WHEN MATCHED THEN
          UPDATE SET
            line_number_text = @line_number_text,
            ref_text = @ref_text,
            specification_text = @specification_text,
            hs_code_text = @hs_code_text,
            origin_text = @origin_text,
            quantity_text = @quantity_text,
            unit_price_text = @unit_price_text,
            amount_text = @amount_text,
            updated_by_user_id = @actor_user_id,
            updated_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (
            shipment_session_id, line_key, line_number_text, ref_text,
            specification_text, hs_code_text, origin_text, quantity_text,
            unit_price_text, amount_text, created_by_user_id, updated_by_user_id
          )
          VALUES (
            @shipment_session_id, @line_key, @line_number_text, @ref_text,
            @specification_text, @hs_code_text, @origin_text, @quantity_text,
            @unit_price_text, @amount_text, @actor_user_id, @actor_user_id
          );
      `);
  }
  return { saved: (lines || []).filter((line) => text(line.lineKey)).length };
}

const LENS_BASE_CATEGORY = 1;
const LENS_ADDON_CATEGORIES = new Set([4, 6, 7, 10, 11, 13]);
// CategoryType 16 is a separate lens-sale billing path used by orders that never
// carry a CategoryType-1 line (confirmed: 0 overlap across a 3000-shipment sample).
// Descriptions look identical to normal lens descriptions ("1.50 SV Clear",
// "Resin..." etc.) but without a "Left:"/"Right:" prefix. Before this fix these
// fell into the generic "other" bucket, which meant they never got the lens
// weight/UOM/HS-code defaults below and always tripped the "not yet classified"
// warning even though they're genuine lens sales (~$289k across the sample).
const LENS_STOCK_CATEGORY = 16;
const FRAME_CATEGORY = 8;
const FREIGHT_CATEGORY = 12;
const EXCLUDED_CATEGORIES = new Set([9, 17]);

function stripSide(description) {
  const value = text(description);
  const left = value.match(/^(left|\(left\))[:\s-]*/i);
  if (left) return { side: "L", name: value.slice(left[0].length).trim() };
  const right = value.match(/^(right|\(right\))[:\s-]*/i);
  if (right) return { side: "R", name: value.slice(right[0].length).trim() };
  return {
    side: null,
    name: value
      .replace(/\s+\((left|right)\)\s*/ig, " ")
      .replace(/\s+(left|right)\s*$/ig, "")
      .trim()
  };
}

function shortCommodityName(name) {
  const value = text(name).replace(/\s+/g, " ");
  if (!value) return "";
  const progressive = value.match(/^((?:PAL|TRN\s+SV|TRN\s+S?V|[A-Z0-9]+)\s+[A-Z0-9]+(?:\s+[A-Z0-9]+){0,2})\b/i);
  if (progressive) return progressive[1].trim();
  return value
    .replace(/\s+[S]?\d+(?:\.\d+)?mm\b.*$/i, "")
    .replace(/\s+[+-]\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?.*$/i, "")
    .replace(/\s+\((left|right)\).*$/i, "")
    .trim() || value;
}

function defaultCatalogValues(category, name) {
  const defaultUom = category === "frame" ? "Pieces" : category === "lens" ? "Pairs" : "Pieces";
  const defaultWeight = category === "lens" ? CONFIG.weights.lensPairUncut : 0;
  const isGlassLens = category === "lens" && /\bglass\b/i.test(name);
  const hs = category === "lens"
    ? (isGlassLens ? CONFIG.hsCodes.lensGlass : CONFIG.hsCodes.lensOther)
    : { code: "", description: "" };
  return {
    hsCode: hs.code,
    hsDescription: hs.description,
    unitOfMeasure: defaultUom,
    weightKg: defaultWeight,
    countryOfOrigin: CONFIG.defaults.countryOfOrigin,
    certificateEligible: category === "lens"
  };
}

function isCertificateOrder(row) {
  const orderTypeName = text(row.OrderTypeName).replace(/[^a-z0-9]/gi, "").toLowerCase();
  const orderType = Number(row.OrderType);
  return Boolean(row.InvoiceID)
    && Boolean(text(row.RxNumber))
    && (orderType === 1 || orderTypeName === "rx" || orderTypeName === "rxorder");
}

async function composeShipmentItems(lines, warnings, options = {}) {
  const certificateOnly = Boolean(options.certificateOnly);
  const byOrder = new Map();
  const orderRefs = new Set();
  const invoiceNos = new Set();
  const invoiceDates = new Set();

  for (const row of lines) {
    if (row.OrderID !== null && row.OrderID !== undefined) {
      const key = String(row.OrderID);
      if (!byOrder.has(key)) byOrder.set(key, []);
      byOrder.get(key).push(row);
    }
    if (text(row.CustomerOrdReference)) orderRefs.add(text(row.CustomerOrdReference));
    if (row.InvoiceID !== null && row.InvoiceID !== undefined) invoiceNos.add(String(row.InvoiceID));
    if (row.InvoiceTime) invoiceDates.add(dateOnly(row.InvoiceTime));
  }

  const composed = [];
  let freightTotal = 0;

  for (const [, orderLines] of byOrder) {
    const first = orderLines[0] || {};
    if (certificateOnly && !isCertificateOrder(first)) continue;
    const lensParts = [];
    const frameItems = [];
    const otherItems = [];

    for (const row of orderLines) {
      if (!row.Description) continue;
      const category = Number(row.CategoryType);
      const unitPrice = Number(row.InvoicePrice || 0);
      const lineQty = Number(row.Quantity || 0);
      const lineTotal = unitPrice * lineQty;

      if (category === FREIGHT_CATEGORY) {
        freightTotal += lineTotal;
        continue;
      }
      if (EXCLUDED_CATEGORIES.has(category)) continue;
      if (!(lineTotal > 0)) continue;

      if (category === LENS_BASE_CATEGORY || category === LENS_STOCK_CATEGORY || LENS_ADDON_CATEGORIES.has(category)) {
        const { name } = stripSide(row.Description);
        if (name) lensParts.push({ name, total: lineTotal, category });
        continue;
      }

      if (category === FRAME_CATEGORY) {
        frameItems.push({ name: text(row.Description), unitPrice, qty: lineQty || 1 });
        continue;
      }

      otherItems.push({ name: text(row.Description), unitPrice, qty: lineQty || 1 });
    }

    const ref = text(first.RxNumber) || text(first.OrderID);
    const invoiceNumber = first.InvoiceID !== null && first.InvoiceID !== undefined ? String(first.InvoiceID) : "";
    const customerReference = text(first.CustomerOrdReference || first.CustomerPOReference);

    if (lensParts.length) {
      const basePart = lensParts.find((part) => part.category === LENS_BASE_CATEGORY) || lensParts[0];
      const orderedParts = [basePart, ...lensParts
        .filter((part) => part !== basePart)
        .sort((a, b) => a.category - b.category || a.name.localeCompare(b.name))];

      const seenNames = new Set();
      const nameParts = [];
      let total = 0;
      for (const part of orderedParts) {
        total += part.total;
        if (!seenNames.has(part.name)) {
          seenNames.add(part.name);
          nameParts.push(part.name);
        }
      }

      composed.push({
        name: shortCommodityName(nameParts.join(" + ")),
        sourceName: nameParts.join(" + "),
        unitPrice: round(total, 2),
        qty: 1,
        category: "lens",
        ref,
        invoiceNumber,
        customerReference,
        certificateOrder: isCertificateOrder(first)
      });
    }

    for (const frame of frameItems) {
      composed.push({
        name: shortCommodityName(frame.name),
        sourceName: frame.name,
        unitPrice: round(frame.unitPrice, 2),
        qty: frame.qty,
        category: "frame",
        ref,
        invoiceNumber,
        customerReference,
        certificateOrder: isCertificateOrder(first)
      });
    }
    for (const other of otherItems) {
      composed.push({
        name: shortCommodityName(other.name),
        sourceName: other.name,
        unitPrice: round(other.unitPrice, 2),
        qty: other.qty,
        category: "other",
        ref,
        invoiceNumber,
        customerReference,
        certificateOrder: isCertificateOrder(first)
      });
    }
  }

  if (!composed.length) {
    warnings.push(certificateOnly
      ? "No certificate-eligible Rx invoice lines were found for this shipment."
      : "No billable invoice lines were found to build commercial invoice items from.");
  }

  await touchCatalogEntries(composed.map((item) => ({ name: item.name, category: item.category })));
  const catalog = await getCatalogEntries(composed.map((item) => item.name));

  const enriched = composed.map((item) => {
    const entry = catalog.get(normalizeName(item.name));
    const defaults = defaultCatalogValues(item.category, item.name);
    const certificateEligible = entry?.certificateEligible === null || entry?.certificateEligible === undefined
      ? defaults.certificateEligible
      : Boolean(entry.certificateEligible);
    if (!entry || !entry.hsCode) {
      warnings.push(`New item not yet classified \u2014 add HS code and weight for: ${item.name}`);
    }

    return {
      ...item,
      displayName: entry?.shortName || item.name,
      hsCode: entry?.hsCode || defaults.hsCode,
      hsDescription: entry?.hsDescription || defaults.hsDescription,
      commercialDescription: entry?.commercialDescription || item.name,
      quantity: item.qty,
      uom: entry?.unitOfMeasure || defaults.unitOfMeasure,
      countryOfOrigin: entry?.countryOfOrigin || defaults.countryOfOrigin,
      certificateEligible,
      unitCost: item.unitPrice,
      value: round(item.unitPrice * item.qty, 2),
      weightKg: entry?.weightKg != null ? Number(entry.weightKg) : defaults.weightKg
    };
  });

  const grouped = new Map();
  for (const entry of enriched) {
    if (certificateOnly && !(entry.certificateOrder && entry.certificateEligible)) continue;
    const keyParts = [
      entry.displayName,
      entry.unitPrice.toFixed(2),
      entry.hsCode,
      entry.countryOfOrigin,
      certificateOnly ? "" : entry.ref || entry.invoiceNumber || entry.customerReference || ""
    ];
    const key = keyParts.join("\u241F");
    if (!grouped.has(key)) {
      grouped.set(key, { ...entry, lineKey: commercialInvoiceLineKey(keyParts), name: entry.displayName, quantity: 0, qty: 0, value: 0 });
    }
    const target = grouped.get(key);
    target.quantity += Number(entry.quantity || 0);
    target.qty = target.quantity;
    target.value = round(Number(target.value || 0) + Number(entry.value || 0), 2);
  }

  const items = [...grouped.values()];
  return { items, freightTotal, jobCount: byOrder.size, orderRefs, invoiceNos, invoiceDates };
}

function commercialInvoiceLineKey(parts) {
  return crypto.createHash("sha1").update((parts || []).map((part) => text(part)).join("\u241F")).digest("base64url");
}

async function learnFromItems(items, actorUserId) {
  for (const item of items || []) {
    if (!item?.name) continue;
    await learnCatalogEntry(item.name, {
      hsCode: item.hsCode,
      commercialDescription: item.commercialDescription,
      shortName: item.displayName || item.shortName,
      weightKg: item.weightKg,
      unitOfMeasure: item.uom,
      countryOfOrigin: item.countryOfOrigin,
      certificateEligible: item.certificateEligible
    }, actorUserId);
  }
}

function mergeEditablePayload(payload, input = {}) {
  const out = JSON.parse(JSON.stringify(payload));
  const transport = input.transport || {};
  const invoice = input.invoiceDetails || {};
  const packaging = input.packaging || {};
  const origin = input.origin || {};

  assign(out.transport, "trackingNumber", input.trackingNumber ?? transport.trackingNumber);
  assign(out.transport, "shippingDate", input.shippingDate ?? transport.shippingDate);
  assign(out.transport, "shippingMarks", input.shippingMarks ?? transport.shippingMarks);
  assign(out.transport, "deliveryTerms", input.deliveryTerms ?? transport.deliveryTerms);
  assign(out.invoiceDetails, "freightCost", input.freightCost ?? invoice.freightCost, Number);
  assign(out.invoiceDetails, "packingCost", input.packingCost ?? invoice.packingCost, Number);
  assign(out.invoiceDetails, "insuranceCost", input.insuranceCost ?? invoice.insuranceCost, Number);
  assign(out.invoiceDetails, "otherCost", input.otherCost ?? invoice.otherCost, Number);
  assign(out.invoiceDetails, "cubeQuantity", input.cubeQuantity ?? invoice.cubeQuantity, Number);
  assign(out.packaging, "box", input.boxCode ?? packaging.box);
  assign(out.packaging, "numberOfPackages", input.packageCount ?? packaging.numberOfPackages, Number);
  assign(out.packaging, "actualGrossKg", input.actualGrossKg ?? packaging.actualGrossKg, Number);
  assign(out.origin, "notes", input.originNotes ?? origin.notes);

  const box = selectBox(out.jobs, out.packaging.box);
  out.packaging.box = box.code;
  out.packaging.boxName = box.name;
  if (!input.cubeQuantity && !invoice.cubeQuantity) out.invoiceDetails.cubeQuantity = box.cubeM3;
  out.packaging.dimWeightKg = round((box.lengthCm * box.widthCm * box.heightCm) / CONFIG.carriers.dimDivisorCm3PerKg, 3);

  if (Array.isArray(input.items)) {
    out.items = out.items.map((item, index) => ({ ...item, ...(input.items[index] || {}) }));
  }
  return out;
}

function validateEditablePayload(payload) {
  const warnings = [];
  if (!text(payload.transport.trackingNumber)) warnings.push("Tracking/AWB is blank.");
  if (!text(payload.transport.shippingDate)) warnings.push("Shipping date is blank.");
  if (!Number(payload.packaging.actualGrossKg)) warnings.push("Actual gross kg is blank; suggested weight will be used for BeSwift item weights.");
  if (!text(payload.importer.email)) warnings.push("Importer email is blank.");
  for (const [index, item] of payload.items.entries()) {
    if (!text(item.hsCode)) warnings.push(`Item ${index + 1} HS code is blank.`);
    if (!Number(item.quantity)) warnings.push(`Item ${index + 1} quantity is blank or zero.`);
    if (!Number(item.unitCost)) warnings.push(`Item ${index + 1} unit cost is blank or zero.`);
  }
  return warnings;
}

function getBeSwiftPortalCredentials(environment) {
  const entry = findVaultEntry("Web Portals", [
    environment === "production" ? "beswift production" : "beswift training",
    "beswift"
  ]);
  const fields = fieldMap(entry || {});
  const url = fields.url || fields.portalurl || fields.baseurl || "https://sso.training.beswift.gov.bb/";
  const username = fields.username || fields.user || fields.login || "";
  const password = fields.password || fields.pwd || "";
  if (!username || !password) {
    const error = new Error("BeSwift portal credentials are not configured in the Web Portals vault category.");
    error.statusCode = 409;
    throw error;
  }
  return { environment: normalizeEnvironment(environment), url, username, password };
}

async function getApplicationById(coApplicationId) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("co_application_id", coApplicationId)
    .query(`
      SELECT TOP (1)
        co_application_id AS coApplicationId,
        shipment_session_id AS shipmentSessionId,
        portal_environment AS portalEnvironment,
        app_status AS status,
        payload_json AS payloadJson,
        editable_json AS editableJson,
        warnings_json AS warningsJson,
        created_at AS createdAt,
        updated_at AS updatedAt,
        queued_at AS queuedAt,
        filled_at AS filledAt
      FROM delivery.co_applications
      WHERE co_application_id = @co_application_id
    `);
  if (!result.recordset.length) {
    const error = new Error("BeSwift CO draft not found.");
    error.statusCode = 404;
    throw error;
  }
  return hydrateApplication(result.recordset[0]);
}

async function recordWeightLog(sessionId, editable, actorUserId) {
  const actual = Number(editable.packaging?.actualGrossKg || 0);
  if (!actual) return;
  const session = await getShipmentSession(sessionId);
  const pool = await getAppPool();
  await pool.request()
    .input("shipment_session_id", sessionId)
    .input("source_shipment_id", session.source_shipment_id)
    .input("customer_account", session.customer_account)
    .input("job_count", Number(editable.jobs || 0))
    .input("box_code", editable.packaging?.box || "")
    .input("actual_gross_kg", sql.Decimal(18, 3), actual)
    .input("created_by_user_id", actorUserId)
    .query(`
      INSERT INTO delivery.co_weight_log (
        shipment_session_id,
        source_shipment_id,
        customer_account,
        job_count,
        box_code,
        actual_gross_kg,
        created_by_user_id
      )
      VALUES (
        @shipment_session_id,
        @source_shipment_id,
        @customer_account,
        @job_count,
        @box_code,
        @actual_gross_kg,
        @created_by_user_id
      )
    `);
}

function hydrateApplication(row) {
  return {
    coApplicationId: row.coApplicationId,
    shipmentSessionId: row.shipmentSessionId,
    portalEnvironment: row.portalEnvironment,
    status: row.status,
    payload: parseJson(row.payloadJson, {}),
    editable: parseJson(row.editableJson, {}),
    warnings: parseJson(row.warningsJson, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    queuedAt: row.queuedAt,
    filledAt: row.filledAt
  };
}

function hydrateJob(row) {
  return {
    automationJobId: row.automationJobId,
    coApplicationId: row.coApplicationId,
    claimCode: row.claimCode,
    portalEnvironment: row.portalEnvironment,
    status: row.status,
    logs: parseJson(row.logJson, []),
    errorMessage: row.errorMessage || "",
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    claimedAt: row.claimedAt,
    completedAt: row.completedAt
  };
}

function selectBox(jobCount, preferredCode) {
  if (preferredCode) {
    const preferred = CONFIG.carriers.boxes.find((box) => box.code === preferredCode);
    if (preferred) return preferred;
  }
  const rule = CONFIG.carriers.boxSuggestion.find((item) => Number(jobCount || 0) <= item.maxJobs) || CONFIG.carriers.boxSuggestion.at(-1);
  return CONFIG.carriers.boxes.find((box) => box.code === rule.box) || CONFIG.carriers.boxes[0];
}

function assign(target, key, value, coerce) {
  if (value === undefined || value === null || value === "") return;
  target[key] = coerce ? coerce(value) : value;
}

function normalizeEnvironment(value) {
  return String(value || "training").toLowerCase() === "production" ? "production" : "training";
}

function normalizeJobStatus(value) {
  const status = String(value || "").toLowerCase();
  return ["claimed", "logging_in", "filling", "paused", "filled_review", "error", "cancelled"].includes(status) ? status : "filling";
}

function parseJson(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function dateOnly(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function formatHsCode(value) {
  const raw = text(value).replace(/\D/g, "");
  if (raw.length === 8) return `${raw.slice(0, 4)}.${raw.slice(4, 6)}.${raw.slice(6, 8)}.000`;
  if (raw.length === 10) return `${raw.slice(0, 4)}.${raw.slice(4, 6)}.${raw.slice(6, 8)}.${raw.slice(8)}`;
  return text(value);
}

function text(value) {
  return String(value ?? "").trim();
}

function nullableOverrideText(value) {
  const out = text(value);
  return out || null;
}

function numberFromText(value, fallback) {
  const raw = text(value);
  if (!raw) return Number(fallback || 0);
  const parsed = Number(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : Number(fallback || 0);
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round((Number(value || 0) + Number.EPSILON) * factor) / factor;
}

module.exports = {
  createAutomationJob,
  claimAutomationJob,
  getCoForShipment,
  getCommercialInvoicePreview,
  saveCommercialInvoiceLineOverrides,
  prepareCoDraft,
  saveCoDraft,
  updateAutomationJobStatus,
  getAutomationJobStatus,
  resumeAutomationJob,
  recordFillResolution,
  listFillResolutions
};
