# Operations Agent + Zen Bridge — Implementation Plan

Date: 2026-07-16. Anchor documents: [README.md](README.md) (architecture brief) and
[CODEX_BUILD_TASK.md](CODEX_BUILD_TASK.md) (milestone-1 build task). This plan
records the decisions made on 2026-07-16 and sequences the work toward the first
revenue milestone: onboarding Caribbean island opticians onto the virtual lab with
portal-visible order status.

## Decisions (2026-07-16)

1. **Broken database:** `sourceMssql` (Innovations on `MSSQL-SVR/Innovations`) is not
   reliable yet. Until it is, source reads come from the live Actian Zen (Pervasive)
   Innovations database at `192.168.254.5:1583` (DSN `Innovations`).
2. **Bridge design: mirror database.** A new `innovations_mirror` database on the
   working app SQL Server, with the same table/column names as the source, refreshed
   from Zen via ODBC. The source connection is repointed at the mirror; all eight
   consumer modules (`source-innovations`, `innovations-sync`, `live-data-gateway`,
   `live-gateway-worker`, `shipment-sync`, `business-metrics`, `beswift-co`,
   `delivery`) keep their T-SQL untouched.
3. **Source backend switch (UI):** two named source profiles — `mirror` and `live` —
   persisted in the app database and switchable from a card on the integrations page
   with pre-flight health + row-count parity checks. The Zen sync keeps running after
   switching to `live` (warm fallback) until separately retired.
4. **Revenue motion:** onboard island opticians as export customers; differentiator is
   portal status visibility, statements, and published pricelists.
5. **Scope:** milestone-1 foundation **plus a real data spine** — real job matching
   against the mirror and approved statuses riding the existing `/profile/orders`
   feed. Live email/WhatsApp ingestion stays out of milestone 1 (manual XLSX upload).
6. **Portal status:** enrich the existing live-data-gateway → Supabase orders feed with
   the customer-facing status. No new Supabase tables (works within the Lovable
   ownership blocker).
7. **Supplier files are XLSX by email.** Approved deviation from the CSV-only rule:
   one vetted read-only XLSX dependency (`exceljs`), no formula/macro evaluation,
   values only, with tests. CSV support remains.
8. **Execution split:** Codex builds the ops-agent foundation per CODEX_BUILD_TASK.md
   (with the amendments noted there). Claude builds the Zen bridge, source switch,
   real adapters, XLSX parser, and portal enrichment.

## Phase 0 — Discovery (DONE 2026-07-16)

Findings from `scripts/zen-catalog-dump.js` (read-only; catalog JSON regenerable any
time by re-running the script):

- Dev machine has the 64-bit "Pervasive ODBC Interface" driver and DSNs
  `Innovations` (Zen) and `InnovaMSSQL`. Vault/env credentials resolve for both Zen
  and source MSSQL.
- **All 21 required source tables exist on Zen** (611 tables total): Customers (112
  rows), UserAccounts (17), ShippingMethods (19), EFTInstitutions (10), Contacts
  (128), CustomerAddresses (108), Countries (12), BuyinGroups (4), Shipments (9,663),
  ShipmentItems (38,079), Orders (124,687), OrderTypes (23), Invoices (88,805),
  InvoiceLines (361,512), FinARSalesJournal (64,579), CustomerBalances (88),
  StockLots (0), FinAROpenItems (677), FinARAgingPeriods (105), FinARStatements
  (4,138), FinARStatementItems (78,642).
- Spot-checked consumer columns (Customers, UserAccounts, ShippingMethods,
  EFTInstitutions, payment fields) all present with expected names.
- **Every target table has `LastUpdated` (TIMESTAMP) + `UpdatedBy`** — a universal
  watermark for incremental sync.
