# Codex Build Task: Operations Agent Foundation

## Mission

Implement Milestone 1 of the OptiLens Local Operations Agent as a production-shaped prototype.

Read these files before editing code:

1. `/AGENTS.md`
2. `/docs/operations-agent/README.md`
3. `/package.json`
4. `/server.js`
5. `/lib/migrations.js`
6. Existing authentication, audit, database, integration-health, and automation-job modules.

Do not begin by rewriting `server.js`. First understand existing route registration, response helpers, authentication checks, and database patterns.

## Working method

- Work only on the assigned feature branch.
- Keep commits small and coherent.
- Do not refactor unrelated modules.
- Preserve existing behavior.
- Run the existing test suite before changes and after each coherent milestone.
- Add tests with every behavior change.
- When an existing project pattern conflicts with this brief, prefer the existing safe pattern and document the deviation.
- Stop rather than invent credentials, source table meanings, or write-back behavior.

## Deliverable

Build the operations-agent foundation and one simulated supplier-status workflow.

The deliverable must include:

- Operations database schema and migration.
- Event store with idempotent creation and safe claiming.
- Action, approval, exception, and activity/audit services.
- Supplier CSV parser interface and one fixture parser.
- Read-only/mock job matching adapter for tests and development.
- Workflow from simulated file ingestion to proposed actions.
- Approval/rejection endpoints.
- App-owned prototype status projection.
- Notification outbox record; no live sending.
- Minimal Operations UI integrated with the existing platform.
- Automated tests.
- Setup and verification documentation.

## Implementation sequence

### Step 0: Repository reconnaissance

Before editing:

- Run `npm test`.
- Run `npm run check`.
- Identify route and static-file conventions.
- Identify the database helper and transaction conventions.
- Identify authentication and module-access conventions.
- Identify the audit-log implementation.
- Identify how existing automation jobs are claimed, retried, and reported.
- Record findings in the final implementation summary.

### Step 1: Migration

Create `database/020-operations-agent-foundation.sql` and add it to the ordered migration list.

The SQL must be rerunnable. Use schema/object existence checks consistent with existing migrations.

Create, at minimum:

- `ops.Events`
- `ops.Attachments`
- `ops.Actions`
- `ops.Approvals`
- `ops.Exceptions`
- `ops.StatusProjection`
- `ops.NotificationOutbox`
- `ops.ActivityLog` only if an equivalent existing audit facility cannot represent the required history

Add indexes for status/availability queries, correlation lookup, external references, and unique idempotency keys.

Do not add real customer or supplier data.

### Step 2: Core operations services

Implement under `lib/operations/`:

- event creation
- event retrieval/listing
- atomic event claim
- retry/failure transition
- action creation
- approval request/decision
- exception creation/resolution
- activity recording
- idempotency helpers

Requirements:

- Validate all enum/state transitions.
- Use transactions where related records must succeed together.
- Return stable plain objects from the service boundary.
- Avoid exposing raw SQL errors to browser responses.
- Use UTC timestamps.

### Step 3: Supplier parser contract

Create a parser registry and a deterministic development fixture parser.

Parser output must use the normalized supplier-row contract from the architecture brief.

Validation must identify:

- missing required headers
- empty job references
- duplicate rows
- unsupported statuses
- malformed dates

Do not add XLSX parsing in this milestone unless it is implemented with an explicitly reviewed dependency and tests. CSV is sufficient.

### Step 4: Simulated ingestion

Add a development/test-only endpoint that accepts a fixture CSV or references a bundled test fixture.

Safety requirements:

- disabled by default outside test/development configuration
- strict maximum size
- sanitized filename
- SHA-256 hash
- storage outside public web assets
- deterministic event idempotency key

The same file submitted twice must return the original event/result rather than creating duplicate work.

### Step 5: Workflow orchestration

Implement `supplier.status_file.received` workflow:

- load attachment
- select parser
- parse and normalize
- match against a development/read-only job adapter
- create proposed status actions
- create exceptions for unresolved rows
- place medium-risk updates in `WAITING_APPROVAL`
- produce summary counts

No Innovations or PSQL writes.

### Step 6: Approval and projection

Approval must:

- verify user authorization
- lock or transactionally recheck action state
- write only to `ops.StatusProjection`
- mark action complete
- append activity/audit record
- create one notification-outbox record when the customer-facing status changes

Reapproval or request retry must not duplicate projection history or outbox records.

Rejection must preserve the proposed action and record the decision/reason.

### Step 7: API routes

Implement the API surface in the architecture brief using existing server response/auth conventions.

Do not place all route logic inside `server.js`. Register the operations routes from a small module entry point.

List endpoints need bounded pagination and safe filters.

### Step 8: Operations UI

Build a minimal internal screen using the repository’s existing frontend conventions.

Required views:

- summary cards
- event list
- proposed actions awaiting approval
- exceptions
- activity history

Required actions:

- inspect event details
- approve action
- reject action with note
- resolve exception with note
- run simulated fixture ingestion in development mode

The interface does not need final visual polish, but it must clearly show states and errors.

### Step 9: Tests

Add tests for:

- event idempotency
- action idempotency
- event claim concurrency semantics where practical
- valid CSV parsing
- invalid headers
- duplicate supplier rows
- unsupported status mapping
- unmatched job exception
- approval transition
- rejection transition
- duplicate approval safety
- outbox deduplication
- migration rerun safety where the current test infrastructure permits it
- authorization on mutation endpoints

Use synthetic data only.

### Step 10: Documentation and verification

Add a concise runbook:

- configuration flags
- migration command/path
- how to run tests
- how to ingest the fixture
- how to inspect events/actions/exceptions
- how to disable the development endpoint
- known limitations

Run and report:

```text
npm run check
npm test
```

Also perform a manual smoke test of startup and the simulated workflow if the local database is available. Do not claim database smoke-test success if the required local service is unavailable.

## Definition of done

Do not mark complete until every applicable acceptance criterion in `docs/operations-agent/README.md` is satisfied.

The implementation summary must state:

- files changed
- schema added
- routes added
- security controls added
- tests run and results
- manual tests performed
- any acceptance criteria not completed
- recommended next milestone

## Prohibited shortcuts

- No direct AI/database write path.
- No live email or WhatsApp integration in this milestone.
- No source Innovations/PSQL updates.
- No swallowing exceptions without an exception/activity record.
- No in-memory-only event queue.
- No unbounded list endpoints.
- No credentials or realistic private data in fixtures.
- No broad rewrite of the existing application.
- No claim that the prototype is production-ready.
