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

## Verified remote access inventory

Verified 2026-08-24 from controller `CLASSICMAIN` (`192.168.254.1`). SSH uses the controller-held Ed25519 key; its private material must remain in the controller user profile or approved credential storage and must never be copied into the repository, prompts, or logs.

| Host | Address | Verified SSH login | Scope |
| --- | --- | --- | --- |
| `INO-3FRC3Q3` | `192.168.254.7` | `Administrator` | OptiLens Local authoritative host checkout |
| `INNOVA-SVR` | `192.168.254.8` | `Administrator` | Innovations/Actian services |
| `MSSQL-SVR` | `192.168.254.9` | `Administrator` | SQL Server host |

All three hosts run OpenSSH with password authentication disabled. Their TCP/22 firewall allowance is restricted to `CLASSICMAIN` (`192.168.254.1`); do not broaden this rule without an approved network-access change.

Use the controller key without putting its path or content into repo files:

```powershell
ssh -i "$env:USERPROFILE\.ssh\optilens-codex-ed25519" Administrator@MSSQL-SVR whoami
```

### MSSQL-SVR read-access verification

The remote `Administrator` session is a SQL Server `sysadmin` on the default instance. The following databases were verified `ONLINE` and accessible through Windows Integrated Authentication: `Innovations`, `innovations_mirror`, `old_innovations`, `optilens_local`, `master`, `model`, `msdb`, and `tempdb`.

Use a read-only local query such as the following. `-C` is required by the installed ODBC 18 client because the server certificate chain is not locally trusted:

```powershell
sqlcmd -E -C -S localhost -Q "SET NOCOUNT ON; SELECT name, state_desc, HAS_DBACCESS(name) AS HasAccess FROM sys.databases ORDER BY name;"
```

This access does not override the application data rules: source Innovations/PSQL/MSSQL data remains read-only for discovery unless the privileged-admin confirmation policy is followed.

## Guarded documentation delivery

`INO-3FRC3Q3` hosts a loopback-only Premises Code Harness on `127.0.0.1:8787`. The controller reaches it through the `PremisesCodeHarnessTunnel` SSH tunnel, also bound only to controller loopback. The configured target is restricted to `docs/REMOTE_AGENT_OPERATIONS.md`; every replacement is hash-verified and audited at `C:\ProgramData\PremisesCodeHarness\audit.jsonl`.

Do not expose the harness directly on the LAN or Internet, do not place its bearer token in repository files, and do not widen its allowlist without explicit approval.
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
