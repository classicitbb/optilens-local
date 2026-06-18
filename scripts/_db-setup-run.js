// Temporary setup runner — delete after use
const sql = require("mssql");
const fs = require("node:fs");
const path = require("node:path");

const SERVER = "MSSQL-SVR";
const USER = "sql_reporting";
const PASS = "Ocuco123!";
const APP_PASS = "Ocuco123!";

const BASE = path.join(__dirname, "..");

const connOpts = (database) => ({
  server: SERVER,
  database,
  user: USER,
  password: PASS,
  options: { encrypt: true, trustServerCertificate: true },
  pool: { max: 1, min: 0, idleTimeoutMillis: 5000 },
  connectionTimeout: 10000,
  requestTimeout: 30000
});

function batches(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split(/^\s*GO\s*$/im)
    .map((b) => b.replace(/^\s*USE\s+\[?[\w_]+\]?\s*;?\s*/i, "").trim())
    .filter((b) => b.length > 0);
}

async function runBatches(pool, filePath) {
  const name = path.relative(BASE, filePath);
  for (const batch of batches(filePath)) {
    await pool.request().query(batch);
  }
  console.log(`  OK: ${name}`);
}

async function main() {
  // Phase 1: master — create database + schemas + login
  console.log("Connecting to master...");
  const master = await sql.connect(connOpts("master"));

  // 001: create database and schemas (needs master context first)
  console.log("Running 001-create-database.sql...");
  const s001 = fs.readFileSync(path.join(BASE, "database", "001-create-database.sql"), "utf8");
  for (const batch of s001.split(/^\s*GO\s*$/im).map((b) => b.trim()).filter((b) => b)) {
    try {
      await master.request().query(batch);
    } catch (e) {
      // ALTER DATABASE (recovery model) requires sysadmin — skip if denied
      if (/ALTER DATABASE/i.test(batch) && /failed|permission/i.test(e.message)) {
        console.log("  SKIP (permission): ALTER DATABASE RECOVERY SIMPLE");
      } else {
        throw e;
      }
    }
  }
  console.log("  OK: 001-create-database.sql");

  // Create optilens_app login on master
  console.log("Creating optilens_app login...");
  await master.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'optilens_app')
      CREATE LOGIN [optilens_app]
      WITH PASSWORD = N'${APP_PASS}', CHECK_POLICY = ON, CHECK_EXPIRATION = OFF
  `);
  console.log("  OK: login created (or already exists)");

  await master.close();

  // Phase 2: optilens_local — core schema, delivery schema, seed, user
  console.log("Connecting to optilens_local...");
  const app = await sql.connect(connOpts("optilens_local"));

  await runBatches(app, path.join(BASE, "database", "002-core-schema.sql"));
  await runBatches(app, path.join(BASE, "database", "003-delivery-module-schema.sql"));
  await runBatches(app, path.join(BASE, "database", "004-seed-platform.sql"));

  console.log("Creating optilens_app user in optilens_local...");
  await app.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'optilens_app')
      CREATE USER [optilens_app] FOR LOGIN [optilens_app]
  `);
  await app.request().query(`ALTER ROLE [db_owner] ADD MEMBER [optilens_app]`);
  console.log("  OK: user created and added to db_owner");

  await app.close();
  console.log("\nDatabase setup complete.");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
