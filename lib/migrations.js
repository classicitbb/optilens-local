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
  "028-customer-context.sql"
];

async function runMigrations() {
  const pool = await getAppPool();
  const applied = [];

  for (const file of migrationFiles) {
    const filePath = path.join(__dirname, "..", "database", file);
    const sqlText = fs.readFileSync(filePath, "utf8");
    const batches = splitSqlBatches(sqlText);

    for (const batch of batches) {
      const trimmed = batch.trim();
      if (trimmed) {
        await pool.request().batch(trimmed);
      }
    }

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
