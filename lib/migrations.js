const fs = require("node:fs");
const path = require("node:path");
const { getAppPool } = require("./db");
const { loadEdition } = require("./edition");

// Each migration belongs to the core or to one module. A site's edition decides
// which run: the core and every enabled module's files, in this order. The full
// edition runs them all. A new migration must be tagged here.
const migrationFiles = [
  { file: "002-core-schema.sql", module: "core" },
  { file: "003-delivery-module-schema.sql", module: "delivery-export" },
  { file: "008-access-archive-schema.sql", module: "delivery-export" },
  { file: "006-pricing-module-schema.sql", module: "pricing-automation" },
  { file: "004-seed-platform.sql", module: "core" },
  { file: "007-auth-hardening.sql", module: "core" },
  { file: "009-user-module-access.sql", module: "core" },
  { file: "010-role-module-access.sql", module: "core" },
  { file: "011-docstudio-schema.sql", module: "doc-studio" },
  { file: "012-beswift-co-schema.sql", module: "beswift" },
  { file: "013-shipment-sync-columns.sql", module: "delivery-export" },
  { file: "014-customer-commercial-params.sql", module: "delivery-export" },
  { file: "015-co-item-catalog.sql", module: "beswift" },
  { file: "016-beswift-fill-resolutions.sql", module: "beswift" },
  { file: "017-commercial-invoice-item-settings.sql", module: "delivery-export" },
  { file: "018-commercial-invoice-line-overrides.sql", module: "delivery-export" },
  { file: "019-standards-catalog.sql", module: "delivery-export" },
  { file: "021-app-settings.sql", module: "core" },
  { file: "022-supplier-email-operations.sql", module: "automation" },
  { file: "023-supplier-email-rules.sql", module: "automation" },
  { file: "024-supplier-email-workspace.sql", module: "automation" },
  { file: "025-skylab-orderid-matching.sql", module: "automation" },
  { file: "026-supplier-record-order-context.sql", module: "automation" },
  { file: "027-patient-id-context.sql", module: "automation" },
  { file: "028-customer-context.sql", module: "automation" },
  { file: "029-inventory-analysis-schema.sql", module: "inventory-intelligence" },
  { file: "030-item-cost-exemptions.sql", module: "inventory-intelligence" },
  { file: "031-inventory-dashboard-tiles.sql", module: "inventory-intelligence" },
  { file: "032-supplier-record-lifecycle.sql", module: "automation" },
  { file: "033-supplier-record-reference-lifecycle.sql", module: "automation" },
  { file: "034-commercial-invoice-header-overrides.sql", module: "delivery-export" },
  { file: "035-qbo-invoice-sync.sql", module: "qbo" },
  { file: "036-qbo-production-safety.sql", module: "qbo" },
  { file: "037-privileged-admin-data-access.sql", module: "privileged-data-access" },
  { file: "038-retire-legacy-data-sources.sql", module: "core" },
  { file: "039-beswift-production-default.sql", module: "beswift" },
  { file: "040-delivery-document-archive-and-authorisation.sql", module: "delivery-export" },
  { file: "041-supplier-exception-digests.sql", module: "automation" },
  { file: "042-chemistry-clip-module.sql", module: "chemistry" },
  { file: "043-rx-capture.sql", module: "rx-capture" },
  { file: "044-rx-capture-milestone-2.sql", module: "rx-capture" },
  { file: "045-rx-capture-review-workflow.sql", module: "rx-capture" },
  { file: "046-rx-capture-milestone-4-release.sql", module: "rx-capture" },
  { file: "047-file-drop-destinations.sql", module: "rx-capture" },
  { file: "048-rx-capture-innovations-account-mappings.sql", module: "rx-capture" },
  { file: "049-rx-capture-voice-input.sql", module: "rx-capture" },
  { file: "050-email-client.sql", module: "email" },
  { file: "051-email-accounts.sql", module: "email" },
  { file: "052-email-signatures.sql", module: "email" },
  { file: "053-inventory-intelligence.sql", module: "inventory-intelligence" },
  { file: "054-rx-capture-bulk-upload.sql", module: "rx-capture" },
  { file: "055-commercial-invoice-custom-lines.sql", module: "delivery-export" }
];

// The files a site runs, in order: the core plus each module its edition enables.
function migrationPlan(edition = loadEdition()) {
  return migrationFiles
    .filter((entry) => entry.module === "core" || edition.isModuleEnabled(entry.module))
    .map((entry) => entry.file);
}

async function runMigrations(edition = loadEdition()) {
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

  for (const file of migrationPlan(edition)) {
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

module.exports = { migrationFiles, migrationPlan, runMigrations };
