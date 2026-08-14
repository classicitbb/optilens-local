# Codex Build Task: OptiLens Local Inventory Intelligence Cockpit

## Project and scope

**Project:** OptiLens Local
**Module location:** Business Metrics → **Inventory Intelligence**
**Audience:** internal staff only. This module, its APIs, recommendations, work queues,
tasks, audit history, and stock/supplier evidence must have no customer-facing route,
portal projection, or public API exposure.

## Purpose

Build an intelligent replenishment cockpit that monitors item usage, stock, and open
purchase orders (POs), then makes deterministic, reviewable replenishment
recommendations. It turns those recommendations into managed operational work rather
than directly changing purchasing settings or source inventory data.

The cockpit answers:

- What should be ordered now, and why?
- Which items are already covered by an open PO?
- Which items appear overstocked, stale, unreliable, or in need of a physical shelf
  count?
- Which proposed replenishment changes are awaiting an authorized decision?

This is an internal decision-support and approval workflow. It is not a customer
feature and it must not write directly to the live `LensItem` table.

## Non-negotiable rules

1. The calculation engine is deterministic. AI may summarize evidence or help explain
   an approved result, but it may not calculate the authoritative recommendation,
   create an unvalidated write, or update source tables.
2. Usage must use weighted recent windows, not a simple lifetime average. The model
   must retain the 30-day and 90-day evidence separately.
3. Open PO quantity must be considered before suggesting another order, so supply is
   not double-ordered.
4. Suggested quantities must respect a supplier/item minimum order quantity (MOQ) and
   pack multiple; the calculation rounds upward only where an order is required.
5. Each recommendation creates, links to, or updates an operational task. Repeated
   scans must be idempotent and must not create duplicate unresolved tasks for the
   same item and recommendation purpose.
6. Only an approved task may write to the app-owned `ItemReplenishmentSettings`
   table. Draft POs must read approved settings only, never a pending recommendation.
7. Do not update the live lens item table, Innovations, PSQL, or a supplier system in
   this milestone. Source access is read-only.
8. Every scan, recommendation transition, task transition, edit, approval, rejection,
   approved-setting write, and draft-PO use must have audit context.
9. Low-quality, conflicting, or unmapped data is surfaced as a confidence signal and
   an exception/task; it is never silently treated as trustworthy.

## User experience

### Dashboard

Add **Inventory Intelligence** as an internal Business Metrics entry. It may be an
Inventory-tab subview or a first-class module route, but it must be reachable from the
Business Metrics navigation and obey existing authenticated module permissions.

The dashboard contains these KPI cards. Each card opens its filtered work queue:

| Card | Queue meaning |
|---|---|
| Order More | Items with a supported replenishment shortfall not already covered by an open PO. |
| Order Less | Items whose approved setting or proposed quantity is materially above weighted demand. |
| Write-Off Review | Slow/non-moving or obsolete-risk stock requiring a write-off decision; not an automatic financial write-off. |
| Shelf Check | Items whose stock position or confidence requires a physical count. |
| Pending Approval | Replenishment recommendations/tasks awaiting an authorized decision. |
| Already Covered by PO | Items where open PO supply covers the current replenishment need; shown to make non-ordering visible. |

Each card shows the count, priority/severity, and a concise value-at-risk or unit
context. Cards must distinguish “no work” from “data unavailable.”

### Work queue

The work queue supports the six card filters, search, sorting, bounded pagination,
and a clear current-scan timestamp. Each row shows:

- item
- supplier
- on hand
- open PO quantity
- 30-day usage
- 90-day usage
- trend indicator
- days of stock remaining
- supplier lead time
- suggested order quantity
- recommended actions
- confidence

Evidence must be visually separate from recommended actions. For example, evidence
columns and an expandable evidence summary can appear on the left, while a distinct
action area shows the recommendation, state, and task controls. Do not present a
suggested order as if it were an approved PO.

Queue actions:

