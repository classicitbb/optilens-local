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

## Next discovery gates

Before live IMAP or supplier status processing is added, confirm the mailbox
provider and protocol settings, secret storage at rest, exact supplier-to-order
reference fields, active-order definition, and the approved status-update
policy. Live mailbox access, OCR, printing, scheduling, and source writes are
not part of this foundation milestone.
