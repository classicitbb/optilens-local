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
- Read-only Operations UI at `/modules/automation/supplier-email`.
- Parser and fixture validation tests using synthetic data.

## Configuration and safety

The simulation route is available only when `NODE_ENV` is `development` or
`test`. It writes fixtures under the operating-system temporary directory,
never under `public`. No mailbox password, supplier attachment, or real
customer data belongs in the repository.

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
populated for all 166; `CustomerTrayID` was populated for none. A batch probe
against two real active references returned two exact matches through the new
parameterized matcher. The matcher therefore defaults to
`customer_order_reference`, while `customer_tray_id` remains available only
when explicitly configured.

Status discovery found ID 190 as `Shipped from OS Lab` and ID 238 as the source
description `Transmited TOG`. The spelling and mapping are preserved as source
data; no status update is performed.

The matcher supports `customer_order_reference`, `customer_tray_id`, and
`order_id`. Set `OPTILENS_SUPPLIER_MATCH_MODE=source` and
`OPTILENS_SUPPLIER_MATCH_FIELD=customer_order_reference` to select the
read-only source matcher. The default remains the development mock matcher.

Migration 023 adds disabled mailbox and supplier-rule records for TOG WIP,
TOG Dispatch, and SkyLab shipped reports. They remain
`PENDING_CONFIRMATION` until sanitized supplier samples confirm the reference
field and subject/attachment behavior. No live mailbox credential is stored
by this migration.

## Next discovery gates

Before live IMAP or supplier status processing is added, confirm the mailbox
provider and protocol settings, secret storage at rest, exact supplier-to-order
reference fields, active-order definition, and the approved status-update
policy. Live mailbox access, OCR, printing, scheduling, and source writes are
not part of this foundation milestone.
