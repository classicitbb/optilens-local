# Remote Agent Operations

This document is the operational runbook for agents working from a machine
other than the OptiLens host. It applies only to the authoritative host
checkout:

`C:\Users\Administrator\Documents\GitHub\optilens-local`

Do not use `C:\DEV\optilens-local`. That checkout is for human work only and
may have stale or uncommitted changes.

## Remote access

Use SSH to execute commands on the host without an interactive desktop or LAN
file-share session:

```powershell
ssh Administrator@ino-3frc3q3
ssh Administrator@ino-3frc3q3 "Set-Location 'C:\Users\Administrator\Documents\GitHub\optilens-local'; git status --short"
```

Use SSH keys or the approved credential manager. Never place a password,
private key, token, or connection string in agent instructions, source files,
shell history, or Git.

For a Windows remoting environment that is already configured and authorized,
the equivalent PowerShell form is:

```powershell
Invoke-Command -ComputerName ino-3frc3q3 -ScriptBlock {
  Set-Location 'C:\Users\Administrator\Documents\GitHub\optilens-local'
  git status --short
}
```

Do not enable or configure PowerShell remoting merely to perform a change; use
SSH when remoting is not already available. The SMB share is read-only context
for agents and is not an editing or deployment channel.

## Change and deployment sequence

Before editing, inspect the host branch and worktree. Do not overwrite or
discard unrelated changes. Work on a feature branch and run the relevant
checks. After a verified code change, agents have standing authorization on
the host checkout to commit the scoped change with a clear message and make a
normal, non-force push of that branch to its configured shared remote. Never
force-push, push unrelated work, or use a push to bypass review protections.

Typical host-side Git sequence:

```powershell
git switch -c feature/<scoped-change>
# edit and validate only the intended files
git add <intended-files>
git commit -m "Describe the scoped change"
git push -u origin feature/<scoped-change>
```

For a host-local deployment of the checked-out revision:

```powershell
Set-Location 'C:\Users\Administrator\Documents\GitHub\optilens-local'
npm test
npm run app:restart
node scripts/monitor-harness.js verify
```

For a deployment that must first fast-forward the host from a shared remote,
use the guarded update script instead of manually pulling and restarting:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/apply-local-update.ps1 -PullGit -GitRemote origin -GitBranch <branch>
node scripts/monitor-harness.js verify
```

The guarded script refuses a dirty checkout, installs production dependencies,
runs syntax checks and tests, applies requested migrations, restarts the app,
and re-kicks the host monitor and watchdog task.

## Health recovery

Every deployment must end with a successful health check. `verify` requires
both the app health endpoint and the host monitor to be healthy. If a normal
restart does not restore health, run the controlled repair once, then verify:

```powershell
Set-Location 'C:\Users\Administrator\Documents\GitHub\optilens-local'
node scripts/monitor-harness.js repair
node scripts/monitor-harness.js verify
```

If repair fails, preserve the logs and report the failure; do not repeatedly
restart, reset the checkout, or run business-data sync tasks. Review
`data\host-repair.log` and `data\local-update.log` for the failure context.

Scheduled data syncs and source-system write-back remain outside this standing
authorization.
