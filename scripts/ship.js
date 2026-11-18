#!/usr/bin/env node
"use strict";

// npm run ship -- -m "what changed"
//
// One command from "it looks right in the preview" to "it is live and healthy":
//   check -> commit -> push -> merge to master -> guarded update of the live checkout -> health verify
//
// The live site is only ever changed through the documented guarded updater
// (scripts/apply-local-update.ps1 -PullGit), which backs up the revision, runs its smoke check,
// restarts, verifies deep health and rolls back on failure.
//
// Flags:
//   -m, --message <text>   commit message / PR title (prompted when omitted)
//   --fast                 skip the full test suite (syntax check and UI build still run)
//   --strict               block on any failing test (default: report, like the guarded updater)
//   --yes                  do not ask for confirmation
//   --direct               fast-forward push to master instead of a pull request
//   --no-live              publish to master but do not apply it to the live site now
//   --apply-only           only apply what is already on master to the live site
//   --revert [sha]         undo the newest commit on master (or sha) through the same pipeline
//   --dry-run              show what would happen and change nothing
//
// The production checkout is the first git worktree unless OPTILENS_LIVE_CHECKOUT names a
// separate clone (the usual case when the service runs from its own folder).

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const flow = require("../lib/dev-flow");

function parseArgs(argv) {
  const args = { message: "", fast: false, strict: false, yes: false, direct: false, noLive: false, applyOnly: false, revert: false, revertSha: "", dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-m" || arg === "--message") args.message = argv[++i] || "";
    else if (arg === "--fast") args.fast = true;
    else if (arg === "--strict") args.strict = true;
    else if (arg === "--yes" || arg === "-y") args.yes = true;
    else if (arg === "--direct") args.direct = true;
    else if (arg === "--no-live") args.noLive = true;
    else if (arg === "--apply-only") args.applyOnly = true;
    else if (arg === "--revert") { args.revert = true; if (argv[i + 1] && !argv[i + 1].startsWith("-")) args.revertSha = argv[++i]; }
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else throw new Error(`Unknown option ${arg}. Run with --help.`);
  }
  return args;
}

const log = (message) => console.log(`[ship] ${message}`);

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve("");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

function usage() {
  const text = fs.readFileSync(__filename, "utf8").split("\n").filter((line) => line.startsWith("//")).map((line) => line.slice(3)).join("\n");
  console.log(text);
}

function runGates(top, changed, args) {
  const syntaxFailures = [];
  for (const file of flow.changedJsFiles(changed)) {
    if (!fs.existsSync(path.join(top, file))) continue;
    const result = flow.run(process.execPath, ["--check", file], { cwd: top, allowFail: true });
    if (result.status !== 0) syntaxFailures.push(`${file}: ${result.stderr.trim().split("\n")[0]}`);
  }
  if (syntaxFailures.length) throw new Error(`Syntax check failed:\n  ${syntaxFailures.join("\n  ")}`);
  log(`Syntax check passed (${flow.changedJsFiles(changed).length} file(s)).`);

  if (flow.needsUiBuild(changed)) {
    const build = flow.run(process.execPath, [path.join("scripts", "build-ui.mjs")], { cwd: top, allowFail: true });
    if (build.status !== 0) throw new Error(`UI build failed:\n${(build.stderr || build.stdout).trim().slice(0, 800)}`);
    log("UI build passed.");
  }

  if (args.fast) return log("Tests skipped (--fast).");
  log("Running the test suite...");
  const started = Date.now();
  const tests = flow.run(process.execPath, ["--test", "--test-force-exit", ...fs.readdirSync(path.join(top, "test")).filter((f) => f.endsWith(".test.js")).map((f) => path.join("test", f))], { cwd: top, allowFail: true });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (tests.status === 0) return log(`Tests passed in ${seconds}s.`);
  const failing = [...new Set((tests.stdout.match(/^test at (\S+)/gm) || []).map((line) => line.replace("test at ", "")))];
  const detail = failing.length ? `\n  failing: ${failing.join(", ")}` : "";
  if (args.strict) throw new Error(`Tests failed in ${seconds}s (--strict).${detail}`);
  log(`Tests reported failures in ${seconds}s (advisory, same policy as the guarded updater).${detail}`);
}

