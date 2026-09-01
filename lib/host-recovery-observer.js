"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { tailTextFile, runHostScript } = require("./host-control");

function createHostRecoveryObserver({ projectRoot, dataDir }) {
  const auditFile = path.join(dataDir, "host-recovery-actions.jsonl");
  const repairLog = path.join(dataDir, "host-repair.log");
  const updateLog = path.join(dataDir, "local-update.log");
  const updateStatusFile = path.join(dataDir, "update-status.json");
  const serverLog = path.join(projectRoot, "server.err.log");

  // apply-local-update.ps1 treats the full test suite as advisory: a
  // failure there no longer blocks the update itself (see
  // scripts/smoke-check.js for what does block). This reads the pipeline's
  // own structured verdict instead of grepping raw TAP output for "not ok" /
  // "# fail", which would otherwise misreport an advisory failure as a
  // blocking one.
  function readUpdateStatus() {
    try {
      return JSON.parse(fs.readFileSync(updateStatusFile, "utf8"));
    } catch {
      return null;
    }
  }

  function inspect() {
    const logs = [updateLog, repairLog, serverLog].map((file) => tailTextFile(file, 65536));
    // Historical failures remain useful evidence but must not permanently
    // block recovery. Logs are append-only, so select timestamped records from
    // a short active window rather than relying on each file's modification time.
    const activeWindowMinutes = 5;
    const activeAfter = Date.now() - (activeWindowMinutes * 60 * 1000);
    const serverErrorLog = logs.find((log) => log.path === serverLog);
    // server.err.log is append-only. A boot separator lets us inspect only the
    // currently running Node instance without deleting historical evidence.
    const bootMarker = "OptiLens recovery observer boot ";
    const markerIndex = serverErrorLog ? serverErrorLog.text.lastIndexOf(bootMarker) : -1;
    const currentServerText = markerIndex >= 0 ? serverErrorLog.text.slice(markerIndex) : "";
    const recentRecords = logs.filter((log) => log.path !== serverLog).map((log) => {
      return log.text.split(/\r?\n/).filter((line) => {
        const match = line.match(/^(\d{4}-\d\d-\d\dT[^ ]+)\s/);
        return match && Date.parse(match[1]) >= activeAfter;
      }).join("\n");
    });
    const text = recentRecords.concat(currentServerText).join("\n");
    const findings = [];

    if (/EADDRINUSE|address already in use/i.test(text)) {
      findings.push({ code: "port-in-use", severity: "error", title: "Port 8080 collision", repair: "controlled-restart", detail: "A Node process could not bind its listening port." });
    }
    if (/Key not valid for use in specified state|DataProtectionScope|Unprotect/i.test(text)) {
      findings.push({ code: "dpapi-profile-mismatch", severity: "warning", title: "Protected credential is unavailable to the service account", repair: "manual-credential-recapture", detail: "A Windows-protected value was encrypted for a different account. It cannot be safely rewritten without the original credential." });
    }
    if (/Update failed:|Repair failed:/i.test(text) && findings.length === 0) {
      findings.push({ code: "unclassified-host-failure", severity: "error", title: "Unclassified host recovery failure", repair: "controlled-restart", detail: "Review the captured update and repair logs before changing code or configuration." });
    }

    // Added after the fallback check above, on purpose: this is advisory
    // evidence, not an explanation for an update/repair failure, so it must
    // not suppress the generic fallback finding the way port-in-use or
    // dpapi-mismatch legitimately do.
    const updateStatus = readUpdateStatus();
    if (updateStatus?.testSuite?.ran && updateStatus.testSuite.passed === false) {
      // Severity "warning" so it never flips `healthy` to false or blocks
      // the superuser-fix path (repair is not "none" / "manual-credential-recapture").
      findings.push({ code: "advisory-test-failures", severity: "warning", title: "Full test suite has failures (advisory)", repair: "informational", detail: "The last update went live because it passed the fast smoke check; the full test suite reported failures separately. Review data/local-update.log for detail." });
    }

    return {
      checkedAt: new Date().toISOString(),
      activeLogWindowMinutes: activeWindowMinutes,
      healthy: findings.every((finding) => finding.severity !== "error"),
      findings,
      logs: logs.map((log) => ({ path: path.relative(projectRoot, log.path).replaceAll("\\", "/"), updatedAt: log.updatedAt, exists: log.exists })),
      proposal: {
        sourceEdits: [],
        message: findings.some((finding) => finding.repair === "manual-credential-recapture")
          ? "No source files were changed. A privileged operator must re-save the protected credential under the service account policy."
          : "No source files were changed automatically. Reviewable code changes must be made through the normal branch, test, and deployment flow."
      }
    };
  }

  function audit(action, outcome, details = {}) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(auditFile, `${JSON.stringify({ at: new Date().toISOString(), action, outcome, ...details })}\n`);
  }

  function runSuperuserFix({ actor = "local-superuser", failedConnections = [] } = {}) {
    const report = inspect();
    const blocked = report.findings.filter((finding) => finding.repair === "manual-credential-recapture" || finding.repair === "none");
    if (blocked.length) {
      audit("superuser-fix", "blocked", { actor, findings: blocked.map((finding) => finding.code) });
      const error = new Error(`Automatic repair is blocked: ${blocked.map((finding) => finding.title).join("; ")}. See the recovery report for the required manual action.`);
      error.statusCode = 409;
      throw error;
    }
    const result = runHostScript(projectRoot, "repair-host.ps1", [
      "-ProjectRoot", projectRoot,
      "-Reason", "Privileged host recovery command",
      "-FailedConnections", failedConnections.map(String).slice(0, 20).join(", ")
    ]);
    audit("superuser-fix", "started", { actor, findings: report.findings.map((finding) => finding.code), pid: result.pid });
    return { ok: true, message: "Privileged controlled repair started. The recovery report will retain its output and any manual recommendations.", pid: result.pid, report };
  }

  return { inspect, runSuperuserFix };
}

module.exports = { createHostRecoveryObserver };
