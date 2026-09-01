const nodemailer = require("nodemailer");

const DIGEST_HEADER = "daily-unresolved-digest";

function digestDate(now = new Date()) { return now.toISOString().slice(0, 10); }

function renderDigest({ date, exceptions, actions }) {
  const lines = [
    `OptiLens Local unresolved supplier automation report — ${date}`,
    "",
    `Open exceptions: ${exceptions.length}`,
    `Waiting approvals: ${actions.length}`,
    ""
  ];
  for (const item of exceptions) lines.push(`[${item.exception_type}] ${item.subject_reference || "No reference"}: ${item.message}`);
  for (const item of actions) lines.push(`[WAITING_APPROVAL] Order ${item.target_reference}: ${item.action_type}`);
  return lines.join("\n");
}

async function sendDailyExceptionDigest({ pool, credential, enabled, now = new Date(), createTransport = nodemailer.createTransport } = {}) {
  if (!enabled) return { state: "disabled" };
  if (!credential?.username || !credential?.password || !credential?.smtpHost || !credential?.smtpPort) {
    return { state: "smtp-not-configured" };
  }
  const date = digestDate(now);
  const created = await pool.request().input("digest_date", date).input("recipient", credential.username).query(`
    IF NOT EXISTS (SELECT 1 FROM ops.DailyExceptionDigests WHERE digest_date = @digest_date AND recipient_reference = @recipient)
      INSERT INTO ops.DailyExceptionDigests (digest_date, recipient_reference) VALUES (@digest_date, @recipient);
    SELECT TOP (1) digest_id, status, attempts FROM ops.DailyExceptionDigests
    WHERE digest_date = @digest_date AND recipient_reference = @recipient;
  `);
  const digest = created.recordset[0];
  if (!digest || digest.status === "SENT") return { state: "already-sent" };
  const [exceptions, actions] = await Promise.all([
    pool.request().query("SELECT TOP (200) exception_type, subject_reference, message FROM ops.Exceptions WHERE status IN (N'OPEN', N'REVIEWING') ORDER BY created_at DESC;"),
    pool.request().query("SELECT TOP (200) action_type, target_reference FROM ops.Actions WHERE status = N'WAITING_APPROVAL' ORDER BY created_at DESC;")
  ]);
  const text = renderDigest({ date, exceptions: exceptions.recordset, actions: actions.recordset });
  try {
    const transport = createTransport({ host: credential.smtpHost, port: credential.smtpPort, secure: Boolean(credential.smtpSecure), auth: { user: credential.username, pass: credential.password } });
    await transport.sendMail({ from: credential.username, to: credential.username, subject: `OptiLens Local: ${exceptions.recordset.length} exceptions, ${actions.recordset.length} approvals`, text, headers: { "X-OptiLens-Notification": DIGEST_HEADER } });
    await pool.request().input("digest_id", digest.digest_id).query("UPDATE ops.DailyExceptionDigests SET status = N'SENT', attempts = attempts + 1, sent_at = SYSUTCDATETIME(), last_error = NULL WHERE digest_id = @digest_id;");
    return { state: "sent", exceptionCount: exceptions.recordset.length, actionCount: actions.recordset.length };
  } catch (error) {
    await pool.request().input("digest_id", digest.digest_id).input("error", String(error.message || error)).query("UPDATE ops.DailyExceptionDigests SET status = N'FAILED', attempts = attempts + 1, last_error = @error WHERE digest_id = @digest_id;");
    return { state: "failed", error: error.message };
  }
}

module.exports = { DIGEST_HEADER, renderDigest, sendDailyExceptionDigest };