async function mergeViaPullRequest(top, branch, deploy, message, files, originUrl) {
  const hasGh = flow.run("gh", ["--version"], { cwd: top, allowFail: true }).status === 0;
  if (!hasGh) {
    log("GitHub CLI (gh) is not available, so the pull request cannot be merged automatically.");
    const url = flow.compareUrl(originUrl, branch, deploy);
    if (url) log(`Open and merge it here: ${url}`);
    log("After merging, run:  npm run ship -- --apply-only");
    process.exitCode = 2;
    return false;
  }
  const title = message.split("\n")[0];
  const body = `${message}\n\nFiles:\n${files.slice(0, 40).map((file) => `- ${file}`).join("\n")}\n\nPublished with \`npm run ship\`.`;
  const created = flow.run("gh", ["pr", "create", "--base", deploy, "--head", branch, "--title", title, "--body", body], { cwd: top, allowFail: true });
  if (created.status !== 0 && !/already exists/i.test(created.stderr)) throw new Error(`gh pr create failed: ${created.stderr.trim().slice(0, 400)}`);
  const merged = flow.run("gh", ["pr", "merge", branch, "--squash"], { cwd: top, allowFail: true });
  if (merged.status !== 0) {
    log(`The pull request could not be merged automatically: ${merged.stderr.trim().slice(0, 300)}`);
    log("Merge it on GitHub (reviews or checks may be required), then run:  npm run ship -- --apply-only");
    process.exitCode = 2;
    return false;
  }
  const state = flow.run("gh", ["pr", "view", branch, "--json", "state", "-q", ".state"], { cwd: top, allowFail: true }).stdout.trim();
  if (state !== "MERGED") {
    log(`Pull request state is ${state || "unknown"}; waiting for GitHub. Run  npm run ship -- --apply-only  once it shows MERGED.`);
    process.exitCode = 2;
    return false;
  }
  log("Pull request merged.");
  return true;
}

async function publish(top, mainRoot, args, deploy) {
  const remote = "origin";
  flow.git(top, ["fetch", "--quiet", remote]);
  const currentBranch = flow.git(top, ["branch", "--show-current"]).trim();
  if (!currentBranch) throw new Error("HEAD is detached. Switch to a branch first.");
  const originUrl = flow.git(top, ["remote", "get-url", remote]).trim();
  const isMainWorktree = path.resolve(top) === path.resolve(mainRoot);

  let message = args.message;
  let files = [];

  if (args.revert) {
    if (flow.git(top, ["status", "--porcelain", "--untracked-files=no"]).trim()) throw new Error("Commit or stash local changes before --revert.");
    const sha = flow.git(top, ["rev-parse", args.revertSha || `${remote}/${deploy}`]).trim();
    const subject = flow.git(top, ["log", "-1", "--format=%s", sha]).trim();
    message = message || `Revert "${subject}"`;
    log(`Reverting ${sha.slice(0, 7)} "${subject}"`);
    if (args.dryRun) return log("Dry run: stopping before any change.");
    const branch = flow.publishBranchName(`revert-${subject}`);
    flow.git(top, ["switch", "-c", branch, `${remote}/${deploy}`]);
    const reverted = flow.git(top, ["revert", "--no-edit", sha], { allowFail: true });
    if (reverted.status !== 0) {
      flow.git(top, ["revert", "--abort"], { allowFail: true });
      throw new Error(`Could not revert cleanly: ${reverted.stderr.trim().slice(0, 300)}`);
    }
    files = flow.git(top, ["diff", "--name-only", `${remote}/${deploy}`, "HEAD"]).split(/\r?\n/).filter(Boolean);
    return finishPublish(top, args, { branch, deploy, message, files, originUrl, isMainWorktree, returnTo: currentBranch });
  }

  const entries = flow.parseStatusZ(flow.git(top, ["status", "--porcelain=v1", "-z", "-uall"]));
  const ahead = Number(flow.git(top, ["rev-list", "--count", `${remote}/${deploy}..HEAD`]).trim() || 0);
  if (!entries.length && (ahead === 0 || currentBranch === deploy)) {
    log("Nothing to publish: no local changes and nothing ahead of master.");
    return false;
  }
  files = entries.map((entry) => entry.path);
  const secrets = flow.findSecretPaths(files);
  if (secrets.length) throw new Error(`Refusing to commit credential-like files:\n  ${secrets.join("\n  ")}\nRemove them from the change or add them to .gitignore.`);

  log(`${entries.length} changed file(s), ${ahead} commit(s) already ahead of ${remote}/${deploy}:`);
  for (const entry of entries.slice(0, 25)) console.log(`    ${entry.code.trim().padEnd(2)} ${entry.path}`);
  if (entries.length > 25) console.log(`    ... and ${entries.length - 25} more`);

  runGates(top, files, args);

  if (!message) message = (await ask("Commit message: ")) || "";
  if (!message) throw new Error("A message is required. Use -m \"what changed\".");
  if (args.dryRun) return log("Dry run: stopping before any commit or push.");
  if (!args.yes) {
    const answer = await ask(`Publish ${entries.length} file(s) to ${deploy} and ${args.noLive ? "stop" : "apply to the live site"}? [y/N] `);
    if (!/^y(es)?$/i.test(answer)) throw new Error("Cancelled.");
  }

  let branch = currentBranch;
  if (currentBranch === deploy) {
    branch = flow.publishBranchName(message);
    flow.git(top, ["switch", "-c", branch]);
    log(`Working on ${deploy}; created branch ${branch} for this change.`);
  }
  if (entries.length) {
    flow.git(top, ["add", "-A"]);
    flow.git(top, ["commit", "-m", message]);
    log(`Committed ${flow.git(top, ["rev-parse", "--short", "HEAD"]).trim()}.`);
  }
  return finishPublish(top, args, { branch, deploy, message, files, originUrl, isMainWorktree, returnTo: currentBranch });
}

