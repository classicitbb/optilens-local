"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const flow = require("../lib/dev-flow");

const repoRoot = path.join(__dirname, "..");

test("credential-like files are caught, .env.example is not", () => {
  assert.deepEqual(
    flow.findSecretPaths([".env", ".env.local", "a/.env.production", "data/vault.json", "k/site.pem", "data/auth-sessions.protected", ".env.example", "public/x.js", "docs/env.md"]),
    [".env", ".env.local", "a/.env.production", "data/vault.json", "k/site.pem", "data/auth-sessions.protected"]
  );
});

test("branch names are safe and stable", () => {
  assert.equal(flow.slugify("Fix: Automation tooltip!! (v2)"), "fix-automation-tooltip-v2");
  assert.equal(flow.slugify("   "), "change");
  assert.equal(flow.publishBranchName("Fix the thing", new Date("2026-11-18T16:30:00Z")), "publish/fix-the-thing-202611181630");
  assert.equal(flow.devBranchName("Russell Hunte"), "dev/russell-hunte");
  assert.equal(flow.devBranchName("###"), "dev/preview");
});

test("parseWorktreeList puts the main (live) checkout first", () => {
  const trees = flow.parseWorktreeList("worktree /srv/app\nHEAD abc\nbranch refs/heads/master\n\nworktree /srv/app-dev\nHEAD def\nbranch refs/heads/dev/russell\n");
  assert.equal(trees[0].path, "/srv/app");
  assert.equal(trees[0].branch, "master");
  assert.equal(trees[1].branch, "dev/russell");
});

test("parseStatusZ handles modified, untracked, deleted and renamed entries", () => {
  const out = [" M public/a.html", "?? new.txt", " D gone.js", "R  new-name.js", "old-name.js"].join("\0") + "\0";
  assert.deepEqual(flow.parseStatusZ(out), [
    { code: " M", path: "public/a.html" },
    { code: "??", path: "new.txt" },
    { code: " D", path: "gone.js" },
    { code: "R ", path: "new-name.js" }
  ]);
});

test("gates run only what the change needs", () => {
  assert.deepEqual(flow.changedJsFiles(["lib/a.js", "public/x.css", "node_modules/q/i.js"]), ["server.js", "lib/a.js"]);
  assert.equal(flow.needsUiBuild(["public/x.css"]), false);
  assert.equal(flow.needsUiBuild(["scripts/ui/app.jsx"]), true);
  assert.equal(flow.needsUiBuild(["package-lock.json"]), true);
});

test("compareUrl and env parsing", () => {
  assert.equal(flow.compareUrl("https://github.com/classicitbb/optilens-local.git", "publish/x-1"), "https://github.com/classicitbb/optilens-local/compare/master...publish/x-1?expand=1");
  assert.equal(flow.compareUrl("git@github.com:classicitbb/optilens-local.git", "b"), "https://github.com/classicitbb/optilens-local/compare/master...b?expand=1");
  assert.equal(flow.compareUrl("file:///tmp/x", "b"), "");
  assert.equal(flow.readEnvValue("OPTILENS_HOST=0.0.0.0\nOPTILENS_PORT=8081\n", "OPTILENS_PORT"), "8081");
  assert.equal(flow.readEnvValue("A=1", "OPTILENS_PORT"), "");
});

test("the live update uses the documented guarded script with -PullGit", () => {
  const args = flow.applyUpdateArgs("/srv/app", { port: "8081" });
  assert.deepEqual(args.slice(args.indexOf("-PullGit")), ["-PullGit", "-GitRemote", "origin", "-GitBranch", "master", "-Port", "8081"]);
  assert.ok(args.includes("-ProjectRoot"));
  assert.ok(!flow.applyUpdateArgs("/srv/other", { port: "bad" }).includes("-Port"));
});

// ---- end to end against scratch repositories -------------------------------------------------

// An empty home keeps the developer's own git configuration (signing, hooks, aliases) out of the scratch repos.
const gitHome = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-githome-"));
const gitEnv = {
  ...process.env,
  HOME: gitHome, USERPROFILE: gitHome, XDG_CONFIG_HOME: gitHome, GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_TERMINAL_PROMPT: "0"
};

function sh(cwd, command, args, env = gitEnv) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  return { status: result.status, out: `${result.stdout}${result.stderr}`.trim() };
}

function scratch() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-ship-"));
  const origin = path.join(base, "origin.git");
  const live = path.join(base, "live");
  assert.equal(sh(base, "git", ["init", "--bare", "-b", "master", origin]).status, 0);
  assert.equal(sh(base, "git", ["clone", origin, live]).status, 0);
  fs.mkdirSync(path.join(live, "public"));
  fs.writeFileSync(path.join(live, "server.js"), "console.log('live');\n");
  fs.writeFileSync(path.join(live, "public", "page.html"), "<p>one</p>\n");
  sh(live, "git", ["add", "-A"]);
  assert.equal(sh(live, "git", ["commit", "-m", "initial"]).status, 0);
  assert.equal(sh(live, "git", ["push", "origin", "HEAD:master"]).status, 0);
  sh(live, "git", ["branch", "--set-upstream-to=origin/master", "master"]);
  const setup = sh(live, process.execPath, [path.join(repoRoot, "scripts", "dev-setup.js"), "--skip-install"]);
  assert.equal(setup.status, 0, setup.out);
  const dev = path.join(base, "live-dev");
  assert.ok(fs.existsSync(path.join(dev, "server.js")), "dev worktree created");
  return { base, origin, live, dev };
}

