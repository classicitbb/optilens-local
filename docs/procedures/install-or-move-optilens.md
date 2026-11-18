# Procedure: Install or move OptiLens on Windows

> Goal: deliver a silent, resumable installation with an explicit production cutover.
> Created: 2026-11-18

## Context and inputs

Select **New installation** or **Move an existing service**. For a move, collect the source revision, destination service identity, existing database and DNS ownership, TLS signing route, and active task inventory through approved host-local access. Use the [cutover runbook](../WINDOWS_WORKSTATION_CUTOVER.md) for operational details. The existing licensed installer starts from an empty site and database. A move must preserve the existing database and durable operational state.

## Installer stages

1. **Discover.** Verify elevation, resolve the Windows account to its SID, compare source and destination revisions, check ports and private network routes, and inventory task principals, triggers, enabled state, and last results. Record DNS and IIS ownership separately from the app location. Show a plan before making changes.
2. **Stage.** Install dependencies and build the UI and monitor without opening console windows. Keep the new application and business workers guarded against startup. Renew or issue a site leaf under the existing trusted CA and validate the certificate and upstream connections with harmless reads. Provision protected settings locally through Windows prompts and re-protect DPAPI material under the correct user or machine scope. Prompt once for the computer-qualified local service account password when registering unattended tasks. Use the supported Intuit authorization flow for QuickBooks when its protected store lacks credentials.
3. **Preserve state.** Inventory generated catalogues, pricing inputs, pending files, archives, RX sequence, the gateway’s protected state, and the Innovations worker’s fingerprints, timing state, and pricing watermark. Stage safe snapshots first. After quiescing writers, transfer the final state over authenticated, trusted transport and verify counts and integrity. Keep secrets and record contents out of logs and source control.
4. **Switch.** Confirm the operator’s cutover decision, stop the old app and relevant writers, start the new service under the registered account, and verify trusted HTTPS and database health before switching DNS. Keep one owner per schedule. Preserve previous disabled states and hold integrations whose credentials or read-only checks fail. Temporary forwarding must have a defined expiry and cleanup step.
5. **Verify and retire.** Test the staff URL from another device and verify watchdog recovery before sign-in, then verify the tray and shortcut after sign-in. Test the real certificate presented by HTTPS. Show the public CA on split hosts and direct signing and DNS management to the appropriate host. Verify the first runs of restored workers and leave old DNS and databases available.

## Output and behavior

- Provide a wizard with a review page, progress for each stage, and resumable checkpoints outside Git. Offer an unattended mode for preapproved, preprovisioned steps. Prompt locally for credentials and irreversible decisions.
- Use an interactive logon task for the Host Monitor. A session-zero monitor must never prevent the interactive tray from opening. Use a GUI-subsystem launcher for interactive background jobs, preserve their exit codes, and keep tasks visible in the monitor.
- Report passed, pending, and failed checks by name. A rerun must preserve validated state, skip completed steps, and avoid duplicating tasks or processing queues. A failed cutover must support restoring routing and worker ownership after reconciling downstream changes.
- Treat this procedure as acceptance criteria for installer development. The full migration wizard and unattended orchestration are not implemented by this record.