async function finishPublish(top, args, { branch, deploy, message, files, originUrl, isMainWorktree, returnTo }) {
  const remote = "origin";
  const behind = Number(flow.git(top, ["rev-list", "--count", `HEAD..${remote}/${deploy}`]).trim() || 0);
  if (behind > 0) {
    log(`${remote}/${deploy} moved ${behind} commit(s) ahead; rebasing.`);
    const rebased = flow.git(top, ["rebase", `${remote}/${deploy}`], { allowFail: true });
    if (rebased.status !== 0) {
      flow.git(top, ["rebase", "--abort"], { allowFail: true });
      throw new Error(`Rebase onto ${remote}/${deploy} hit conflicts and was aborted. Resolve them (git rebase ${remote}/${deploy}) and run ship again.`);
    }
  }

  let merged;
  if (args.direct) {
    flow.git(top, ["push", remote, `HEAD:${deploy}`]);
    log(`Pushed straight to ${deploy}.`);
    merged = true;
  } else {
    flow.git(top, ["push", "-u", remote, branch]);
    log(`Pushed ${branch}.`);
    merged = await mergeViaPullRequest(top, branch, deploy, message, files, originUrl);
  }

  if (merged && !isMainWorktree) {
    // The dev checkout lives on a long-lived branch; once its work is on master it starts over from there.
    const back = returnTo && returnTo !== deploy ? returnTo : branch;
    flow.git(top, ["fetch", "--quiet", remote]);
    flow.git(top, ["switch", "-C", back, `${remote}/${deploy}`]);
    log(`Dev checkout reset to ${remote}/${deploy} on ${back}.`);
  }
  return merged;
}

function applyToLive(mainRoot, deploy, args) {
  if (process.platform !== "win32") {
    log("The live update runs on the Windows host. The host's updater will pick the change up on its next check (within 5 minutes).");
    return;
  }
  const dirty = flow.git(mainRoot, ["status", "--porcelain", "--untracked-files=no"]).split(/\r?\n/).filter(Boolean);
  if (dirty.length) {
    log(`The live checkout has local changes, so the guarded updater will refuse to run:\n    ${dirty.slice(0, 8).join("\n    ")}`);
    log("Commit or discard them in the live checkout, then run:  npm run ship -- --apply-only");
    process.exitCode = 3;
    return;
  }
  let port = "";
  try { port = flow.readEnvValue(fs.readFileSync(path.join(mainRoot, ".env"), "utf8"), "OPTILENS_PORT"); } catch { /* default port */ }
  const before = flow.git(mainRoot, ["rev-parse", "--short", "HEAD"]).trim();
  log(`Applying to the live site through the guarded updater (checks, restart, health, auto-rollback). Live is at ${before}.`);
  const updated = flow.run("powershell", flow.applyUpdateArgs(mainRoot, { branch: deploy, port }), { cwd: mainRoot, allowFail: true, inherit: true });
  if (updated.status !== 0) {
    log("The guarded update did not complete. The host kept or restored its previous revision; see data\\local-update.log.");
    process.exitCode = 4;
    return;
  }
  const verify = flow.run(process.execPath, [path.join("scripts", "monitor-harness.js"), "verify"], { cwd: mainRoot, allowFail: true, inherit: true });
  const after = flow.git(mainRoot, ["rev-parse", "--short", "HEAD"]).trim();
  if (verify.status !== 0) {
    log("Update applied but the health verification failed. Run: node scripts/monitor-harness.js repair (once), then verify. Do not restart repeatedly.");
    process.exitCode = 5;
    return;
  }
  log(`LIVE and healthy at ${after}${after === before ? " (already up to date)" : ""}.`);
  log("To undo: npm run ship -- --revert");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  const top = flow.git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const trees = flow.parseWorktreeList(flow.git(top, ["worktree", "list", "--porcelain"]));
  const mainRoot = trees[0].path;
  const liveRoot = process.env.OPTILENS_LIVE_CHECKOUT ? path.resolve(process.env.OPTILENS_LIVE_CHECKOUT) : mainRoot;
  const deploy = process.env.OPTILENS_UPDATE_BRANCH || "master";

  let published = true;
  if (!args.applyOnly) published = await publish(top, mainRoot, args, deploy);
  if (args.dryRun) return;
  if (published === false && !args.applyOnly) return;
  if (args.noLive) return log(`Published. Not applied to the live site (--no-live); the host updater will pick it up within 5 minutes.`);
  if (!fs.existsSync(path.join(liveRoot, "scripts", "apply-local-update.ps1"))) throw new Error(`${liveRoot} is not an OptiLens checkout. Set OPTILENS_LIVE_CHECKOUT to the folder the service runs from.`);
  flow.git(liveRoot, ["fetch", "--quiet", "origin"]);
  applyToLive(liveRoot, deploy, args);
}

main().catch((error) => {
  console.error(`[ship] ${error.message}`);
  process.exit(1);
});
