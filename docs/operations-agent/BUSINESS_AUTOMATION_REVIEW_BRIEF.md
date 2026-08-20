# OptiLens Business Automation and Operations Agent

Status: review draft for Russell Hunte and implementation source for Codex.

This document consolidates the intended business outcome, system architecture, communications integrations, safety controls, implementation sequence, and future capabilities discussed for OptiLens Local and the customer-facing OptiLens website.

It is deliberately broader than the first prototype. The prototype must be small, but it must be shaped so that its code becomes the permanent foundation rather than a throwaway demonstration.

---

## 1. Executive intent

Classic Visions should operate through a controlled automation platform in which routine work happens without Russell having to remember, chase, copy, reconcile, or manually report it.

The intended operating model is:

> Routine work is automated. Exceptions are surfaced. Material decisions require approval. Every action is traceable. Russell concentrates on sales, strategy, customer relationships, and the decisions that genuinely require him.

This is not achieved by cron jobs alone. The full system will combine:

- Scheduled jobs.
- Event-driven workflows.
- Email and WhatsApp communication.
- Supplier file ingestion.
- Database and application integrations.
- Human approvals.
- AI-assisted interpretation.
- Deterministic business rules.
- Exception management.
- Audit logging.
- Operational dashboards.
- Customer notifications.
- Recovery, retry, reconciliation, and monitoring.

The product should be described as an **event-driven business operations platform with AI-assisted agents**, not as a chatbot and not as a folder of scripts.

---

## 2. Product boundaries

### 2.1 OptiLens Local

`classicitbb/optilens-local` is the internal operations engine and source of operational truth for automation activity.

Its responsibilities include:

- Receiving events from email, WhatsApp, the public website, suppliers, schedules, and internal users.
- Storing inbound messages, files, and events durably.
- Applying deterministic validation and business rules.
- Asking AI services for structured interpretation where appropriate.
- Managing action proposals, approvals, retries, exceptions, and audit history.
- Reading from approved business systems.
- Writing only through explicit, controlled adapters.
- Maintaining customer-facing status projections.
- Queuing outbound email, WhatsApp, and portal notifications.
- Providing the internal Operations Console.
- Monitoring integration health and service-level performance.

OptiLens Local must remain modular. `server.js` may register the operations module, but the operations implementation must live under a dedicated module boundary.

### 2.2 OptiLens website

`classicitbb/optilens` is the customer-facing website and portal. It is currently a React/Vite application with authentication, store, knowledge, profile, orders, and admin areas.

Its responsibilities should include:

- Customer authentication and account presentation.
- Product browsing and ordering.
- Showing customer-safe order and job status.
- Showing customer communication history where permitted.
- Accepting customer requests and documents.
- Displaying notifications, expected dates, and exceptions in customer-friendly language.
- Calling a secure API or gateway rather than accessing legacy databases directly.

The website should not become a second operations engine. It is a channel and customer window into the operating platform.

### 2.3 Integration relationship

The long-term relationship should be:

```text
Customer / Staff / Supplier
          |
          v
Website, Email, WhatsApp, Scheduled Pollers
          |
          v
Secure OptiLens API / Inbound Connectors
          |
          v
OptiLens Local Event Inbox and Orchestrator
          |
          +--> Private app database
          +--> Innovations / PSQL read adapters
          +--> Approved write-back adapters
          +--> Notification outbox
          |
          v
Customer-safe API projection
          |
          v
OptiLens website, email, and WhatsApp
```

The two repositories need a versioned API contract, shared identifiers, authentication rules, and clearly assigned data ownership so that they do not drift apart.

---

## 3. Core architectural principles

These rules are non-negotiable unless a later decision record explicitly changes them.

### Decision record — privileged-admin data access (2026-08-20)

The owner authorizes a privileged-admin data-access capability for approved on-premise MSSQL, Actian/PSQL, and Access sources. This overrides principles 5 and 9 only for an authenticated privileged-admin tool that requires a fresh confirmation challenge showing the target source and exact SQL before each execution, plus a second confirmation for writes. It may expose an audited direct database handle to the model, accept arbitrary SQL, access all tables and views available to the configured account, generate CSV/XLSX/PDF artifacts, and create internal dashboard metrics. Apply configured row, statement-timeout, and connection-timeout limits; retain a lightweight audit record; and keep credentials outside model context and repository files.

