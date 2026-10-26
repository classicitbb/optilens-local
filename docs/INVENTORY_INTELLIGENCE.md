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

The Draft PO preview also offers read-only review of existing Innovations purchase orders. Saved is the default status filter; On Order, Back Order, and All are also available. A blank search browses the selected status. Search by exact numeric PO number or a lens OPC/UserSKU barcode, then expand a PO directly below its row to inspect all lines and ordered/received quantities. Every summary column can be sorted; Created descending is the default. Results are capped at 50 in the selected sort order, so a specific PO number or barcode helps narrow a long history. Barcode matches use the stock item's chiral side. Status labels come from Innovations `POStatus`, while `CommitDate` is labeled as an Innovations commit time rather than proof of supplier transmission. This review reads `POHeaders`, `POItems`, `POStatus`, `Vendors`, `StockItems`, and `LensItem` through the read-only source connection; it never creates or changes a PO. The Audit trail is a collapsible section inside Scan history.

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

## Clearance catalogue review draft

Administrator preview: /modules/inventory-clearance (HTML alias /clearance-catalogue.html).
The authenticated read endpoint is GET /api/inventory-intelligence/clearance-catalogue.
This is a separate sale-data projection; the private cockpit has no anonymous route.

lib/inventory/clearance-service.js rechecks active write-off recommendations using
current inventory, policy, approved settings and shelf-count metadata with the existing
confidence and replenishment calculators. It writes no recommendations or tasks.
Zero/negative stock, changed classifications, invalid costs and missing identities
are excluded. A truncated source read fails the refresh. Lens quantities include
right + left + paired stock times two, with handed SKUs and stock breakdowns visible.

Owner-confirmed cost convention for this workflow: the numeric LensItem.Cost is
supplier USD cost PER PAIR despite its source BBD-each presentation. Clearance price
in BBD per lens is Cost / 2 * 2.66, rounded to two decimals. No source cost or other
valuation behaviour is changed. Missing/zero costs do not become free offers.

The successful review is cached for 24 hours, refreshing on the first authenticated
request after expiry. An open page checks expiry each minute. Refresh failure does
not serve an expired catalogue. This is daily refresh on access, not an installed
scheduled task or an external publishing connection.

Run node scripts/export-clearance-catalogue.js to create the standalone review HTML
under ignored output/clearance-catalogue/index.html. Optional --snapshot and --output
arguments support reproducible exports. Exported fields are allowlisted and script
delimiters escaped. Source costs, internal ids and review notes are not exported.
An export is a time-limited snapshot, not a connected external webpage.

External hosting and the daily outbound publishing transport remain pending the
hosting choice and explicit deployment/publication approval. Never expose the
private inventory API or source database to publish the catalogue.

### Confirmed grid and publication refinements
The owner chose the existing Classic Visions website, an unlisted private link with
no menu/sitemap entry, and material/manufacturer/design/colour optical matrices.
Progressive/bifocal (and other supported multifocal) quantities are whole pairs:
OnHand_P + min(OnHand_R,OnHand_L). Single vision shows eaches:
OnHand_R + OnHand_L + 2*OnHand_P. Unmatched multifocal lenses are hidden.
BBD prices are rounded per sale unit: supplier USD pair cost *2.66 for pairs,
or pair cost /2*2.66 for eaches. Diameter stays separate within a family.
All grid columns are uniformly 80px and colours follow the host site's semantic tokens.
The website branch prepares server-side, admin-only family suppression that survives
daily snapshot replacement; this does not alter the source lens catalogue.

The office publisher command is node scripts/publish-clearance-catalogue.js (dry run).
--commit requires explicitly authorized outbound publication, a scoped catalog:write key,
a secure receiver URL and a private link token in approved host-local configuration.
Configuration names are OPTILENS_CLEARANCE_PUBLISH_URL, OPTILENS_CLEARANCE_API_KEY and
OPTILENS_CLEARANCE_LINK_TOKEN. Values never belong in repository files or logs.
The daily task installer defaults to preview and is not installed by this build.
