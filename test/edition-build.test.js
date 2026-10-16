const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { applyBuild, globToRegExp, planBuild, requireClosure, writeBuild, SYNC_FILE } = require("../scripts/build-edition");
const { MODULES, expandModules } = require("../lib/edition");
const { migrationFiles } = require("../lib/migrations");

const ROOT = path.join(__dirname, "..");
const fileMap = JSON.parse(fs.readFileSync(path.join(ROOT, "editions", "file-map.json"), "utf8"));
const definition = JSON.parse(fs.readFileSync(path.join(ROOT, "editions", "value-optical.json"), "utf8"));
const knownModules = Object.keys(MODULES);

function realTree() {
  try {
    return execFileSync("git", ["-c", "core.quotepath=off", "ls-files", "-z"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString("utf8").split("\0").filter(Boolean);
  } catch { return null; }
}

function plan(files, texts = {}, overrides = {}) {
  return planBuild({
    definition: { ...definition, ...overrides },
    fileMap,
    files,
    io: { readText: (file) => texts[file] ?? null },
    migrationFiles,
    expandModules,
    knownModules
  });
}

test("globs match one level with * and any depth with **", () => {
  assert.ok(globToRegExp("public/rx-capture*").test("public/rx-capture.html"));
  assert.ok(!globToRegExp("public/rx-capture*").test("public/rx-capture/x.html"));
  assert.ok(globToRegExp("lib/**").test("lib/email/routes.js"));
  assert.ok(globToRegExp("lib/**").test("lib/db.js"));
  assert.ok(!globToRegExp("lib/**").test("library/db.js"));
  assert.ok(globToRegExp("docs/a.b").test("docs/a.b"));
  assert.ok(!globToRegExp("docs/a.b").test("docs/aXb"));
});

test("the closure follows relative requires and reports the ones that go nowhere", () => {
  const texts = {
    "server.js": 'const a = require("./lib/a"); const b = require("./lib/sub");',
    "lib/a.js": 'require("./b"); require("./missing");',
    "lib/b.js": "",
    "lib/sub/index.js": 'require("../b");',
    "lib/unused.js": ""
  };
  const exists = (file) => file in texts;
  const result = requireClosure(["server.js"], (file) => texts[file] ?? null, exists);
  assert.deepEqual([...result.files].sort(), ["lib/a.js", "lib/b.js", "lib/sub/index.js", "server.js"]);
  assert.deepEqual(result.unresolved, [{ file: "lib/a.js", spec: "./missing" }]);
});

test("every tracked file is classified, so a new file cannot slip into or out of a build unseen", (t) => {
  const files = realTree();
  if (!files) return t.skip("not a git checkout");
  const result = plan(files);
  const unclassified = result.problems.filter((problem) => /not classified/.test(problem));
  assert.deepEqual(unclassified, [], "add the new file to editions/file-map.json");
  assert.deepEqual(result.problems, []);
});

test("the Value Optical build ships the core, RX Capture and the vault, and keeps everything else out", (t) => {
  const files = realTree();
  if (!files) return t.skip("not a git checkout");
  const result = plan(files);
  const shipped = new Set(result.selected);
  for (const file of ["server.js", "lib/edition.js", "lib/edition-public-key.pem", "public/rx-capture.html", "public/credentials.html", "database/002-core-schema.sql", "database/043-rx-capture.sql", "database/054-rx-capture-bulk-upload.sql", "public/edition-banner.js"]) {
    assert.ok(shipped.has(file), `${file} should ship`);
  }
  for (const file of [
    "scripts/edition-sign.js", "scripts/build-edition.js", "editions/value-optical.json", "CLAUDE.md", "AGENTS.md",
    "public/delivery-export.html", "public/pricing-automation.html", "public/business-metrics.html", "public/tools/QBO/README.md",
    "database/003-delivery-module-schema.sql", "database/029-inventory-analysis-schema.sql", "database/035-qbo-invoice-sync.sql", "database/050-email-client.sql",
    "docs/EDITIONS.md", "docs/REMOTE_AGENT_OPERATIONS.md", "outputs/lens-order-frequency-2026-08-27/lens-order-frequency-report.xlsx"
  ]) {
    assert.ok(!shipped.has(file), `${file} should stay out`);
  }
  assert.ok(!shipped.has("lib/edition-build.json"), "core never carries the build marker; the build writes it");
  assert.equal(files.includes("lib/edition-build.json"), false, "committing the marker would lock the full edition");
});

test("every migration the edition runs is in the build, and none the edition skips", (t) => {
  const files = realTree();
  if (!files) return t.skip("not a git checkout");
  const shipped = new Set(plan(files).selected);
  const enabled = expandModules(definition.modules);
  for (const entry of migrationFiles) {
    const wanted = entry.module === "core" || enabled.has(entry.module);
    assert.equal(shipped.has(`database/${entry.file}`), wanted, entry.file);
  }
});

test("code that server.js loads at start-up ships even when its module is not licensed, and is reported as dormant", () => {
  const files = ["server.js", "lib/email/routes.js", "lib/db.js", "lib/inventory/store.js", "package.json"];
  const texts = { "server.js": 'require("./lib/email/routes"); require("./lib/db");', "lib/email/routes.js": "", "lib/db.js": "" };
  const result = plan(files, texts);
  assert.ok(result.selected.includes("lib/email/routes.js"));
  assert.deepEqual(result.dormant, [{ file: "lib/email/routes.js", owner: "email" }]);
  assert.ok(!result.selected.includes("lib/inventory/store.js"), "unreferenced module code stays out");
});

test("a tracked file with no rule fails the plan, and shipped code cannot need a 'never' file", () => {
  const unknown = plan(["server.js", "mystery.bin"]);
  assert.match(unknown.problems.join("\n"), /not classified[\s\S]*mystery\.bin/);
  const needsNever = plan(["server.js", "lib/innova-api-client.js"], { "server.js": 'require("./lib/innova-api-client")' });
  assert.match(needsNever.problems.join("\n"), /marked 'never'/);
  const badModule = plan(["server.js"], {}, { modules: ["rx-capture", "nonsense"] });
  assert.match(badModule.problems.join("\n"), /unknown module: nonsense/);
});

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `optilens-${label}-`));
}

