const fs = require("node:fs");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
const sql = require("mssql");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");
const MailComposer = require("nodemailer/lib/mail-composer");
const { getAppPool } = require("../db");
const { mailboxFromVault } = require("../credential-vault");
const { addressList, displayNameForFolder, folderSortKey, parseRecipients, safeFilename, snippetFrom } = require("./message-utils");

// MVP: one company mailbox, the same orders@ login the supplier automation
// reads from the vault. More accounts later become rows keyed by account_code.
const ACCOUNT_CODE = "orders";
const SYNC_DAYS = Math.max(Number(process.env.OPTILENS_EMAIL_SYNC_DAYS) || 90, 1);
const MAX_PER_FOLDER = Math.max(Number(process.env.OPTILENS_EMAIL_MAX_PER_FOLDER) || 500, 1);
const MAX_FOLDERS = 40;
const FROM_NAME = process.env.OPTILENS_EMAIL_FROM_NAME || "Classic Visions";
const ATTACHMENT_ROOT = path.join(__dirname, "..", "..", "data", "mail", "attachments");
const MAX_SEND_BYTES = 20 * 1024 * 1024;

let syncState = { running: false, lastStartedAt: null, lastCompletedAt: null, lastError: null, lastSummary: null };
let activeSync = null;

async function loadAccount() {
  const credential = mailboxFromVault();
  if (!credential) return { configured: false, reason: "The orders mailbox login is not in the Credentials Vault." };
  const pool = await getAppPool();
  const ops = (await pool.request().query(`
    SELECT TOP 1 server_hostname, port, ssl_enabled, mailbox_username
    FROM ops.MailboxConfigurations WHERE configuration_code = N'classic-visions-orders';
  `)).recordset[0] || {};
  const host = credential.host || ops.server_hostname;
  if (!host) return { configured: false, reason: "The orders mailbox has no IMAP server set." };
  return {
    configured: true,
    accountCode: ACCOUNT_CODE,
    address: credential.username || ops.mailbox_username,
    imap: {
      host,
      port: Number(credential.port || ops.port || 993),
      secure: ops.ssl_enabled === undefined ? true : ops.ssl_enabled !== false && ops.ssl_enabled !== 0,
      auth: { user: credential.username || ops.mailbox_username, pass: credential.password }
    },
    smtp: credential.smtpHost && credential.smtpPort ? {
      host: credential.smtpHost,
      port: credential.smtpPort,
      secure: credential.smtpSecure || credential.smtpPort === 465,
      auth: { user: credential.username, pass: credential.password }
    } : null
  };
}

