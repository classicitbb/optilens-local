#!/usr/bin/env node
// Builds a licensed edition's source tree from this (core) repository.
//
//   node scripts/build-edition.js --edition value-optical --out build/value-optical
//   node scripts/build-edition.js --edition value-optical --check
//   node scripts/build-edition.js --edition value-optical --out build/vo --apply ../optilens-value-optical
//
// The output is an allowlist: a tracked file ships only when editions/file-map.json
// gives it to the core or to a module the edition includes (plus whatever
// server.js and the shipped scripts require, so the tree always starts).
// The build writes lib/edition-build.json {requireManifest:true}, so a build
// with no signed manifest runs the core only, and edition-sync.json, which lets
// a later sync replace exactly the files it owns and spot local edits.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SYNC_FILE = "edition-sync.json";
const BUILD_FILE = "lib/edition-build.json";

function toPosix(value) {
  return value.split(path.sep).join("/");
}

// Text is hashed with LF line endings, so a Windows checkout that converted them
// does not look like an edit.
function sha256(buffer) {
  const text = buffer.includes(0) ? buffer : Buffer.from(buffer.toString("latin1").split("\r\n").join("\n"), "latin1");
  return crypto.createHash("sha256").update(text).digest("hex");
}

function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      source += ".*";
      i += 1;
      if (glob[i + 1] === "/") i += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function compileRules(fileMap) {
  return fileMap.rules.map((rule) => ({ ...rule, regex: globToRegExp(rule.match) }));
}

function ownerOf(file, rules) {
  const rule = rules.find((entry) => entry.regex.test(file));
  return rule ? rule.owner : null;
}

