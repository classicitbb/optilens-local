const { execFile } = require("node:child_process");

const GIT_CHECK_TIMEOUT_MS = 30000;

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

function createGitUpdateChecker(projectRoot, options = {}) {
  const run = options.run || ((args) => runGit(projectRoot, args));

  let status = {
    configured: null,
    checking: false,
    checkedAt: null,
    updateAvailable: false,
    localChanges: false,
    error: null
  };
  let refreshInFlight = null;

  async function refresh() {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      status = { ...status, checking: true, error: null };
      try {
        const upstream = (await run(["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim();
        const separator = upstream.indexOf("/");
        const remote = separator > 0 ? upstream.slice(0, separator) : "";
        const branch = separator > 0 ? upstream.slice(separator + 1) : "";
        if (!remote || !branch) {
          status = {
            ...status,
            configured: false,
            checking: false,
            checkedAt: new Date().toISOString(),
            updateAvailable: false,
            error: "No upstream Git branch is configured."
          };
          return status;
        }

        await run(["fetch", "--quiet", remote]);
        const count = (await run(["rev-list", "--left-right", "--count", `HEAD...${upstream}`])).stdout.trim().split(/\s+/).map(Number);
        const porcelain = (await run(["status", "--porcelain"])).stdout.trim();
        const [ahead = 0, behind = 0] = count;
        status = {
          configured: true,
          checking: false,
          checkedAt: new Date().toISOString(),
          remote,
          branch,
          upstream,
          behind,
          ahead,
          updateAvailable: behind > 0,
          localChanges: Boolean(porcelain),
          error: null
        };
      } catch (error) {
        status = {
          ...status,
          checking: false,
          checkedAt: new Date().toISOString(),
          updateAvailable: false,
          error: error.message || "Git update check failed."
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

module.exports = { createGitUpdateChecker };