- Approve all — only homogeneous, eligible recommendations the current user may
  approve; report skipped rows and reasons.
- Edit values — edits the proposed values and records a new proposed revision; it does
  not edit the live item table.
- Approve selected.
- Reject — requires a reason.
- Assign shelf count — creates or assigns the related shelf-count task.

### Detail drawer

Opening a row displays a detail drawer with two visually equal, side-by-side areas:

| Metrics and evidence | Recommended actions |
|---|---|
| Current stock, open-PO coverage, usage windows, trend, days of cover, supplier/stock data freshness, calculation inputs, and confidence signals. | Proposed order point, proposed lead-time override, proposed reorder quantity, MOQ, pack multiple, suggested supplier changes, recommendation status, and linked operational task(s). |

The drawer must show evidence provenance and timestamps separately from recommendation
rationale. It must display audit history and let an authorized user perform the same
approve/edit/reject/assign actions as the queue.

## Deterministic monitoring and calculation engine

The engine evaluates an item/supplier replenishment position from app-approved settings
and read-only operational evidence.

### Inputs

- Current on-hand stock and its freshness/reliability.
- Open PO quantity for the same approved item/supplier mapping, net of received or
  cancelled quantity.
- Usage in the last 30 and 90 days.
- Trend derived from recent versus trailing demand, with an explicit neutral/unknown
  state when evidence is insufficient.
- Approved lead time, MOQ, pack multiple, safety-stock/order-point settings, and
  supplier mapping.
- Data-quality signals: stale stock, conflicting identity/supplier mappings, missing
  MOQ/pack data, incomplete PO state, negative stock, or inadequate usage history.

### Required calculation behavior

Use weighted daily usage, retaining the component windows in the result. The initial
implementation must make the weights configurable and auditable; a suitable starting
rule is a heavier 30-day component than 90-day component. Lifetime average is not an
allowed fallback.

At a minimum, calculate and persist:

```text
weightedDailyUsage = configuredWeighted(usage30 / 30, usage90 / 90)
leadTimeDemand     = weightedDailyUsage * effectiveLeadTimeDays
proposedOrderPoint = leadTimeDemand + approvedSafetyStock
availableCoverage  = max(0, onHand) + openPoQuantity
rawOrderQuantity   = max(0, proposedOrderPoint + targetCover - availableCoverage)
suggestedOrderQty  = roundUp(rawOrderQuantity, MOQ, packMultiple)
daysRemaining      = onHand / weightedDailyUsage, or UNKNOWN when usage is insufficient
```

`targetCover` and safety-stock policy must be explicit approved settings, not hidden
constants. A recommendation is **Already Covered by PO** when the open PO plus current
stock meets the approved target/coverage policy; it must not also appear in **Order
More** for the same calculation revision.

Write-off, order-less, and shelf-check rules must be deterministic, configuration-led,
and explainable. Their thresholds and sources are stored with the recommendation.

### Triggers

Create an idempotent recalculation request when any of these occur:

- new or revised usage data;
- a stock adjustment or stock-count result;
- an open-PO creation, quantity, receipt, cancellation, or status event;
- an approved replenishment-setting change;
- scheduled full scan.

The scheduled full scan enqueues work through the existing durable job/event pattern;
it does not run an unbounded purchasing process in a single request. A scan stores its
run ID, source watermark(s), input time, result summary, and errors.

## Data model

Use the private app database. Names may follow the repository schema convention, but
the ownership and fields below are required.

### `ReplenishmentRecommendation`

Stores a versioned, deterministic proposed change and its evidence snapshot.

- Recommendation ID, stable item ID, supplier/mapping ID, scan/run ID, and an
  idempotency key.
- Recommendation type/queue: `ORDER_MORE`, `ORDER_LESS`, `WRITE_OFF_REVIEW`,
  `SHELF_CHECK`, `ALREADY_COVERED_BY_PO`, or `DATA_REVIEW`.