- Remaining parity risk is column-level on the less-inspected tables; it surfaces
  deterministically when consumer queries run against the mirror (T-SQL "invalid
  column name"), fixed in the sync layer, never in consumers.

## Phase 1 — Zen → mirror bridge + source switch (Claude)

1. **DDL generation** (`scripts/zen-mirror-ddl.js`): generate `innovations_mirror`
   CREATE TABLE statements from the Zen catalog. Full tables (all columns), same
   names, `dbo` schema. Type map: INTEGER→int, SMALLINT→smallint, TIMESTAMP→datetime2,
   DATE→date, TIME→time, CURRENCY→money, BIT→bit, (U)CHAR/VARCHAR→nvarchar(n),
   LONGVARCHAR→nvarchar(max), DOUBLE/FLOAT→float, DECIMAL/NUMERIC→decimal(p,s),
   AUTOINC/IDENTITY→int (no identity on mirror; values copied).
2. **Sync module** (`lib/zen-mirror-sync.js`):
   - Paged read-only ODBC pulls from Zen; transactional upserts (staging table +
     MERGE) into the mirror.
   - Small tables (< ~1,000 rows): full refresh each run.
   - Large tables: `LastUpdated > watermark` incremental, plus a nightly key-diff
     reconcile to catch hard deletes.
   - Per-table sync log (reuse `innovations-sync-log` patterns) and an
     integration-health entry ("Zen mirror: last sync, rows, lag").
   - Schedule: default every 15 min (`OPTILENS_MIRROR_SYNC_MINUTES`), using the
     existing automation-job/worker pattern; "Sync now" action on the integrations
     page.
3. **Source profile switch:**
   - Config exposes two named profiles: `mirror` (MSSQL-SVR/innovations_mirror) and
     `live` (vendor Innovations MSSQL). Active profile persisted in the app DB
     (settings table), read at pool creation; switching resets the source pool.
   - Integrations page card "Innovations Source": both profiles with live health
     probes, active one marked, switch button with pre-flight (connectivity + row
     count parity on Customers/Shipments/Orders), confirmation, audit record.
   - Read-only mode enforced on both profiles.
4. **Cutover to mirror:** flip the switch to `mirror`; run the test suite and smoke
   every consumer surface (dashboard, delivery/export, statements, live gateway,
   shipment sync, beswift, business metrics). Fix column gaps in the sync layer as
   they surface.
5. **Exit plan:** when the vendor MSSQL is correct and current, the integrations-page
   switch flips source reads to `live` instantly (pre-flight proves parity first).
   Retire the Zen sync via its own toggle once trusted; drop `innovations_mirror`
   after a comfort period.

## Phase 2 — Ops-agent foundation (Codex)

Execute [CODEX_BUILD_TASK.md](CODEX_BUILD_TASK.md) as written, with its 2026-07-16
amendments: XLSX parsing allowed via `exceljs` (values only), job-match adapter is an
interface with a mock implementation (tests/dev default) plus a mirror-backed real
implementation selected by configuration, and the source pool may be pointing at
`innovations_mirror` (transparent to all code using `getSourcePool()`).

## Phase 3 — Real data spine (Claude, after Phase 2 merges)

1. **Real supplier parser #1:** highest-volume supplier's XLSX; deterministic
   status-map config from their real status vocabulary; unknown wording → exception.
   Inputs needed: 2–3 anonymized sample files + supplier name.
2. **Production manual upload** in the ops UI (authenticated, size/MIME/SHA-256
   validation, stored outside public assets) — the operational path until mailbox
   ingestion (later milestone).
3. **Real job matching** against the mirror: supplier order number ↔ Innovations
   order/job references, confidence rules, unmatched → exceptions.
4. **Portal enrichment:** live-data-gateway payload gains the customer-facing status
   from `ops.StatusProjection` (fallback to current derivation); portal
   `/profile/orders` renders it. If the receiving edge function's allowlist needs the
   extra field, that is a code change in the cloud repo, not a Supabase migration.
5. Notification outbox stays record-only; staff copy outbox text into WhatsApp.

## Phase 4 — Onboarding (commercial, parallel with Phase 3)

- Publish pricelists to 1–2 pilot island accounts (expiring-token portal access).
- Orders keep flowing through existing channels into Innovations.
- Pilot differentiator: live status + statements + pricelist on the portal.
- **Money milestone:** first new island account ordering against a published
  pricelist while watching real statuses flow supplier-XLSX → approval → portal.

## Risk register

| Risk | Mitigation |
| --- | --- |
| Column-level Zen/MSSQL divergence on uninspected tables | Full-table mirror; failures surface as exact T-SQL errors at smoke-test time; fix in sync layer |
| Hard deletes invisible to watermark sync | Nightly key-diff reconcile; small tables full-refresh |
| Zen load during business hours | Paged incremental reads every 15 min; watermark keeps pulls small |
| Edge-function allowlist blocks new status field | Field addition is cloud-repo code, not a Supabase migration; verify during Phase 3 |
| Supplier XLSX chaos (merged cells, multiple sheets) | Parser registry is per-supplier; exceptions, never guesses |
| Vendor MSSQL fixed mid-build | Switch makes cutover a UI action; no code change |

## Inputs still needed from the operator

1. 2–3 sample supplier status XLSX files (anonymized OK) + which supplier goes first.
2. Pilot island account(s) for Phase 4.
3. Word when the vendor's Innovations MSSQL is believed correct (to run the parity
   pre-flight and flip the switch).
