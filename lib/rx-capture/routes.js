const { createRxCaptureService } = require("./service");

const service = createRxCaptureService();

async function handleRxCaptureRoute({ req, res, url, handleApi, readJsonBody, requirePermission }) {
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
      return { order: await service.createOrder(await readJsonBody(req, 24 * 1024 * 1024), actor) };
    }, 201);
    return true;
  }

  const match = url.pathname.match(/^\/api\/rx-capture\/orders\/([^/]+)(?:\/(reprocess))?$/);
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

  return false;
}

module.exports = { handleRxCaptureRoute };
