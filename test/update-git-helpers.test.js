const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

/* The git steps of scripts/apply-local-update.ps1, run for real in PowerShell against throwaway
   repositories. Windows only: the updater is a Windows host tool. */

const helpers = path.join(__dirname, "..", "scripts", "update-git-helpers.ps1");
const windows = process.platform === "win32";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
    encoding: "utf8", windowsHide: true
  }).trim();
}

function makeWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-ps-"));
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
    push(message) {
      fs.appendFileSync(path.join(dev, "app.txt"), `${message}\n`);
      git(dev, "add", "."); git(dev, "commit", "-q", "-m", message);
      git(dev, "push", "-q", "origin", "master");
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); }
  };
}

/** Runs a PowerShell snippet with the helpers loaded; the snippet's last output is returned. */
function ps(world, body) {
  const script = path.join(world.root, `step-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(script, `$ErrorActionPreference = "Stop"\n. '${helpers}'\n$Root = '${world.host}'\n${body}\n`);
  return execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
    encoding: "utf8", windowsHide: true
  }).trim();
}

test("tracked changes are reported and untracked files are ignored", { skip: !windows }, () => {
  const w = makeWorld();
  try {
    fs.writeFileSync(path.join(w.host, "stray.log"), "noise\n");
    assert.equal(ps(w, "Get-TrackedChanges $Root"), "");
    fs.appendFileSync(path.join(w.host, "app.txt"), "edit\n");
    assert.match(ps(w, "Get-TrackedChanges $Root"), /M app\.txt/);
  } finally { w.cleanup(); }
});

test("a host already on the deploy branch is not switched", { skip: !windows }, () => {
  const w = makeWorld();
  try {
    const out = ps(w, `$s = Enter-DeployBranch $Root 'origin' 'master'; "$($s.Switched)"`);
    assert.equal(out, "False");
    assert.equal(git(w.host, "rev-parse", "--abbrev-ref", "HEAD"), "master");
  } finally { w.cleanup(); }
});

test("an update from a feature branch moves to master, and a failure puts everything back", { skip: !windows }, () => {
  const w = makeWorld();
  try {
    const masterBefore = git(w.host, "rev-parse", "master");
    git(w.host, "switch", "-q", "-c", "feature/x");
    const featureBefore = git(w.host, "rev-parse", "HEAD");
    w.push("Upstream change");
    git(w.host, "fetch", "-q", "origin");

    // The update (switch to master, fast-forward it) and then its failure, in one process
    // because the recorded state only lives as long as the updater run.
    const out = ps(w, `
      $s = Enter-DeployBranch $Root 'origin' 'master'
      git -C $Root merge --ff-only origin/master | Out-Null
      $during = (git -C $Root rev-parse --abbrev-ref HEAD)
      $ok = Restore-GitState $Root $s
      "$($s.Switched)|$during|$ok|$(git -C $Root rev-parse --abbrev-ref HEAD)"
    `);
    assert.equal(out, "True|master|True|feature/x");
    assert.equal(git(w.host, "rev-parse", "HEAD"), featureBefore, "the feature branch is where it was");
    assert.equal(git(w.host, "rev-parse", "master"), masterBefore, "master is back where it was, not left advanced");
  } finally { w.cleanup(); }
});

test("a deploy branch that did not exist locally is created for the update and removed on restore", { skip: !windows }, () => {
  const w = makeWorld();
  try {
    git(w.host, "switch", "-q", "-c", "feature/x");
    git(w.host, "branch", "-q", "-D", "master");
    const out = ps(w, `
      $s = Enter-DeployBranch $Root 'origin' 'master'
      $created = (git -C $Root rev-parse --abbrev-ref HEAD)
      $ok = Restore-GitState $Root $s
      "$created|$ok|$(git -C $Root rev-parse --abbrev-ref HEAD)|$(git -C $Root branch --list master)"
    `);
    assert.equal(out, "master|True|feature/x|");
  } finally { w.cleanup(); }
});

test("a detached checkout is restored to the same commit", { skip: !windows }, () => {
  const w = makeWorld();
  try {
    git(w.host, "switch", "-q", "--detach");
    const before = git(w.host, "rev-parse", "HEAD");
    const out = ps(w, `
      $s = Enter-DeployBranch $Root 'origin' 'master'
      $ok = Restore-GitState $Root $s
      "$($s.Detached)|$ok|$(git -C $Root rev-parse --abbrev-ref HEAD)"
    `);
    assert.equal(out, "True|True|HEAD");
    assert.equal(git(w.host, "rev-parse", "HEAD"), before);
  } finally { w.cleanup(); }
});

test("with no switch, a failed update resets to the original revision", { skip: !windows }, () => {
  const w = makeWorld();
  try {
    const before = git(w.host, "rev-parse", "HEAD");
    w.push("Upstream change");
    git(w.host, "fetch", "-q", "origin");
    ps(w, `
      $s = Enter-DeployBranch $Root 'origin' 'master'
      git -C $Root merge --ff-only origin/master | Out-Null
      Restore-GitState $Root $s | Out-Null
    `);
    assert.equal(git(w.host, "rev-parse", "HEAD"), before);
  } finally { w.cleanup(); }
});

test("the guarded updater is wired to those helpers", () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "apply-local-update.ps1"), "utf8");
  assert.match(script, /\. \(Join-Path \$PSScriptRoot "update-git-helpers\.ps1"\)/);
  assert.match(script, /Get-TrackedChanges \$ProjectRoot/);
  assert.match(script, /Enter-DeployBranch \$ProjectRoot \$GitRemote \$GitBranch/);
  assert.match(script, /Restore-GitState \$ProjectRoot \$script:gitState/);
  assert.doesNotMatch(script, /reset --hard \$originalRevision \*>> \$logFile\n\s+if \(\$LASTEXITCODE -ne 0\) \{ throw "Rollback/, "rollback must use the shared restore");
});

test("the host monitor is rebuilt only when its source changed, and no longer killed on every update", () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "apply-local-update.ps1"), "utf8");
  assert.match(script, /function Update-HostMonitor/);
  assert.match(script, /monitor-build\.hash/);
  assert.match(script, /build-monitor-exe\.ps1/);
  assert.equal((script.match(/Stop-Process/g) || []).length, 1, "the only monitor stop is inside the rebuild");
});
