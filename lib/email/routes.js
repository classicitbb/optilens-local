const fs = require("node:fs");
const liveGatewayAutostart = require("../live-gateway-autostart");
const { createSupabaseStaffAuth } = require("./supabase-auth");
const service = require("./service");

// /api/email/* is the only path the Cloudflare tunnel exposes. Callers are the
// OpticAdmin web app, authenticated with their Supabase session.
const DEFAULT_ORIGINS = [
  "https://www.classicvisions.net",
  "https://classicvisions.net",
  "https://staging.classicvisions.net",
  "https://classicvisions.lovable.app",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
];

function allowedOrigins() {
  const extra = String(process.env.OPTILENS_EMAIL_ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...extra]);
}

function isAllowedOrigin(origin) {
  return Boolean(origin) && allowedOrigins().has(origin);
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

  const route = url.pathname.slice("/api/email/".length).split("/").filter(Boolean);
  const auth = () => getStaffAuth().verify(req.headers.authorization);

  if (req.method === "GET" && route[0] === "status") {
    await handleApi(res, async () => { await auth(); return service.getStatus(); });
    return true;
  }
  if (req.method === "POST" && route[0] === "sync") {
    await handleApi(res, async () => {
      await auth();
      service.syncNow().catch(() => {});
      return service.getStatus();
    });
    return true;
  }
  if (req.method === "GET" && route[0] === "folders") {
    await handleApi(res, async () => { await auth(); return { folders: await service.listFolders() }; });
    return true;
  }
  if (req.method === "GET" && route[0] === "messages" && route.length === 1) {
    await handleApi(res, async () => {
      await auth();
      const folderId = url.searchParams.get("folder_id");
      if (!folderId) throw Object.assign(new Error("folder_id is required."), { statusCode: 400 });
      return { messages: await service.listMessages({ folderId, q: url.searchParams.get("q"), before: url.searchParams.get("before"), limit: url.searchParams.get("limit") }) };
    });
    return true;
  }
  if (route[0] === "messages" && route.length >= 2) {
    const messageId = route[1];
    if (req.method === "GET" && route.length === 2) {
      await handleApi(res, async () => { await auth(); return service.getMessage(messageId); });
      return true;
    }
    if (req.method === "PATCH" && route.length === 2) {
      await handleApi(res, async () => {
        await auth();
        const body = await readJsonBody(req);
        return service.updateFlags(messageId, { isRead: body.is_read, isFlagged: body.is_flagged });
      });
      return true;
    }
    if (req.method === "POST" && route[2] === "move") {
      await handleApi(res, async () => {
        await auth();
        const body = await readJsonBody(req);
        return service.moveMessage(messageId, String(body.to || ""));
      });
      return true;
    }
  }
  if (req.method === "GET" && route[0] === "attachments" && route[1]) {
    try {
      await auth();
      const file = await service.getAttachment(route[1]);
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
  if (req.method === "GET" && route[0] === "history") {
    await handleApi(res, async () => {
      await auth();
      return { messages: await service.getHistory(url.searchParams.getAll("address"), url.searchParams.get("limit")) };
    });
    return true;
  }
  if (req.method === "POST" && route[0] === "send") {
    await handleApi(res, async () => {
      const user = await auth();
      const body = await readJsonBody(req, 30 * 1024 * 1024);
      return service.sendMessage({
        user,
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