1. External messages, attachments, web requests, and AI outputs never write directly to business records.
2. Every inbound item becomes a durable event before processing.
3. Every proposed write becomes a durable action with target, reason, before value, proposed value, risk, and status.
4. Every action is idempotent. Replaying the same input must not create duplicate effects.
5. AI produces structured proposals only. Deterministic application code validates and executes them.
6. Unknown, ambiguous, conflicting, or low-confidence matches become exceptions rather than guessed changes.
7. Supplier status, internal production status, and customer-facing status are separate concepts.
8. Outbound notifications are queued separately so sending can retry without repeating the underlying business update.
9. Source-system write-back is disabled until an adapter and approval policy are explicitly reviewed.
10. All meaningful state changes are audited.
11. Scheduled tasks enqueue work; they do not contain an entire multi-system business process in one script.
12. Each integration has a health state, ownership, credentials boundary, rate limits, and failure policy.
13. Features that can affect customers or source data must support a safe disabled or observation-only mode.
14. The platform must be recoverable after a restart without relying on in-memory queues.
15. The system must explain what it did, why it did it, and what requires attention.

---

## 4. Reference architecture

```text
+------------------------------------------------------------------+
|                         CHANNELS                                 |
|  IMAP/POP email | SMTP | WhatsApp | Website | Supplier APIs      |
|  Manual upload  | Schedules | Internal modules | Future mobile   |
+------------------------------+-----------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|                    CONNECTOR AND GATEWAY LAYER                    |
| Authentication | signature checks | allowlists | rate limits     |
| normalization | attachment capture | duplicate detection         |
+------------------------------+-----------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|                         EVENT INBOX                              |
| Durable events | correlation | idempotency | raw payload refs     |
| claim/lease | retry | dead-letter | replay                       |
+------------------------------+-----------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|                  OPERATIONS ORCHESTRATOR                          |
| Workflow registry | policy engine | rules | AI proposals          |
| confidence gates | approvals | compensation | exception routing   |
+------------------------------+-----------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|                        ACTION QUEUE                               |
| Proposed actions | risk | approval status | before/after          |
| worker claims | retry | deduplication | rollback/compensation     |
+------------+-----------------+------------------+-----------------+
             |                 |                  |
             v                 v                  v
     App-owned records   Source adapters     Notification outbox
     and projections     and integrations    email/WhatsApp/portal
             |                 |                  |
             +-----------------+------------------+
                               |
                               v
+------------------------------------------------------------------+
|              AUDIT, EXCEPTIONS, METRICS, AND HEALTH              |
| Activity history | unresolved work | SLAs | alerts | dashboards   |
| reconciliation | data lineage | cost and quality metrics          |
+------------------------------------------------------------------+
```

---

## 5. Main platform components

### 5.1 Connector registry

Every external system must be registered through a common integration definition.

A connector record should define:

- Connector ID and human-readable name.
- Connector type, such as IMAP, POP3, SMTP, WhatsApp, HTTP API, ODBC, MSSQL, file drop, or schedule.
- Environment and enabled state.
- Read and write capabilities.
- Authentication method and secret reference.
- Polling or webhook configuration.
- Rate limit and timeout.
- Retry policy.
- Health-check method.
- Data classification permitted through the connector.
- Owner and escalation contact.
- Last successful operation and last error.

Connectors normalize external input but do not make business decisions.

Suggested module structure:

```text
lib/operations/connectors/
  registry.js
  imap-email.js
  pop3-email.js
  smtp-email.js
  whatsapp-cloud.js
  website-api.js
  supplier-api.js
  file-drop.js
  scheduler.js
  innovations-read.js
  innovations-write.js
```

The write adapters should be absent or disabled until approved, not merely hidden in configuration.

### 5.2 Event inbox

The event inbox is the durable entry point for all work.

Typical event types include:

- `email.message.received`
- `email.attachment.received`
- `supplier.status_file.received`
- `whatsapp.message.received`
- `website.order.created`
- `website.status.requested`
- `job.status.changed`
- `customer.notification.requested`
- `schedule.email_sync.requested`
- `schedule.delayed_job_scan.requested`
- `integration.health_check.requested`
- `approval.decision.recorded`

Events require:

- Unique event ID.
- Event type and schema version.
- Source system and external reference.
- Correlation ID and causation ID.
- Deterministic idempotency key.
- Payload or secure payload reference.
- Processing status.
- Attempt count and next available time.
- Lock owner and lock expiry.
- Last error and error classification.
- Created, updated, completed, and retention timestamps.

Events should support replay. Replay must create no duplicate business effects.

### 5.3 Workflow registry and orchestrator

Workflows are explicit code modules with versioned input and output contracts.

A workflow should declare:

- Event types it accepts.
- Required permissions and connector capabilities.
- Expected schema version.
- Steps and state transitions.
- Risk classification.
- Approval policy.
- Retry and timeout policy.
- Compensation or recovery behavior.
- Notification rules.
- Metrics and service-level target.

AI may be called within a workflow, but cannot select arbitrary tools or write arbitrary SQL.

Suggested structure:

