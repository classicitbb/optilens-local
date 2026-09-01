// Scopes a git-based update to what actually changed between two revisions,
// so apply-local-update.ps1 stops forcing a full npm ci + migration run on
// every pull regardless of whether either was touched.
//
// Usage: node scripts/plan-update-scope.js <fromRevision> <toRevision>
// Prints a JSON plan to stdout: { changedAreas, restartService, installDependencies, runMigrations }

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { planForChangedPaths } = require("../lib/update-manager");

const [fromRevision, toRevision] = process.argv.slice(2);
if (!fromRevision || !toRevision) {
  process.stderr.write("Usage: node scripts/plan-update-scope.js <fromRevision> <toRevision>\n");
  process.exit(2);
}

const projectRoot = path.join(__dirname, "..");

try {
  const output = execFileSync(
    "git",
    ["-c", `safe.directory=${projectRoot}`, "-C", projectRoot, "diff", "--name-only", fromRevision, toRevision],
    { encoding: "utf8", windowsHide: true }
  );
  const changedPaths = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const plan = planForChangedPaths(changedPaths);
  process.stdout.write(JSON.stringify({ ...plan, changedPathCount: changedPaths.length }));
} catch (error) {
  process.stderr.write(`Could not diff ${fromRevision}..${toRevision}: ${error.message}\n`);
  process.exit(1);
}
