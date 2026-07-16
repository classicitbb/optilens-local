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
- Do not modify source PSQL, source MSSQL `Innovations`, or Access databases during discovery.
- First release writes shipment close/reopen/edit state only to the private app database.
- Source write-back is a future approved phase and must be explicitly designed before enabling.
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
- Local LLMs may use controlled APIs/tools later, but must not receive direct database write access.

## Security Rules

- Do not commit passwords, connection strings with secrets, API keys, SMTP secrets, or tokens.
- Use environment variables or Windows secret storage for credentials.
- No credentials in browser JavaScript.
- The unauthenticated dashboard must only expose safe operational status.
- Any change-capable endpoint must require authentication once auth is implemented.

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
- AI may return validated structured proposals but may not receive direct database write access or produce executable SQL.
- Every business write must be an idempotent action with audit context and an explicit risk/approval policy.
- Unknown or ambiguous matches become exceptions; do not guess.
- Customer-facing status must remain separate from supplier and internal status.
- Source Innovations/PSQL write-back remains disabled until a later explicitly approved milestone.
- IMAP is the preferred email synchronization route, POP3 may be supported as a fallback, and SMTP is used for controlled outbound email.
- WhatsApp integration must use the official WhatsApp Business Platform, not browser scraping or unofficial personal-account automation.
- Durable queues, retries, dead-letter handling, reconciliation, feature flags, health monitoring, and emergency disable controls are part of the architecture.
- Work on a feature branch, keep changes small and reversible, preserve existing behavior, and report tests honestly.