```text
lib/operations/workflows/
  supplier-status-import.js
  customer-status-request.js
  delayed-job-monitor.js
  customer-notification.js
  inactive-customer-followup.js
  statement-delivery.js
  inventory-reorder-review.js
```

### 5.4 Policy and rules engine

Deterministic rules should govern predictable decisions.

Examples:

```text
IF sender is on Supplier A allowlist
AND attachment type is CSV
AND required columns match parser version 2
THEN create supplier status import workflow.
```

```text
IF a source row matches exactly one job
AND status mapping is known
AND the change is forward-moving and low risk
THEN create an auto-applicable app-owned status action.
ELSE require approval or create an exception.
```

```text
IF a WhatsApp sender is verified for exactly one customer account
THEN allow read-only order status for that account.
ELSE request verification or escalate.
```

Rules should begin in version-controlled code or configuration. A no-code rule editor is a later capability and must include validation, simulation, approval, and version history.

### 5.5 AI interpretation layer

Useful AI responsibilities include:

- Classifying an email or WhatsApp message.
- Extracting a customer, order, supplier, or job reference.
- Mapping unfamiliar spreadsheet headers to a known schema.
- Summarizing a supplier explanation.
- Producing a customer-friendly message from approved facts.
- Detecting likely anomalies or discrepancies.
- Suggesting the next action for human review.

AI outputs must use validated structured schemas, for example:

```json
{
  "intent": "CHECK_JOB_STATUS",
  "customerReference": "CV-10482",
  "confidence": 0.96,
  "requestedTool": "READ_CUSTOMER_JOB_STATUS"
}
```

The application must reject outputs that fail schema validation, exceed permitted scope, reference unauthorized tools, or fall below the workflow confidence threshold.

The platform also needs:

- Prompt and model version tracking.
- Redaction before external model calls.
- Maximum data scope per request.
- Cost and token limits.
- Timeouts and model fallback.
- Evaluation fixtures for common messages.
- A method to disable AI and use deterministic/manual processing.

### 5.6 Action workers

Workers perform controlled actions such as:

- Applying an app-owned status projection.
- Updating an approved source-system field.
- Creating a notification-outbox record.
- Sending email.
- Sending WhatsApp.
- Updating the customer portal.
- Generating a report.
- Creating a purchase-order recommendation.

Each action requires:

- Stable action type.
- Target type and target reference.
- Idempotency key.
- Before, proposed, and applied values.
- Risk level.
- Approval requirement.
- Actor and reason.
- Status and attempt history.
- Result or error.
- Compensation status where relevant.

### 5.7 Human approval service

Approval is a first-class workflow, not an informal message.

Approval records should contain:

- Action and workflow context.
- Risk and affected records.
- Plain-language explanation.
- Before and proposed values.
- Supporting source message or attachment link.
- Requestor.
- Authorized approver roles.
- Expiry and escalation rules.
- Decision, note, actor, and time.

Approvals should support:

- Approve.
- Reject.
- Request more information.
- Edit and approve where policy permits.
- Bulk approval only for homogeneous low-risk actions.
- Four-eyes approval for high-risk financial or clinical actions.

### 5.8 Exception service

The system should aim to make normal work disappear and abnormal work obvious.

Exception examples include:

- Unknown supplier.
- Untrusted sender.
- Attachment cannot be parsed.
- Required columns missing.
- Duplicate file or duplicate source row.
- No matching job.
- More than one matching job.
- Status would move backwards unexpectedly.
- Customer identity cannot be verified.
- Notification repeatedly failed.
- Connector authentication expired.
- Source and app data disagree.
- Workflow exceeded its service-level target.

Exceptions need severity, owner, due date, status, notes, related event/action, and resolution reason.

### 5.9 Notification outbox

Business changes and customer messages must be separate transactions.

When a status changes, the workflow creates one notification intent. A notification worker later sends it.

This avoids:

- Repeating a database change because email failed.
- Sending duplicate messages during retries.
- Losing messages when a service is unavailable.
- Hiding delivery failure.

Notification records should include template version, recipient identity, channel, rendered content hash, language, consent state, send attempts, provider reference, delivery status, and related event/action.

### 5.10 Operations Console

The existing operations-agent placeholder should become the control centre.

Recommended screens:

- **Overview:** volume, waiting approvals, failures, open exceptions, connector health, SLA breaches.
- **Inbox:** new events and messages.
- **Approvals:** proposed changes with evidence and risk.
- **Exceptions:** unresolved mismatches and failures.
- **Activity:** chronological, searchable audit trail.
- **Automations:** workflows, schedules, enabled state, last and next run.
- **Connections:** IMAP/POP/SMTP, WhatsApp, website, databases, and APIs.
- **Conversations:** customer and supplier messages linked to accounts, jobs, and orders.
- **Reconciliation:** app projection compared with source systems.
- **Policies:** read-only view of active approval and automation policies initially.
- **Metrics:** processing time, error rate, notification delivery, automation rate, manual touches, and estimated time saved.

