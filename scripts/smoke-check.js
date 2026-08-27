// Fast, blocking pre-flight gate for apply-local-update.ps1. Replaces the
// full test suite as the thing standing between a pull and a restart: this
// checks that every changed JS file parses and that the new code can reach
// both databases, in a couple of seconds instead of 30+.
//
// The full test suite still runs (see apply-local-update.ps1), but as an
// advisory, non-blocking check — a flaky or unrelated test failure should
// not by itself keep a healthy change from going live.
//
// Usage: node scripts/smoke-check.js [fromRevision toRevision]
// Exits 0 and prints a JSON summary on success; exits 1 on failure.

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { checkAppDatabase, checkSourceDatabase } = require("../lib/db");

const projectRoot = path.join(__dirname, "..");
const [fromRevision, toRevision] = process.argv.slice(2);

function changedJsFiles() {
  if (!fromRevision || !toRevision) return ["server.js"];
  try {
    const output = execFileSync(
      "git",
      ["-c", `safe.directory=${projectRoot}`, "-C", projectRoot, "diff", "--name-only", "--diff-filter=d", fromRevision, toRevision],
      { encoding: "utf8", windowsHide: true }
    );
    const files = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.endsWith(".js"));
    return files.length ? [...new Set(["server.js", ...files])] : ["server.js"];
  } catch {
    return ["server.js"];
  }
}

function checkSyntax(files) {
  const failures = [];
  for (const file of files) {
    try {
      execFileSync("node", ["--check", file], { cwd: projectRoot, windowsHide: true, stdio: "pipe" });
    } catch (error) {
      failures.push({ file, detail: String(error.stderr || error.message).trim().slice(0, 500) });
    }
  }
  return failures;
}

async function main() {
  const files = changedJsFiles();
  const syntaxFailures = checkSyntax(files);
  const [appDatabase, sourceDatabase] = await Promise.all([checkAppDatabase(), checkSourceDatabase()]);

  const result = {
    checkedAt: new Date().toISOString(),
    filesChecked: files,
    syntaxFailures,
    appDatabase,
    sourceDatabase,
    ok: syntaxFailures.length === 0 && appDatabase.state === "online" && sourceDatabase.state === "online"
  };

  process.stdout.write(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
