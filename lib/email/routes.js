const fs = require("node:fs");
const liveGatewayAutostart = require("../live-gateway-autostart");
const { createSupabaseStaffAuth } = require("./supabase-auth");
const service = require("./service");

// /api/email/* is the only path the Cloudflare tunnel exposes. Callers are the
// OpticAdmin web app, authenticated with their Supabase session; every service
// call receives that user and checks mailbox access itself.
const DEFAULT_ORIGINS = [
  "https://www.classicvisions.net",
  "https://classicvisions.net",
  "https://staging.classicvisions.net",
  "https://classicvisions.lovable.app"
];

function allowedOrigins() {
  const extra = String(process.env.OPTILENS_EMAIL_ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...extra]);
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  // Local dev servers on this or a staff PC; the session token is still required.
  return allowedOrigins().has(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/.test(origin);
}

function writeCors(req, res) {
  const origin = req.headers.origin || "";
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}

let staffAuth = null;
function getStaffAuth() {
  if (!staffAuth) {
    staffAuth = createSupabaseStaffAuth({
      getAnonKey: () => {
        if (process.env.OPTILENS_SUPABASE_ANON_KEY) return process.env.OPTILENS_SUPABASE_ANON_KEY;
        try { return liveGatewayAutostart.load()?.anonKey || null; } catch { return null; }
      }
    });
  }
  return staffAuth;
}

async function handleEmailRoute({ req, res, url, handleApi, readJsonBody }) {
  if (!url.pathname.startsWith("/api/email/")) return false;
  writeCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(isAllowedOrigin(req.headers.origin) ? 204 : 403);
    res.end();
    return true;
  }

  const route = url.pathname.slice("/api/email/".length).split("/").filter(Boolean).map(decodeURIComponent);
  const auth = () => getStaffAuth().verify(req.headers.authorization);
  const api = (work) => handleApi(res, async () => work(await auth()));
  const method = req.method;

  if (method === "GET" && route[0] === "status") { await api((user) => service.getStatus(user)); return true; }

  if (method === "POST" && route[0] === "sync") {
    await api(async (user) => {
      const accounts = await service.listAccounts(user);
      const wanted = url.searchParams.get("account");
      for (const account of accounts.filter((row) => !wanted || row.code === wanted)) service.syncNow(account.code).catch(() => {});
      return service.getStatus(user);
    });
    return true;
  }

  if (route[0] === "accounts") {
    if (method === "POST" && route.length === 1) {
      await api(async (user) => {
        const body = await readJsonBody(req);
        return service.connectAccount(user, { address: body.address, password: body.password, displayName: body.display_name, isShared: Boolean(body.is_shared) });
      });
      return true;
    }
    const code = route[1];
    if (method === "POST" && route[2] === "members" && route[3] === "remove") {
      await api(async (user) => service.unshareAccount(user, code, (await readJsonBody(req)).email));
      return true;
    }
    if (method === "POST" && route[2] === "members") {
      await api(async (user) => service.shareAccount(user, code, (await readJsonBody(req)).email));
      return true;
    }
    if (method === "POST" && route[2] === "disconnect") {
      await api((user) => service.disconnectAccount(user, code));
      return true;
    }
  }

  if (method === "GET" && route[0] === "folders") {
    await api(async (user) => ({ folders: await service.listFolders(user, url.searchParams.get("account") || "") }));
    return true;
  }
  if (method === "GET" && route[0] === "messages" && route.length === 1) {
    await api(async (user) => {
      const folderId = url.searchParams.get("folder_id");
      if (!folderId) throw Object.assign(new Error("folder_id is required."), { statusCode: 400 });
      return { messages: await service.listMessages(user, { folderId, q: url.searchParams.get("q"), before: url.searchParams.get("before"), limit: url.searchParams.get("limit") }) };
    });
    return true;
  }
  if (route[0] === "messages" && route.length >= 2) {
    const messageId = route[1];
    if (method === "GET" && route.length === 2) { await api((user) => service.getMessage(user, messageId)); return true; }
    if (method === "PATCH" && route.length === 2) {
      await api(async (user) => {
        const body = await readJsonBody(req);
        return service.updateFlags(user, messageId, { isRead: body.is_read, isFlagged: body.is_flagged });
      });
      return true;
    }
    if (method === "POST" && route[2] === "move") {
      await api(async (user) => service.moveMessage(user, messageId, String((await readJsonBody(req)).to || "")));
      return true;
    }
  }
  if (method === "GET" && route[0] === "attachments" && route[1]) {
    try {
      const file = await service.getAttachment(await auth(), route[1]);
      res.writeHead(200, {
        "Content-Type": file.content_type || "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff"
      });
      fs.createReadStream(file.storage_path).pipe(res);
    } catch (error) {
      await handleApi(res, async () => { throw error; });
    }
    return true;
  }
  if (method === "GET" && route[0] === "history") {
    await api(async (user) => ({ messages: await service.getHistory(user, url.searchParams.getAll("address"), url.searchParams.get("limit")) }));
    return true;
  }
  if (method === "POST" && route[0] === "send") {
    await api(async (user) => {
      const body = await readJsonBody(req, 30 * 1024 * 1024);
      return service.sendMessage(user, {
        accountCode: body.account,
        to: body.to,
        cc: body.cc,
        subject: body.subject,
        text: body.text,
        replyToMessageId: body.reply_to_message_id,
        attachments: body.attachments
      });
    });
    return true;
  }

  await handleApi(res, async () => { throw Object.assign(new Error("Unknown email endpoint."), { statusCode: 404 }); });
  return true;
}

module.exports = { handleEmailRoute, isAllowedOrigin };