---

## 6. Email architecture: IMAP, POP3, and SMTP

### 6.1 Recommended route

Use **IMAP for reading and synchronization** and **SMTP for sending** wherever the mail provider supports them.

IMAP is preferable because it supports:

- Server-side folders.
- Flags and read state.
- Moving processed messages.
- Multiple clients sharing a mailbox.
- Incremental synchronization.
- Stable message identifiers when implemented carefully.

Suggested folders:

- Inbox.
- Suppliers.
- Processing.
- Processed.
- Needs Review.
- Failed.

Folder movement is helpful but must not be the only processing record. The event database remains authoritative.

### 6.2 POP3 support

POP3 can be supported for providers that do not offer usable IMAP, but it has limitations:

- Usually focuses on downloading Inbox messages.
- Does not provide rich folder synchronization.
- Message deletion behavior varies.
- It is harder for multiple clients to coordinate.
- It is easier to re-download or lose state if identifiers change.

POP3 should therefore use:

- Leave-on-server configuration where possible.
- Stable duplicate detection using provider ID plus content hash.
- A local checkpoint and retrieval ledger.
- A conservative deletion policy; the agent should not delete server mail initially.

### 6.3 SMTP sending

SMTP can send customer and supplier messages.

The system should also preserve a communication record even if the provider does not automatically place SMTP messages into Sent Items. Depending on provider behavior, it may:

- Save the sent MIME message to the IMAP Sent folder.
- BCC a controlled archive mailbox.
- Store the rendered message and provider response internally.

### 6.4 Email ingestion flow

```text
Mailbox poll or IMAP notification
        |
        v
Retrieve message headers and stable identifier
        |
        v
Deduplicate and save message metadata
        |
        v
Store approved attachment types outside public web storage
        |
        v
Create email.message.received and attachment events
        |
        v
Classify sender, intent, and workflow
        |
        v
Process, approve, update, notify, and audit
        |
        v
Move/flag message according to outcome
```

### 6.5 Attachment handling

Initial supported types:

- CSV.
- XLSX after a reviewed parser dependency is added.
- PDF for text extraction and human review; automated interpretation should be introduced cautiously.

Controls:

- Sender allowlist and supplier identity mapping.
- File-size limit.
- Extension and MIME validation.
- Safe server-generated filename.
- SHA-256 hash.
- Malware scanning where available.
- No macro execution.
- No spreadsheet formula execution.
- Storage outside the public directory.
- Retention and deletion policy.
- Original file preserved for audit.
- Parser version recorded.

---

## 7. WhatsApp architecture

Use the official WhatsApp Business Platform, normally Meta WhatsApp Cloud API or an approved provider using the official platform.

Do not rely on WhatsApp Web scraping, browser automation, or an unofficial personal-account library. Those approaches are fragile, may violate platform rules, and can expose the business account to disruption.

### 7.1 Inbound flow

```text
WhatsApp message
       |
       v
Verified provider webhook
       |
       v
Webhook signature and replay validation
       |
       v
Message saved and event created
       |
       v
Phone number matched to verified customer/contact
       |
       v
Intent interpreted
       |
       v
Policy selects read tool, approval, or escalation
       |
       v
Response queued and audited
```

### 7.2 Safe initial capabilities

- Check order or job status.
- List outstanding jobs for the verified account.
- Ask for an expected completion or dispatch date.
- Confirm receipt of a document or request.
- Receive approved status-change notifications.
- Escalate a problem to staff.
- Answer controlled knowledge-base questions.

### 7.3 Initially prohibited capabilities

- Change a prescription.
- Cancel or remake a job without approval.
- Change pricing or credit terms.
- Issue refunds or credits.
- Reveal data for another customer.
- Change account identity or ownership.
- Make commitments unsupported by recorded facts.

### 7.4 Identity and consent

A phone number is not enough for every action. The system requires:

- Customer/contact mapping.
- Verification state.
- Allowed accounts and roles.
- Opt-in and template consent where required.
- Re-verification for sensitive actions.
- Message retention policy.
- Staff handoff and conversation ownership.

---

## 8. First complete business workflow

The first vertical slice should prove the architecture end to end:

> Supplier email attachment -> normalized supplier rows -> job matching -> proposed status changes -> approval -> app-owned status projection -> customer notification intent.

### 8.1 Detailed flow

