const fs = require("node:fs");
const path = require("node:path");
const { getAppPool } = require("./db");

const migrationFiles = [
  "002-core-schema.sql",
  "003-delivery-module-schema.sql",
  "004-seed-platform.sql"
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
