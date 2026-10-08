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
const { protectString, unprotectString } = require("../windows-protected-store");
const { addressList, displayNameForFolder, folderSortKey, normalizeAddress, parseRecipients, safeFilename, snippetFrom } = require("./message-utils");
const { canAccessAccount, canManageAccount } = require("./access");

// Many mailboxes (~15 staff plus shared ones like orders@) live in
// mail.accounts. The mail server stays the system of record; the mail schema
// is a cache the sync rebuilds.
const SYNC_DAYS = Math.max(Number(process.env.OPTILENS_EMAIL_SYNC_DAYS) || 90, 1);
const MAX_PER_FOLDER = Math.max(Number(process.env.OPTILENS_EMAIL_MAX_PER_FOLDER) || 500, 1);
const MAX_FOLDERS = 40;
const ATTACHMENT_ROOT = path.join(__dirname, "..", "..", "data", "mail", "attachments");
const MAX_SEND_BYTES = 20 * 1024 * 1024;

const passwordCache = new Map(); // account_code -> { updatedAt, password }
const accountSync = new Map(); // account_code -> { running, lastStartedAt, lastCompletedAt, lastError }
const activeSyncs = new Map(); // account_code -> Promise

const fail = (message, statusCode) => Object.assign(new Error(message), { statusCode });

// ── Accounts and access ─────────────────────────────────────────────────────

const ACCOUNT_COLUMNS = `account_code, address, display_name, is_shared, imap_host, imap_port, imap_secure,
  smtp_host, smtp_port, smtp_secure, username, credential_source, protected_password, is_enabled,
  last_sync_at, last_error, updated_at`;

async function allAccounts(pool) {
  return (await pool.request().query(`SELECT ${ACCOUNT_COLUMNS} FROM mail.accounts ORDER BY is_shared DESC, display_name;`)).recordset;
}

async function membersByAccount(pool) {
  const rows = (await pool.request().query(`SELECT account_code, user_email, role FROM mail.account_members;`)).recordset;
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.account_code)) map.set(row.account_code, []);
    map.get(row.account_code).push({ email: row.user_email, role: row.role });
  }
  return map;
}

async function accessibleAccounts(user) {
  const pool = await getAppPool();
  const members = await membersByAccount(pool);
  return (await allAccounts(pool))
    .map((account) => ({ ...account, members: members.get(account.account_code) || [] }))
    .filter((account) => canAccessAccount(user, account, account.members));
}

async function requireAccount(user, accountCode) {
  const account = (await accessibleAccounts(user)).find((row) => row.account_code === accountCode);
  if (!account) throw fail("You don't have access to that mailbox.", 404);
  return account;
}

async function requireFolderAccess(user, folderId) {
  const pool = await getAppPool();
  const row = (await pool.request().input("folder_id", sql.Int, Number(folderId))
    .query(`SELECT account_code FROM mail.folders WHERE folder_id = @folder_id;`)).recordset[0];
  if (!row) throw fail("That folder no longer exists.", 404);
  return requireAccount(user, row.account_code);
}

async function requireMessageAccess(user, messageId) {
  const pool = await getAppPool();
  const row = (await pool.request().input("message_id", sql.BigInt, Number(messageId)).query(`
    SELECT m.message_id, m.uid, m.folder_id, f.path, f.account_code
    FROM mail.messages m JOIN mail.folders f ON f.folder_id = m.folder_id WHERE m.message_id = @message_id;
  `)).recordset[0];
  if (!row) throw fail("That email is no longer in the mailbox.", 404);
  const account = await requireAccount(user, row.account_code);
  return { location: row, account };
}