1. A message is retrieved from a development mailbox, fixture, or manual test upload.
2. Sender, subject, date, provider identifier, and message hash are recorded.
3. The attachment is saved safely and hashed.
4. An `email.message.received` event is created.
5. A `supplier.status_file.received` event is created for the attachment.
6. The supplier is identified from approved configuration.
7. The appropriate parser and parser version are selected.
8. Required columns, row count, file type, and limits are validated.
9. Rows are normalized to a common supplier-status contract.
10. Duplicate, malformed, unknown-status, and missing-reference rows become exceptions.
11. Job references are matched using a read-only adapter.
12. Exact matches create proposed status actions.
13. Ambiguous or unmatched rows become exceptions.
14. Customer-facing status is derived separately.
15. Low-risk app-owned updates may be auto-applied according to policy; medium-risk changes wait for approval.
16. Approved actions update only app-owned projection records in the first milestone.
17. One notification intent is created when customer-visible status materially changes.
18. No live notification is sent in the foundation milestone; use a test outbox.
19. Every step is visible in activity history.
20. Reprocessing the same email or file produces no duplicate event, action, projection, or notification.

### 8.2 Normalized supplier row

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

### 8.3 Status separation

Supplier/internal statuses may be detailed:

- RX generated.
- Surfacing.
- Polishing.
- Hard coat queue.
- AR chamber.
- Tinting.
- Quality control.
- Packed.
- Dispatched.

Normalized internal statuses can initially be:

- `RECEIVED_BY_SUPPLIER`
- `IN_PRODUCTION`
- `QUALITY_CONTROL`
- `READY_TO_SHIP`
- `SHIPPED`
- `ON_HOLD`
- `CANCELLED`
- `UNKNOWN`

Customer-facing statuses should be simpler:

- Order received.
- In production.
- Quality checks.
- On the way to Classic Visions.
- Delayed - being reviewed.
- Completed.

Unknown supplier wording must create a mapping exception rather than silently selecting a customer status.

---

## 9. Foundation data model

The existing operations-agent brief defines the initial tables. The full target should account for the following entities, implemented in phases.

### Foundation tables

- `ops.Events`
- `ops.Attachments`
- `ops.Actions`
- `ops.Approvals`
- `ops.Exceptions`
- `ops.StatusProjection`
- `ops.NotificationOutbox`
- `ops.ActivityLog` if the existing audit implementation is insufficient

### Communications tables

- `ops.Conversations`
- `ops.Messages`
- `ops.MessageParticipants`
- `ops.ContactIdentities`
- `ops.CommunicationConsents`
- `ops.NotificationTemplates`

### Automation-control tables

- `ops.WorkflowDefinitions`
- `ops.WorkflowVersions`
- `ops.WorkflowRuns`
- `ops.Schedules`
- `ops.Integrations`
- `ops.IntegrationCheckpoints`
- `ops.FeatureFlags`
- `ops.PolicyVersions`
- `ops.PromptVersions`

### Reliability and governance tables

- `ops.DeadLetters`
- `ops.ReconciliationRuns`
- `ops.ReconciliationDifferences`
- `ops.ServiceLevelBreaches`
- `ops.DataRetentionQueue`
- `ops.ModelUsage`
- `ops.QualityEvaluations`

Not all tables belong in Milestone 1. The code should nevertheless avoid assumptions that prevent them later.

---

## 10. Agentic capabilities that were not explicitly requested but are necessary

These are the less visible capabilities that turn an impressive demo into a dependable business system.

### 10.1 Idempotency and duplicate safety

Email providers, webhooks, users, and workers can all retry. Duplicate delivery must be treated as normal.

Use deterministic keys for:

- Retrieved messages.
- Attachments.
- Parsed source rows.
- Proposed actions.
- Applied updates.
- Outbound notifications.

### 10.2 Claim leases and crash recovery

A worker must claim an event or action for a limited time. If it crashes, the lease expires and another worker can safely continue.

### 10.3 Dead-letter handling

After bounded retries, failed work moves to a dead-letter state with full context. It must not loop forever or vanish.

### 10.4 Reconciliation

Automation cannot rely only on its own success response. Periodic reconciliation compares:

- Supplier file versus imported rows.
- App status versus source system.
- Notification outbox versus provider delivery state.
- Website projection versus app projection.
- Expected scheduled runs versus actual runs.

### 10.5 Circuit breakers

When an integration is failing or returning unexpected data, automatic calls should pause rather than generate a storm of failures or bad writes.

### 10.6 Feature flags and operating modes

Each major workflow should support appropriate modes:

- Disabled.
- Observe only.
- Simulate.
- Require approval.
- Limited auto-execution.
- Fully enabled within policy.

### 10.7 Data lineage

The system should answer:

- Which email or file produced this status?
- Which parser and mapping version interpreted it?
- Which rule or model proposed the action?
- Who approved it?
- Which worker applied it?
- Which customer messages resulted?

### 10.8 Schema and workflow versioning

