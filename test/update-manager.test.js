const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createUpdateManager, planForChangedPaths } = require("../lib/update-manager");
const { tailTextFile } = require("../lib/host-control");

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-update-manager-"));
  for (const directory of ["lib", "public", "database", "scripts"]) {
    fs.mkdirSync(path.join(root, directory));
  }
  fs.writeFileSync(path.join(root, "server.js"), "console.log('server');\n");
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  return root;
}

test("reports browser-only changes without requiring a service restart", () => {
  const root = makeProject();
  try {
    const manager = createUpdateManager(root, "2026-07-22T00:00:00.000Z");
    fs.writeFileSync(path.join(root, "public", "app.js"), "console.log('new');\n");

    const status = manager.getStatus();
    assert.equal(status.available, true);
    assert.deepEqual(status.changedAreas.map((area) => area.id), ["browser"]);
    assert.equal(status.plan.restartService, false);
    assert.equal(status.plan.reloadBrowser, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plans dependency installation and a restart when manifests change", () => {
  const root = makeProject();
  try {
    const manager = createUpdateManager(root);
    fs.writeFileSync(path.join(root, "package.json"), '{"dependencies":{"x":"1.0.0"}}\n');

    const status = manager.getStatus();
    assert.equal(status.plan.restartService, true);
    assert.equal(status.plan.installDependencies, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("planForChangedPaths scopes a docs-only diff to no install and no migration", () => {
  const plan = planForChangedPaths(["docs/agent/HANDOFF.md", "README.md"]);
  assert.deepEqual(plan.changedAreas, []);
  assert.equal(plan.restartService, false);
  assert.equal(plan.installDependencies, false);
  assert.equal(plan.runMigrations, false);
});

test("planForChangedPaths flags dependency installation only when manifests changed", () => {
  const plan = planForChangedPaths(["package-lock.json", "public/app.js"]);
  assert.equal(plan.installDependencies, true);
  assert.equal(plan.runMigrations, false);
  assert.equal(plan.restartService, true);
  assert.deepEqual(plan.changedAreas.map((area) => area.id).sort(), ["browser", "dependencies"]);
});

test("planForChangedPaths flags migrations only when the database area changed", () => {
  const plan = planForChangedPaths(["database/040-new-thing.sql", "lib/db.js"]);
  assert.equal(plan.installDependencies, false);
  assert.equal(plan.runMigrations, true);
  assert.equal(plan.restartService, true);
  assert.deepEqual(plan.changedAreas.map((area) => area.id).sort(), ["migrations", "runtime"]);
});

test("planForChangedPaths does not match a path that merely starts with an area name", () => {
  const plan = planForChangedPaths(["scripts-external/notes.txt", "publication.md"]);
  assert.deepEqual(plan.changedAreas, []);
  assert.equal(plan.restartService, false);
});

test("tails host log files without failing when they are missing", () => {
  const root = makeProject();
  try {
    const logFile = path.join(root, "local-update.log");
    fs.writeFileSync(logFile, "first\nsecond\nthird\n");

    const tailed = tailTextFile(logFile, 12);
    assert.equal(tailed.exists, true);
    assert.equal(tailed.truncated, true);
    assert.match(tailed.text, /second|third/);

    const missing = tailTextFile(path.join(root, "missing.log"));
    assert.equal(missing.exists, false);
    assert.equal(missing.text, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("guarded updater handles a clean porcelain status without a PowerShell null method call", () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "apply-local-update.ps1"), "utf8");
  assert.match(script, /\$dirty = \(\(& git -c "safe\.directory=\$ProjectRoot" status --porcelain\) -join "`n"\)\.Trim\(\)/);
});

test("guarded updater verifies and repairs production dependencies before smoke checks", () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "apply-local-update.ps1"), "utf8");
  assert.match(script, /function Test-ProductionDependencies/);
  assert.match(script, /npm\.cmd ls --omit=dev --depth=0/);
  assert.match(script, /Production dependencies are incomplete; forcing a reproducible reinstall before smoke checks/);
  assert.match(script, /stop-app\.ps1.*before reinstalling dependencies[\s\S]*npm\.cmd ci --omit=dev --no-audit --no-fund/);
});
