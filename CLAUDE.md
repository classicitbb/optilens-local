This app is an internal app acting as the medium of connection between mssql-svr for Innovations, the CV website and Odoo accounts in the future. 

C:\DEV\optilens-local is the local repo to work from or, \\INO-3FRC3Q3\GitHub\optilens-local is direct to the host serving the page 

you can use this ssh Administrator@ino-3frc3q3 with the password U$E0cuc0

Make all sites, apps, extesions and scripts, drivable and accesible by claude and codex

When you (Claude or Codex) finish and verify a code change in this repo, land it without waiting for a manual go-ahead: commit the change with a clear message, then restart the affected local service(s) using the existing scripts (`npm run app:restart`, or `scripts/apply-local-update.ps1` for a full update). If the service does not come back healthy, run the existing self-repair tooling (`scripts/repair-host.ps1`) automatically rather than leaving it broken. The tray monitor and the "OptiLens Local Watchdog" scheduled task should be relaunched/kicked as part of that restart so they reflect the change immediately, mirroring the behavior `scripts/apply-local-update.ps1` already implements for a landed update.

This standing authorization covers local commits and local service restarts on this repo/host only. It does not cover pushing to a shared remote, force-pushing, discarding uncommitted work, or running the scheduled data-sync tasks (innovations-sync, inventory-snapshot, rx-catalog-sync, actian-lens-status-sync) — those remain explicit since they act on business data outside the app.