Events, supplier parsers, status mappings, policies, templates, prompts, and API contracts must be versioned. Historical activity must remain interpretable after a newer version is deployed.

### 10.9 Business calendar and SLA engine

Expected processing times should consider working days, holidays, supplier calendars, dispatch days, and time zones. This supports meaningful delayed-job detection rather than simplistic elapsed-hours checks.

### 10.10 Ownership and escalation

Every exception type and integration must have an owner. Escalation can progress from staff member to manager to Russell based on severity and age.

Russell should not receive every operational notification. He should receive only defined high-impact exceptions, sales opportunities, decisions, and unresolved risks.

### 10.11 Human handoff

Email and WhatsApp conversations need an explicit handoff state so the agent stops replying while a staff member owns the conversation.

### 10.12 Approval policy matrix

Actions should be classified by risk and authority, for example:

| Action | Default policy |
|---|---|
| Read customer order status | Automatic after identity check |
| Update app-owned supplier status projection | Approval during prototype; policy-based later |
| Send routine status notification | Automatic from approved template |
| Write status to Innovations/PSQL | Disabled initially; explicit adapter and approval later |
| Change price or credit terms | Authorized human approval |
| Issue refund or credit | Financial approval, possibly two-person review |
| Change prescription or clinical data | Restricted human-only workflow |

### 10.13 Prompt and model governance

AI behavior should not change invisibly. Record model, prompt version, structured output, confidence, latency, cost, redaction result, and human correction.

### 10.14 Evaluation and correction loop

Maintain synthetic test messages and supplier files. Measure extraction accuracy, job matching, status mapping, false escalation, and customer-message quality before promoting a model or prompt.

### 10.15 Privacy, retention, and minimization

Only necessary data should be passed to external services. Messages and attachments require retention rules. Sensitive data should be redacted where possible, and deletion should be controlled and auditable.

### 10.16 Backup and disaster recovery

Back up:

- Private MSSQL application data.
- Integration configuration and encrypted secret references.
- Attachments and message artifacts required for audit.
- Notification and event history.
- Deployment configuration.

A backup is not proven until restore testing succeeds. Record restore-test date and result.

### 10.17 Cost and capacity controls

The platform needs daily and monthly limits for AI usage, messaging, storage, and high-volume workflows. Unexpected volume should create an exception rather than an uncontrolled bill.

### 10.18 Security incident controls

Provide a kill switch for outbound communication and source writes. Record suspicious sender activity, repeated failed verification, webhook signature failure, and unusual access volume.

### 10.19 Explainability

Every automatic action presented to staff should have a concise reason, such as:

> Supplier A file row 14 matched job CV-10482 by exact supplier order number. Status `COATING` mapped through Supplier A Status Map v2 to `IN_PRODUCTION`. Customer projection changes from `Order received` to `In production`.

### 10.20 Operational metrics

Track:

- Automation rate.
- Manual touches per order.
- Average event processing time.
- Approval turnaround.
- Exception rate and age.
- Duplicate prevention count.
- Notification success and delivery time.
- Integration availability.
- Supplier turnaround performance.
- Estimated staff time saved.
- Customer status enquiries avoided.

---

## 11. Scheduling strategy

Cron-style schedules remain useful, but the schedule must only request work.

Good:

```text
Every 10 minutes -> enqueue schedule.email_sync.requested
Every hour -> enqueue schedule.integration_health_check.requested
Every morning -> enqueue schedule.daily_operations_summary.requested
```

Bad:

```text
Every 10 minutes -> read email, parse every file, update all systems,
send messages, and delete temporary data inside one untracked script
```

For the Windows-first deployment:

- Use Windows Task Scheduler or a Windows service wrapper to ensure OptiLens Local and workers restart after boot or failure.
- Use the app scheduler for business schedules stored in the database.
- Use cron expressions as a portable schedule representation if helpful.
- Persist next-run and last-run state.
- Detect missed runs after downtime.
- Prevent overlapping runs of the same workflow unless explicitly allowed.

---

## 12. API approach

OptiLens Local should expose bounded, authenticated internal APIs for operations and a narrower customer-safe API for the public website.

### Internal operations API examples

- `GET /api/operations/summary`
- `GET /api/operations/events`
- `GET /api/operations/events/:id`
- `GET /api/operations/actions`
- `POST /api/operations/actions/:id/approve`
- `POST /api/operations/actions/:id/reject`
- `GET /api/operations/exceptions`
- `POST /api/operations/exceptions/:id/resolve`
- `GET /api/operations/activity`
- `GET /api/operations/integrations`
- `POST /api/operations/workflows/:id/simulate`

### Customer-safe API examples

- `GET /api/customer/orders`
- `GET /api/customer/orders/:id/status`
- `GET /api/customer/conversations`
- `POST /api/customer/status-requests`