function trackedFiles(root) {
  const output = execFileSync("git", ["-c", "core.quotepath=off", "ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return output.toString("utf8").split("\0").filter(Boolean);
}

function resolveLocal(from, spec, exists) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  for (const candidate of [base, `${base}.js`, `${base}.json`, `${base}/index.js`]) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

// Local files reachable by require("./...") from the entry points.
function requireClosure(entries, readText, exists) {
  const seen = new Set();
  const unresolved = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.endsWith(".js")) continue;
    const text = readText(file);
    if (text == null) continue;
    for (const match of text.matchAll(/\brequire\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      const resolved = resolveLocal(file, match[1], exists);
      if (resolved) queue.push(resolved);
      else unresolved.push({ file, spec: match[1] });
    }
  }
  return { files: seen, unresolved };
}

function setPath(target, dotted, value) {
  const keys = dotted.split(".");
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== "object") node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

function loadDefinition(root, name) {
  const definition = JSON.parse(fs.readFileSync(path.join(root, "editions", `${name}.json`), "utf8"));
  const fileMap = JSON.parse(fs.readFileSync(path.join(root, "editions", "file-map.json"), "utf8"));
  return { definition, fileMap };
}

// Decides what ships. Pure apart from reading files through `io`, so tests can
// drive it with a fake tree.
function planBuild({ definition, fileMap, files, io, migrationFiles, expandModules, knownModules }) {
  const problems = [];
  const rules = compileRules(fileMap);
  for (const id of definition.modules) {
    if (!knownModules.includes(id)) problems.push(`The edition lists an unknown module: ${id}`);
  }
  const enabled = new Set(expandModules(definition.modules));
  const migrationOwner = new Map(migrationFiles.map((entry) => [`database/${entry.file}`, entry.module]));

  const owners = new Map();
  const unclassified = [];
  for (const file of files) {
    let owner = migrationOwner.get(file);
    if (!owner) owner = ownerOf(file, rules);
    if (!owner) unclassified.push(file);
    else owners.set(file, owner);
  }
  if (unclassified.length) {
    problems.push(`${unclassified.length} tracked file(s) are not classified in editions/file-map.json:\n  ${unclassified.slice(0, 25).join("\n  ")}`);
  }
  for (const [file, owner] of owners) {
    if (owner !== "core" && owner !== "never" && !knownModules.includes(owner) && owner !== "doc-studio") {
      problems.push(`${file} is owned by an unknown module: ${owner}`);
    }
  }

  const ships = (owner) => owner === "core" || enabled.has(owner);
  const selected = new Set([...owners].filter(([, owner]) => ships(owner)).map(([file]) => file));

  // server.js requires most of lib/ at load, so what it reaches must ship even
  // when its module is not bought. Those files are dormant: present, routes 404.
  const exists = (file) => files.includes(file);
  const entries = [...selected].filter((file) => file === "server.js" || file.startsWith("scripts/"));
  const closure = requireClosure(entries, io.readText, exists);
  const dormant = [];
  for (const file of closure.files) {
    if (!exists(file) || selected.has(file)) continue;
    const owner = owners.get(file);
    if (owner === "never") problems.push(`${file} is required by shipped code but is marked 'never'.`);
    selected.add(file);
    dormant.push({ file, owner });
  }
  for (const item of closure.unresolved) {
    // Pre-existing dead paths are reported, not fatal, unless they could not start the server.
    if (item.file === "server.js") problems.push(`server.js requires ${item.spec}, which does not exist.`);
  }

  // Scripts that shipped code runs by name (PowerShell hosts, the updater).
  const missingScripts = [];
  for (const file of selected) {
    if (!/\.(js|ps1)$/.test(file)) continue;
    const text = io.readText(file);
    if (!text) continue;
    for (const match of text.matchAll(/scripts[\\/]+([A-Za-z0-9_.-]+\.(?:ps1|js|cs|sql))/g)) {
      const target = `scripts/${match[1]}`;
      if (exists(target) && !selected.has(target)) missingScripts.push({ file, target, owner: owners.get(target) });
    }
  }

  // Every migration the edition runs must be present.
  const migrationPlan = migrationFiles
    .filter((entry) => entry.module === "core" || enabled.has(entry.module))
    .map((entry) => `database/${entry.file}`);
  for (const file of migrationPlan) {
    if (!selected.has(file)) problems.push(`The migration plan needs ${file}, which is not in the build.`);
  }

  return {
    enabled: [...enabled].sort(),
    selected: [...selected].sort(),
    excluded: files.filter((file) => !selected.has(file)).sort(),
    dormant: dormant.sort((a, b) => a.file.localeCompare(b.file)),
    missingScripts,
    problems
  };
}

function sourceInfo(root) {
  const git = (...args) => {
    try { return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim(); } catch { return ""; }
  };
  return {
    commit: git("rev-parse", "HEAD"),
    tag: process.env.EDITION_SOURCE_TAG || git("describe", "--tags", "--exact-match"),
    dirty: Boolean(git("status", "--porcelain", "--untracked-files=no"))
  };
}

function writeBuild({ root, outDir, definition, plan, source, builtAt }) {
  const files = {};
  const write = (relative, buffer) => {
    const target = path.join(outDir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
    files[relative] = sha256(buffer);
  };

  for (const file of plan.selected) {
    let buffer = fs.readFileSync(path.join(root, ...file.split("/")));
    if (file === "package.json" && definition.package) {
      buffer = Buffer.from(`${JSON.stringify({ ...JSON.parse(buffer.toString("utf8")), ...definition.package }, null, 2)}\n`);
    }
    const overrides = definition.jsonOverrides && definition.jsonOverrides[file];
    if (overrides) {
      const json = JSON.parse(buffer.toString("utf8"));
      for (const [dotted, value] of Object.entries(overrides)) setPath(json, dotted, value);
      buffer = Buffer.from(`${JSON.stringify(json, null, 2)}\n`);
    }
    write(file, buffer);
  }

  write(BUILD_FILE, Buffer.from(`${JSON.stringify({ requireManifest: true, edition: definition.edition }, null, 2)}\n`));

  const sync = {
    edition: definition.edition,
    source: { repo: "classicitbb/optilens-local", commit: source.commit, tag: source.tag || null },
    builtAt,
    modules: plan.enabled,
    dormantFiles: plan.dormant.length,
    files
  };
  fs.writeFileSync(path.join(outDir, SYNC_FILE), `${JSON.stringify(sync, null, 2)}\n`);
  return sync;
}

function readSync(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, SYNC_FILE), "utf8")); } catch { return null; }
}

