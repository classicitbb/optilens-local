"use strict";

// Small, dependency-free helpers shared by scripts/dev-setup.js and scripts/ship.js.

const { spawnSync } = require("node:child_process");
const path = require("node:path");

// Files that must never ride along in a commit made by the ship flow. `.env.example` is fine.
const SECRET_PATH = /(^|\/)(\.env(\.(?!example$)[^/]*)?|[^/]*\.pem|[^/]*\.pfx|[^/]*\.protected|vault\.json)$/i;

function findSecretPaths(paths) {
  return paths.filter((file) => SECRET_PATH.test(String(file).replaceAll("\\", "/")));
}

function slugify(text, max = 40) {
  const slug = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
  return slug || "change";
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}`;
}

function publishBranchName(message, date = new Date()) {
  return `publish/${slugify(message, 30)}-${stamp(date)}`;
}

function devBranchName(username) {
  return `dev/${slugify(username, 24) === "change" ? "preview" : slugify(username, 24)}`;
}

// `git worktree list --porcelain`. The first entry is always the main worktree, which on the
// production host is the checkout the service runs from.
function parseWorktreeList(output) {
  const trees = [];
  let current = null;
  for (const line of String(output).split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9).trim(), branch: "", head: "", bare: false };
      trees.push(current);
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5).trim();
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
    else if (current && line.trim() === "bare") current.bare = true;
  }
  return trees;
}

// `git status --porcelain=v1 -z -uall` -> [{ code, path }]. A rename or copy carries its old
// path as a separate entry, which is skipped.
function parseStatusZ(output) {
  const parts = String(output).split("\0").filter((part) => part.length);
  const entries = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const code = part.slice(0, 2);
    entries.push({ code, path: part.slice(3) });
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") index++;
  }
  return entries;
}

function changedJsFiles(paths) {
  return [...new Set(["server.js", ...paths.filter((file) => file.endsWith(".js") && !file.startsWith("node_modules/"))])];
}

function needsUiBuild(paths) {
  return paths.some((file) => file.startsWith("scripts/ui/") || file === "package.json" || file === "package-lock.json" || file === "scripts/build-ui.mjs");
}

function compareUrl(originUrl, branch, base = "master") {
  const match = String(originUrl).trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return match ? `https://github.com/${match[1]}/${match[2]}/compare/${base}...${encodeURIComponent(branch).replace(/%2F/g, "/")}?expand=1` : "";
}

function readEnvValue(envText, name) {
  const match = String(envText).match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, "m"));
  return match ? match[1].replace(/^"|"$/g, "") : "";
}

// Arguments for the documented guarded update: scripts/apply-local-update.ps1 -PullGit.
function applyUpdateArgs(liveRoot, { remote = "origin", branch = "master", port = "" } = {}) {
  const args = [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", path.join(liveRoot, "scripts", "apply-local-update.ps1"),
    "-ProjectRoot", liveRoot,
    "-PullGit", "-GitRemote", remote, "-GitBranch", branch
  ];
  if (/^\d{2,5}$/.test(String(port))) args.push("-Port", String(port));
  return args;
}

function run(command, args, { cwd, allowFail = false, input, inherit = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    input,
    stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false
  });
  if (result.error) {
    if (allowFail) return { status: 127, stdout: "", stderr: String(result.error.message) };
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${String(result.stderr || result.stdout || "").trim().slice(0, 600)}`);
  }
  return { status: result.status, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}

function git(cwd, args, options = {}) {
  const result = run("git", ["-c", `safe.directory=${cwd}`, ...args], { cwd, ...options });
  return options.allowFail ? result : result.stdout;
}

module.exports = {
  findSecretPaths,
  slugify,
  publishBranchName,
  devBranchName,
  parseWorktreeList,
  parseStatusZ,
  changedJsFiles,
  needsUiBuild,
  compareUrl,
  readEnvValue,
  applyUpdateArgs,
  run,
  git
};
