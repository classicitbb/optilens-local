# AI Agent Monitor & Service Harness

This document describes the unified harness for any AI agent (Claude, Codex, Antigravity, Gemini, or custom automation scripts) to programmatically inspect, start, stop, restart, repair, and verify the OptiLens Local host monitor and background Node service.

---

## Quick Reference Commands

Agents can run the harness via `npm` or `node`:

```bash
# Check status (JSON or human-readable format)
npm run app:monitor:harness -- status
npm run app:monitor:harness -- status --json

# Ensure both Node service and OptiLensHostMonitor tray process are running
npm run app:monitor:harness -- start

# Restart Node service, verify JS syntax, and re-kick monitor tray process
npm run app:monitor:harness -- restart

# Bring host monitor window to foreground
npm run app:monitor:harness -- show

# Trigger controlled self-heal repair script
npm run app:monitor:harness -- repair

# Perform automated assertion check (exit 0 if healthy, exit 1 if failing)
npm run app:monitor:harness -- verify
```

---

## Agent Integration Rules & Workflow

When an AI agent makes changes or updates to OptiLens Local:

1. **Verification**: Run `npm run app:monitor:harness -- verify` to assert that Node and the monitor tray process are responding cleanly.
2. **Post-commit Restart**: Relaunch or restart using `npm run app:monitor:harness -- restart`.
3. **Self-Heal**: If a connection fails or service goes offline, run `npm run app:monitor:harness -- repair`.
4. **Interactive Tray**: To verify the interactive monitor tray UI is active, run `npm run app:monitor:harness -- start` or `npm run app:monitor:harness -- show`.

---

## Harness Architecture

- **CLI Harness**: `scripts/monitor-harness.js`
- **Tray Monitor Executable**: `OptiLensHostMonitor.exe` (built from `scripts/OptiLensHostMonitorLauncher.cs`)
- **60-Second Watchdog**: `scripts/ensure-app-running.ps1`
- **Service Control**: `scripts/start-app.ps1`, `scripts/stop-app.ps1`, `scripts/restart-app.ps1`
- **Self-Heal Tooling**: `scripts/repair-host.ps1`, `/api/monitor/repair`
