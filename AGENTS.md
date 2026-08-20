# OptiLens Local Agent Instructions

## Project Direction

OptiLens Local is an internal Windows/MSSQL web platform. The Access delivery/export workflow is the first module, not the entire product.

The platform must support:

- Start page and module launch shortcuts.
- Unauthenticated internal LAN dashboard.
- Authenticated change-capable module screens.
- Shared users, roles, permissions, audit logs, APIs, integrations, and background jobs.
- Future multiple modules, tenants/workspaces, and local LLM automation.

## Non-Negotiable Data Rules

- Do not discard or overwrite historic data.
- Do not modify source PSQL, source MSSQL `Innovations`, or Access databases during discovery unless a privileged administrator has completed the required confirmation challenge for the specific operation.
- The delivery/export module writes shipment close/reopen/edit state only to the private app database by default.
- Source write-back is disabled by default; the privileged-admin data-access policy below is the explicit approved exception.
- Active operational data is last 12 months by ship date.
- Older records must remain available through an archive screen or archive data path.

## Known Sources

- Private app database: MSSQL, recommended actual name `optilens_local`.
- Source MSSQL: `MSSQL-SVR`, database `Innovations`.
- Source shipment flag: `Shipments.Shipped`, where `0` means open and `1` means shipped.
- PSQL/Actian source also has `Shipments` and `ShipmentItems`.
- Historic Access source: `CV_Accounts_be.accdb`.

## First Module

Module address: `/modules/delivery-export`

Must support:

- Export shipment prep.
- `CustomerAccount` and `ShipmentID` source preload.
- Dispatcher selection.
- Invoice scanning.
- Patient name and price visual confirmation.
- Add/remove items before document generation.
- App-owned close, reopen, and edit of shipment/job details.
- Commercial invoice generation.
- Archive search.

## Architecture Rules

- Keep platform core separate from module logic.
- Use a private app database schema for core tables and separate schemas for modules.
- Preserve legacy IDs and source table names during migration.
- Add audit logging to every app-owned data change.
- Keep deterministic business rules in application code.
- Local LLMs may use controlled APIs/tools. The privileged-admin data-access policy governs the explicit exception for direct database-handle tools.

## Security Rules

- Do not commit passwords, connection strings with secrets, API keys, SMTP secrets, or tokens.
- Use environment variables or Windows secret storage for credentials.
- No credentials in browser JavaScript.
- The unauthenticated dashboard must only expose safe operational status.
- Any change-capable endpoint must require authentication once auth is implemented.

## Privileged-Admin Data Access (Explicit Owner Override)

The owner authorizes an authenticated privileged-admin reporting and data-access capability for every approved on-premise source database, including MSSQL, Actian/PSQL, and Access where a supported adapter is configured.

- Use distinct least-privilege read and write service accounts for each source database; keep credentials only in approved Windows secret storage or environment configuration.
- Permit arbitrary SQL only through the privileged-admin interface. Require a fresh confirmation challenge that displays the target source and SQL text before every execution; writes require an explicit second confirmation.
- Permit all tables and views available to the configured account. Enforce a maximum result-row count, statement timeout, and connection timeout.
- Allow the service to create CSV, XLSX, and PDF artifacts in the app-managed workspace, and allow privileged administrators to create or update internal dashboard metrics from approved query results.
- Record a lightweight audit entry for each request: authenticated user, source, SQL/report classification, execution time, outcome, result count, and artifact reference. Do not store credentials in the audit record.
- Expose database access to the model only through an authenticated, audited privileged-admin tool. Do not place raw credentials in skills, prompts, browser code, or model context.

## Windows Setup Preference

- Run on Windows.
- First deployment: Node service behind IIS reverse proxy.
- LAN URL target: `http://192.168.254.9:8080/`.
- Docker is not the first route.

## Coding Preference

- Keep the first build dependency-light.
- Use clear module boundaries.
- Add setup scripts and docs when adding new operational requirements.
- Do not refactor unrelated files unless needed for the requested milestone.

## Operations Agent Direction

OptiLens Local is also the intended internal business-operations engine. The separate `classicitbb/optilens` repository is the customer-facing website and must consume customer-safe APIs rather than duplicate operational logic or connect directly to legacy source databases.

Before implementing operations-agent work, read these files in order:

1. `/docs/operations-agent/BUSINESS_AUTOMATION_REVIEW_BRIEF.md`
2. `/docs/operations-agent/README.md`
3. `/docs/operations-agent/CODEX_BUILD_TASK.md`
4. Relevant existing modules, migrations, and tests

The full review brief contains the product direction and long-term architecture. `CODEX_BUILD_TASK.md` defines the immediate Milestone 1 scope. Do not implement future milestones merely because they are described in the full brief.

Operations-agent non-negotiables:

- External messages, attachments, webhooks, schedules, and AI outputs must create durable events before processing.
- AI may return validated structured proposals. The privileged-admin data-access policy governs the explicit exception for direct database-handle tools and arbitrary SQL.
- Every business write outside the privileged-admin SQL interface must be an idempotent action with audit context and an explicit risk/approval policy.
- Unknown or ambiguous matches become exceptions; do not guess.
- Customer-facing status must remain separate from supplier and internal status.
- Source Innovations/PSQL write-back remains disabled outside the privileged-admin data-access policy.
- IMAP is the preferred email synchronization route, POP3 may be supported as a fallback, and SMTP is used for controlled outbound email.
- WhatsApp integration must use the official WhatsApp Business Platform, not browser scraping or unofficial personal-account automation.
- Durable queues, retries, dead-letter handling, reconciliation, feature flags, health monitoring, and emergency disable controls are part of the architecture.
- Work on a feature branch, keep changes small and reversible, preserve existing behavior, and report tests honestly.

## Agent working rule: the host repo is the only source of truth

Automated agents (Claude/Codex) must edit **only** the host checkout at
`C:\Users\Administrator\Documents\GitHub\optilens-local` (reachable over
`ssh Administrator@ino-3frc3q3`, or `\\INO-3FRC3Q3\GitHub\optilens-local`).

`C:\DEV\optilens-local` is a human working copy. Agents do not read, edit,
commit or revert anything there. Editing both checkouts is what caused the
divergence on 2026-08-06 — the same change existed uncommitted in one tree and
committed in the other, and the mount reports stale git state for the local
copy, so it cannot be trusted to reconcile itself.

Practical notes for agents:

- Read `docs/REMOTE_AGENT_OPERATIONS.md` before using SSH, PowerShell remoting,
  deployment, restart, or host recovery. It is the authoritative remote
  operations runbook; authenticate with keys or approved credential storage
  and never add credentials to repository files or agent instructions.
- Edit via the remote harness, not scp-by-hand: pull a file to a sandbox
  cache, do exact-match string surgery there, push it back. The push verifies
  a SHA match on both sides, runs `node --check` on the host for `.js`, and
  **refuses to write if the host file changed since it was pulled** — so a
  human editing on the host is never silently clobbered.
- After a verified scoped change, commit on the host and follow the complete
  deployment, health verification, and controlled recovery sequence in the
  remote operations runbook.
- Browser-internal pages (`chrome://extensions`, `edge://extensions`) are
  unreachable from the Chrome MCP — it force-prefixes `https://`. This host
  runs **Edge**, not Chrome. The beta extension therefore self-reloads from
  `GET /api/beswift-extension/build`; see `extensions/beswift-co-beta/background.js`.
