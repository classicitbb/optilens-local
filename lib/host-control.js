const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

// Starts a PowerShell script that must outlive this process (an update stops this very service).
//
// Node's `detached: true` is not usable for this on the host: a detached powershell.exe exits
// with code 0 after ~80 ms without running its script, so the update runner silently never
// started. A normal child would also be killed with the service's process tree. Win32_Process
// Create starts the script as an independent process outside both, and reports a real failure
// instead of vanishing. The short-lived launcher's output goes to `logFile` when given.
function launchIndependent(powershellArgs, { cwd, logFile } = {}) {
  // Only values that need it are quoted: powershell.exe does not treat a quoted "-File" as a switch.
  const quote = (value) => (/[\s"]/.test(String(value)) ? `"${String(value).replace(/"/g, '\\"')}"` : String(value));
  const commandLine = [quote(powershell), ...powershellArgs.map(quote)].join(" ");
  const launcher = "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:OPTILENS_LAUNCH_COMMAND; CurrentDirectory = $env:OPTILENS_LAUNCH_CWD }; " +
    "if ($r.ReturnValue -ne 0) { Write-Error \"Win32_Process.Create returned $($r.ReturnValue)\"; exit 1 }; Write-Output \"started pid $($r.ProcessId)\"";
  let fd = "ignore";
  if (logFile) { try { fd = fs.openSync(logFile, "a"); } catch { /* output is best effort */ } }
  try {
    const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", launcher], {
      cwd,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
      env: { ...process.env, OPTILENS_LAUNCH_COMMAND: commandLine, OPTILENS_LAUNCH_CWD: cwd || process.cwd() }
    });
    return child;
  } finally {
    if (fd !== "ignore") { try { fs.closeSync(fd); } catch { /* the child holds its own handle */ } }
  }
}

function runHostScript(projectRoot, scriptName, args = []) {
  const scriptPath = path.join(projectRoot, "scripts", scriptName);
  if (!scriptPath.startsWith(path.join(projectRoot, "scripts") + path.sep)) {
    throw new Error("Invalid host script path.");
  }
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Host script is missing: ${scriptName}`);
  }

  const child = launchIndependent([
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    ...args,
  ], { cwd: projectRoot, logFile: path.join(projectRoot, "data", "host-script-launch.log") });
  child.unref();
  return { pid: child.pid };
}

function runHostScriptAndCapture(projectRoot, scriptName, args = []) {
  const scriptPath = path.join(projectRoot, "scripts", scriptName);
  if (!fs.existsSync(scriptPath)) throw new Error(`Host script is missing: ${scriptName}`);
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args], {
      cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ pid: child.pid }) : reject(new Error(stderr.trim() || `Host script exited with ${code}.`)));
  });
}

function tailTextFile(filePath, maxBytes = 65536) {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return {
        exists: true,
        path: filePath,
        size,
        updatedAt: stat.mtime.toISOString(),
        truncated: start > 0,
        text: buffer.toString("utf8"),
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { exists: false, path: filePath, size: 0, updatedAt: null, truncated: false, text: "" };
  }
}

module.exports = { powershell, launchIndependent, runHostScript, runHostScriptAndCapture, tailTextFile };
