#!/usr/bin/env node

/**
 * OptiLens Local Host Monitor AI Agent Harness
 *
 * Unified CLI and SDK harness allowing any AI agent (Claude, Codex, Antigravity, custom subagents)
 * to inspect, start, stop, restart, repair, and verify the host monitor and background Node service.
 *
 * Usage:
 *   node scripts/monitor-harness.js <command> [--json] [--port 8080]
 *
 * Commands:
 *   status     Check Node service health, monitor process state, and listening ports.
 *   start      Ensure Node service and OptiLensHostMonitor process are running.
 *   stop       Shut down Node service and OptiLensHostMonitor.
 *   restart    Verify syntax, restart Node service, and re-kick host monitor process.
 *   show       Bring the host monitor window to foreground via show signal.
 *   repair     Trigger self-heal repair script for failed DB pools or services.
 *   verify     Automated health check assertion (exit 0 if healthy, exit 1 if failed).
 */

const http = require("node:http");
const { execSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const portIndex = args.indexOf("--port");
const port = portIndex !== -1 && args[portIndex + 1] ? Number(args[portIndex + 1]) : Number(process.env.OPTILENS_PORT || 8080);
const command = args.find((a) => !a.startsWith("--")) || "status";

async function fetchJson(urlPath, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}${urlPath}`, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ ok: res.statusCode === 200, data: JSON.parse(body), status: res.statusCode });
        } catch {
          resolve({ ok: false, data: body, status: res.statusCode });
        }
      });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
  });
}

function getRunningProcess(processName) {
  try {
    const output = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, Handles, WorkingSet64 | ConvertTo-Json"`,
      { encoding: "utf8" }
    ).trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function runPowerShellScript(scriptName, scriptArgs = "") {
  const scriptPath = path.join(projectRoot, "scripts", scriptName);
  if (!fs.existsSync(scriptPath)) throw new Error(`Script not found: ${scriptPath}`);
  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -ProjectRoot "${projectRoot}" -Port ${port} ${scriptArgs}`;
  return execSync(cmd, { cwd: projectRoot, encoding: "utf8" }).trim();
}

async function getHarnessStatus() {
  const healthResult = await fetchJson("/api/health");
  const monitorProcs = getRunningProcess("OptiLensHostMonitor");
  const nodeProcs = getRunningProcess("node");

  const isServiceLive = healthResult.ok && healthResult.data && healthResult.data.ok === true;
  const isMonitorLive = monitorProcs.length > 0;

  return {
    timestamp: new Date().toISOString(),
    service: {
      live: isServiceLive,
      port,
      health: healthResult.data || null,
      error: healthResult.error || null
    },
    hostMonitor: {
      running: isMonitorLive,
      pids: monitorProcs.map((p) => p.Id),
      exePath: path.join(projectRoot, "OptiLensHostMonitor.exe")
    },
    nodeProcesses: nodeProcs.map((p) => ({ id: p.Id, memoryMb: Math.round(p.WorkingSet64 / 1024 / 1024) })),
    healthy: isServiceLive && isMonitorLive
  };
}

async function main() {
  switch (command) {
    case "status": {
      const status = await getHarnessStatus();
      if (jsonMode) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log("=== OptiLens Local Agent Harness Status ===");
        console.log(`Node Service (port ${port}): ${status.service.live ? "HEALTHY (ONLINE)" : "DOWN"}`);
        console.log(`Host Monitor Tray Process:  ${status.hostMonitor.running ? `RUNNING (PID: ${status.hostMonitor.pids.join(", ")})` : "STOPPED"}`);
        if (status.service.health) {
          console.log(`Active App DB: ${status.service.health.appDatabase?.detail || "N/A"}`);
          console.log(`Active Source: ${status.service.health.activeSourceProfile || "N/A"}`);
        }
      }
      process.exit(status.healthy ? 0 : 1);
      break;
    }

    case "start": {
      console.log("[Harness] Ensuring Node service and Host Monitor are running...");
      const before = await getHarnessStatus();
      if (!before.service.live) {
        console.log("[Harness] Starting Node service...");
        runPowerShellScript("start-app.ps1");
      }
      if (!before.hostMonitor.running) {
        console.log("[Harness] Launching Host Monitor...");
        runPowerShellScript("start-monitor.ps1");
      }
      const after = await getHarnessStatus();
      if (jsonMode) console.log(JSON.stringify(after, null, 2));
      else console.log(`[Harness] Started cleanly. Service: ${after.service.live ? "ONLINE" : "OFFLINE"}, Host Monitor: ${after.hostMonitor.running ? "RUNNING" : "OFFLINE"}`);
      process.exit(after.healthy ? 0 : 1);
      break;
    }

    case "stop": {
      console.log("[Harness] Stopping OptiLens Local Node service and Host Monitor...");
      try {
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-Process -Name OptiLensHostMonitor -Force -ErrorAction SilentlyContinue"`, { cwd: projectRoot });
      } catch {}
      runPowerShellScript("stop-app.ps1", "-Intentional");
      console.log("[Harness] OptiLens Local shut down.");
      process.exit(0);
      break;
    }

    case "restart": {
      console.log("[Harness] Verifying syntax before restart...");
      execSync("node --check server.js", { cwd: projectRoot });
      execSync("node --check lib/config.js", { cwd: projectRoot });

      console.log("[Harness] Restarting application and tray monitor...");
      runPowerShellScript("restart-app.ps1");
      runPowerShellScript("ensure-app-running.ps1");

      const status = await getHarnessStatus();
      if (jsonMode) console.log(JSON.stringify(status, null, 2));
      else console.log(`[Harness] Restart complete. Service: ${status.service.live ? "ONLINE" : "OFFLINE"}, Monitor: ${status.hostMonitor.running ? "RUNNING" : "OFFLINE"}`);
      process.exit(status.healthy ? 0 : 1);
      break;
    }

    case "show": {
      console.log("[Harness] Sending signal to show Host Monitor window...");
      runPowerShellScript("start-monitor.ps1");
      console.log("[Harness] Monitor show signal sent.");
      process.exit(0);
      break;
    }

    case "repair": {
      console.log("[Harness] Executing controlled self-heal repair script...");
      runPowerShellScript("repair-host.ps1", `-Reason "Agent harness repair request"`);
      const status = await getHarnessStatus();
      process.exit(status.healthy ? 0 : 1);
      break;
    }

    case "verify": {
      const status = await getHarnessStatus();
      if (status.healthy) {
        console.log("[Harness Verification SUCCESS] All systems online.");
        process.exit(0);
      } else {
        console.error("[Harness Verification FAILURE]", JSON.stringify(status));
        process.exit(1);
      }
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      console.error("Valid commands: status | start | stop | restart | show | repair | verify");
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`[Harness Fatal Error] ${err.stack || err.message}`);
  process.exit(1);
});
