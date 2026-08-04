const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "database", "032-supplier-record-lifecycle.sql"), "utf8");
const service = fs.readFileSync(path.join(root, "lib", "operations", "service.js"), "utf8");

test("supplier record lifecycle enforces one active row per Innovations order", () => {
  assert.match(migration, /CREATE UNIQUE INDEX UX_ops_supplier_records_active_order/);
  assert.match(migration, /WHERE internal_order_id IS NOT NULL AND lifecycle_state = N'ACTIVE'/);
});

test("email occurrences resolve to a canonical lifecycle record", () => {
  assert.match(migration, /CREATE TABLE ops\.SupplierRecordOccurrences/);
  assert.match(migration, /UNIQUE \(event_id, attachment_id, row_number\)/);
  assert.match(service, /WHERE internal_order_id = @internal_order_id AND lifecycle_state = N'ACTIVE'/);
  assert.match(service, /INSERT INTO ops\.SupplierRecordOccurrences/);
  assert.match(service, /o\.record_id = r\.record_id AND o\.mailbox_message_id = @mailbox_message_id/);
});

test("archived lifecycle snapshots are not refreshed from live Innovations state", () => {
  assert.match(service, /filter\(\(row\) => row\.lifecycle_state !== "ARCHIVED"\)/);
  assert.match(service, /live_status_state: "archived-snapshot"/);
});
