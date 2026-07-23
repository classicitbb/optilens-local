const assert = require("node:assert/strict");
const test = require("node:test");
const { createGitUpdateChecker } = require("../lib/git-update-checker");

test("reports a fetched upstream update and local worktree changes", async () => {
  const responses = new Map([
    ["rev-parse --abbrev-ref @{upstream}", "origin/master\n"],
    ["fetch --quiet origin", ""],
    ["rev-list --left-right --count HEAD...origin/master", "0\t2\n"],
    ["status --porcelain", " M server.js\n"]
  ]);
  const checker = createGitUpdateChecker("C:/project", {
    run: async (args) => ({ stdout: responses.get(args.join(" ")) || "" })
  });

  const status = await checker.refresh();
  assert.equal(status.updateAvailable, true);
  assert.equal(status.behind, 2);
  assert.equal(status.localChanges, true);
  assert.equal(status.remote, "origin");
  assert.equal(status.branch, "master");
});
