const fs = require("node:fs");
const path = require("node:path");
const { createRxCaptureService } = require("./service");
const rxGenerator = require("../rx-generator");
const { FIELDS, missingForRelease, siteSettings } = require("../site-settings");
const { innovationsIncomingFolderFromVault } = require("../credential-vault");
const { getEdition } = require("../edition");

const ROOT = path.join(__dirname, "..", "..");

const service = createRxCaptureService();

async function recoverRxCaptureProcessing() {
  return service.recoverProcessingOrders();
}

async function handleRxCaptureRoute({ req, res, url, handleApi, readJsonBody, requirePermission, searchCustomers }) {
  if (!url.pathname.startsWith("/api/rx-capture/")) return false;

  if (url.pathname === "/api/rx-capture/orders" && req.method === "GET") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "rx-capture.read");
      return { orders: await service.listOrders(actor, url.searchParams.get("limit"), url.searchParams.get("q"), { batchId: url.searchParams.get("batch") }) };
    });
    return true;
  }

  // Site settings: lab number, operator, agent name and the Innovations folders.
  // Administrators only; a licensed site must save them before it can submit.
  if (url.pathname === "/api/rx-capture/site-settings" && req.method === "GET") {
    await handleApi(res, async () => {
      await requirePermission(req, "platform.admin");
      return siteSettingsView();
    });
    return true;
  }

  if (url.pathname === "/api/rx-capture/site-settings" && req.method === "PUT") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "platform.admin");
      const body = await readJsonBody(req);
      await siteSettings.save(body?.settings, actor);
      return siteSettingsView();
    });
    return true;
  }

  // Read-only: is each folder reachable and writable by this service?
  if (url.pathname === "/api/rx-capture/site-settings/check" && req.method === "POST") {
    await handleApi(res, async () => {
      await requirePermission(req, "platform.admin");
      const config = effectiveConfig();
      return {
        folders: await Promise.all([
          checkFolder("Innovations incoming folder", config.folders?.incoming),
          checkFolder("Staging folder", config.folders?.staging),
          checkFolder("Archive folder", config.folders?.archive)
        ])
      };
    });
    return true;
  }

  // Progress counts for one bulk upload (queued / processing / ready / ...).
  const batchMatch = url.pathname.match(/^\/api\/rx-capture\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    await handleApi(res, async () => {
      await requirePermission(req, "rx-capture.read");
      return { batch: await service.batchSummary(decodeURIComponent(batchMatch[1])) };
    });
    return true;
  }

  if (url.pathname === "/api/rx-capture/orders" && req.method === "POST") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "rx-capture.write");
      const body = await readJsonBody(req, 24 * 1024 * 1024);
      body.customer = await resolveCustomer(body.customer, searchCustomers);
      return { order: await service.createOrder(body, actor) };
    }, 201);
    return true;
  }

  if (url.pathname === "/api/rx-capture/customers" && req.method === "GET") {
    await handleApi(res, async () => {
      await requirePermission(req, "rx-capture.write");
      const query = String(url.searchParams.get("q") || "").trim();
      if (query.length < 2) return { customers: [] };
      const rows = await searchCustomers(query);
      return { customers: rows.slice(0, 30).map(publicCustomer) };
    });
    return true;
  }

  if (url.pathname === "/api/rx-capture/customers/frequent" && req.method === "GET") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "rx-capture.write");
      return { customers: await service.frequentCustomers(actor) };
    });
    return true;
  }

  if (url.pathname === "/api/rx-capture/voice-status" && req.method === "GET") {
    await handleApi(res, async () => {
      await requirePermission(req, "rx-capture.write");
      return service.voiceStatus();
    });
    return true;
  }

  // Speech to text for the capture page. Accepts a recording or an uploaded
  // audio file ({ audio: dataUrl, durationMs }); nothing is stored.
  if (url.pathname === "/api/rx-capture/transcribe" && req.method === "POST") {
    await handleApi(res, async () => {
      await requirePermission(req, "rx-capture.write");
      const body = await readJsonBody(req, 16 * 1024 * 1024);
      return service.transcribeDictation(body);
    });
    return true;
  }

  if (url.pathname === "/api/rx-capture/coatings" && req.method === "GET") {
    await handleApi(res, async () => {
      await requirePermission(req, "rx-capture.write");
      return { items: await service.listCoatings() };
    });
    return true;
  }

  if (url.pathname === "/api/rx-capture/catalog" && req.method === "GET") {
    await handleApi(res, async () => {
      await requirePermission(req, "rx-capture.write");
      return { items: await service.listCatalog() };
    });
    return true;
  }

  if (url.pathname === "/api/rx-capture/review-queue" && req.method === "GET") {
    await handleApi(res, async () => {
      await requireQueuePermission(req, requirePermission);
      return { orders: await service.listApprovalQueue() };
    });
    return true;
  }

  const match = url.pathname.match(/^\/api\/rx-capture\/orders\/([^/]+)(?:\/(reprocess|resolution|alias-suggestion|submission-account|approve|stage|release|submit))?$/);
  if (!match) return false;
  const orderId = decodeURIComponent(match[1]);

  if (!match[2] && req.method === "GET") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "rx-capture.read");
      return { order: await service.getOrder(orderId, actor) };
    });
    return true;
  }

  if (!match[2] && req.method === "PATCH") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "rx-capture.write");
      return { order: await service.updateOrder(orderId, await readJsonBody(req), actor) };
    });
    return true;
  }

  if (!match[2] && req.method === "DELETE") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "rx-capture.write");
      return await service.discardOrder(orderId, actor);
    });
    return true;
  }

  if (match[2] === "reprocess" && req.method === "POST") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "rx-capture.write");
      return { order: await service.reprocessOrder(orderId, actor) };
    });
    return true;
  }

  if (match[2] === "resolution" && req.method === "POST") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "rx-capture.write");
      return { order: await service.saveResolution(orderId, await readJsonBody(req), actor) };
    });
    return true;
  }

  if (match[2] === "alias-suggestion" && req.method === "GET") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "rx-capture.read");
      return { suggestion: await service.suggestAlias(orderId, actor) };
    });
    return true;
  }

  if (match[2] === "approve" && req.method === "POST") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "rx-capture.approve");
      return { order: await service.approveOrder(orderId, actor) };
    });
    return true;
  }

  if (match[2] === "stage" && req.method === "POST") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "rx-capture.stage");
      return { order: await service.stageOrder(orderId, actor) };
    });
    return true;
  }

  if (match[2] === "release" && req.method === "POST") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "rx-capture.release");
      return { order: await service.releaseOrder(orderId, actor) };
    });
    return true;
  }

  if (match[2] === "submission-account" && req.method === "GET") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "rx-capture.write");
      return await service.submissionAccount(orderId, actor);
    });
    return true;
  }

  if (match[2] === "submit" && req.method === "POST") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "rx-capture.write");
      await requirePermission(req, "rx-capture.release");
      return { order: await service.submitOrder(orderId, actor) };
    });
    return true;
  }

  return false;
}

