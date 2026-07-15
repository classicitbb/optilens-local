# OptiLens Local Operations Agent

Status: implementation brief for a production-shaped prototype.

## Objective

Build an event-driven operations layer inside OptiLens Local so routine work can be received, interpreted, validated, approved where necessary, executed, audited, and surfaced as exceptions.

The first complete workflow is:

> Supplier email attachment -> normalized supplier status rows -> proposed job matches -> approved status updates -> customer-visible status -> notification record.

This is not a general autonomous chatbot. It is a controlled operations platform with AI-assisted interpretation at defined boundaries.

## Existing repository constraints

- Node.js 20, dependency-light CommonJS application.
- MSSQL private application database.
- ODBC/MSSQL access to legacy source systems.
- `server.js` currently registers many platform modules.
- Existing migration runner reads an explicit ordered file list from `lib/migrations.js`.
- Existing authentication, roles, audit concepts, integration health, delivery, shipment sync, and automation-job patterns should be reused where appropriate.
- Source Innovations/PSQL data remains read-only unless a later milestone explicitly approves write-back.
- No credentials, API tokens, connection strings, or supplier data may be committed.

## Architecture

```text
Email / WhatsApp / Portal / Supplier API / Scheduler
                         |
                         v
                  Inbound connectors
                         |
                         v
                    Event inbox
                         |
                         v
               Operations orchestrator
              /          |            \
       rules engine   AI proposal   approval gate
              \          |            /
                         v
                    Action queue
                         |
                         v
                    Action workers
             /           |             \
       app database  source adapters  notifications
                         |
                         v
                 Audit + exceptions
```

## Non-negotiable design rules

1. External messages and files never update a business record directly.
2. Every inbound item is stored as an immutable event before processing.
3. Every write is represented by an action with before/after values.
4. Duplicate delivery must be harmless through idempotency keys.
5. AI returns structured proposals only; deterministic code validates and executes them.
6. Low-confidence matches become exceptions, never guessed updates.
7. Customer-facing status is separate from supplier/internal status.
8. Notification sending is independently retryable and auditable.
9. Source-system write-back is disabled in the foundation milestone.
10. Existing modules must continue to start and function.

## Proposed module structure

```text
lib/operations/
  index.js
  routes.js
  orchestrator.js
  event-store.js
  action-store.js
  approval-service.js
  exception-service.js
  audit-service.js
  idempotency.js
  status-map.js
  schemas/
  connectors/
  parsers/
  workflows/
  workers/
  notifications/

public/operations/
  index.html
  operations.js
  operations.css

database/
  020-operations-agent-foundation.sql

test/
  operations-event-store.test.js
  operations-idempotency.test.js
  operations-supplier-import.test.js
  operations-approval.test.js
```

## Foundation data model

### `ops.Events`

Durable inbox for all external and scheduled work.

Required fields:

- `EventId` uniqueidentifier primary key
- `EventType` nvarchar(100)
- `SourceSystem` nvarchar(50)
- `ExternalReference` nvarchar(255), nullable
- `IdempotencyKey` nvarchar(255), unique
- `CorrelationId` uniqueidentifier
- `PayloadJson` nvarchar(max)
- `Status` nvarchar(30): `RECEIVED`, `PROCESSING`, `WAITING_APPROVAL`, `COMPLETED`, `FAILED`, `DEAD_LETTER`
- `AttemptCount` int
- `AvailableAt` datetime2
- `LockedAt` datetime2, nullable
- `LockedBy` nvarchar(100), nullable
- `LastError` nvarchar(max), nullable
- `CreatedAt`, `UpdatedAt`, `CompletedAt`

### `ops.Attachments`

Metadata and safe local-storage reference for inbound files.

Required fields:

- `AttachmentId`
- `EventId`
- `OriginalFilename`
- `StoredFilename`
- `MimeType`
- `SizeBytes`
- `Sha256`
- `StoragePath`
- `ScanStatus`
- `CreatedAt`

Do not store attachment bytes in event JSON.

### `ops.Actions`

Proposed or executable business operations.

Required fields:

- `ActionId`
- `EventId`
- `ActionType`
- `TargetType`
- `TargetReference`
- `IdempotencyKey`, unique
- `BeforeJson`, nullable
- `ProposedJson`
- `AppliedJson`, nullable
- `RiskLevel`: `LOW`, `MEDIUM`, `HIGH`
- `ApprovalRequired` bit
- `Status`: `PROPOSED`, `APPROVED`, `RUNNING`, `COMPLETED`, `FAILED`, `REJECTED`
- timestamps and error fields

### `ops.Approvals`

- `ApprovalId`
- `ActionId`
- `Status`: `PENDING`, `APPROVED`, `REJECTED`
- `RequestedAt`
- `DecidedAt`
- `DecidedByUserId`
- `DecisionNote`

### `ops.Exceptions`