// Copies a build into a downstream checkout. Files the previous sync wrote and
// this build no longer has are removed. A synced file edited downstream is a
// conflict (their fix belongs in a PR to core) unless force is set.
function applyBuild({ outDir, targetDir, force = false }) {
  const next = readSync(outDir);
  if (!next) throw new Error(`${outDir} has no ${SYNC_FILE}; build it first.`);
  const previous = readSync(targetDir);
  const conflicts = [];
  const hashOnDisk = (relative) => {
    try { return sha256(fs.readFileSync(path.join(targetDir, ...relative.split("/")))); } catch { return null; }
  };

  for (const [relative, hash] of Object.entries(next.files)) {
    const current = hashOnDisk(relative);
    if (current === null || current === hash) continue;
    const recorded = previous && previous.files[relative];
    if (recorded !== current) conflicts.push({ file: relative, reason: recorded ? "edited downstream since the last sync" : "exists downstream but core did not put it there" });
  }
  const removals = previous ? Object.keys(previous.files).filter((relative) => !(relative in next.files)) : [];
  for (const relative of removals) {
    const current = hashOnDisk(relative);
    if (current !== null && current !== previous.files[relative]) conflicts.push({ file: relative, reason: "edited downstream but core no longer ships it" });
  }
  if (conflicts.length && !force) return { applied: false, conflicts, added: [], updated: [], removed: [] };

  const added = [];
  const updated = [];
  for (const [relative, hash] of Object.entries(next.files)) {
    const current = hashOnDisk(relative);
    if (current === hash) continue;
    const target = path.join(targetDir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(outDir, ...relative.split("/")), target);
    (current === null ? added : updated).push(relative);
  }
  const removed = [];
  for (const relative of removals) {
    const target = path.join(targetDir, ...relative.split("/"));
    if (fs.existsSync(target)) { fs.rmSync(target); removed.push(relative); }
  }
  fs.copyFileSync(path.join(outDir, SYNC_FILE), path.join(targetDir, SYNC_FILE));
  return { applied: true, conflicts, added, updated, removed };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

function reportApply(result, targetDir) {
  if (!result.applied) {
    console.error(`  sync stopped: ${result.conflicts.length} synced file(s) were changed downstream:`);
    for (const conflict of result.conflicts) console.error(`    ${conflict.file} (${conflict.reason})`);
    console.error("  Send those changes to core as a PR, or rerun with --force to overwrite them.");
    process.exitCode = 2;
    return;
  }
  console.log(`  synced into ${targetDir}: ${result.added.length} added, ${result.updated.length} updated, ${result.removed.length} removed`);
}

function main(argv) {
  const args = parseArgs(argv);
  // Applies a build made earlier, so a pipeline can test the build before syncing it.
  if (args["apply-build"]) {
    if (!args.apply) throw new Error("--apply-build needs --apply <downstream dir>.");
    const targetDir = path.resolve(String(args.apply));
    reportApply(applyBuild({ outDir: path.resolve(String(args["apply-build"])), targetDir, force: Boolean(args.force) }), targetDir);
    return;
  }
  if (!args.edition) throw new Error("Pass --edition <name> (a file in editions/).");
  const { definition, fileMap } = loadDefinition(ROOT, args.edition);
  const { MODULES, expandModules } = require("../lib/edition");
  const { migrationFiles } = require("../lib/migrations");

  const files = trackedFiles(ROOT);
  const plan = planBuild({
    definition,
    fileMap,
    files,
    io: { readText: (file) => { try { return fs.readFileSync(path.join(ROOT, ...file.split("/")), "utf8"); } catch { return null; } } },
    migrationFiles,
    expandModules,
    knownModules: Object.keys(MODULES)
  });
  const source = sourceInfo(ROOT);

  console.log(`Edition ${definition.edition}: modules ${plan.enabled.join(", ")}`);
  console.log(`  ships ${plan.selected.length} files (${plan.dormant.length} dormant: required by server.js, routes blocked), keeps ${plan.excluded.length} out`);
  for (const item of plan.missingScripts) console.warn(`  warning: ${item.file} refers to ${item.target} (${item.owner}), which is not in the build`);
  if (plan.problems.length) {
    for (const problem of plan.problems) console.error(`  error: ${problem}`);
    process.exitCode = 1;
    return;
  }
  if (args.strict && plan.dormant.length) {
    console.error(`  error (--strict): ${plan.dormant.length} dormant file(s) from modules this edition does not include.`);
    process.exitCode = 1;
    return;
  }
  if (source.dirty && !args["allow-dirty"] && !args.check) {
    console.error("  error: tracked files have uncommitted changes. Commit them or pass --allow-dirty.");
    process.exitCode = 1;
    return;
  }
  if (args.check) { console.log("  check passed"); return; }
  if (!args.out) throw new Error("Pass --out <dir> (or --check).");

  const outDir = path.resolve(String(args.out));
  if (fs.existsSync(outDir)) {
    if (fs.readdirSync(outDir).length && !fs.existsSync(path.join(outDir, SYNC_FILE))) {
      throw new Error(`${outDir} exists and is not a previous build; refusing to overwrite it.`);
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const sync = writeBuild({ root: ROOT, outDir, definition, plan, source, builtAt: new Date().toISOString() });
  console.log(`  wrote ${Object.keys(sync.files).length} files to ${outDir}`);

  if (args.apply) {
    const targetDir = path.resolve(String(args.apply));
    reportApply(applyBuild({ outDir, targetDir, force: Boolean(args.force) }), targetDir);
  }
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { applyBuild, compileRules, globToRegExp, ownerOf, planBuild, requireClosure, writeBuild, SYNC_FILE, BUILD_FILE };