- Status: `OPEN`, `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `SUPERSEDED`,
  `APPLIED`, `CANCELLED`.
- Evidence snapshot JSON and version: on hand, open PO coverage, 30/90-day usage,
  trend, days remaining, freshness, source references, and confidence signals.
- Proposed settings JSON: order point, lead-time override, reorder quantity, MOQ, pack
  multiple, supplier change, and rationale.
- Calculation version, policy/threshold version, confidence level/score, created,
  updated, superseded, and decision timestamps.
- Before/approved-setting snapshot, decision reason, actor, and linked task ID(s).

Never overwrite a decided recommendation. Create a new revision and link it to the
previous record when evidence or proposed values change.

### `OperationalTask`

Tracks the human workflow created from each recommendation. It contains:

- task ID, recommendation ID, item/supplier reference, and idempotency key;
- type, status, assignee, priority, due date, source/run reference;
- task payload/evidence reference, resolution/decision note, and audit correlation;
- created, updated, completed, cancelled, and escalation timestamps.

Task types:

- `APPROVE_REPLENISHMENT_CHANGE`
- `REVIEW_SUGGESTED_PO`
- `COUNT_SHELF`
- `REVIEW_WRITE_OFF`
- `REVIEW_OVERSTOCK`
- `RESOLVE_SUPPLIER_MAPPING`
- `CORRECT_ITEM_DATA`

Use a controlled status set such as `OPEN`, `ASSIGNED`, `IN_PROGRESS`,
`PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `COMPLETED`, `CANCELLED`, and `BLOCKED`.
Task history is append-only and records status changes, assignments, comments, edits,
approvals, and rejections.

### `ItemReplenishmentSettings`

This is the approved, app-owned source of replenishment truth that draft POs read.
It must retain the legacy/source item identity but must not write back to `LensItem`.

Required approved fields include:

- item and approved supplier mapping;
- active state;
- order point / safety-stock policy;
- lead-time days and approved override reason;
- reorder quantity;
- MOQ and pack multiple;
- supplier preference/substitution policy;
- approved recommendation/task reference, approver, timestamps, and version;
- effective-from/effective-to values where settings require history.

### `InventoryConfidence`

Stores current and historical data-reliability signals at item/supplier scope. Include:

- confidence score and level;
- stock freshness and last verified count;
- usage sufficiency and coverage window;
- PO completeness/freshness;
- supplier mapping quality;
- missing/invalid settings flags;
- reasons/evidence JSON and calculation timestamp.

Confidence must be exposed in the queue and drawer. Below the approved policy threshold,
the engine creates a shelf-check, supplier-mapping, or item-data task instead of an
auto-approvable ordering action.

### Audit and scan records

Reuse the platform audit facility only if it can provide immutable actor, action,
before/after, correlation, timestamp, and reason fields. Otherwise add an append-only
inventory audit table. Also persist scan/job run records and source watermarks so every
recommendation can be reproduced from the retained evidence snapshot.

## Approval and write-back workflow

```text
Read-only source events / scheduled scan
  -> deterministic calculation + evidence snapshot
  -> ReplenishmentRecommendation
  -> OperationalTask
  -> authorized decision (approve, edit-and-approve, reject, or shelf count)
  -> approved ItemReplenishmentSettings revision only
  -> audit record + recalculation request
  -> draft PO consumes approved settings only
```

Approval must transactionally re-read the recommendation/task state, authorization, and
current approved-settings version before applying. Duplicate approval requests must be
harmless. An edit-and-approve creates an auditable proposed revision and records the
human-supplied values/reason before it becomes an approved settings revision.

Rejecting preserves the evidence and recommendation; it never deletes history. A shelf
count result should create a stock-adjustment event for a later deterministic
recalculation, not mutate a recommendation in place.

## Draft PO support

Draft PO generation is a later step in this task, but its contract is fixed now:

- It reads only approved, effective `ItemReplenishmentSettings`.
- It reads current source stock and open-PO evidence to refresh presentation, but it
  cannot silently adopt a pending recommendation.