const ship = (dev, args, env = gitEnv) => sh(dev, process.execPath, [path.join(repoRoot, "scripts", "ship.js"), ...args], env);
const originFile = (s, file) => sh(s.live, "git", ["--no-pager", "show", `origin/master:${file}`]).out;

test("dev:setup makes an isolated worktree on its own branch and leaves the live checkout alone", () => {
  const s = scratch();
  const branch = sh(s.dev, "git", ["branch", "--show-current"]).out;
  assert.match(branch, /^dev\//);
  assert.equal(sh(s.live, "git", ["branch", "--show-current"]).out, "master");
  assert.equal(sh(s.live, "git", ["status", "--porcelain"]).out, "");
});

test("ship publishes a dev edit to master, resets the dev checkout, and never touches the live tree", () => {
  const s = scratch();
  fs.writeFileSync(path.join(s.dev, "public", "page.html"), "<p>two</p>\n");
  const result = ship(s.dev, ["--fast", "--yes", "--direct", "--no-live", "-m", "Change page copy"]);
  assert.equal(result.status, 0, result.out);
  sh(s.live, "git", ["fetch", "origin"]);
  assert.equal(originFile(s, "public/page.html"), "<p>two</p>");
  assert.match(sh(s.live, "git", ["log", "-1", "--format=%s", "origin/master"]).out, /Change page copy/);
  assert.equal(sh(s.dev, "git", ["status", "--porcelain"]).out, "");
  assert.equal(sh(s.dev, "git", ["rev-parse", "HEAD"]).out, sh(s.live, "git", ["rev-parse", "origin/master"]).out);
  assert.equal(fs.readFileSync(path.join(s.live, "public", "page.html"), "utf8"), "<p>one</p>\n", "live files change only through the updater");
});

test("ship --dry-run changes nothing and a syntax error stops the publish", () => {
  const s = scratch();
  fs.writeFileSync(path.join(s.dev, "public", "page.html"), "<p>three</p>\n");
  const dry = ship(s.dev, ["--fast", "--dry-run", "-m", "x"]);
  assert.equal(dry.status, 0, dry.out);
  assert.match(sh(s.dev, "git", ["status", "--porcelain"]).out, /page\.html/);

  fs.writeFileSync(path.join(s.dev, "server.js"), "const = ;\n");
  const broken = ship(s.dev, ["--fast", "--yes", "--direct", "--no-live", "-m", "broken"]);
  assert.notEqual(broken.status, 0);
  assert.match(broken.out, /Syntax check failed/);
  sh(s.live, "git", ["fetch", "origin"]);
  assert.equal(originFile(s, "public/page.html"), "<p>one</p>");
});

test("ship refuses credential-like files", () => {
  const s = scratch();
  fs.writeFileSync(path.join(s.dev, ".env.local"), "OPTILENS_DB_PASSWORD=nope\n");
  const result = ship(s.dev, ["--fast", "--yes", "--direct", "--no-live", "-m", "oops"]);
  assert.notEqual(result.status, 0);
  assert.match(result.out, /credential-like files/);
  assert.match(result.out, /\.env\.local/);
});

test("ship reports nothing to publish on a clean checkout", () => {
  const s = scratch();
  const result = ship(s.dev, ["--fast", "--yes", "--direct", "--no-live", "-m", "noop"]);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /Nothing to publish/);
});

test("ship --revert undoes the newest commit on master through the same pipeline", () => {
  const s = scratch();
  fs.writeFileSync(path.join(s.dev, "public", "page.html"), "<p>bad</p>\n");
  assert.equal(ship(s.dev, ["--fast", "--yes", "--direct", "--no-live", "-m", "Bad change"]).status, 0);
  const reverted = ship(s.dev, ["--yes", "--direct", "--no-live", "--revert"]);
  assert.equal(reverted.status, 0, reverted.out);
  sh(s.live, "git", ["fetch", "origin"]);
  assert.equal(originFile(s, "public/page.html"), "<p>one</p>");
  assert.match(sh(s.live, "git", ["log", "-1", "--format=%s", "origin/master"]).out, /^Revert "Bad change"/);
});

test("ship opens and merges a pull request through gh by default", { skip: process.platform === "win32" }, () => {
  const s = scratch();
  const bin = path.join(s.base, "bin");
  fs.mkdirSync(bin);
  const calls = path.join(s.base, "gh-calls.log");
  fs.writeFileSync(path.join(bin, "gh"), [
    "#!/bin/sh",
    `echo "$@" >> "${calls}"`,
    'case "$1 $2" in',
    '  "pr merge") git push origin HEAD:master >/dev/null 2>&1 ;;',
    '  "pr view") echo MERGED ;;',
    "esac",
    "exit 0"
  ].join("\n"), { mode: 0o755 });
  fs.writeFileSync(path.join(s.dev, "public", "page.html"), "<p>via pr</p>\n");
  const result = ship(s.dev, ["--fast", "--yes", "--no-live", "-m", "Copy via PR"], { ...gitEnv, PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(result.status, 0, result.out);
  const log = fs.readFileSync(calls, "utf8");
  assert.match(log, /pr create --base master --head dev\//);
  assert.match(log, /pr merge dev\/.* --squash/);
  sh(s.live, "git", ["fetch", "origin"]);
  assert.equal(originFile(s, "public/page.html"), "<p>via pr</p>");
});