function fakeRoot(files) {
  const root = tempDir("src");
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

test("a build writes the marker, the overrides and a hash list of what it owns", () => {
  const root = fakeRoot({
    "package.json": JSON.stringify({ name: "optilens-local", version: "0.1.0" }),
    "data/rx/config.json": JSON.stringify({ defaults: { labNum: "1177", agentName: "LL" }, folders: { incoming: "\\\\x\\y" } }),
    "server.js": "// core"
  });
  const outDir = path.join(tempDir("out"), "b");
  fs.mkdirSync(outDir);
  const result = { selected: ["package.json", "data/rx/config.json", "server.js"], enabled: ["rx-capture"], dormant: [] };
  const sync = writeBuild({ root, outDir, definition, plan: result, source: { commit: "abc123", tag: "v1" }, builtAt: "2026-10-16T00:00:00.000Z" });

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, "lib", "edition-build.json"), "utf8")), { requireManifest: true, edition: "value-optical" });
  const config = JSON.parse(fs.readFileSync(path.join(outDir, "data", "rx", "config.json"), "utf8"));
  assert.equal(config.defaults.labNum, "", "the donor lab's number is not shipped");
  assert.equal(config.defaults.agentName, "LL", "other defaults are kept");
  assert.equal(config.folders.incoming, "");
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, "package.json"), "utf8")).name, "optilens-value-optical");
  assert.equal(sync.source.tag, "v1");
  assert.deepEqual(Object.keys(sync.files).sort(), ["data/rx/config.json", "lib/edition-build.json", "package.json", "server.js"]);
});

function builtDir(files) {
  const outDir = tempDir("built");
  const hashes = {};
  const crypto = require("node:crypto");
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(outDir, file)), { recursive: true });
    fs.writeFileSync(path.join(outDir, file), content);
    hashes[file] = crypto.createHash("sha256").update(content).digest("hex");
  }
  fs.writeFileSync(path.join(outDir, SYNC_FILE), JSON.stringify({ edition: "value-optical", files: hashes }));
  return outDir;
}

test("a sync adds, updates and removes only what core owns, and leaves downstream's own files", () => {
  const target = tempDir("downstream");
  fs.writeFileSync(path.join(target, "zen-adapter.js"), "downstream only");

  const first = builtDir({ "server.js": "v1", "lib/old.js": "old", "public/a.html": "a" });
  assert.deepEqual(applyBuild({ outDir: first, targetDir: target }).added.sort(), ["lib/old.js", "public/a.html", "server.js"]);

  const second = builtDir({ "server.js": "v2", "public/a.html": "a", "lib/new.js": "new" });
  const result = applyBuild({ outDir: second, targetDir: target });
  assert.equal(result.applied, true);
  assert.deepEqual(result.updated, ["server.js"]);
  assert.deepEqual(result.added, ["lib/new.js"]);
  assert.deepEqual(result.removed, ["lib/old.js"]);
  assert.equal(fs.readFileSync(path.join(target, "server.js"), "utf8"), "v2");
  assert.equal(fs.existsSync(path.join(target, "lib", "old.js")), false);
  assert.equal(fs.readFileSync(path.join(target, "zen-adapter.js"), "utf8"), "downstream only");
});

test("a synced file edited downstream stops the sync instead of being overwritten", () => {
  const target = tempDir("downstream");
  applyBuild({ outDir: builtDir({ "server.js": "v1", "lib/keep.js": "k" }), targetDir: target });
  fs.writeFileSync(path.join(target, "server.js"), "their fix");
  fs.writeFileSync(path.join(target, "lib", "keep.js"), "their edit of a file core drops");

  const next = builtDir({ "server.js": "v2" });
  const blocked = applyBuild({ outDir: next, targetDir: target });
  assert.equal(blocked.applied, false);
  assert.deepEqual(blocked.conflicts.map((conflict) => conflict.file).sort(), ["lib/keep.js", "server.js"]);
  assert.equal(fs.readFileSync(path.join(target, "server.js"), "utf8"), "their fix", "nothing was written");

  assert.equal(applyBuild({ outDir: next, targetDir: target, force: true }).applied, true);
  assert.equal(fs.readFileSync(path.join(target, "server.js"), "utf8"), "v2");
});

test("a file that already exists downstream but was never synced is a conflict, unless identical", () => {
  const target = tempDir("downstream");
  fs.writeFileSync(path.join(target, "server.js"), "something else");
  fs.writeFileSync(path.join(target, "same.js"), "same");
  const out = builtDir({ "server.js": "v1", "same.js": "same" });
  const result = applyBuild({ outDir: out, targetDir: target });
  assert.equal(result.applied, false);
  assert.deepEqual(result.conflicts.map((conflict) => conflict.file), ["server.js"]);
});