async function withImap(account, work) {
  const client = new ImapFlow({ ...account.imap, logger: false });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

// ── Sync ────────────────────────────────────────────────────────────────────

async function upsertFolder(pool, box) {
  const special = box.specialUse || (box.path.toUpperCase() === "INBOX" ? "\\Inbox" : null);
  const result = await pool.request()
    .input("account_code", sql.NVarChar(60), ACCOUNT_CODE)
    .input("path", sql.NVarChar(400), box.path)
    .input("display_name", sql.NVarChar(200), displayNameForFolder(box.path, special))
    .input("special_use", sql.NVarChar(40), special)
    .query(`
      MERGE mail.folders AS target
      USING (SELECT @account_code AS account_code, @path AS path) AS source
        ON target.account_code = source.account_code AND target.path = source.path
      WHEN MATCHED THEN UPDATE SET display_name = @display_name, special_use = @special_use
      WHEN NOT MATCHED THEN INSERT (account_code, path, display_name, special_use) VALUES (@account_code, @path, @display_name, @special_use);
      SELECT folder_id, uid_validity FROM mail.folders WHERE account_code = @account_code AND path = @path;
    `);
  return result.recordset[0];
}

async function insertMessage(pool, folderId, uid, fetched) {
  const parsed = await simpleParser(fetched.source);
  const from = addressList(parsed.from)[0] || null;
  const to = addressList(parsed.to);
  const cc = addressList(parsed.cc);
  const flags = [...(fetched.flags || [])].map((flag) => String(flag).toUpperCase());
  const attachments = (parsed.attachments || []).filter((item) => item.contentDisposition !== "inline" || !item.contentId);
  const text = parsed.text || "";
  const references = Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references || null;

  const inserted = await pool.request()
    .input("folder_id", sql.Int, folderId)
    .input("uid", sql.BigInt, uid)
    .input("internet_message_id", sql.NVarChar(998), parsed.messageId || null)
    .input("in_reply_to", sql.NVarChar(998), parsed.inReplyTo || null)
    .input("references_header", sql.NVarChar(sql.MAX), references)
    .input("subject", sql.NVarChar(998), parsed.subject || null)
    .input("from_address", sql.NVarChar(320), from?.address || null)
    .input("from_name", sql.NVarChar(320), from?.name || null)
    .input("to_json", sql.NVarChar(sql.MAX), JSON.stringify(to))
    .input("cc_json", sql.NVarChar(sql.MAX), JSON.stringify(cc))
    .input("sent_at", sql.DateTime2(0), parsed.date || fetched.internalDate || null)
    .input("is_read", sql.Bit, flags.includes("\\SEEN"))
    .input("is_flagged", sql.Bit, flags.includes("\\FLAGGED"))
    .input("has_attachments", sql.Bit, attachments.length > 0)
    .input("snippet", sql.NVarChar(300), snippetFrom(text))
    .input("body_text", sql.NVarChar(sql.MAX), text)
    .input("body_html", sql.NVarChar(sql.MAX), typeof parsed.html === "string" ? parsed.html : null)
    .query(`
      INSERT INTO mail.messages (folder_id, uid, internet_message_id, in_reply_to, references_header, subject,
        from_address, from_name, to_json, cc_json, sent_at, is_read, is_flagged, has_attachments, snippet, body_text, body_html)
      OUTPUT INSERTED.message_id
      VALUES (@folder_id, @uid, @internet_message_id, @in_reply_to, @references_header, @subject,
        @from_address, @from_name, @to_json, @cc_json, @sent_at, @is_read, @is_flagged, @has_attachments, @snippet, @body_text, @body_html);
    `);
  const messageId = inserted.recordset[0].message_id;

  const addresses = new Map();
  if (from) addresses.set(`${from.address}|from`, { address: from.address, role: "from" });
  for (const item of to) addresses.set(`${item.address}|to`, { address: item.address, role: "to" });
  for (const item of cc) addresses.set(`${item.address}|cc`, { address: item.address, role: "cc" });
  for (const entry of addresses.values()) {
    await pool.request()
      .input("message_id", sql.BigInt, messageId)
      .input("address", sql.NVarChar(320), entry.address)
      .input("role", sql.NVarChar(4), entry.role)
      .query(`INSERT INTO mail.message_addresses (message_id, address, role) VALUES (@message_id, @address, @role);`);
  }

  if (attachments.length) {
    const dir = path.join(ATTACHMENT_ROOT, String(messageId));
    fs.mkdirSync(dir, { recursive: true });
    for (const [index, attachment] of attachments.entries()) {
      const filename = safeFilename(attachment.filename, `attachment-${index + 1}`);
      const storagePath = path.join(dir, `${index}-${filename}`);
      fs.writeFileSync(storagePath, attachment.content);
      await pool.request()
        .input("message_id", sql.BigInt, messageId)
        .input("filename", sql.NVarChar(400), filename)
        .input("content_type", sql.NVarChar(200), attachment.contentType || null)
        .input("size_bytes", sql.BigInt, attachment.size || attachment.content?.length || 0)
        .input("storage_path", sql.NVarChar(800), storagePath)
        .query(`INSERT INTO mail.attachments (message_id, filename, content_type, size_bytes, storage_path) VALUES (@message_id, @filename, @content_type, @size_bytes, @storage_path);`);
    }
  }
  return messageId;
}

async function deleteMessages(pool, folderId, uids) {
  for (const uid of uids) {
    const row = (await pool.request().input("folder_id", sql.Int, folderId).input("uid", sql.BigInt, uid)
      .query(`DELETE FROM mail.messages OUTPUT DELETED.message_id WHERE folder_id = @folder_id AND uid = @uid;`)).recordset[0];
    if (row) fs.rmSync(path.join(ATTACHMENT_ROOT, String(row.message_id)), { recursive: true, force: true });
  }
}

async function syncFolder(pool, client, box) {
  const folder = await upsertFolder(pool, box);
  const mailbox = await client.mailboxOpen(box.path, { readOnly: true });
  const uidValidity = mailbox.uidValidity ? Number(mailbox.uidValidity) : null;

  if (folder.uid_validity !== null && uidValidity !== null && Number(folder.uid_validity) !== uidValidity) {
    const stale = (await pool.request().input("folder_id", sql.Int, folder.folder_id).query(`SELECT uid FROM mail.messages WHERE folder_id = @folder_id;`)).recordset.map((row) => Number(row.uid));
    await deleteMessages(pool, folder.folder_id, stale);
  }

  const since = new Date(Date.now() - SYNC_DAYS * 86400000);
  const serverUids = mailbox.exists ? [...new Set((await client.search({ since }, { uid: true })).map(Number))].sort((x, y) => x - y).slice(-MAX_PER_FOLDER) : [];
  const serverSet = new Set(serverUids);
  const localUids = (await pool.request().input("folder_id", sql.Int, folder.folder_id).query(`SELECT uid FROM mail.messages WHERE folder_id = @folder_id;`)).recordset.map((row) => Number(row.uid));
  const localSet = new Set(localUids);

  const removed = localUids.filter((uid) => !serverSet.has(uid));
  await deleteMessages(pool, folder.folder_id, removed);

  let added = 0;
  for (const uid of serverUids.filter((value) => !localSet.has(value))) {
    const fetched = await client.fetchOne(uid, { source: true, flags: true, internalDate: true }, { uid: true });
    if (!fetched?.source) continue;
    try {
      await insertMessage(pool, folder.folder_id, uid, fetched);
      added += 1;
    } catch (error) {
      console.error(`Email sync could not store ${box.path} UID ${uid}: ${error.message}`);
    }
  }

  // Read/flag state changes made in other mail clients.
  const kept = serverUids.filter((uid) => localSet.has(uid));
  if (kept.length) {
    for await (const message of client.fetch(kept.join(","), { flags: true }, { uid: true })) {
      const flags = [...(message.flags || [])].map((flag) => String(flag).toUpperCase());
      await pool.request()
        .input("folder_id", sql.Int, folder.folder_id).input("uid", sql.BigInt, Number(message.uid))
        .input("is_read", sql.Bit, flags.includes("\\SEEN")).input("is_flagged", sql.Bit, flags.includes("\\FLAGGED"))
        .query(`UPDATE mail.messages SET is_read = @is_read, is_flagged = @is_flagged
                WHERE folder_id = @folder_id AND uid = @uid AND (is_read <> @is_read OR is_flagged <> @is_flagged);`);
    }
  }

  await pool.request().input("folder_id", sql.Int, folder.folder_id).input("uid_validity", sql.BigInt, uidValidity)
    .query(`UPDATE mail.folders SET uid_validity = @uid_validity, last_synced_at = SYSUTCDATETIME() WHERE folder_id = @folder_id;`);
  return { path: box.path, added, removed: removed.length };
}

async function runSync({ onlyPaths = null } = {}) {
  const account = await loadAccount();
  if (!account.configured) return { state: "not-configured", reason: account.reason };
  const pool = await getAppPool();
  return withImap(account, async (client) => {
    const boxes = (await client.list())
      .filter((box) => !(box.flags && box.flags.has && box.flags.has("\\Noselect")))
      .filter((box) => !onlyPaths || onlyPaths.includes(box.path))
      .slice(0, MAX_FOLDERS);
    const folders = [];
    for (const box of boxes) {
      try {
        folders.push(await syncFolder(pool, client, box));
      } catch (error) {
        folders.push({ path: box.path, error: error.message });
      }
    }
    if (!onlyPaths) {
      const keep = boxes.map((box) => box.path);
      const gone = (await pool.request().input("account_code", sql.NVarChar(60), ACCOUNT_CODE)
        .query(`SELECT folder_id, path FROM mail.folders WHERE account_code = @account_code;`)).recordset.filter((row) => !keep.includes(row.path));
      for (const row of gone) {
        await pool.request().input("folder_id", sql.Int, row.folder_id).query(`DELETE FROM mail.folders WHERE folder_id = @folder_id;`);
      }
    }
    return { state: "synced", folders };
  });
}

function syncNow(options) {
  if (activeSync) return activeSync;
  syncState = { ...syncState, running: true, lastStartedAt: new Date().toISOString() };
  activeSync = runSync(options)
    .then((summary) => {
      syncState = { ...syncState, running: false, lastCompletedAt: new Date().toISOString(), lastError: null, lastSummary: summary };
      return summary;
    })
    .catch((error) => {
      syncState = { ...syncState, running: false, lastError: error.message };
      throw error;
    })
    .finally(() => { activeSync = null; });
  return activeSync;
}

function startEmailSync({ intervalMs = Math.max(Number(process.env.OPTILENS_EMAIL_SYNC_SECONDS) || 120, 30) * 1000 } = {}) {
  if (process.env.OPTILENS_EMAIL_SYNC_DISABLED === "1") return null;
  const tick = () => syncNow().catch((error) => console.error("Email sync failed:", error.message));
  const first = setTimeout(tick, 15000);
  const timer = setInterval(tick, intervalMs);
  first.unref?.();
  timer.unref?.();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function getStatus() {
  const account = await loadAccount().catch((error) => ({ configured: false, reason: error.message }));
  return {
    configured: account.configured,
    reason: account.reason || null,
    account: account.configured ? { code: account.accountCode, address: account.address, canSend: Boolean(account.smtp) } : null,
    sync: syncState
  };
}

async function listFolders() {
  const pool = await getAppPool();
  const rows = (await pool.request().input("account_code", sql.NVarChar(60), ACCOUNT_CODE).query(`
    SELECT f.folder_id, f.path, f.display_name, f.special_use, f.last_synced_at,
           COUNT(m.message_id) AS total_count,
           SUM(CASE WHEN m.is_read = 0 THEN 1 ELSE 0 END) AS unread_count
    FROM mail.folders f LEFT JOIN mail.messages m ON m.folder_id = f.folder_id
    WHERE f.account_code = @account_code
    GROUP BY f.folder_id, f.path, f.display_name, f.special_use, f.last_synced_at;
  `)).recordset;
  return rows.map((row) => ({ ...row, unread_count: Number(row.unread_count || 0) })).sort((a, b) => folderSortKey(a).localeCompare(folderSortKey(b)));
}

const SUMMARY_COLUMNS = `m.message_id, m.folder_id, m.subject, m.from_address, m.from_name, m.to_json, m.sent_at,
  m.is_read, m.is_flagged, m.has_attachments, m.snippet`;

function summaryRow(row) {
  return { ...row, to: JSON.parse(row.to_json || "[]"), to_json: undefined };
}

async function listMessages({ folderId, q, before, limit }) {
  const pool = await getAppPool();
  const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = (await pool.request()
    .input("folder_id", sql.Int, Number(folderId))
    .input("q", sql.NVarChar(200), q ? `%${String(q).slice(0, 190)}%` : null)
    .input("before", sql.DateTime2(0), before ? new Date(before) : null)
    .input("take", sql.Int, take)
    .query(`
      SELECT TOP (@take) ${SUMMARY_COLUMNS}
      FROM mail.messages m
      WHERE m.folder_id = @folder_id
        AND (@before IS NULL OR m.sent_at < @before)
        AND (@q IS NULL OR m.subject LIKE @q OR m.from_address LIKE @q OR m.from_name LIKE @q OR m.snippet LIKE @q)
      ORDER BY m.sent_at DESC, m.message_id DESC;
    `)).recordset;
  return rows.map(summaryRow);
}

async function getMessage(messageId) {
  const pool = await getAppPool();
  const request = pool.request().input("message_id", sql.BigInt, Number(messageId));
  const row = (await request.query(`
    SELECT m.*, f.path AS folder_path, f.display_name AS folder_name, f.special_use
    FROM mail.messages m JOIN mail.folders f ON f.folder_id = m.folder_id WHERE m.message_id = @message_id;
  `)).recordset[0];
  if (!row) throw Object.assign(new Error("That email is no longer in the mailbox."), { statusCode: 404 });
  const attachments = (await pool.request().input("message_id", sql.BigInt, row.message_id)
    .query(`SELECT attachment_id, filename, content_type, size_bytes FROM mail.attachments WHERE message_id = @message_id ORDER BY attachment_id;`)).recordset;
  return {
    ...row,
    to: JSON.parse(row.to_json || "[]"),
    cc: JSON.parse(row.cc_json || "[]"),
    to_json: undefined,
    cc_json: undefined,
    attachments
  };
}

async function getAttachment(attachmentId) {
  const pool = await getAppPool();
  const row = (await pool.request().input("attachment_id", sql.BigInt, Number(attachmentId))
    .query(`SELECT filename, content_type, storage_path FROM mail.attachments WHERE attachment_id = @attachment_id;`)).recordset[0];
  if (!row || !row.storage_path.startsWith(ATTACHMENT_ROOT) || !fs.existsSync(row.storage_path)) {
    throw Object.assign(new Error("That attachment is no longer available."), { statusCode: 404 });
  }
  return row;
}

// Every synced email to or from any of the given addresses: the CRM's email
// history for a contact. Junk and deleted mail are left out.
async function getHistory(addresses, limit = 100) {
  const list = [...new Set(addresses.map((value) => String(value).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  if (!list.length) return [];
  const pool = await getAppPool();
  const request = pool.request().input("take", sql.Int, Math.min(Number(limit) || 100, 300));
  const params = list.map((address, index) => {
    request.input(`a${index}`, sql.NVarChar(320), address);
    return `@a${index}`;
  });
  const rows = (await request.query(`
    SELECT TOP (@take) ${SUMMARY_COLUMNS}, f.display_name AS folder_name, f.special_use
    FROM mail.messages m JOIN mail.folders f ON f.folder_id = m.folder_id
    WHERE m.message_id IN (SELECT message_id FROM mail.message_addresses WHERE address IN (${params.join(",")}))
      AND (f.special_use IS NULL OR f.special_use NOT IN (N'\\Trash', N'\\Junk'))
    ORDER BY m.sent_at DESC;
  `)).recordset;
  return rows.map((row) => ({ ...summaryRow(row), direction: list.includes(String(row.from_address || "").toLowerCase()) ? "received" : "sent" }));
}

// ── Mailbox changes (written to the mail server first, then the cache) ─────

async function messageLocation(pool, messageId) {
  const row = (await pool.request().input("message_id", sql.BigInt, Number(messageId)).query(`
    SELECT m.message_id, m.uid, m.folder_id, f.path FROM mail.messages m JOIN mail.folders f ON f.folder_id = m.folder_id WHERE m.message_id = @message_id;
  `)).recordset[0];
  if (!row) throw Object.assign(new Error("That email is no longer in the mailbox."), { statusCode: 404 });
  return row;
}

async function updateFlags(messageId, { isRead, isFlagged }) {
  const account = await loadAccount();
  if (!account.configured) throw Object.assign(new Error(account.reason), { statusCode: 503 });
  const pool = await getAppPool();
  const location = await messageLocation(pool, messageId);
  await withImap(account, async (client) => {
    await client.mailboxOpen(location.path);
    const uid = String(location.uid);
    if (typeof isRead === "boolean") await (isRead ? client.messageFlagsAdd(uid, ["\\Seen"], { uid: true }) : client.messageFlagsRemove(uid, ["\\Seen"], { uid: true }));
    if (typeof isFlagged === "boolean") await (isFlagged ? client.messageFlagsAdd(uid, ["\\Flagged"], { uid: true }) : client.messageFlagsRemove(uid, ["\\Flagged"], { uid: true }));
  });
  await pool.request().input("message_id", sql.BigInt, location.message_id)
    .input("is_read", sql.Bit, typeof isRead === "boolean" ? isRead : null)
    .input("is_flagged", sql.Bit, typeof isFlagged === "boolean" ? isFlagged : null)
    .query(`UPDATE mail.messages SET is_read = COALESCE(@is_read, is_read), is_flagged = COALESCE(@is_flagged, is_flagged) WHERE message_id = @message_id;`);
  return { ok: true };
}

const MOVE_TARGETS = { archive: "\\Archive", trash: "\\Trash", inbox: "\\Inbox", junk: "\\Junk" };

async function moveMessage(messageId, target) {
  const special = MOVE_TARGETS[target];
  if (!special) throw Object.assign(new Error("Move target must be archive, trash, inbox or junk."), { statusCode: 400 });
  const account = await loadAccount();
  if (!account.configured) throw Object.assign(new Error(account.reason), { statusCode: 503 });
  const pool = await getAppPool();
  const destination = (await pool.request().input("account_code", sql.NVarChar(60), ACCOUNT_CODE).input("special_use", sql.NVarChar(40), special)
    .query(`SELECT TOP 1 path FROM mail.folders WHERE account_code = @account_code AND special_use = @special_use;`)).recordset[0];
  if (!destination) throw Object.assign(new Error(`This mailbox has no ${target} folder.`), { statusCode: 409 });
  const location = await messageLocation(pool, messageId);
  await withImap(account, async (client) => {
    await client.mailboxOpen(location.path);
    await client.messageMove(String(location.uid), destination.path, { uid: true });
  });
  await deleteMessages(pool, location.folder_id, [Number(location.uid)]);
  syncNow({ onlyPaths: [destination.path] }).catch(() => {});
  return { ok: true };
}

// ── Sending ─────────────────────────────────────────────────────────────────

async function sendMessage({ user, to, cc, subject, text, replyToMessageId, attachments = [] }) {
  const account = await loadAccount();
  if (!account.configured) throw Object.assign(new Error(account.reason), { statusCode: 503 });
  if (!account.smtp) throw Object.assign(new Error("The orders mailbox has no SMTP server in the Credentials Vault, so it can't send yet."), { statusCode: 503 });

  const toList = parseRecipients(to);
  const ccList = parseRecipients(cc || []);
  if (!toList.length) throw Object.assign(new Error("Add at least one recipient."), { statusCode: 400 });
  const files = (Array.isArray(attachments) ? attachments : []).map((item, index) => ({
    filename: safeFilename(item.filename, `attachment-${index + 1}`),
    contentType: item.contentType || undefined,
    content: Buffer.from(String(item.base64 || ""), "base64")
  }));
  const totalBytes = files.reduce((sum, file) => sum + file.content.length, 0);
  if (totalBytes > MAX_SEND_BYTES) throw Object.assign(new Error("Attachments are over the 20 MB limit."), { statusCode: 413 });

  const pool = await getAppPool();
  let threading = {};
  if (replyToMessageId) {
    const original = (await pool.request().input("message_id", sql.BigInt, Number(replyToMessageId))
      .query(`SELECT internet_message_id, references_header FROM mail.messages WHERE message_id = @message_id;`)).recordset[0];
    if (original?.internet_message_id) {
      threading = {
        inReplyTo: original.internet_message_id,
        references: [original.references_header, original.internet_message_id].filter(Boolean).join(" ")
      };
    }
  }

  const domain = String(account.address).split("@")[1] || "classicvisions.local";
  const internetMessageId = `<${nodeCrypto.randomUUID()}@${domain}>`;
  const raw = await new MailComposer({
    from: { name: FROM_NAME, address: account.address },
    to: toList,
    cc: ccList.length ? ccList : undefined,
    subject: String(subject || "").slice(0, 900),
    text: String(text || ""),
    messageId: internetMessageId,
    attachments: files,
    ...threading
  }).compile().build();

  const transporter = nodemailer.createTransport(account.smtp);
  await transporter.sendMail({ envelope: { from: account.address, to: [...toList, ...ccList] }, raw });

  // Keep a copy in Sent so other mail clients and the CRM history see it.
  const sent = (await pool.request().input("account_code", sql.NVarChar(60), ACCOUNT_CODE)
    .query(`SELECT TOP 1 path FROM mail.folders WHERE account_code = @account_code AND special_use = N'\\Sent';`)).recordset[0];
  let savedToSent = false;
  if (sent && process.env.OPTILENS_EMAIL_APPEND_SENT !== "0") {
    await withImap(account, (client) => client.append(sent.path, raw, ["\\Seen"]))
      .then(() => { savedToSent = true; })
      .catch((error) => console.error("Sent email could not be saved to Sent:", error.message));
    syncNow({ onlyPaths: [sent.path] }).catch(() => {});
  }

  await pool.request()
    .input("account_code", sql.NVarChar(60), ACCOUNT_CODE)
    .input("sent_by_user_id", sql.NVarChar(64), user?.id || null)
    .input("sent_by_email", sql.NVarChar(320), user?.email || null)
    .input("to_list", sql.NVarChar(sql.MAX), [...toList, ...ccList].join(", "))
    .input("subject", sql.NVarChar(998), subject || null)
    .input("internet_message_id", sql.NVarChar(998), internetMessageId)
    .input("attachment_count", sql.Int, files.length)
    .query(`INSERT INTO mail.send_log (account_code, sent_by_user_id, sent_by_email, to_list, subject, internet_message_id, attachment_count)
            VALUES (@account_code, @sent_by_user_id, @sent_by_email, @to_list, @subject, @internet_message_id, @attachment_count);`);
  return { ok: true, internetMessageId, savedToSent };
}

module.exports = {
  getAttachment, getHistory, getMessage, getStatus, listFolders, listMessages,
  moveMessage, sendMessage, startEmailSync, syncNow, updateFlags
};