- It references the approved settings revision and task/recommendation lineage for
  every line.
- It remains a draft/review artifact in this scope; no supplier submission or source
  PO write-back is implied.

## Internal API and access requirements

All endpoints require authenticated internal access and existing/added Business Metrics
permissions. Customer roles and customer-facing applications receive none of these
endpoints or payloads.

Provide bounded, filterable APIs for:

- cockpit summary/KPI cards;
- work queues and a single recommendation/detail view;
- task listing, assignment, task history, and shelf-count assignment;
- recommendation approval, edit-and-approve, and rejection;
- approved replenishment-setting history;
- internal draft-PO preview based on approved settings;
- scan status/history and authorized manual scan enqueueing.

Mutation requests must validate enum transitions, use idempotency keys, enforce role
checks, and return safe error messages. Do not expose raw source SQL errors or source
credentials.

## Build order

Build and verify in this order. Keep each stage small, reversible, and covered by
tests before advancing:

1. UI shell — Business Metrics navigation, internal permission wiring, empty/loading/
   unavailable states, and no customer route.
2. Dashboard cards — six queue cards and correct filtered navigation.
3. Work queue table — required evidence and action fields, bounded filtering/sorting,
   visually separate evidence and actions.
4. Detail drawer — side-by-side metrics/evidence and recommendations/actions, with
   audit/task state presentation.
5. Data models — migrations for recommendations, tasks, approved settings, confidence,
   scan records, and required indexes/audit linkage.
6. Monitoring engine — read-only source adapters, deterministic weighted-usage and
   open-PO calculations, MOQ/pack rounding, confidence evaluation, event triggers,
   and scheduled full scan.
7. Approval workflow — task creation/deduplication, assignment, approval,
   edit-and-approve, rejection, shelf-count workflow, and full audit history.
8. Write back to approved settings — transactional revisions to
   `ItemReplenishmentSettings` only; no `LensItem` or source-system write-back.
9. Draft PO support — internal draft lines read approved settings only, with lineage.
10. Audit trail — end-to-end audit/query UI, scan provenance, retry/idempotency proof,
    and retention/visibility checks.

## Acceptance criteria

The task is complete only when all of the following are demonstrated with synthetic
test data and, where safe, read-only local data:

1. Inventory Intelligence is visible only inside authenticated internal Business
   Metrics and has no customer exposure.
2. The dashboard shows all six cards and each opens the correct queue.
3. Queue rows show every required metric/action/confidence field and evidence is
   visually distinct from actions.
4. The drawer shows metrics/evidence and recommendations/actions side by side,
   including linked tasks and audit history.
5. Weighted recent usage, trend, open-PO coverage, MOQ, and pack-multiple rounding are
   tested and explainable; no lifetime-average rule is used.
6. Open PO supply prevents duplicate Order More recommendations and is visible in the
   Already Covered by PO queue.
7. Every actionable recommendation creates or reuses an idempotent operational task
   with type, status, assignee, priority, due date, and history.
8. Approvals write only to `ItemReplenishmentSettings`; tests prove no direct update
   path exists to the live lens item table or source databases.
9. Draft PO output reflects only approved settings values and records their lineage.
10. Usage, stock-adjustment, and PO events enqueue recalculation; a scheduled full
    scan produces the same controlled result path.
11. Every material transition has a complete audit record and duplicate events or
    approvals create no duplicate settings writes, tasks, or draft lines.
12. Existing Business Metrics and operations workflows continue to function, and the
    relevant automated tests and manual internal UI checks pass.

## Explicitly out of scope

- Customer portal, website, email, WhatsApp, or public API exposure.
- Direct AI writes, AI-generated SQL, or AI as the source of the authoritative
  replenishment calculation.
- Direct write-back to Innovations, PSQL, `LensItem`, supplier systems, or live PO
  submission.
- Automatic financial write-offs or an autonomous purchasing agent.
- Replacing existing inventory source systems or changing historical source records.
