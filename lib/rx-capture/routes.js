const { createRxCaptureService } = require("./service");

const service = createRxCaptureService();

async function handleRxCaptureRoute({ req, res, url, handleApi, readJsonBody, requirePermission, searchCustomers }) {
  if (!url.pathname.startsWith("/api/rx-capture/")) return false;

  if (url.pathname === "/api/rx-capture/orders" && req.method === "GET") {
    await handleApi(res, async () => {
      const actor = await requirePermission(req, "rx-capture.read");
      return { orders: await service.listOrders(actor, url.searchParams.get("limit")) };
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

module.exports = { handleRxCaptureRoute };
