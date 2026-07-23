const { execFileSync } = require("node:child_process");
const path = require("node:path");

const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const protectionScript = path.join(__dirname, "..", "scripts", "protect-local-data.ps1");

function protectString(value) {
  return runProtection("Protect", String(value));
}

function unprotectString(value) {
  return Buffer.from(runProtection("Unprotect", String(value)), "base64").toString("utf8");
}

function runProtection(mode, value) {
  const input = mode === "Protect"
    ? Buffer.from(String(value), "utf8").toString("base64")
    : String(value);
  return execFileSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", protectionScript,
    "-Mode", mode
  ], {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 1024 * 1024
  }).trim();
}

module.exports = { protectString, unprotectString };
