const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const UPDATE_AREAS = [
  { id: "runtime", label: "server code", paths: ["server.js", "lib"], restartRequired: true },
  { id: "browser", label: "browser files", paths: ["public"], restartRequired: false },
  { id: "dependencies", label: "dependencies", paths: ["package.json", "package-lock.json"], restartRequired: true },
  { id: "migrations", label: "database migrations", paths: ["database", "lib/migrations.js", "scripts/run-app-migrations.js"], restartRequired: true },
  { id: "operations", label: "maintenance scripts", paths: ["scripts"], restartRequired: true }
];

const EXCLUDED_NAMES = new Set(["node_modules", ".git", "data", "output", "test-results", "_snapshots"]);

function createUpdateManager(projectRoot, startedAt = new Date().toISOString()) {
  const runningSnapshot = createSnapshot(projectRoot);

  function getStatus() {
    const currentSnapshot = createSnapshot(projectRoot);
    const changedAreas = UPDATE_AREAS
      .filter((area) => currentSnapshot.areas[area.id] !== runningSnapshot.areas[area.id])
      .map((area) => ({
        id: area.id,
        label: area.label,
        restartRequired: area.restartRequired
      }));

    const available = changedAreas.length > 0;
    return {
      available,
      checkedAt: new Date().toISOString(),
      running: {
        revision: runningSnapshot.revision,
        startedAt
      },
      availableRevision: currentSnapshot.revision,
      changedAreas,
      plan: {
        reloadBrowser: available,
        restartService: changedAreas.some((area) => area.restartRequired),
        installDependencies: changedAreas.some((area) => area.id === "dependencies"),
        runMigrations: changedAreas.some((area) => area.id === "migrations")
      }
    };
  }

  return { getStatus };
}

function createSnapshot(projectRoot) {
  const areas = {};
  const digest = crypto.createHash("sha256");

  for (const area of UPDATE_AREAS) {
    const areaDigest = crypto.createHash("sha256");
    for (const entry of area.paths) {
      hashEntry(projectRoot, entry, areaDigest);
    }
    areas[area.id] = areaDigest.digest("hex");
    digest.update(`${area.id}:${areas[area.id]}\n`);
  }

  return { areas, revision: digest.digest("hex").slice(0, 16) };
}

function hashEntry(projectRoot, relativePath, digest) {
  const absolutePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    digest.update(`missing:${relativePath}\n`);
    return;
  }

  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) {
    hashFile(projectRoot, absolutePath, digest);
    return;
  }

  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (EXCLUDED_NAMES.has(entry.name)) continue;
    hashEntry(projectRoot, path.join(relativePath, entry.name), digest);
  }
}

function hashFile(projectRoot, absolutePath, digest) {
  const relativePath = path.relative(projectRoot, absolutePath).replaceAll("\\", "/");
  digest.update(`${relativePath}\0`);
  digest.update(fs.readFileSync(absolutePath));
  digest.update("\0");
}

module.exports = { createUpdateManager };
