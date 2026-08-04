const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function runHostScript(projectRoot, scriptName, args = []) {
  const scriptPath = path.join(projectRoot, "scripts", scriptName);
  if (!scriptPath.startsWith(path.join(projectRoot, "scripts") + path.sep)) {
    throw new Error("Invalid host script path.");
  }
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Host script is missing: ${scriptName}`);
  }

  const child = spawn(powershell, [
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    ...args,
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: projectRoot,
  });
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

module.exports = { powershell, runHostScript, runHostScriptAndCapture, tailTextFile };
