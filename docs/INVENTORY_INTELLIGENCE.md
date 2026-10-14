# Inventory Intelligence

Internal replenishment cockpit at `/modules/inventory-intelligence`, linked from Business Metrics. It reads stock, usage and open
purchase orders from Innovations (read-only), calculates deterministic recommendations,
and turns each actionable one into a task a person decides. Nothing here orders anything,
writes to Innovations or changes the lens table. Build brief:
`INVENTORY_INTELLIGENCE_COCKPIT_BUILD_TASK.md`.

## Flow

```text
Innovations (SELECT only)  ->  evidence  ->  calculator (pure, deterministic)
   -> recommendation (versioned) -> operational task -> person decides
   -> approved ItemReplenishmentSettings version (app DB only) -> recalculation queued
   -> draft PO preview reads approved settings only
```

Code is in `lib/inventory/`: `calculator.js` (rules), `confidence.js` (data quality),
`source-adapter.js` (the only code that touches Innovations), `recommendations-service.js`,
`task-service.js`, `settings-service.js`, `count-service.js`, `events.js` (durable queue),
`scan-runner.js`, `draft-po-service.js`, `audit-service.js`, `routes.js`. UI is
`public/business-metrics-inventory-intelligence.js`, mounted by `public/inventory-intelligence.html`.

## Rules the code enforces

- **Usage** is `0.7 x (30-day / 30) + 0.3 x (90-day / 90)`; weights are rows in
  `core.app_settings` (`inventory_weight_30`, `inventory_weight_90`), normalised to sum to 1.
  Both windows are kept on every recommendation. There is no lifetime average.
- **Open PO** quantity is subtracted before an order is suggested. If stock alone is short but
  stock plus PO meets the requirement, the item is **Already Covered by PO**, never Order More.
- **MOQ / pack multiple** round upward only when an order is required.
- **Order Less** fires when the approved order point is materially above what demand supports,
  or stock is far above the cover ratio. **Write-Off Review** is a review task, not a write-off.
- **No demand evidence, no order.** An item with no usage in 90 days and no approved setting is
  never suggested for ordering.
- **Low confidence gates ordering.** Negative stock, a stale count or a missing/conflicting
  supplier produces a shelf-check, supplier-mapping or item-data task instead of an approvable order.
- Thresholds come from `core.app_settings` (`inventory_*`). Their effective values are hashed into
  a policy version stored on every recommendation.

## Safety guarantees

- The source adapter sends a single SELECT and refuses anything else. If Innovations is
  unreachable the scan **fails visibly** and changes nothing; it never substitutes sample data.
- A database failure is an error, never a silent fallback to memory. The in-memory model exists
  for automated tests only.
- Approval is one transaction: re-read and lock the recommendation, check the approved-settings
  version has not moved, write the settings version, move the task, write the audit record,
  queue a recalculation. Repeating an approval is harmless.
- A decided recommendation is never edited. A change that matters creates a linked revision.
  Rejected situations are not re-raised for 30 days unless the proposal changes materially.
- `inventory.audit_events`, `inventory.task_history` and `inventory.stock_count_results` are
  append-only, enforced by `INSTEAD OF UPDATE, DELETE` triggers in migration 053.
- Mutations take an `Idempotency-Key`; the key is the correlation id on the audit records.
- API errors are safe: only deliberate messages are returned; SQL errors and hosts are logged
  server-side. There is no customer-facing route.

## Access

Reads need `inventory.read`, `delivery.read` (the existing Business Metrics read authority) or
`platform.admin`. Anything that changes state needs `inventory.write` or `platform.admin`.
The page itself is administrator-only (`/modules/inventory-intelligence`).

## Operating it

Apply migration `053-inventory-intelligence.sql` through the normal update path (it is in
`lib/migrations.js`). Then, from the Inventory Intelligence workspace, **Run full scan**.

The scheduled full scan is a command, not an installed task:

```powershell
npm run inventory:scan            # queue and run a scheduled full scan
npm run inventory:scan -- --drain # only process requests already queued
```

It exits non-zero if a scan fails. Schedule it (for example daily, early morning) once the
owner has approved the schedule; the app does not install it.

Recalculation requests (`inventory.recalculation_requests`) are queued by: a manual or
scheduled scan, an approved settings change, and a recorded shelf count. They are processed
a couple of seconds later by the web app, or by `npm run inventory:scan -- --drain`.

## Known limits (read before trusting a number)

- Usage comes from RxArchive job history. Only about 63% of jobs carry a lens reference, so usage
  undercounts by roughly a third, unevenly. The cockpit prints this caveat.
- Open PO quantity is the item-level `LensItem.OnOrder_*` balance. Individual PO lines are not
  walked for receipt or cancellation, and the confidence signal says so.
- "Last counted" is known only for counts recorded in this app. Counts made in Innovations stock
  control are not read, so most items show "never counted here" until someone counts them.
- Events that happen inside Innovations (new orders, PO receipts) are not pushed to this app; they
  are picked up by the next scan. Item-level recalculation requests are for events this app owns.
- A shelf count does not change stock in Innovations. If the shelf and the system disagree, the
  item is flagged for someone to correct the stock record there.
- The draft PO is a review preview. It is not stored and nothing is sent to a supplier.
- Unit tests run against the in-memory model. The SQL paths were reviewed but have not been run
  against a live SQL Server from the development machine; verify on the host after the migration.