- `ExceptionId`
- `EventId`, nullable
- `ActionId`, nullable
- `ExceptionType`
- `Severity`
- `Summary`
- `DetailsJson`
- `Status`: `OPEN`, `RESOLVED`, `IGNORED`
- ownership and timestamps

### `ops.AuditLog`

Append-only record of operations-agent decisions and changes. Reuse the platform audit implementation if it already provides equivalent guarantees; otherwise create this table.

## Standard normalized supplier row

```json
{
  "supplier": "Example Supplier",
  "supplierOrderNumber": "SO-93822",
  "customerOrderNumber": "CV-10482",
  "supplierStatus": "COATING",
  "normalizedStatus": "IN_PRODUCTION",
  "estimatedCompletionDate": "2026-07-18",
  "trackingNumber": null,
  "sourceRow": 14
}
```

## Initial status model

Internal normalized statuses:

- `RECEIVED_BY_SUPPLIER`
- `IN_PRODUCTION`
- `QUALITY_CONTROL`
- `READY_TO_SHIP`
- `SHIPPED`
- `ON_HOLD`
- `CANCELLED`
- `UNKNOWN`

Initial customer-facing statuses:

- `Order received`
- `In production`
- `Quality checks`
- `On the way to Classic Visions`
- `Delayed - being reviewed`
- `Completed`

Supplier-specific wording maps to normalized status in deterministic configuration. Unknown wording creates an exception.

## API surface for the foundation

All mutation endpoints require authenticated access and existing role/module authorization.

- `GET /api/operations/summary`
- `GET /api/operations/events`
- `GET /api/operations/events/:id`
- `POST /api/operations/events/simulate-supplier-file`
- `GET /api/operations/actions`
- `POST /api/operations/actions/:id/approve`
- `POST /api/operations/actions/:id/reject`
- `GET /api/operations/exceptions`
- `POST /api/operations/exceptions/:id/resolve`
- `GET /api/operations/activity`

The simulation endpoint is development-only and must be disabled through configuration outside development/testing.

## First vertical workflow

1. Accept a test CSV fixture through a development-only ingestion endpoint.
2. Calculate file hash and create an attachment record.
3. Create one `supplier.status_file.received` event using a deterministic idempotency key.
4. Select a supplier parser from explicit configuration.
5. Parse and validate required columns.
6. Normalize every source row.
7. Match job references through a read-only adapter.
8. Create proposed actions; do not update Innovations/PSQL.
9. Unmatched, duplicate, conflicting, or invalid rows create exceptions.
10. Present proposed actions in the Operations UI.
11. Approval applies changes only to app-owned prototype status records.
12. Record customer notification intent, but use a fake/outbox notifier in the foundation milestone.
13. Retrying the same file must not duplicate events, actions, updates, or notifications.

## Security and safety

- Store secrets only through environment variables or approved Windows secret storage.
- Validate file extension, MIME type, size, and SHA-256.
- Store uploaded files outside the publicly served directory.
- Sanitize filenames and generate server-owned stored names.
- Never execute spreadsheet formulas or macros.
- CSV parsing must handle quoted values safely.
- XLSX support is not required in the foundation milestone unless a safe dependency is deliberately approved.
- Do not send raw customer or supplier datasets to an AI service in this milestone.
- No AI-generated SQL.
- No direct source database write access.
- Log decisions without logging secrets.

## Acceptance criteria

The foundation is complete when:

1. The existing application starts normally.
2. Existing tests still pass.
3. A migration creates the operations schema idempotently.
4. Re-running migrations does not fail or duplicate seed/configuration data.
5. A fixture supplier CSV creates one event and the expected proposed actions.
6. Re-ingesting the same fixture creates no duplicates.
7. Invalid rows appear as exceptions with actionable explanations.
8. An authorized user can approve or reject a proposed action.
9. Approval changes only app-owned prototype records.
10. Every state transition appears in activity/audit history.
11. Failed processing can be retried without duplicate effects.
12. The operations page shows counts for received, waiting approval, failed, and open exceptions.
13. No credential or real supplier/customer data is added to the repository.
14. Tests cover parsing, normalization, idempotency, approvals, and failure handling.

## Explicitly out of scope for the foundation

- Live Microsoft 365 mailbox access.
- Live WhatsApp Cloud API connection.
- Automated customer messages.
- QuickBooks integration.
- Production AI provider integration.
- Writes to Innovations or PSQL.
- Fully configurable no-code workflow builder.
- Autonomous financial, prescription, pricing, cancellation, or credit decisions.

## Later milestones

1. Microsoft Graph email connector and attachment ingestion.
2. Supplier-specific CSV/XLSX parser registry.
3. Customer-facing status projection and email outbox.
4. Official WhatsApp Business Platform webhook and verified-contact mapping.
5. Read-only conversational order-status tools.
6. Delayed-job monitoring and exception escalation.
7. Controlled source-system write-back after explicit review.
8. Reporting, purchasing recommendations, and broader operational workflows.
