const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "database", "033-supplier-record-reference-lifecycle.sql"), "utf8");
const service = fs.readFileSync(path.join(root, "lib", "operations", "service.js"), "utf8");
const migrations = fs.readFileSync(path.join(root, "lib", "migrations.js"), "utf8");

test("migration list includes the supplier record reference lifecycle migration", () => {
  assert.match(migrations, /"033-supplier-record-reference-lifecycle\.sql"/);
});

test("unmatched supplier references get a canonical active placeholder", () => {
  assert.match(migration, /CREATE UNIQUE INDEX UX_ops_supplier_records_active_reference/);
  assert.match(migration, /WHERE internal_order_id IS NULL AND lifecycle_state = N'ACTIVE'/);
  assert.match(migration, /PARTITION BY rule_code, supplier_reference/);
});

test("a still-unmatched reference reuses its existing placeholder instead of duplicating", () => {
  assert.match(service, /WHERE rule_code = @rule_code\s+AND supplier_reference = @supplier_reference\s+AND internal_order_id IS NULL\s+AND lifecycle_state = N'ACTIVE'/);
});
