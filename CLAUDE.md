This app is an internal app acting as the medium of connection between mssql-svr for Innovations, the CV website and Odoo accounts in the future.

The host checkout is `C:\Users\Administrator\Documents\GitHub\optilens-local`.
`C:\DEV\optilens-local` is a human-only working copy and must not be used by
automated agents. Read `docs/REMOTE_AGENT_OPERATIONS.md` for the approved SSH
or preconfigured PowerShell-remoting workflow, deployment commands, health
verification, and recovery procedure. Do not record credentials in this file
or anywhere in Git.

Make all sites, apps, extensions and scripts drivable and accessible by Claude
and Codex.

When an agent finishes and verifies a scoped code change in the host checkout,
it has standing authorization to commit it with a clear message, restart the
affected local service, verify health, run the documented controlled repair if
needed, and make a normal non-force push of its own verified branch. This does
not authorize a force push, discarding uncommitted work, or scheduled business-data sync tasks
(`innovations-sync`, `inventory-snapshot`, `rx-catalog-sync`, or
`actian-lens-status-sync`).
