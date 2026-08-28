const fs = require("node:fs");
const path = require("node:path");
const { getAppPool } = require("./db");

const migrationFiles = [
  "002-core-schema.sql",
  "003-delivery-module-schema.sql",
  "008-access-archive-schema.sql",
  "006-pricing-module-schema.sql",
  "004-seed-platform.sql",
  "007-auth-hardening.sql",
  "009-user-module-access.sql",
  "010-role-module-access.sql",
  "011-docstudio-schema.sql",
  "012-beswift-co-schema.sql",
  "013-shipment-sync-columns.sql",
  "014-customer-commercial-params.sql",
  "015-co-item-catalog.sql",
  "016-beswift-fill-resolutions.sql",
  "017-commercial-invoice-item-settings.sql",
  "018-commercial-invoice-line-overrides.sql",
  "019-standards-catalog.sql",
  "021-app-settings.sql",
  // 020 is already used by the standards-catalog index migration.
  "022-supplier-email-operations.sql",
  "023-supplier-email-rules.sql",
  "024-supplier-email-workspace.sql",
  "025-skylab-orderid-matching.sql",
  "026-supplier-record-order-context.sql",
  "027-patient-id-context.sql",
  "028-customer-context.sql",
  "029-inventory-analysis-schema.sql",
  "030-item-cost-exemptions.sql",
  "031-inventory-dashboard-tiles.sql",
  "032-supplier-record-lifecycle.sql",
  "033-supplier-record-reference-lifecycle.sql",
  "034-commercial-invoice-header-overrides.sql",
  "035-qbo-invoice-sync.sql",
  "036-qbo-production-safety.sql",
  "037-privileged-admin-data-access.sql",
  "038-retire-legacy-data-sources.sql",
  "039-beswift-production-default.sql",
  "040-delivery-document-archive-and-authorisation.sql"
];

async function runMigrations() {
  const pool = await getAppPool();
  const applied = [];

  // Keep a durable checkpoint so the updater can safely retry after a
  // service restart or a failed later migration. The table intentionally
  // lives in dbo so it can be created before migration 002 creates core.
  await pool.request().batch(`
    IF OBJECT_ID(N'dbo.app_migrations', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.app_migrations (
        migration_name nvarchar(260) NOT NULL CONSTRAINT PK_app_migrations PRIMARY KEY,
        applied_at datetime2(0) NOT NULL CONSTRAINT DF_app_migrations_applied_at DEFAULT SYSUTCDATETIME()
      );
    END;
  `);

  for (const file of migrationFiles) {
    const existing = await pool.request()
      .input("migration_name", file)
      .query("SELECT migration_name FROM dbo.app_migrations WHERE migration_name = @migration_name");
    if (existing.recordset.length) continue;

    const filePath = path.join(__dirname, "..", "database", file);
    const sqlText = fs.readFileSync(filePath, "utf8");
    const batches = splitSqlBatches(sqlText);

    for (const batch of batches) {
      const trimmed = batch.trim();
      if (trimmed) {
        await pool.request().batch(trimmed);
      }
    }

    await pool.request()
      .input("migration_name", file)
      .query("INSERT INTO dbo.app_migrations (migration_name) VALUES (@migration_name)");

    applied.push(file);
  }

  return {
    applied,
    appliedAt: new Date().toISOString()
  };
}

function splitSqlBatches(sqlText) {
  return sqlText
    .split(/^\s*GO\s*$/gim)
    .map((batch) => batch.trim())
    .filter(Boolean);
}

module.exports = { runMigrations };
