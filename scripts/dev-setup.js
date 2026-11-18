#!/usr/bin/env node
"use strict";

// npm run dev:setup
//
// Creates the isolated dev checkout: a git worktree next to the production checkout, on its own
// branch, with its own node_modules and data/ folder. Edits there cannot reach the running
// service; they only go live through npm run ship.
//
// Usage: node scripts/dev-setup.js [--dir <path>] [--skip-install]

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const flow = require("../lib/dev-flow");

const argv = process.argv.slice(2);
const dirFlag = argv.indexOf("--dir");
const skipInstall = argv.includes("--skip-install");

function say(message) {
  console.log(`[dev-setup] ${message}`);
}

function main() {
  const top = flow.git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const trees = flow.parseWorktreeList(flow.git(top, ["worktree", "list", "--porcelain"]));
  const mainRoot = trees[0].path;
  const deployBranch = process.env.OPTILENS_UPDATE_BRANCH || "master";
  const target = path.resolve(dirFlag >= 0 ? argv[dirFlag + 1] : path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}-dev`));
  const branch = flow.devBranchName(os.userInfo().username);

  flow.git(mainRoot, ["fetch", "--quiet", "origin"]);

  if (trees.some((tree) => path.resolve(tree.path) === target)) {
    say(`Dev checkout already exists at ${target} (branch ${trees.find((t) => path.resolve(t.path) === target).branch || "detached"}).`);
  } else {
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`${target} exists and is not empty.`);
    const branchExists = flow.git(mainRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true }).status === 0;
    say(`Creating worktree ${target} on ${branchExists ? "existing" : "new"} branch ${branch}...`);
    if (branchExists) flow.git(mainRoot, ["worktree", "add", target, branch]);
    else flow.git(mainRoot, ["worktree", "add", "-b", branch, target, `origin/${deployBranch}`]);
  }

  const envFile = path.join(mainRoot, ".env");
  const targetEnv = path.join(target, ".env");
  if (fs.existsSync(envFile) && !fs.existsSync(targetEnv)) {
    fs.copyFileSync(envFile, targetEnv);
    say("Copied .env (gitignored, stays on this machine).");
  }

  if (!skipInstall && !fs.existsSync(path.join(target, "node_modules"))) {
    say("Installing dependencies (one time, a few minutes)...");
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const install = flow.run(npm, ["ci", "--no-audit", "--no-fund"], { cwd: target, allowFail: true, inherit: true });
    if (install.status !== 0) throw new Error("npm ci failed in the dev checkout; fix it and re-run npm run dev:setup.");
  }

  say("Ready.");
  console.log([
    "",
    `  cd "${target}"`,
    "  npm run dev:preview     # hot-reload preview on its own port",
    "  npm run ship -- -m \"what changed\"   # test, publish and apply to the live site",
    ""
  ].join("\n"));
}

try {
  main();
} catch (error) {
  console.error(`[dev-setup] ${error.message}`);
  process.exit(1);
}
