const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createGitUpdateChecker,
  isGitAuthorizationFailure,
  resolveDeployBranch
} = require("../lib/git-update-checker");

/* These tests use real Git against throwaway repositories (a bare "origin", a developer clone
   that pushes, and a "host" clone that the checker inspects), because the behaviour that matters
   here is Git's own: ahead/behind counts, fast-forwardability and what counts as dirty. */

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
    encoding: "utf8", windowsHide: true
  }).trim();
}

function makeWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-upd-"));
  const origin = path.join(root, "origin.git");
  const dev = path.join(root, "dev");
  const host = path.join(root, "host");
  execFileSync("git", ["init", "--bare", "-b", "master", origin], { windowsHide: true });
  execFileSync("git", ["clone", "-q", origin, dev], { windowsHide: true });
  git(dev, "checkout", "-q", "-b", "master");
  fs.writeFileSync(path.join(dev, "app.txt"), "one\n");
  git(dev, "add", "."); git(dev, "commit", "-q", "-m", "first");
  git(dev, "push", "-q", "-u", "origin", "master");
  execFileSync("git", ["clone", "-q", origin, host], { windowsHide: true });

  return {
    root, dev, host,
    push(message, file = "app.txt") {
      fs.appendFileSync(path.join(dev, file), `${message}\n`);
      git(dev, "add", "."); git(dev, "commit", "-q", "-m", message);
      git(dev, "push", "-q", "origin", "master");
    },
    checker: () => createGitUpdateChecker(host, { deployBranch: "master" }),
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); }
  };
}

test("a host on the deploy branch sees what master gained, with the commit subjects", async () => {
  const w = makeWorld();
  try {
    w.push("Add cost check");
    w.push("Fix launch pad");
    const s = await w.checker().refresh();
    assert.equal(s.updateAvailable, true);
    assert.equal(s.behind, 2);
    assert.equal(s.onDeployBranch, true);
    assert.equal(s.switchRequired, false);
    assert.equal(s.autoApplySafe, true);
    assert.equal(s.branch, "master");
    assert.equal(s.remote, "origin");
    assert.deepEqual(s.pendingCommits.map((c) => c.replace(/^\w+ /, "")), ["Fix launch pad", "Add cost check"]);
  } finally { w.cleanup(); }
});

test("an up-to-date host reports nothing to apply", async () => {
  const w = makeWorld();
  try {
    const s = await w.checker().refresh();
    assert.equal(s.updateAvailable, false);
    assert.equal(s.behind, 0);
    assert.deepEqual(s.pendingCommits, []);
    assert.equal(s.error, null);
  } finally { w.cleanup(); }
});

test("a merge to master is seen even though the host is resting on a feature branch", async () => {
  const w = makeWorld();
  try {
    git(w.host, "switch", "-q", "-c", "feature/x"); // fully merged: no commits of its own
    w.push("Merged feature");
    const s = await w.checker().refresh();
    assert.equal(s.currentBranch, "feature/x");
    assert.equal(s.updateAvailable, true);
    assert.equal(s.switchRequired, true);
    assert.equal(s.holdsUnmergedWork, false);
    assert.equal(s.autoApplySafe, true, "a fully merged branch can be left unattended");
  } finally { w.cleanup(); }
});

test("a host testing a branch with unmerged commits is never moved off it automatically", async () => {
  const w = makeWorld();
  try {
    git(w.host, "switch", "-q", "-c", "feature/testing");
    fs.writeFileSync(path.join(w.host, "wip.txt"), "wip\n");
    git(w.host, "add", "."); git(w.host, "commit", "-q", "-m", "work in progress");
    w.push("Unrelated master change");

    const s = await w.checker().refresh();
    assert.equal(s.updateAvailable, true, "the operator can still choose to apply it");
    assert.equal(s.holdsUnmergedWork, true);
    assert.equal(s.autoApplySafe, false, "but an unattended run must not discard the branch being tested");
    assert.equal(s.ahead, 1);
  } finally { w.cleanup(); }
});

test("a feature branch ahead of master with master unchanged has nothing to apply", async () => {
  const w = makeWorld();
  try {
    git(w.host, "switch", "-q", "-c", "feature/testing");
    fs.writeFileSync(path.join(w.host, "wip.txt"), "wip\n");
    git(w.host, "add", "."); git(w.host, "commit", "-q", "-m", "work in progress");
    const s = await w.checker().refresh();
    assert.equal(s.updateAvailable, false);
    assert.equal(s.holdsUnmergedWork, true);
  } finally { w.cleanup(); }
});

test("only tracked changes block an update; stray untracked files do not", async () => {
  const w = makeWorld();
  try {
    w.push("Upstream change");
    fs.writeFileSync(path.join(w.host, "scratch.log"), "noise\n");
    let s = await w.checker().refresh();
    assert.equal(s.localChanges, false, "an untracked file cannot be lost by a fast-forward");
    assert.equal(s.updateAvailable, true);

    fs.appendFileSync(path.join(w.host, "app.txt"), "local edit\n");
    s = await w.checker().refresh();
    assert.equal(s.localChanges, true);
    assert.deepEqual(s.dirtyFiles.map((f) => f.trim()), ["M app.txt"]);
  } finally { w.cleanup(); }
});

test("a deploy branch that has diverged from the remote cannot be fast-forwarded", async () => {
  const w = makeWorld();
  try {
    fs.appendFileSync(path.join(w.host, "app.txt"), "host-only\n");
    git(w.host, "commit", "-q", "-am", "host-only commit");
    w.push("Upstream change");
    const s = await w.checker().refresh();
    assert.equal(s.diverged, true);
    assert.equal(s.updateAvailable, false);
    assert.match(s.error, /cannot be fast-forwarded/);
  } finally { w.cleanup(); }
});

test("a missing deploy branch is reported plainly instead of as a Git error", async () => {
  const w = makeWorld();
  try {
    const s = await createGitUpdateChecker(w.host, { deployBranch: "release" }).refresh();
    assert.equal(s.updateAvailable, false);
    assert.match(s.error, /origin\/release does not exist/);
  } finally { w.cleanup(); }
});

test("the deploy branch defaults to master and can be set, but only to a safe name", () => {
  assert.equal(resolveDeployBranch({}), "master");
  assert.equal(resolveDeployBranch({ OPTILENS_UPDATE_BRANCH: "release/2026" }), "release/2026");
  assert.equal(resolveDeployBranch({ OPTILENS_UPDATE_BRANCH: "x; rm -rf /" }), "master");
});

test("classifies non-interactive Git credential failures for operator alerting", async () => {
  const checker = createGitUpdateChecker("C:/project", {
    run: async (args) => {
      if (args[0] === "rev-parse") return { stdout: "master\n" };
      const error = new Error("git fetch failed");
      error.stderr = "fatal: could not read Username for 'https://example.invalid': terminal prompts disabled";
      throw error;
    }
  });

  const status = await checker.refresh();
  assert.equal(status.authorizationRequired, true);
  assert.match(status.error, /terminal prompts disabled/);
  assert.equal(isGitAuthorizationFailure("network timeout"), false);
});
