const crypto = require("node:crypto");

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeAddress(value) {
  const text = typeof value === "object" && value ? value.address : value;
  return normalize(text);
}

function matchesSubject(subject, rule) {
  const actual = String(subject || "");
  const pattern = String(rule.subject_pattern || "");
  switch (String(rule.subject_match_type || "CONTAINS").toUpperCase()) {
    case "EXACT": return actual.toLowerCase() === pattern.toLowerCase();
    case "STARTS_WITH": return actual.toLowerCase().startsWith(pattern.toLowerCase());
    case "REGEX": return new RegExp(pattern, "i").test(actual);
    case "CONTAINS": return actual.toLowerCase().includes(pattern.toLowerCase());
    default: return false;
  }
}

function ruleMatchesMessage(message, rule, { confirmed = true } = {}) {
  if (!rule) return false;
  if (confirmed && (!rule.is_enabled || String(rule.mapping_state).toUpperCase() !== "CONFIRMED")) return false;
  const sender = normalizeAddress(message.from);
  const allowedSender = normalizeAddress(rule.sender_address);
  const senderDomain = normalize(rule.sender_domain).replace(/^@/, "");
  if (allowedSender && sender !== allowedSender) return false;
  if (senderDomain && !sender.endsWith(`@${senderDomain}`)) return false;
  return matchesSubject(message.subject, rule);
}

function supplierSenderMatches(message, rule) {
  if (!rule) return false;
  const sender = normalizeAddress(message.from);
  const allowedSender = normalizeAddress(rule.sender_address);
  const senderDomain = normalize(rule.sender_domain).replace(/^@/, "");
  if (allowedSender && sender !== allowedSender) return false;
  if (senderDomain && !sender.endsWith(`@${senderDomain}`)) return false;
  return Boolean(allowedSender || senderDomain);
}

function identifySupplier(message, rules) {
  const matches = (Array.isArray(rules) ? rules : [])
    .filter((rule) => supplierSenderMatches(message, rule))
    .sort((a, b) => Number(a.priority || 100) - Number(b.priority || 100));
  const rule = matches[0] || null;
  return rule
    ? { supplierCode: rule.supplier_code || null, supplierName: rule.supplier_name || null, rule }
    : { supplierCode: null, supplierName: null, rule: null };
}

function selectAttachments(attachments, rule) {
  const allowed = new Set(String(rule.allowed_extensions || "")
    .split(/[;,\s]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => value.startsWith(".") ? value : `.${value}`));
  return (Array.isArray(attachments) ? attachments : []).map((attachment) => {
    const filename = String(attachment.filename || "").trim();
    const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")).toLowerCase() : "";
    return { ...attachment, filename, extension, allowed: allowed.has(extension) };
  });
}

function routeMailboxMessage(message, rules, { discovery = false } = {}) {
  const candidates = (Array.isArray(rules) ? rules : [])
    .filter((rule) => ruleMatchesMessage(message, rule, { confirmed: !discovery }))
    .sort((a, b) => Number(a.priority || 100) - Number(b.priority || 100));
  if (!candidates.length) return { matched: false, reason: "NO_CONFIRMED_RULE", attachments: [], acceptedAttachments: [] };
  const rule = candidates[0];
  const attachments = selectAttachments(message.attachments, rule);
  const accepted = attachments.filter((attachment) => attachment.allowed);
  if (rule.attachment_required && !accepted.length) {
    return { matched: true, rule, attachments, acceptedAttachments: [], reason: "REQUIRED_ATTACHMENT_NOT_FOUND" };
  }
  return { matched: true, rule, attachments, acceptedAttachments: accepted, reason: discovery ? "DISCOVERY_PENDING" : "MATCHED" };
}

function mailboxMessageKey({ mailboxCode, uid, messageId, attachments = [] }) {
  const attachmentKeys = attachments.map((attachment) => `${attachment.filename}:${attachment.sha256 || ""}`).sort();
  return crypto.createHash("sha256")
    .update([mailboxCode, uid || "", messageId || "", ...attachmentKeys].join("|"))
    .digest("hex");
}

module.exports = { identifySupplier, mailboxMessageKey, matchesSubject, routeMailboxMessage, selectAttachments, supplierSenderMatches };
