const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function createGitUpdateChecker(projectRoot, options = {}) {
  const run = options.run || ((args) => execFileAsync("git", ["-c", `safe.directory=${projectRoot}`, "-C", projectRoot, ...args], {
    windowsHide: true,
    timeout: 30000
  }));

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
