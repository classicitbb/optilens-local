# Procedure: Remote Agent Deployment and Health Recovery

> Goal: Safely make a verified agent change in the authoritative host checkout, deploy it, and leave the OptiLens service and host monitor healthy.
> Created: 2026-08-20

## Context & Inputs

- **Host checkout**: `C:\Users\Administrator\Documents\GitHub\optilens-local`
- **Remote access**: SSH to `Administrator@ino-3frc3q3`, or PowerShell remoting only when it is already configured and authorized.
- **Excluded checkout**: `C:\DEV\optilens-local` is human-only; automated agents must not use it.
- **Credentials**: SSH keys or approved credential storage only. Never record credentials in Git, instructions, or shell history.

## Step-by-Step Instructions

1. Connect to the host and change to the authoritative checkout.
2. Inspect the branch and worktree. Preserve unrelated changes; never reset or overwrite them.
3. Create or select a scoped feature branch, implement the requested change, and run relevant validation.
4. Commit only intended files with a clear message and push the branch with a normal, non-force push.
5. For the checked-out revision, run `npm test`, `npm run app:restart`, and `node scripts/monitor-harness.js verify`.
6. If deploying a branch that must first be fast-forwarded on a target checkout, use `scripts/apply-local-update.ps1 -PullGit -GitRemote origin -GitBranch <branch>` and then run the harness verification.
7. If verification fails, run `node scripts/monitor-harness.js repair` once and verify again.
8. If repair still fails, preserve logs and report the failure. Do not repeatedly restart, reset Git, or run scheduled data synchronization tasks.

## Output Requirements

- **Git**: A scoped commit and normal non-force remote branch push.
- **Deployment**: The intended host checkout is running the verified revision.
- **Health**: `node scripts/monitor-harness.js verify` exits successfully; this requires both the service endpoint and the host monitor.
- **Failure evidence**: `data\host-repair.log` and `data\local-update.log` are retained when recovery fails.

## Verification

```powershell
Set-Location 'C:\Users\Administrator\Documents\GitHub\optilens-local'
node scripts/monitor-harness.js verify
```

See `docs/REMOTE_AGENT_OPERATIONS.md` for command examples and authorization boundaries.