function accountPassword(account) {
  if (account.credential_source === "vault") {
    const credential = mailboxFromVault();
    if (!credential?.password) throw fail(`The ${account.address} login is not in the Credentials Vault.`, 503);
    return credential.password;
  }
  if (!account.protected_password) throw fail(`${account.address} has no saved password. Reconnect it.`, 503);
  const stamp = String(account.updated_at);
  const cached = passwordCache.get(account.account_code);
  if (cached && cached.updatedAt === stamp) return cached.password;
  const password = unprotectString(account.protected_password);
  passwordCache.set(account.account_code, { updatedAt: stamp, password });
  return password;
}

function imapOptions(account, password = accountPassword(account)) {
  return {
    host: account.imap_host,
    port: Number(account.imap_port || 993),
    secure: account.imap_secure !== false && account.imap_secure !== 0,
    auth: { user: account.username, pass: password },
    logger: false
  };
}

function smtpOptions(account) {
  if (account.credential_source === "vault") {
    const credential = mailboxFromVault();
    if (credential?.smtpHost && credential?.smtpPort) {
      return { host: credential.smtpHost, port: credential.smtpPort, secure: credential.smtpSecure || credential.smtpPort === 465, auth: { user: account.username, pass: credential.password } };
    }
  }
  if (!account.smtp_host || !account.smtp_port) return null;
  return { host: account.smtp_host, port: Number(account.smtp_port), secure: account.smtp_secure !== false && account.smtp_secure !== 0, auth: { user: account.username, pass: accountPassword(account) } };
}

