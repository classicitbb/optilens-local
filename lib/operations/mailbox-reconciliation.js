function reconcileMailboxMessages(messages, processedKeys = new Set()) {
  const rows = (Array.isArray(messages) ? messages : []).map((message) => ({
    uid: message.uid,
    messageId: message.messageId || null,
    subject: message.subject || "",
    date: message.date || null,
    isRead: Boolean(message.isRead),
    idempotencyKey: message.idempotencyKey || null,
    isProcessed: Boolean(message.idempotencyKey && processedKeys.has(message.idempotencyKey)),
    processingState: message.idempotencyKey && processedKeys.has(message.idempotencyKey) ? "PROCESSED" : "NOT_PROCESSED"
  }));
  return {
    scanned: rows.length,
    read: rows.filter((row) => row.isRead).length,
    unread: rows.filter((row) => !row.isRead).length,
    processed: rows.filter((row) => row.isProcessed).length,
    notProcessed: rows.filter((row) => !row.isProcessed).length,
    rows
  };
}

module.exports = { reconcileMailboxMessages };
