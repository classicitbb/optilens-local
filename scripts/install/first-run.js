#!/usr/bin/env node
// First-run helper for scripts/install/Install-OptiLens.ps1.
//
// The installer does the Windows work (software, SQL Server, files, tasks) and
// calls this for everything that needs the application's own code: reading the
// licence, applying migrations, creating the first administrator and saving the
// lab's site settings. It reads one JSON request on stdin and writes one JSON
// reply on stdout, so passwords never appear on a command line or in a log.
//
//   echo {"action":"licence","file":"C:\\x\\edition.json"} | node scripts/install/first-run.js
//
// Actions: licence, migrate, setup, verify. Every action is safe to repeat.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

function fail(message, extra = {}) {
  return { ok: false, error: message, ...extra };
}

// Reads a licence file and reports what it grants, using the same verification
// the running server uses. Nothing is installed.
function checkLicence(file, { root = ROOT, publicKey } = {}) {
  const { loadEdition } = require(path.join(root, "lib", "edition"));
  const build = readJson(path.join(root, "lib", "edition-build.json"));
  const licensedBuild = Boolean(build?.requireManifest);
  if (!file || !fs.existsSync(file)) return fail("The licence file was not found.", { licensedBuild });
  const manifest = readJson(file);
  if (!manifest) return fail("The licence file is not valid JSON.", { licensedBuild });
  const edition = loadEdition(publicKey ? { manifest, publicKey } : { manifest });
  const info = edition.describe();
  if (info.reason) return fail(info.reason, { licensedBuild, licensee: info.licensee, edition: info.name });
  return {
    ok: true,
    licensedBuild,
    edition: info.name,
    licensee: info.licensee,
    modules: info.modules,
    trial: info.trial,
    expiresAt: info.expiresAt,
    daysLeft: info.daysLeft,
    remoteRenewal: info.remoteRenewal
  };
}

async function migrate() {
  const { runMigrations } = require(path.join(ROOT, "lib", "migrations"));
  const result = await runMigrations();
  return { ok: true, applied: result.applied || [], result };
}

// Creates the lab's first administrator and saves its site settings. A user that
// already exists is left as it is, so a repeated run never resets a password.
async function setup(request) {
  const admin = request.admin || {};
  const auth = require(path.join(ROOT, "lib", "auth"));
  const { getAppPool } = require(path.join(ROOT, "lib", "db"));
  const summary = { ok: true, adminCreated: false, adminExisted: false, defaultAdminDisabled: false, siteSettingsSaved: false };

  const existing = (await auth.listUsers()).find((user) => String(user.username).toLowerCase() === String(admin.username || "").toLowerCase());
  if (existing) {
    summary.adminExisted = true;
  } else {
    await auth.createUser({
      username: admin.username,
      displayName: admin.displayName || admin.username,
      email: admin.email || "",
      password: admin.password,
      roles: ["admin"]
    }, null);
    // The installer typed this password themselves, so do not force a change at
    // the first sign-in.
    const pool = await getAppPool();
    await pool.request().input("username", String(admin.username).toLowerCase()).query(`
      UPDATE c SET must_change_password = 0
      FROM core.user_credentials c
      INNER JOIN core.users u ON u.user_id = c.user_id
      WHERE LOWER(u.username) = @username;
    `);
    summary.adminCreated = true;
  }

  // The built-in account has a known password. Turn it off once a named
  // administrator exists.
  if (request.disableDefaultAdmin !== false && String(admin.username).toLowerCase() !== "optilens") {
    const users = await auth.listUsers();
    const builtIn = users.find((user) => String(user.username).toLowerCase() === "optilens");
    if (builtIn && builtIn.isActive !== false) {
      await auth.updateUser(builtIn.userId, { isActive: false }, null);
      summary.defaultAdminDisabled = true;
    }
  }

  if (request.site && Object.keys(request.site).length) {
    const { siteSettings } = require(path.join(ROOT, "lib", "site-settings"));
    await siteSettings.save(request.site, { username: "installer" });
    summary.siteSettingsSaved = true;
  }
  return summary;
}

// Checks the finished install from the inside, without opening a session.
async function verify(request) {
  const out = { ok: true, checks: [] };
  const check = (name, pass, detail = "") => {
    out.checks.push({ name, pass: Boolean(pass), detail });
    if (!pass) out.ok = false;
  };

  const { loadEdition } = require(path.join(ROOT, "lib", "edition"));
  const info = loadEdition().describe();
  check("Licence is valid", !info.reason, info.reason || `${info.licensee || info.name}, modules: ${info.modules.join(", ")}`);

  try {
    const { getAppPool } = require(path.join(ROOT, "lib", "db"));
    const pool = await getAppPool();
    await pool.request().query("SELECT 1 AS ok");
    check("Application database connects", true);
  } catch (error) {
    check("Application database connects", false, error.message);
    return out;
  }

  const { migrationPlan } = require(path.join(ROOT, "lib", "migrations"));
  const { getAppPool } = require(path.join(ROOT, "lib", "db"));
  const pool = await getAppPool();
  const applied = new Set((await pool.request().query("SELECT migration_name FROM dbo.app_migrations")).recordset.map((row) => row.migration_name));
  const missing = migrationPlan().filter((file) => !applied.has(file));
  check("All migrations applied", missing.length === 0, missing.length ? `Missing: ${missing.join(", ")}` : `${applied.size} applied`);

  if (request.admin?.username && request.admin?.password) {
    try {
      const result = await require(path.join(ROOT, "lib", "auth")).authenticateUser(request.admin.username, request.admin.password);
      check("Administrator can sign in", Boolean(result));
    } catch (error) {
      check("Administrator can sign in", false, error.message);
    }
  }

  const { siteSettings, missingForRelease } = require(path.join(ROOT, "lib", "site-settings"));
  const saved = await siteSettings.refresh();
  const lacking = missingForRelease(saved);
  check("Site settings saved", lacking.length === 0, lacking.length ? `Missing: ${lacking.join(", ")}` : "");
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "").trim();
  return text ? JSON.parse(text) : {};
}

async function run(request) {
  switch (request.action) {
    case "licence": return checkLicence(request.file);
    case "migrate": return migrate();
    case "setup": return setup(request);
    case "verify": return verify(request);
    default: return fail(`Unknown action: ${request.action}`);
  }
}

if (require.main === module) {
  (async () => {
    let reply;
    try {
      reply = await run(await readStdin());
    } catch (error) {
      reply = fail(error.message);
    }
    process.stdout.write(JSON.stringify(reply));
    // The database pool keeps the process alive; this is a one-shot command.
    process.exit(reply.ok ? 0 : 1);
  })();
}

module.exports = { checkLicence, run };