Customer APIs must use a customer identity from authentication. They must not accept an arbitrary account number and trust it.

### API contract controls

- Versioned routes or schemas.
- Request and response validation.
- Bounded pagination.
- Rate limits.
- Correlation IDs.
- Safe error messages.
- Idempotency keys for mutations.
- Audit linkage.
- Contract tests between the two repositories.

---

## 13. Security model

The current local credential vault and session implementation may be acceptable for internal prototyping, but email, WhatsApp, customer identity, and source-write credentials require a stronger production path.

Required controls include:

- Secrets stored in environment variables, Windows DPAPI, or an approved secret store.
- No secrets in browser JavaScript or repository files.
- Separate credentials and minimum permissions for each connector.
- Credential expiry and rotation alerts.
- Webhook signature verification and replay protection.
- Role-based access to approvals, policies, credentials, and source writes.
- Customer/contact identity verification.
- Field-level filtering before AI calls.
- No AI-generated SQL.
- Parameterized database access.
- Attachment limits and scanning.
- Append-only or tamper-evident audit history for material actions.
- Session expiry, secure cookies or tokens, CSRF protection where applicable, and login-rate controls.
- Network boundaries between public website, gateway, local services, and legacy databases.
- Outbound destination allowlists.
- Emergency disable controls.

---

## 14. Deployment and runtime shape

The first route remains Windows-first and dependency-conscious.

A practical runtime can begin as:

- OptiLens Local web process.
- Operations worker process, or a worker loop isolated from HTTP request handling.
- MSSQL private app database.
- Secure local attachment directory.
- Windows service/task startup and restart controls.
- IIS reverse proxy where already intended.
- Health endpoint and integration-health screen.

As load and criticality grow, workers may be separated by responsibility. A distributed message broker is not required for the first milestone, provided the MSSQL-backed event and action queues are durable and use safe claims.

---

## 15. Phased implementation plan

### Milestone 0: Repository reconnaissance and design confirmation

- Run existing tests and syntax checks.
- Inspect route, auth, audit, migrations, database, integration-health, and automation-job patterns.
- Confirm the existing operations placeholder and navigation.
- Record deviations between this brief and current code.

### Milestone 1: Operations foundation and simulated supplier workflow

- Operations schema.
- Event/action/approval/exception/activity services.
- Safe CSV fixture ingestion.
- Parser registry and one synthetic supplier parser.
- Read-only/mock job matching.
- App-owned status projection.
- Notification outbox only; no live send.
- Minimal Operations Console.
- Idempotency, retry, and tests.

### Milestone 2: IMAP email intake and SMTP test delivery

- Integration registry entries.
- IMAP connector with checkpointing and folder/flag handling.
- Optional POP3 fallback connector.
- SMTP connector and sent-message preservation.
- Sender allowlists and supplier mailbox routing.
- Live email disabled by default and enabled through explicit configuration.

### Milestone 3: Supplier parser expansion

- Reviewed XLSX dependency.
- Supplier-specific parser and status-map versions.
- Mapping review UI.
- Parser simulation and sample-file tests.
- Supplier turnaround and file-quality metrics.

### Milestone 4: Customer status API and website integration

- Customer-safe status projection.
- Versioned contract between `optilens-local` and `optilens`.
- Orders page integration.
- Customer identity and authorization tests.
- Portal notification history.

### Milestone 5: Controlled customer email notifications

- Template registry and approval.
- Notification worker.
- Delivery state and retries.
- Consent and preference handling.
- Quiet hours and frequency controls.

### Milestone 6: Official WhatsApp integration

- Verified webhook.
- Contact identity mapping.
- Read-only status intents.
- Approved outbound templates.
- Human handoff.
- Rate, consent, and safety controls.

### Milestone 7: Delayed-job and exception automation

- Business calendar.
- SLA rules.
- Delayed-job detection.
- Staff ownership and escalation.
- Customer-safe delay messages.

### Milestone 8: Controlled source-system write-back

- Explicit field-level adapter.
- Observation and simulation period.
- Before/after reconciliation.
- Approval policy.
- Rollback or compensation plan.
- Limited rollout and kill switch.

### Milestone 9: Broader business automation

- Statements and collections workflows.
- Inventory monitoring and reorder recommendations.
- Purchasing approvals.
- Inactive-customer and sales-opportunity alerts.
- Management dashboards and daily briefs.
- Supplier performance and gross-margin reporting.
- QuickBooks or other accounting integration after separate review.

---

## 16. Milestone 1 acceptance criteria

The first build is complete only when:

