const pinSession = require("./chemistry-pin-session");
const chemistry = require("./chemistry");

const ORDER_ID_PATH = /^\/api\/chemistry\/orders\/([0-9a-fA-F-]{36})$/;
const ORDER_LOCK_PATH = /^\/api\/chemistry\/orders\/([0-9a-fA-F-]{36})\/lock$/;
const ORDER_UNLOCK_PATH = /^\/api\/chemistry\/orders\/([0-9a-fA-F-]{36})\/unlock$/;
const ORDER_ITEMS_PATH = /^\/api\/chemistry\/orders\/([0-9a-fA-F-]{36})\/items$/;
const ORDER_ITEM_PATH = /^\/api\/chemistry\/orders\/([0-9a-fA-F-]{36})\/items\/([0-9a-fA-F-]{36})$/;

// Shared PIN session used instead of a per-user login (chemistry-pin-session.js).
// Requests carry an "operator" string in the body/query for attribution on
// records (e.g. the optician's initials) since the PIN itself identifies no
// individual person.
function actorFrom(req, url, body) {
  return (body && body.operator) || url.searchParams.get("operator") || null;
}

async function handleChemistryRoute({ req, res, url, handleApi, readJsonBody }) {
  if (!url.pathname.startsWith("/api/chemistry/")) return false;

  // ── PIN session (unauthenticated by design -- this IS the auth gate) ─────
  if (url.pathname === "/api/chemistry/session/state" && req.method === "GET") {
    return handled(handleApi(res, async () => pinSession.getState()));
  }

  if (url.pathname === "/api/chemistry/session/setup" && req.method === "POST") {
    return handled(handleApi(res, async () => {
      const { pin } = await readJsonBody(req);
      const token = pinSession.setupPin(pin);
      pinSession.setSessionCookie(res, token);
      return { ok: true };
    }, 201));
  }

  if (url.pathname === "/api/chemistry/session/unlock" && req.method === "POST") {
    return handled(handleApi(res, async () => {
      const { pin } = await readJsonBody(req);
      const token = pinSession.unlock(pin);
      pinSession.setSessionCookie(res, token);
      return { ok: true };
    }));
  }

  if (url.pathname === "/api/chemistry/session/reset" && req.method === "POST") {
    return handled(handleApi(res, async () => {
      const { currentPin, newPin } = await readJsonBody(req);
      const token = pinSession.resetPin(currentPin, newPin);
      pinSession.setSessionCookie(res, token);
      return { ok: true };
    }));
  }

  if (url.pathname === "/api/chemistry/session/lock" && req.method === "POST") {
    return handled(handleApi(res, async () => {
      const token = pinSession.parseCookies(req.headers.cookie)[pinSession.COOKIE_NAME];
      pinSession.destroySession(token);
      pinSession.clearSessionCookie(res);
      return { ok: true };
    }));
  }

  // ── Everything below requires an unlocked tablet session ─────────────────
  const requireSession = () => pinSession.requireChemistrySession(req);

  if (url.pathname === "/api/chemistry/orders" && req.method === "GET") {
    return handled(handleApi(res, async () => {
      requireSession();
      return chemistry.listOrders({
        search: url.searchParams.get("search"),
        limit: url.searchParams.get("limit")
      });
    }));
  }

  if (url.pathname === "/api/chemistry/orders" && req.method === "POST") {
    return handled(handleApi(res, async () => {
      requireSession();
      const body = await readJsonBody(req);
      return chemistry.createOrder(body, actorFrom(req, url, body));
    }, 201));
  }

  const orderMatch = url.pathname.match(ORDER_ID_PATH);
  if (orderMatch && req.method === "GET") {
    return handled(handleApi(res, async () => {
      requireSession();
      return chemistry.getOrder(orderMatch[1]);
    }));
  }

  if (orderMatch && req.method === "PUT") {
    return handled(handleApi(res, async () => {
      requireSession();
      const body = await readJsonBody(req);
      return chemistry.updateOrder(orderMatch[1], body, actorFrom(req, url, body));
    }));
  }

  const lockMatch = url.pathname.match(ORDER_LOCK_PATH);
  if (lockMatch && req.method === "POST") {
    return handled(handleApi(res, async () => {
      requireSession();
      const body = await readJsonBody(req);
      return chemistry.lockOrder(lockMatch[1], actorFrom(req, url, body));
    }));
  }

  const unlockMatch = url.pathname.match(ORDER_UNLOCK_PATH);
  if (unlockMatch && req.method === "POST") {
    return handled(handleApi(res, async () => {
      requireSession();
      const body = await readJsonBody(req);
      return chemistry.unlockOrder(unlockMatch[1], actorFrom(req, url, body));
    }));
  }

  const itemsMatch = url.pathname.match(ORDER_ITEMS_PATH);
  if (itemsMatch && req.method === "POST") {
    return handled(handleApi(res, async () => {
      requireSession();
      const body = await readJsonBody(req);
      return chemistry.addOrderItem(itemsMatch[1], body, actorFrom(req, url, body));
    }, 201));
  }

  const itemMatch = url.pathname.match(ORDER_ITEM_PATH);
  if (itemMatch && req.method === "DELETE") {
    return handled(handleApi(res, async () => {
      requireSession();
      return chemistry.removeOrderItem(itemMatch[1], itemMatch[2], actorFrom(req, url, null));
    }));
  }

  if (url.pathname === "/api/chemistry/catalog/lookup" && req.method === "GET") {
    return handled(handleApi(res, async () => {
      requireSession();
      return chemistry.lookupCatalogItem(url.searchParams.get("sku"));
    }));
  }

  if (url.pathname === "/api/chemistry/catalog/search" && req.method === "GET") {
    return handled(handleApi(res, async () => {
      requireSession();
      return chemistry.searchCatalog(url.searchParams.get("term"), url.searchParams.get("limit"));
    }));
  }

  if (url.pathname === "/api/chemistry/catalog/options" && req.method === "GET") {
    return handled(handleApi(res, async () => {
      requireSession();
      return chemistry.getClipPartOptions();
    }));
  }

  if (url.pathname === "/api/chemistry/bundle-items" && req.method === "GET") {
    return handled(handleApi(res, async () => {
      requireSession();
      return chemistry.getDefaultBundleItems();
    }));
  }

  return false;
}

function handled(promise) {
  return promise.then(() => true);
}

module.exports = { handleChemistryRoute };
