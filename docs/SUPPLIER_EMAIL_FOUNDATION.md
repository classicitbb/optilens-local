# Supplier Email Automation Foundation

This branch begins the supplier-report subsystem inside OptiLens Local. The
first milestone is deliberately observation-only and does not connect to the
live mailbox or update Innovations/PSQL statuses.

## Current scope

- `ops` database tables for durable events, attachments, actions, approvals,
  exceptions, projections, notification outbox, and activity history.
- Deterministic CSV and XLSX parser contract with ExcelJS values-only loading.
- Development-only simulated supplier-file ingestion.
- SHA-256 attachment identity and event idempotency.
- Read-only IMAP connector with confirmed-rule routing and attachment filtering.
- Read-only Operations UI at `/modules/automation/supplier-email`.
- Parser and fixture validation tests using synthetic data.

## Configuration and safety

The simulation route is available only when `NODE_ENV` is `development` or
`test`. It writes fixtures under the operating-system temporary directory,
never under `public`. No mailbox password, supplier attachment, or real
customer data belongs in the repository.

The IMAP connector is intentionally not scheduled yet. It requires an enabled
mailbox row with `server_hostname`, username, and a runtime-resolved password;
the database stores only a credential reference. It opens the configured folder
read-only, scans the configured date/message window, and never marks or moves
messages. Only `CONFIRMED` and enabled supplier rules can route a message. The
connector is exposed as `lib/operations/imap-mailbox.js` for the controlled
dry-run runner; no live mailbox connection is attempted by the web server.

The first live read-only dry run connected successfully to the configured
mailbox and scanned 20 recent Inbox messages. TOG WIP and Dispatch messages
with XLSX attachments routed and parsed without warnings; SkyLab shipping PDFs
routed and parsed without warnings; `No Data` Dispatch messages became
missing-attachment cases; and unrelated messages produced no confirmed rule.
No message flags or folders were changed.

The migration is `database/022-supplier-email-operations.sql`. Migration 020
was already occupied by the standards-catalog index, so this feature uses 022
to preserve the existing migration history.

## Database discovery checkpoint

The configured live source profile was reachable read-only during discovery.
The active-order candidate used by the existing platform is:

- `dbo.Orders` joined to `dbo.GenStatus` with `GenStatus.Active = 1`.
- `JobID` must be non-null and non-empty.
- `OrderType` must be 1 or 3.

The live source reported 166 active candidates. `CustomerOrdReference` was
populated for all 166; `CustomerTrayID` was populated for none. The live TOG
samples contain short references such as `836`, `973`, and `1031`, which match
active `dbo.Orders.JobID` values. TOG therefore uses `job_id`. The live SkyLab
sample set contains 10 text-readable PDFs with 63 shipped-job rows: 53
explicit `Rx` rows and 10 explicit `Stock` rows. Its report's `Rx No` column is
the provisional `customer_order_reference` mapping. The matcher also supports
`customer_tray_id`, `customer_order_reference`, and `order_id` when explicitly
configured.

Status discovery found ID 190 as `Shipped from OS Lab` and ID 238 as the source
description `Transmited TOG`. The spelling and mapping are preserved as source
data; no status update is performed.

Set `OPTILENS_SUPPLIER_MATCH_MODE=source` and
`OPTILENS_SUPPLIER_MATCH_FIELD=job_id` for TOG, or
`customer_order_reference` for SkyLab, to select the
read-only source matcher. The default remains the development mock matcher.

Migration 023 adds disabled mailbox and supplier-rule records for TOG WIP,
TOG Dispatch, and SkyLab shipped reports. They remain
`PENDING_CONFIRMATION` until operational review confirms the mappings and
subject/attachment behavior. No live mailbox credential is stored by this
migration.

## Next discovery gates

Before live IMAP or supplier status processing is added, confirm the mailbox
provider and protocol settings, secret storage at rest, exact supplier-to-order
reference fields, active-order definition, and the approved status-update
policy. Live mailbox access, OCR, printing, scheduling, and source writes are
not part of this foundation milestone.