1. The existing application still starts.
2. Existing tests continue to pass.
3. The operations migration is rerunnable.
4. Events are durable and safely claimable.
5. The same fixture file cannot produce duplicate work.
6. A valid synthetic supplier CSV creates expected proposed actions.
7. Invalid and unmatched rows become understandable exceptions.
8. An authorized user can approve or reject an action.
9. Approval writes only to app-owned prototype projection records.
10. Notification intent is deduplicated and not sent live.
11. Every meaningful transition appears in activity/audit history.
12. Failed work can retry safely.
13. The Operations Console shows event, approval, failure, and exception states.
14. No credentials or real customer/supplier data are committed.
15. Tests cover parsing, mapping, idempotency, state transitions, authorization, and failure handling.
16. Codex reports exactly what was tested and does not claim unavailable database or integration tests succeeded.

---

## 17. Codex implementation instructions

Codex must read, in order:

1. `/AGENTS.md`
2. `/docs/operations-agent/BUSINESS_AUTOMATION_REVIEW_BRIEF.md`
3. `/docs/operations-agent/README.md`
4. `/docs/operations-agent/CODEX_BUILD_TASK.md`
5. Relevant existing code and tests

Codex must:

- Work on a feature branch.
- Keep commits small and reversible.
- Preserve existing behavior.
- Avoid broad refactoring.
- Use existing repository patterns when safe.
- Add tests with behavior changes.
- Use synthetic data.
- Document assumptions and deviations.
- Stop rather than invent credentials, source-table meanings, supplier formats, or write-back behavior.
- Treat this document as the product and architecture context, and `CODEX_BUILD_TASK.md` as the immediate Milestone 1 execution scope.

Codex must not:

- Put the whole implementation in `server.js`.
- Give AI direct database access.
- Add live WhatsApp or source write-back in Milestone 1.
- Create an in-memory-only event queue.
- Swallow failures without an exception or activity record.
- Add unbounded list endpoints.
- Commit secrets or realistic private data.
- claim the prototype is production-ready.

---

## 18. Decisions currently assumed

These assumptions should be reviewed, but they are safe enough for the architecture brief:

- OptiLens Local is the internal operations engine.
- The OptiLens website is the customer-facing channel.
- The private app MSSQL database owns automation state and customer-safe projections.
- Innovations/PSQL are read-only during the foundation milestones.
- IMAP is preferred over POP3; POP3 remains a fallback.
- SMTP is the initial outbound email mechanism.
- WhatsApp uses the official Business Platform.
- The first live business use case is supplier-status attachment processing.
- The first implementation uses a short-lived feature branch and a draft pull request before merging to `master`.
- The system begins with approval-heavy operation and earns greater autonomy through measured reliability.

---

## 19. Questions that can be answered later without blocking Milestone 1

- Which exact mailbox provider and IMAP/POP/SMTP server settings are used?
- Which mailbox or folder will suppliers send status files to?
- Which supplier should be integrated first?
- What are that supplier's actual CSV/XLSX columns and status terms?
- Which fields in Innovations identify the supplier order and customer job?
- Which customer status changes warrant a notification?
- Which staff roles can approve status updates?
- Which public website environment should first consume the customer-safe API?
- Where should external-facing API gateway code run relative to the local network?
- Which WhatsApp Business provider and phone number will be used?
- What retention periods apply to messages and attachments?
- Which actions should eventually be automatic, approval-based, or prohibited?

The prototype must use synthetic fixtures and adapters until these are explicitly supplied.

---

## 20. Long-term outcome

The mature system should behave less like a bot waiting for commands and more like a disciplined operations team:

- It watches the work arriving.
- It knows which process applies.
- It prepares or performs routine steps.
- It checks its own results.
- It asks for approval at defined boundaries.
- It escalates exceptions to the correct person.
- It keeps customers informed using verified facts.
- It records every material action.
- It learns through reviewed rules, mappings, prompts, and corrections rather than uncontrolled self-modification.

The desired end state is not that Russell has no visibility into operations. It is that he has high-quality visibility without being the person who manually moves every process forward.

---

## 21. Review checklist

Before approving this brief, confirm whether the following statements match the intended direction:

- OptiLens Local should become the operating engine for Classic Visions.
- The public OptiLens website should remain a secure customer channel, not a duplicate operations engine.
- Email must support IMAP and, where necessary, POP3, with SMTP for outbound messages.
- Supplier CSV and Excel attachments should ultimately update job status through controlled workflows.
- WhatsApp should support customer interaction through the official Business Platform.
- AI should interpret and propose, while deterministic rules and approval policies control execution.
- The first prototype should prove supplier attachment ingestion through customer notification intent.
- Source-system writes, financial decisions, pricing, prescriptions, credits, and cancellations remain restricted until explicitly designed.
- Auditability, retries, reconciliation, monitoring, backups, and security are part of the product, not optional cleanup work.
- The system should be expanded iteratively, with each milestone becoming part of the permanent architecture.