function effectiveConfig() {
  try { return rxGenerator.loadConfig(); } catch { return { defaults: {}, folders: {} }; }
}

function siteSettingsView() {
  const saved = siteSettings.current() || {};
  const config = effectiveConfig();
  let vaultIncoming = null;
  try { vaultIncoming = innovationsIncomingFolderFromVault(); } catch { vaultIncoming = null; }
  const edition = getEdition();
  return {
    fields: FIELDS.map(({ key, label, max, kind }) => ({ key, label, max, kind })),
    saved,
    effective: {
      labNum: config.defaults?.labNum || "",
      custSeqNum: config.defaults?.custSeqNum || "",
      remoteOperator: config.defaults?.remoteOperator || "",
      agentName: config.defaults?.agentName || "",
      incomingFolder: config.folders?.incoming || "",
      stagingFolder: config.folders?.staging || "",
      archiveFolder: config.folders?.archive || ""
    },
    incomingFromVault: Boolean(vaultIncoming),
    missingForRelease: edition.restricted ? missingForRelease(saved) : [],
    edition: { name: edition.name, restricted: edition.restricted }
  };
}

async function checkFolder(label, folder) {
  if (!folder) return { label, configured: false, exists: false, writable: false };
  const resolved = path.resolve(ROOT, folder);
  const probe = async () => {
    const result = { label, configured: true, path: resolved, exists: false, writable: false };
    try {
      await fs.promises.access(resolved, fs.constants.F_OK);
      result.exists = true;
      await fs.promises.access(resolved, fs.constants.W_OK);
      result.writable = true;
    } catch (error) {
      result.error = error.code || "unreachable";
    }
    return result;
  };
  // A dead network share can take a long time to answer; do not hang the page.
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ label, configured: true, path: resolved, exists: false, writable: false, error: "timed out" }), 6000));
  return Promise.race([probe(), timeout]);
}

async function requireQueuePermission(req, requirePermission) {
  let denied;
  for (const permission of ["rx-capture.approve", "rx-capture.stage", "rx-capture.release"]) {
    try {
      return await requirePermission(req, permission);
    } catch (error) {
      if (error?.statusCode !== 403) throw error;
      denied = error;
    }
  }
  throw denied;
}

async function resolveCustomer(value, searchCustomers) {
  const source = value && typeof value === "object" ? value : {};
  const id = Number(source.id);
  const account = String(source.account || "").trim();
  if (!Number.isInteger(id) || id <= 0 || !account) {
    throw Object.assign(new Error("Select an ERP customer before submitting the prescription."), { statusCode: 400 });
  }
  const rows = await searchCustomers(account);
  const customer = rows.find((row) => Number(row.customerId) === id && String(row.customerAccount || "").trim().toLowerCase() === account.toLowerCase());
  if (!customer) throw Object.assign(new Error("The selected ERP customer is no longer available. Search and select it again."), { statusCode: 409 });
  return publicCustomer(customer);
}

function publicCustomer(row) {
  return {
    id: Number(row.customerId),
    account: String(row.customerAccount || "").trim(),
    name: String(row.customerName || "").trim()
  };
}

module.exports = { handleRxCaptureRoute, recoverRxCaptureProcessing };
