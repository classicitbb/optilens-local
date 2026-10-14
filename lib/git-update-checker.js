const { execFile } = require("node:child_process");

const GIT_CHECK_TIMEOUT_MS = 30000;
const DEFAULT_DEPLOY_BRANCH = "master";
const MAX_LISTED = 8;

/**
 * The branch the host runs. Updates follow this branch, not whichever branch happens to be
 * checked out: an agent or developer leaving the host on a feature branch must not hide a
 * merge to master from the monitor, and a merge must not need anyone to switch branches first.
 */
function resolveDeployBranch(env = process.env) {
  const configured = String(env.OPTILENS_UPDATE_BRANCH || "").trim();
  return /^[A-Za-z0-9._/-]+$/.test(configured) ? configured : DEFAULT_DEPLOY_BRANCH;
}

function gitFailureDetail(error) {
  return [error?.message, error?.stderr, error?.stdout]
    .filter(Boolean)
    .join("\n")
    .trim() || "Git update check failed.";
}

function isGitAuthorizationFailure(detail) {
  return /authentication failed|authorization failed|could not read (username|password)|terminal prompts disabled|permission denied|access denied|http[s]?:.*\b(401|403)\b|authentication is required/i.test(String(detail || ""));
}

function runGit(projectRoot, args) {
  return new Promise((resolve, reject) => {
    const child = execFile("git", [
      "-c", `safe.directory=${projectRoot}`,
      "-c", "credential.helper=",
      "-C", projectRoot,
      ...args
    ], {
      windowsHide: true,
      timeout: GIT_CHECK_TIMEOUT_MS,
      killSignal: "SIGTERM",
      env: {
        ...process.env,
        // A background health/update check must never open Git Credential
        // Manager or wait for a terminal prompt. It should fail cleanly.
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never"
      }
    }, (error, stdout, stderr) => {
      if (error) {
        // Node's execFile timeout kills git.exe, but Windows may leave its
        // git-remote-https.exe descendants behind. Kill the complete tree.
        if (error.killed && child.pid && process.platform === "win32") {
          execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true
          }, () => {});
        }
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function lines(output) {
  return String(output || "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

function createGitUpdateChecker(projectRoot, options = {}) {
  const run = options.run || ((args) => runGit(projectRoot, args));
  const deployBranch = options.deployBranch || resolveDeployBranch();

  let status = {
    configured: null,
    checking: false,
    checkedAt: null,
    updateAvailable: false,
    localChanges: false,
    error: null
  };
  let refreshInFlight = null;

  async function remoteName() {
    if (options.remote) return options.remote;
    // The current branch's upstream names the remote the checkout was cloned from; a branch
    // with no upstream (or a detached HEAD) falls back to the conventional name.
    try {
      const upstream = (await run(["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim();
      const separator = upstream.indexOf("/");
      if (separator > 0) return upstream.slice(0, separator);
    } catch {
      /* no upstream configured */
    }
    return "origin";
  }

  async function refresh() {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      status = { ...status, checking: true, error: null };
      try {
        const currentBranch = (await run(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
        const remote = await remoteName();
        const target = `${remote}/${deployBranch}`;

        await run(["fetch", "--quiet", remote]);
        try {
          await run(["rev-parse", "--verify", "--quiet", `${target}^{commit}`]);
        } catch {
          status = {
            ...status,
            configured: false,
            checking: false,
            checkedAt: new Date().toISOString(),
            updateAvailable: false,
            error: `The deploy branch ${target} does not exist on the remote.`
          };
          return status;
        }

        const [ahead = 0, behind = 0] = (await run(["rev-list", "--left-right", "--count", `HEAD...${target}`]))
          .stdout.trim().split(/\s+/).map(Number);
        // Tracked changes only. Untracked files never block a fast-forward by themselves; Git
        // refuses, safely, if an incoming file would overwrite one.
        const dirtyFiles = lines((await run(["status", "--porcelain", "--untracked-files=no"])).stdout);
        const pending = behind > 0
          ? lines((await run(["log", "--format=%h %s", "-n", String(MAX_LISTED), `HEAD..${target}`])).stdout)
          : [];

        const onDeployBranch = currentBranch === deployBranch;
        // On the deploy branch an update must fast-forward. Anywhere else the host is switched
        // to the deploy branch, which is only a pure move forward when nothing is lost.
        const diverged = onDeployBranch && ahead > 0 && behind > 0;
        const updateAvailable = behind > 0 && !diverged;
        const holdsUnmergedWork = !onDeployBranch && ahead > 0;

        status = {
          configured: true,
          checking: false,
          checkedAt: new Date().toISOString(),
          remote,
          branch: deployBranch,
          currentBranch,
          onDeployBranch,
          upstream: target,
          behind,
          ahead,
          updateAvailable,
          // Unattended applies must not walk the host off a branch that carries commits the
          // deploy branch does not have (a branch someone is testing on the host).
          autoApplySafe: updateAvailable && !holdsUnmergedWork,
          switchRequired: updateAvailable && !onDeployBranch,
          holdsUnmergedWork,
          diverged,
          pendingCommits: pending,
          localChanges: dirtyFiles.length > 0,
          dirtyFiles: dirtyFiles.slice(0, 10),
          error: diverged
            ? `${deployBranch} on this host has ${ahead} commit(s) that ${target} does not, so it cannot be fast-forwarded.`
            : null
        };
      } catch (error) {
        const detail = gitFailureDetail(error);
        status = {
          ...status,
          checking: false,
          checkedAt: new Date().toISOString(),
          updateAvailable: false,
          error: detail,
          authorizationRequired: isGitAuthorizationFailure(detail)
        };
      }
      return status;
    })();

    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  return {
    getStatus: () => ({ ...status }),
    refresh
  };
}

module.exports = {
  createGitUpdateChecker,
  gitFailureDetail,
  isGitAuthorizationFailure,
  resolveDeployBranch,
  DEFAULT_DEPLOY_BRANCH
};
