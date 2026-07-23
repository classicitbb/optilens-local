const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createUpdateManager } = require("../lib/update-manager");

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
