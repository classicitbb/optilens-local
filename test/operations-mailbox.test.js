const test = require("node:test");
const assert = require("node:assert/strict");
const { identifySupplier, mailboxMessageKey, routeMailboxMessage, supplierSenderMatches } = require("../lib/operations/mailbox-routing");
const { assertReadableConfig } = require("../lib/operations/imap-mailbox");
const { reconcileMailboxMessages } = require("../lib/operations/mailbox-reconciliation");

const rule = {
  rule_code: "tog-wip",
  is_enabled: true,
  mapping_state: "CONFIRMED",
  sender_address: "noreply-system@thaiopticalgroup.com",
  subject_match_type: "CONTAINS",
  subject_pattern: "WIP Report Classic",
  allowed_extensions: ".xlsx",
  attachment_required: true,
  priority: 100
};

test("mailbox routing requires a confirmed enabled sender and subject rule", () => {
  const matched = routeMailboxMessage({
    from: { address: "noreply-system@thaiopticalgroup.com" },
    subject: "WIP Report Classic - 2026-07-28",
    attachments: [{ filename: "WIP.xlsx" }, { filename: "logo.png" }]
  }, [rule]);
  assert.equal(matched.reason, "MATCHED");
  assert.deepEqual(matched.acceptedAttachments.map((item) => item.filename), ["WIP.xlsx"]);
  const ignored = routeMailboxMessage({ from: { address: "other@example.com" }, subject: "WIP Report Classic", attachments: [] }, [rule]);
  assert.equal(ignored.reason, "NO_CONFIRMED_RULE");
  assert.deepEqual(ignored.acceptedAttachments, []);
});

test("mailbox routing reports missing required attachments without guessing", () => {
  const result = routeMailboxMessage({ from: "noreply-system@thaiopticalgroup.com", subject: "WIP Report Classic", attachments: [{ filename: "report.csv" }] }, [rule]);
  assert.equal(result.reason, "REQUIRED_ATTACHMENT_NOT_FOUND");
  assert.equal(result.acceptedAttachments.length, 0);
});

test("supplier capture identifies sender emails even when the rule is not enabled", () => {
  const pendingRule = { ...rule, supplier_code: "TOG", supplier_name: "Thai Optical Group", is_enabled: false, mapping_state: "PENDING_CONFIRMATION" };
  const message = { from: { address: "noreply-system@thaiopticalgroup.com" }, subject: "Report Dispatch Classic" };
  assert.equal(supplierSenderMatches(message, pendingRule), true);
  assert.deepEqual(identifySupplier(message, [pendingRule]), { supplierCode: "TOG", supplierName: "Thai Optical Group", rule: pendingRule });
  assert.equal(identifySupplier({ from: { address: "unrelated@example.com" } }, [pendingRule]).supplierCode, null);
});

test("mailbox message idempotency is stable and changes when attachment identity changes", () => {
  const base = { mailboxCode: "classic-visions-orders", uid: 42, messageId: "<abc@example.com>", attachments: [{ filename: "WIP.xlsx", sha256: "one" }] };
  assert.equal(mailboxMessageKey(base), mailboxMessageKey({ ...base, attachments: [...base.attachments] }));
  assert.notEqual(mailboxMessageKey(base), mailboxMessageKey({ ...base, attachments: [{ filename: "WIP.xlsx", sha256: "two" }] }));
});

test("IMAP connector rejects disabled or incomplete configurations", () => {
  assert.throws(() => assertReadableConfig({ protocol: "IMAP", is_enabled: false }), /disabled/);
  assert.throws(() => assertReadableConfig({ protocol: "IMAP", is_enabled: true }), /hostname and mailbox username/);
});

test("mailbox reconciliation separates actual read state from processing state", () => {
  const result = reconcileMailboxMessages([
    { uid: 1, subject: "WIP", isRead: true, idempotencyKey: "one" },
    { uid: 2, subject: "Dispatch", isRead: false, idempotencyKey: "two" }
  ], new Set(["one"]));
  assert.deepEqual({ scanned: result.scanned, read: result.read, unread: result.unread, processed: result.processed, notProcessed: result.notProcessed }, { scanned: 2, read: 1, unread: 1, processed: 1, notProcessed: 1 });
  assert.equal(result.rows[0].processingState, "PROCESSED");
  assert.equal(result.rows[1].processingState, "NOT_PROCESSED");
});