async function withImap(options, work) {
  const client = new ImapFlow(options);
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

function publicAccount(account, user) {
  const state = accountSync.get(account.account_code) || {};
  return {
    code: account.account_code,
    address: account.address,
    displayName: account.display_name,
    isShared: Boolean(account.is_shared),
    canSend: Boolean(account.smtp_host || account.credential_source === "vault"),
    canManage: canManageAccount(user, account, account.members || []),
    members: account.members || [],
    isEnabled: Boolean(account.is_enabled),
    lastSyncAt: account.last_sync_at,
    lastError: account.last_error,
    syncing: Boolean(state.running)
  };
}

async function listAccounts(user) {
  return (await accessibleAccounts(user)).map((account) => publicAccount(account, user));
}

function accountCodeFor(address) {
  return address.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

// "Connect my mailbox": the person signs in to their own mailbox once. The
// login is tested before anything is saved.
async function connectAccount(user, { address, password, displayName, isShared }) {
  const normalized = normalizeAddress(address);
  if (!normalized) throw fail("Enter a valid email address.", 400);
  if (!password) throw fail("Enter the mailbox password.", 400);
  if (isShared && !user.isAdmin) throw fail("Only admins can add shared mailboxes.", 403);

  const pool = await getAppPool();
  const template = (await pool.request().query(`SELECT TOP 1 imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure FROM mail.accounts ORDER BY is_shared DESC;`)).recordset[0];
  const settings = {
    imap_host: process.env.OPTILENS_EMAIL_IMAP_HOST || template?.imap_host || "mail.classicvisions.net",
    imap_port: template?.imap_port || 993,
    imap_secure: template ? template.imap_secure : true,
    smtp_host: process.env.OPTILENS_EMAIL_SMTP_HOST || template?.smtp_host || template?.imap_host || "mail.classicvisions.net",
    smtp_port: template?.smtp_port || 465,
    smtp_secure: template ? template.smtp_secure !== false : true
  };

  const existing = (await pool.request().input("address", sql.NVarChar(320), normalized)
    .query(`SELECT account_code FROM mail.accounts WHERE address = @address;`)).recordset[0];
  if (existing) {
    const members = (await membersByAccount(pool)).get(existing.account_code) || [];
    const account = (await allAccounts(pool)).find((row) => row.account_code === existing.account_code);
    if (!canManageAccount(user, account, members)) throw fail("That mailbox is already connected. Ask its owner or an admin for access.", 409);
  }

  try {
    await withImap({ host: settings.imap_host, port: settings.imap_port, secure: Boolean(settings.imap_secure), auth: { user: normalized, pass: password }, logger: false }, async () => {});
  } catch (error) {
    throw fail(`The mail server rejected that login (${error.responseText || error.message}). Check the address and password.`, 400);
  }

  const code = existing?.account_code || accountCodeFor(normalized);
  const protectedPassword = protectString(password);
  await pool.request()
    .input("account_code", sql.NVarChar(60), code)
    .input("address", sql.NVarChar(320), normalized)
    .input("display_name", sql.NVarChar(200), String(displayName || "").trim().slice(0, 200) || normalized)
    .input("is_shared", sql.Bit, Boolean(isShared))
    .input("imap_host", sql.NVarChar(260), settings.imap_host)
    .input("imap_port", sql.Int, settings.imap_port)
    .input("imap_secure", sql.Bit, Boolean(settings.imap_secure))
    .input("smtp_host", sql.NVarChar(260), settings.smtp_host)
    .input("smtp_port", sql.Int, settings.smtp_port)
    .input("smtp_secure", sql.Bit, Boolean(settings.smtp_secure))
    .input("protected_password", sql.NVarChar(sql.MAX), protectedPassword)
    .input("created_by_email", sql.NVarChar(320), user.email)
    .query(`
      MERGE mail.accounts AS target USING (SELECT @account_code AS account_code) AS source ON target.account_code = source.account_code
      WHEN MATCHED THEN UPDATE SET display_name = @display_name, protected_password = @protected_password, credential_source = N'stored',
        is_enabled = 1, last_error = NULL, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (account_code, address, display_name, is_shared, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, credential_source, protected_password, created_by_email)
        VALUES (@account_code, @address, @display_name, @is_shared, @imap_host, @imap_port, @imap_secure, @smtp_host, @smtp_port, @smtp_secure, @address, N'stored', @protected_password, @created_by_email);
    `);
  if (!existing && !isShared) await addMember(pool, code, user.email, "owner", user.email);
  passwordCache.delete(code);
  syncNow(code).catch(() => {});
  return { code };
}

async function addMember(pool, accountCode, email, role, addedBy) {
  await pool.request()
    .input("account_code", sql.NVarChar(60), accountCode)
    .input("user_email", sql.NVarChar(320), email)
    .input("role", sql.NVarChar(10), role)
    .input("added_by_email", sql.NVarChar(320), addedBy)
    .query(`IF NOT EXISTS (SELECT 1 FROM mail.account_members WHERE account_code = @account_code AND user_email = @user_email)
            INSERT INTO mail.account_members (account_code, user_email, role, added_by_email) VALUES (@account_code, @user_email, @role, @added_by_email);`);
}

async function shareAccount(user, accountCode, email) {
  const account = await requireAccount(user, accountCode);
  if (!canManageAccount(user, account, account.members)) throw fail("Only the mailbox owner or an admin can share it.", 403);
  const normalized = normalizeAddress(email);
  if (!normalized) throw fail("Enter the OpticAdmin sign-in email of the person to add.", 400);
  await addMember(await getAppPool(), accountCode, normalized, "member", user.email);
  return listAccounts(user);
}

async function unshareAccount(user, accountCode, email) {
  const account = await requireAccount(user, accountCode);
  if (!canManageAccount(user, account, account.members)) throw fail("Only the mailbox owner or an admin can change who has access.", 403);
  await (await getAppPool()).request()
    .input("account_code", sql.NVarChar(60), accountCode).input("user_email", sql.NVarChar(320), String(email || "").toLowerCase())
    .query(`DELETE FROM mail.account_members WHERE account_code = @account_code AND user_email = @user_email AND role <> N'owner';`);
  return listAccounts(user);
}

async function disconnectAccount(user, accountCode) {
  const account = await requireAccount(user, accountCode);
  if (!canManageAccount(user, account, account.members)) throw fail("Only the mailbox owner or an admin can disconnect it.", 403);
  const pool = await getAppPool();
  const ids = (await pool.request().input("account_code", sql.NVarChar(60), accountCode).query(`
    SELECT m.message_id FROM mail.messages m JOIN mail.folders f ON f.folder_id = m.folder_id WHERE f.account_code = @account_code AND m.has_attachments = 1;
  `)).recordset.map((row) => row.message_id);
  await pool.request().input("account_code", sql.NVarChar(60), accountCode).query(`DELETE FROM mail.accounts WHERE account_code = @account_code;`);
  for (const id of ids) fs.rmSync(path.join(ATTACHMENT_ROOT, String(id)), { recursive: true, force: true });
  passwordCache.delete(accountCode);
  return listAccounts(user);
}

// ── Sync ────────────────────────────────────────────────────────────────────

async function upsertFolder(pool, accountCode, box) {
  const special = box.specialUse || (box.path.toUpperCase() === "INBOX" ? "\\Inbox" : null);
  const result = await pool.request()
    .input("account_code", sql.NVarChar(60), accountCode)
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

async function syncFolder(pool, client, accountCode, box) {
  const folder = await upsertFolder(pool, accountCode, box);
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
      console.error(`Email sync could not store ${accountCode} ${box.path} UID ${uid}: ${error.message}`);
    }
  }

  // Read/flag changes made in other mail clients.
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

async function syncAccount(account, { onlyPaths = null } = {}) {
  const pool = await getAppPool();
  try {
    const summary = await withImap(imapOptions(account), async (client) => {
      const boxes = (await client.list())
        .filter((box) => !(box.flags && box.flags.has && box.flags.has("\\Noselect")))
        .filter((box) => !onlyPaths || onlyPaths.includes(box.path))
        .slice(0, MAX_FOLDERS);
      const folders = [];
      for (const box of boxes) {
        try {
          folders.push(await syncFolder(pool, client, account.account_code, box));
        } catch (error) {
          folders.push({ path: box.path, error: error.message });
        }
      }
      if (!onlyPaths) {
        const keep = boxes.map((box) => box.path);
        const gone = (await pool.request().input("account_code", sql.NVarChar(60), account.account_code)
          .query(`SELECT folder_id, path FROM mail.folders WHERE account_code = @account_code;`)).recordset.filter((row) => !keep.includes(row.path));
        for (const row of gone) await pool.request().input("folder_id", sql.Int, row.folder_id).query(`DELETE FROM mail.folders WHERE folder_id = @folder_id;`);
      }
      return { account: account.account_code, folders };
    });
    await pool.request().input("account_code", sql.NVarChar(60), account.account_code)
      .query(`UPDATE mail.accounts SET last_sync_at = SYSUTCDATETIME(), last_error = NULL WHERE account_code = @account_code;`);
    return summary;
  } catch (error) {
    await pool.request().input("account_code", sql.NVarChar(60), account.account_code).input("last_error", sql.NVarChar(1000), String(error.message).slice(0, 1000))
      .query(`UPDATE mail.accounts SET last_error = @last_error WHERE account_code = @account_code;`);
    throw error;
  }
}

function syncNow(accountCode, options) {
  if (activeSyncs.has(accountCode)) return activeSyncs.get(accountCode);
  const state = { ...(accountSync.get(accountCode) || {}), running: true, lastStartedAt: new Date().toISOString() };
  accountSync.set(accountCode, state);
  const run = (async () => {
    const pool = await getAppPool();
    const account = (await allAccounts(pool)).find((row) => row.account_code === accountCode && row.is_enabled);
    if (!account) return { account: accountCode, state: "disabled" };
    return syncAccount(account, options);
  })()
    .then((summary) => {
      accountSync.set(accountCode, { ...state, running: false, lastCompletedAt: new Date().toISOString(), lastError: null });
      return summary;
    })
    .catch((error) => {
      accountSync.set(accountCode, { ...state, running: false, lastError: error.message });
      throw error;
    })
    .finally(() => activeSyncs.delete(accountCode));
  activeSyncs.set(accountCode, run);
  return run;
}

// One pass over every enabled mailbox, one at a time so 15+ accounts don't
// open 15 connections to the mail host at once. A failing mailbox is logged
// on its row and does not stop the others.
async function syncAllAccounts() {
  const pool = await getAppPool();
  const accounts = (await allAccounts(pool)).filter((row) => row.is_enabled);
  const results = [];
  for (const account of accounts) {
    try {
      results.push(await syncNow(account.account_code));
    } catch (error) {
      results.push({ account: account.account_code, error: error.message });
    }
  }
  return results;
}

function startEmailSync({ intervalMs = Math.max(Number(process.env.OPTILENS_EMAIL_SYNC_SECONDS) || 120, 30) * 1000 } = {}) {
  if (process.env.OPTILENS_EMAIL_SYNC_DISABLED === "1") return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await syncAllAccounts(); } catch (error) { console.error("Email sync failed:", error.message); } finally { running = false; }
  };
  const first = setTimeout(tick, 15000);
  const timer = setInterval(tick, intervalMs);
  first.unref?.();
  timer.unref?.();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function getStatus(user) {
  return { accounts: await listAccounts(user), user: { email: user.email, isAdmin: Boolean(user.isAdmin) } };
}

async function listFolders(user, accountCode) {
  await requireAccount(user, accountCode);
  const pool = await getAppPool();
  const rows = (await pool.request().input("account_code", sql.NVarChar(60), accountCode).query(`
    SELECT f.folder_id, f.account_code, f.path, f.display_name, f.special_use, f.last_synced_at,
           COUNT(m.message_id) AS total_count,
           SUM(CASE WHEN m.is_read = 0 THEN 1 ELSE 0 END) AS unread_count
    FROM mail.folders f LEFT JOIN mail.messages m ON m.folder_id = f.folder_id
    WHERE f.account_code = @account_code
    GROUP BY f.folder_id, f.account_code, f.path, f.display_name, f.special_use, f.last_synced_at;
  `)).recordset;
  return rows.map((row) => ({ ...row, unread_count: Number(row.unread_count || 0) })).sort((a, b) => folderSortKey(a).localeCompare(folderSortKey(b)));
}

const SUMMARY_COLUMNS = `m.message_id, m.folder_id, m.subject, m.from_address, m.from_name, m.to_json, m.sent_at,
  m.is_read, m.is_flagged, m.has_attachments, m.snippet`;

function summaryRow(row) {
  return { ...row, to: JSON.parse(row.to_json || "[]"), to_json: undefined };
}

async function listMessages(user, { folderId, q, before, limit }) {
  await requireFolderAccess(user, folderId);
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

async function getMessage(user, messageId) {
  const { account } = await requireMessageAccess(user, messageId);
  const pool = await getAppPool();
  const row = (await pool.request().input("message_id", sql.BigInt, Number(messageId)).query(`
    SELECT m.*, f.path AS folder_path, f.display_name AS folder_name, f.special_use
    FROM mail.messages m JOIN mail.folders f ON f.folder_id = m.folder_id WHERE m.message_id = @message_id;
  `)).recordset[0];
  const attachments = (await pool.request().input("message_id", sql.BigInt, row.message_id)
    .query(`SELECT attachment_id, filename, content_type, size_bytes FROM mail.attachments WHERE message_id = @message_id ORDER BY attachment_id;`)).recordset;
  return {
    ...row,
    account_code: account.account_code,
    account_address: account.address,
    to: JSON.parse(row.to_json || "[]"),
    cc: JSON.parse(row.cc_json || "[]"),
    to_json: undefined,
    cc_json: undefined,
    attachments
  };
}

async function getAttachment(user, attachmentId) {
  const pool = await getAppPool();
  const row = (await pool.request().input("attachment_id", sql.BigInt, Number(attachmentId))
    .query(`SELECT message_id, filename, content_type, storage_path FROM mail.attachments WHERE attachment_id = @attachment_id;`)).recordset[0];
  if (!row) throw fail("That attachment is no longer available.", 404);
  await requireMessageAccess(user, row.message_id);
  if (!row.storage_path.startsWith(ATTACHMENT_ROOT) || !fs.existsSync(row.storage_path)) throw fail("That attachment is no longer available.", 404);
  return row;
}

// The CRM's email history for a contact: every synced email to or from the
// given addresses, across the mailboxes this person can open. Junk and
// deleted mail are left out.
async function getHistory(user, addresses, limit = 100) {
  const list = [...new Set(addresses.map((value) => String(value).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  const accounts = (await accessibleAccounts(user)).map((account) => account.account_code);
  if (!list.length || !accounts.length) return [];
  const pool = await getAppPool();
  const request = pool.request().input("take", sql.Int, Math.min(Number(limit) || 100, 300));
  const addressParams = list.map((address, index) => { request.input(`a${index}`, sql.NVarChar(320), address); return `@a${index}`; });
  const accountParams = accounts.map((code, index) => { request.input(`c${index}`, sql.NVarChar(60), code); return `@c${index}`; });
  const rows = (await request.query(`
    SELECT TOP (@take) ${SUMMARY_COLUMNS}, f.display_name AS folder_name, f.special_use, a.address AS account_address
    FROM mail.messages m
    JOIN mail.folders f ON f.folder_id = m.folder_id
    JOIN mail.accounts a ON a.account_code = f.account_code
    WHERE m.message_id IN (SELECT message_id FROM mail.message_addresses WHERE address IN (${addressParams.join(",")}))
      AND f.account_code IN (${accountParams.join(",")})
      AND (f.special_use IS NULL OR f.special_use NOT IN (N'\\Trash', N'\\Junk'))
    ORDER BY m.sent_at DESC;
  `)).recordset;
  return rows.map((row) => ({ ...summaryRow(row), direction: list.includes(String(row.from_address || "").toLowerCase()) ? "received" : "sent" }));
}

// ── Mailbox changes (mail server first, then the cache) ────────────────────

async function updateFlags(user, messageId, { isRead, isFlagged }) {
  const { location, account } = await requireMessageAccess(user, messageId);
  await withImap(imapOptions(account), async (client) => {
    await client.mailboxOpen(location.path);
    const uid = String(location.uid);
    if (typeof isRead === "boolean") await (isRead ? client.messageFlagsAdd(uid, ["\\Seen"], { uid: true }) : client.messageFlagsRemove(uid, ["\\Seen"], { uid: true }));
    if (typeof isFlagged === "boolean") await (isFlagged ? client.messageFlagsAdd(uid, ["\\Flagged"], { uid: true }) : client.messageFlagsRemove(uid, ["\\Flagged"], { uid: true }));
  });
  await (await getAppPool()).request().input("message_id", sql.BigInt, location.message_id)
    .input("is_read", sql.Bit, typeof isRead === "boolean" ? isRead : null)
    .input("is_flagged", sql.Bit, typeof isFlagged === "boolean" ? isFlagged : null)
    .query(`UPDATE mail.messages SET is_read = COALESCE(@is_read, is_read), is_flagged = COALESCE(@is_flagged, is_flagged) WHERE message_id = @message_id;`);
  return { ok: true };
}

const MOVE_TARGETS = { archive: "\\Archive", trash: "\\Trash", inbox: "\\Inbox", junk: "\\Junk" };

async function moveMessage(user, messageId, target) {
  const special = MOVE_TARGETS[target];
  if (!special) throw fail("Move target must be archive, trash, inbox or junk.", 400);
  const { location, account } = await requireMessageAccess(user, messageId);
  const pool = await getAppPool();
  const destination = (await pool.request().input("account_code", sql.NVarChar(60), account.account_code).input("special_use", sql.NVarChar(40), special)
    .query(`SELECT TOP 1 path FROM mail.folders WHERE account_code = @account_code AND special_use = @special_use;`)).recordset[0];
  if (!destination) throw fail(`This mailbox has no ${target} folder.`, 409);
  await withImap(imapOptions(account), async (client) => {
    await client.mailboxOpen(location.path);
    await client.messageMove(String(location.uid), destination.path, { uid: true });
  });
  await deleteMessages(pool, location.folder_id, [Number(location.uid)]);
  syncNow(account.account_code, { onlyPaths: [destination.path] }).catch(() => {});
  return { ok: true };
}

// ── Sending ─────────────────────────────────────────────────────────────────

async function sendMessage(user, { accountCode, to, cc, subject, text, replyToMessageId, attachments = [] }) {
  const account = await requireAccount(user, accountCode);
  const smtp = smtpOptions(account);
  if (!smtp) throw fail(`${account.address} has no outgoing (SMTP) server set, so it can't send yet.`, 503);

  const toList = parseRecipients(to);
  const ccList = parseRecipients(cc || []);
  if (!toList.length) throw fail("Add at least one recipient.", 400);
  const files = (Array.isArray(attachments) ? attachments : []).map((item, index) => ({
    filename: safeFilename(item.filename, `attachment-${index + 1}`),
    contentType: item.contentType || undefined,
    content: Buffer.from(String(item.base64 || ""), "base64")
  }));
  if (files.reduce((sum, file) => sum + file.content.length, 0) > MAX_SEND_BYTES) throw fail("Attachments are over the 20 MB limit.", 413);

  const pool = await getAppPool();
  let threading = {};
  if (replyToMessageId) {
    await requireMessageAccess(user, replyToMessageId);
    const original = (await pool.request().input("message_id", sql.BigInt, Number(replyToMessageId))
      .query(`SELECT internet_message_id, references_header FROM mail.messages WHERE message_id = @message_id;`)).recordset[0];
    if (original?.internet_message_id) {
      threading = { inReplyTo: original.internet_message_id, references: [original.references_header, original.internet_message_id].filter(Boolean).join(" ") };
    }
  }

  const domain = account.address.split("@")[1] || "classicvisions.local";
  const internetMessageId = `<${nodeCrypto.randomUUID()}@${domain}>`;
  const raw = await new MailComposer({
    from: { name: account.display_name, address: account.address },
    to: toList,
    cc: ccList.length ? ccList : undefined,
    subject: String(subject || "").slice(0, 900),
    text: String(text || ""),
    messageId: internetMessageId,
    attachments: files,
    ...threading
  }).compile().build();

  await nodemailer.createTransport(smtp).sendMail({ envelope: { from: account.address, to: [...toList, ...ccList] }, raw });

  // Keep a copy in Sent so other mail clients and the CRM history see it.
  const sent = (await pool.request().input("account_code", sql.NVarChar(60), account.account_code)
    .query(`SELECT TOP 1 path FROM mail.folders WHERE account_code = @account_code AND special_use = N'\\Sent';`)).recordset[0];
  let savedToSent = false;
  if (sent && process.env.OPTILENS_EMAIL_APPEND_SENT !== "0") {
    await withImap(imapOptions(account), (client) => client.append(sent.path, raw, ["\\Seen"]))
      .then(() => { savedToSent = true; })
      .catch((error) => console.error(`Sent email could not be saved to ${account.address} Sent:`, error.message));
    syncNow(account.account_code, { onlyPaths: [sent.path] }).catch(() => {});
  }

  await pool.request()
    .input("account_code", sql.NVarChar(60), account.account_code)
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
  connectAccount, disconnectAccount, getAttachment, getHistory, getMessage, getStatus, listAccounts, listFolders, listMessages,
  moveMessage, sendMessage, shareAccount, startEmailSync, syncAllAccounts, syncNow, unshareAccount, updateFlags
};
