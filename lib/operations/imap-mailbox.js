const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { mailboxMessageKey } = require("./mailbox-routing");

function assertReadableConfig(config) {
  if (!config || String(config.protocol || "IMAP").toUpperCase() !== "IMAP") throw new Error("Mailbox connector requires an IMAP configuration.");
  if (config.is_enabled !== true && config.is_enabled !== 1) throw new Error("Mailbox configuration is disabled.");
  if (!config.server_hostname || !config.mailbox_username) throw new Error("IMAP hostname and mailbox username are required.");
}

async function readMailbox({ config, credential, rules, onMessage = async () => {} }) {
  assertReadableConfig(config);
  if (!credential || !credential.password) throw new Error("A runtime mailbox credential is required; no credential was loaded from the database.");
  const client = new ImapFlow({
    host: config.server_hostname,
    port: Number(config.port || 993),
    secure: config.ssl_enabled !== false && config.ssl_enabled !== 0,
    auth: { user: config.mailbox_username, pass: credential.password },
    logger: false
  });
  const limit = Math.min(Math.max(Number(config.max_messages_per_run) || 200, 1), 1000);
  const since = new Date(Date.now() - (Math.max(Number(config.scan_previous_days) || 7, 1) * 86400000));
  const criteria = { since };
  if (config.unread_only === true || config.unread_only === 1) criteria.seen = false;
  const results = [];
  try {
    await client.connect();
    await client.mailboxOpen(config.folder_name || "Inbox", { readOnly: true });
    const uids = (await client.search(criteria, { uid: true })).slice(-limit);
    for (const uid of uids) {
      const fetched = await client.fetchOne(uid, { source: true, envelope: true, flags: true, internalDate: true }, { uid: true });
      const parsed = await simpleParser(fetched.source);
      const attachments = (parsed.attachments || []).map((attachment) => ({
        filename: attachment.filename || "attachment",
        contentType: attachment.contentType || null,
        content: attachment.content,
        size: attachment.size || attachment.content?.length || 0
      }));
      const message = {
        uid,
        messageId: parsed.messageId || fetched.envelope?.messageId || null,
        subject: parsed.subject || fetched.envelope?.subject || "",
        from: parsed.from?.value?.[0] || fetched.envelope?.from?.[0] || null,
        date: parsed.date || fetched.internalDate || null,
        flags: [...(fetched.flags || [])],
        isRead: [...(fetched.flags || [])].some((flag) => String(flag).toUpperCase() === "\\SEEN"),
        attachments
      };
      const key = mailboxMessageKey({ mailboxCode: config.configuration_code, uid, messageId: message.messageId, attachments });
      const result = await onMessage({ ...message, idempotencyKey: key });
      results.push({ uid, idempotencyKey: key, result });
    }
    return { scanned: uids.length, results };
  } finally {
    await client.logout().catch(() => {});
  }
}

async function archiveMailboxMessage({ config, credential, uid, folder }) {
  assertReadableConfig({ ...config, is_enabled: true });
  if (!credential || !credential.password) throw new Error("A runtime mailbox credential is required; no credential was loaded from the database.");
  const destination = String(folder || "").trim();
  if (!destination) throw new Error("A configured processed mailbox folder is required before archiving.");
  const client = new ImapFlow({
    host: config.server_hostname,
    port: Number(config.port || 993),
    secure: config.ssl_enabled !== false && config.ssl_enabled !== 0,
    auth: { user: config.mailbox_username, pass: credential.password },
    logger: false
  });
  try {
    await client.connect();
    await client.mailboxOpen(config.folder_name || "Inbox", { readOnly: false });
    await client.messageMove(Number(uid), destination, { uid: true });
    return { uid: Number(uid), folder: destination };
  } finally {
    await client.logout().catch(() => {});
  }
}

module.exports = { archiveMailboxMessage, assertReadableConfig, readMailbox };
