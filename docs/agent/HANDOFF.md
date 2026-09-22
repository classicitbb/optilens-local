# Work Handoff

- Repository: `classicitbb/optilens-local`
- Status: In progress — RX Capture Milestone 1 deployed; authenticated real-image acceptance verification pending
- Last synchronized: 2026-09-22

## Objective and current state

RX Capture Milestone 1 is deployed as an additive feature in the existing server. `/rx-capture` is a full-screen, mobile-first authenticated page with camera/file intake, optional second image, recent owner-scoped orders, processing/failure states, structured patient/OD/OS/ADD/PD review, direct editable correction, and missing/uncertain highlighting. The backend uses the existing app database, cookie session, module access model, and Credentials Vault. It sends images server-side to the configured OpenAI Responses endpoint with strict JSON Schema and `store: false`; the API key is never exposed to the browser. The Credentials Vault is authoritative over stale machine-level `OPENAI_API_KEY` values, and a focused regression protects that precedence. Local temporary images are deleted after successful processing by default. `lib/rx-capture/normalized-order.js` is deliberately source-neutral so future manual entry, customer portal, API, and test-generator inputs can feed the same order engine.

Conditional clinical-field handling now distinguishes blank from illegible content: blank ADD is optional for single-vision or otherwise non-multifocal orders, blank prism/base values are optional even when the form prints those headings, and genuinely ambiguous marks remain in `uncertainFields`. Multifocal lens descriptions deterministically require OD and OS ADD. Seven operator-supplied prescription photos were inspected transiently from the private sample location and were not copied into the repository.

The review page now exposes every extracted lens field and an optional frame section. Frame data defaults to the explicit `TO_BE_TRACED` workflow without fabricated A/B/DBL/ED or segment heights; actual extracted or traced values can replace the blanks later. Missing frame and lens details no longer create `NEEDS_INFO`, while uncertain extracted values remain visible. Failed reprocessing with an older normalized order now labels the retained values instead of accidentally relying on CSS overriding the `hidden` attribute.

Milestone 1 does not include approval, lens/coating/frame catalogue workflow, deterministic `.rx` serialization, staging, or Innovations release. The guarded host deployment fast-forwarded the requested branch through revision `189bfb9`, passed smoke and the full 196/196 host suite, applied `043-rx-capture.sql`, restarted the application, and ended with all systems online. Read-only SQL verification confirmed the migration checkpoint, both `rx_capture` tables, and both permissions. Unauthenticated checks confirmed `/rx-capture` redirects to sign-in and `/api/rx-capture/orders` returns 401. No vault readout, billable model call, source-system write, or real patient-image test was performed.

RX Capture affected files are `database/043-rx-capture.sql`, `lib/rx-capture/*`, `public/rx-capture.html`, `public/rx-capture.js`, `public/styles/pages/rx-capture.css`, `test/rx-capture.test.js`, plus small registration/configuration changes in `server.js`, `lib/auth.js`, `lib/dashboard.js`, `lib/migrations.js`, `public/app.js`, `public/shared.js`, and `.env.example`.

RX Capture next acceptance action: assign RX Capture access to a test employee, then use an approved non-production prescription image in authenticated external Chrome or Edge to verify create → processing → review → correction → reopen with direct typing. A real extraction sends sensitive image data to the configured provider and may be billable, so it requires explicit authorization and must not invoke any Innovations release path.

Host Monitor recovery and the available runtime update completed on 2026-09-14. The previous service wrapper was stuck while accepting no control messages, and its interrupted dependency recovery left production modules incomplete. The verified wrapper and child process were released, production dependencies were rebuilt deterministically, and the registered service returned healthy. The guarded updater then passed its smoke check and full suite (184/184), restarted OptiLens Local successfully, relaunched the Host Monitor, and recorded a completed durable restart state. The final monitor harness verified all systems online; no update remains available.

Delivery Export refinements are complete locally and await deployment plus authenticated external-browser verification. Shared workflow/settings tabs now use top-only rounded corners with active tabs joined to their panels while utility icons remain rounded controls. The Commercial Invoice action sequence is `1 - Prepare Draft`, `2 - Save Draft`, `Print / PDF`, `3 - Queue Fill Job`; shipment/invoice outer containers are square and flush; and fill jobs render as a separator-based rectangular list. Invoice amounts are calculated from quantity × unit price and are read-only. Save and Queue now recompose certificate-eligible invoice items from persisted line overrides, so edited descriptions, customs details, quantity, and price enter every new BeSwift job snapshot; existing job snapshots remain immutable. Edged items enforce `90049000` (displayed as `9004.90.00.000`) despite historical manual HS or amount overrides. Focused invoice/document/design tests (17) and `npm run check` passed; the full `npm test` runner started with four passing assistant tests but did not reach a final result before the local 30-second command limit. No deployment, live-data write, or browser fill job was performed.

Restart progress and the CVWeb alias-tombstone receiver fix are implemented locally but not deployed. `scripts/restart-app.ps1` now writes atomic `data/service-restart-state.json` progress plus `data/logs/service-restart.log`, prevents overlapping runs with a bounded mutex, and finishes only after `/api/health/live` identifies `optilens-local`. The native Host Monitor reads those files directly once per second across the Node outage, shows a labelled `server.err.log` tail, and uses the same window for Restart and Super-user Fix errors. The running monitor executable was locked during rebuild; source compiled successfully to a temporary executable, so rebuild/relaunch remains an explicit host-maintenance action. CVWeb now updates inactive alias tombstones without inserting incomplete catalog rows, and the local sender test guards the minimal tombstone shape. Focused CVWeb and local sender tests passed; no external Edge deployment, committed sync, or controlled live restart was performed.


The portal invoice-line dialog had an approved cloud request path but the private OptiLens gateway did not implement or advertise `innovations.customer_invoice`, producing the empty state in the portal. `lib/live-data-gateway.js` now validates the invoice ID, verifies that it belongs to a non-hidden item on a non-void posted statement owned by the requested customer, and returns only non-suppressed `InvoiceLines` with description, quantity, unit price, and amount. Live order status now includes a posted invoice ID/total; delivery items retain their invoice ID/total so the portal can display prices and open invoice lines per job. The source-schema verification could not run because the configured read-only reporting account reports that its password has expired. No source, cloud, or host writes were made.

The paired portal search refinement is complete locally and awaits the normal
frontend/private-gateway release. `innovations.customer_orders` now returns the
already customer-authorized `order_id`, allowing the shared portal search to
match patient, Rx, or order number across both order status and delivery cards;
a unique delivery opens and flashes. `test/live-data-gateway.test.js` and
`test/delivery-export-current-shipments.test.js` pass (16/16), and the full
Local suite passes (189/189). The commercial-invoice date rule is already
implemented and tested: it uses `Shipments.ShippedTime`, falling back to the
app session's `closed_at`, never a grouped invoice date. No deployment,
restart, source read, or business-data write occurred. Next action: after
explicit release approval, deploy the paired Local gateway and CV Web frontend,
then use authenticated external Edge or Chrome to type a known patient, Rx,
and order ID and verify matching delivery auto-expands and flashes.

Innovations file-drop configuration is now available in Credentials Vault → Other → **Add Innovations incoming folder**. A non-empty `Incoming folder` value overrides only the RX/stock-order incoming destination at runtime; an empty or absent entry retains the existing RX configuration as the safe fallback. This applies consistently to staged RX releases, website-submitted RX file drops, and stock-order releases. Local syntax checks and 20 focused RX/Credentials tests passed. No vault setting, file drop, host restart, deployment, or external submission was performed.

The configured Innovations incoming-folder vault entry resolves at runtime for both RX and stock-order release paths. A host-level non-mutating metadata check confirmed that the destination is reachable. Both the RX and stock-submission workers are registered, ready, and completed their latest scheduled runs successfully. The earlier sandbox-only `EPERM` result was execution confinement rather than an application or folder-permission failure. A single explicitly marked controlled stock file was staged and released successfully; after the normal initial watcher window it remained present and was not renamed as rejected, so delivery is proven but watcher ingestion is still pending.

The authoritative guarded update completed successfully on 2026-09-02: revision `36cf9a2` was installed, its smoke gate passed, the full suite was advisory (170 passed / 2 pre-existing failures), and the application plus Host Monitor verified online. Commercial Invoice now prints `Currency of Sale: Barbados Dollars (BBD)` and `BBD $` amounts. The updater now automatically applies clean fetched `master` revisions, pauses and alerts through the configured incident channels on Git authorization failures, repairs incomplete dependencies safely, and records durable progress/status.

Maintenance recovery on 2026-09-01 completed successfully. The guarded local updater had a missing `Write-UpdateStatus` helper, causing a requested runtime update to exit before it created its durable status record. `scripts/apply-local-update.ps1` now persists state, message, revisions, smoke-check, and advisory test-suite results to `data/update-status.json`. A controlled guarded run passed its smoke check, restarted the service, relaunched the host monitor, wrote `Update completed.`, and the loopback update check reported no available runtime or Git updates. The full suite remains advisory and reported two pre-existing unrelated failures: an innovations-sync log expectation that omits an undefined `warnings` field, and an RX-generator source-validated-lens assertion.

The local test-suite regressions reported by the 2026-09-02 updater are repaired. RX generator coverage now selects any source-validated alias that has a supported RX profile and asserts the corresponding rendered profile, instead of requiring a currently available Single Vision alias. Document-preview helper tests normalize checkout line endings before extracting the browser helpers, so Windows `core.autocrlf` cannot produce false failures. The current complete suite passes 176/176; no host deployment or restart was performed.

The application, private app database, source database, and Host Monitor are online. The health screen still correctly reports the scheduled Innovations-to-Classic-Visions sync as failed. Its latest committed run completed all other entities but rejected one contact with a null mandatory `country` field and one lens alias with a null mandatory `material_code` field at the receiver. Do not supply guessed values or retry this external write until a data-remediation rule or source correction is approved.

Business Metrics' add-power `Sold as stock lenses` channel uses the live Innovations `Fulfillment` order type (`OrderType = 6`) rather than the legacy `Stock` / `Stock Debit` types (3/9). The former types yielded no current stock-lens volume, while fulfillment invoices contain the relevant OPC SKU lines. The source query continues to resolve all right, left, and pair OPC fields and reports both Progressive and Bifocal volume. The authoritative host checkout already contained the correction; its focused regression and full test suite passed, a controlled restart was issued, and the final health harness reported all systems online on 2026-08-31. External Edge reaches the live application but is currently at its sign-in page, so authenticated rendered verification remains pending.

Business Metrics Inventory now opens read-only detail lists from Not moving, Units moved, and Items tracked. Zero-cost inventory rows identify misc SKU values in the `OPC R / SKU` column and open a cached item-properties view; zero-cost invoice rows open a read-only invoice audit with every visible line's price, cost, revenue, and margin. Wide drawers become full-screen before horizontal scrolling. These local changes have not been deployed or authenticated-browser verified.

Credentials Vault deletion now persists an operator-selected removal without template reseeding on a later read, lock, or unlock. Supplier Automation now exposes protected action/exception detail routes, actionable mapping deep links, and a daily unresolved-items digest path. The digest is fail-closed: it remains disabled unless the explicit digest flag and Email-vault SMTP fields are configured; it sends only to the configured mailbox account and self-marked messages are ignored by the IMAP poller. New migration `041-supplier-exception-digests.sql` is registered but has not been applied. No SMTP delivery or source status write-back was enabled.

The Automation capability overview is now a collapsed native accordion. Source status write-back requires a separate least-privilege source writer, an explicit enabled flag, and a non-empty CurrentStatusID allowlist before it can connect or write. The local Credentials Vault now offers a dedicated `Source MSSQL Writer (Innovations)` SQL Server entry and configuration resolves it without falling back to the read identity. The change is not deployed; write-back remains unavailable until an operator stores that entry and separately authorizes the enable flag and status allowlist.

Delivery Export now uses one current-shipment universal search, compact invoice controls, per-shipment defaults, and an accessible resizable shipment split. Shipment prep has a page-header search, explicit active selection, and a viewport-filling preview. Commercial Invoice now defaults freight to 62, packages to 1, and delivery terms to Free on Board; uses a single pounds/kilos gross-weight input persisted as kilograms; defaults Customer order no. to the primary contact; traces shipment tracking before reference fallbacks; and labels stock/fulfillment commodity specifications. Read-only source and local checks found six zero-item rows in the local mirror while the current source had none; current empty Innovations mirrors are now omitted from the operational list without deleting local history. The commodity default no longer prepends PO text, and shipping marks are regenerated as seller / buyer account / shipment ID.

Shipment prep's master-detail workspace now uses square, shadow-free panels and table containers with consistent one-pixel grid rules. Its current-shipment toolbar is a single compact row with 34-pixel controls and a screen-reader-preserved search label. Shipment rows are native buttons with visible keyboard focus, dark-mode selection contrast, and focus restoration after rerendering. This change is local only and has not been deployed.

Commercial Invoice now classifies a lens as finished spectacles (`90049000`, displayed as `9004.90.00.000`) when the source price-list item is marked edged or any invoice line records billed edging (including the established trigger rows). The source query uses a one-row aggregate lookup per invoice line, avoiding duplicate invoice rows when multiple price-list records share an ID. This local change is not deployed.

Delivery Export now has a reusable on-page document-preview module for Commercial Invoice and Packing Slip. The browser host has no trusted native print bridge, so Print accurately invokes the browser print dialog for the exact preview document. Save now rasterizes that preview into high-resolution Letter pages and downloads a real PDF with the existing sanitized document filename. The new Classic Visions packing slip is available from Shipment prep for either classification and includes shipment/customer/job/signature details. The Delivery Checklist tab is deliberately disabled for local shipments with an explanatory title, while the separate packing-slip action remains available. A shipment composed solely of stock/fulfillment orders replaces its printable and on-screen invoice rows with `STOCK ORDER - SEE ATTACHED DOCUMENTS.`; mixed shipments retain their ordinary lines.

Commercial Invoice previews now reserve a transparent signature image area above a distinct signing line, with signer text below. This prevents an authorisation PNG from straddling the line, renders any white backdrop invisibly on the white document, and clips the narrow image-edge frame without touching the signature strokes. The local renderer change is not deployed.

Commercial Invoice now states `Currency of Sale: Barbados Dollars (BBD)` in its printed/PDF header and explicitly renders `BBD $` on every printed/PDF line and total. The editable workspace table labels its unit-price and amount columns `BBD $` while retaining numeric-only inputs for safe recalculation. This is deployed and health-verified.

The authoritative host update flow now auto-applies every clean fetched Git revision through `scripts/apply-local-update.ps1` by default. A Git authentication/authorization failure pauses application, records a deduplicated host incident, and uses the configured alert delivery endpoints when available; setting `OPTILENS_AUTO_APPLY_UPDATES=false` restores manual approval.

The guarded updater's clean-checkout path joins empty `git status --porcelain` output before calling `Trim()`. This prevents the PowerShell null-method failure observed during the first branch deployment attempt; the failed attempt occurred before smoke checks or restart.

The guarded updater verifies production dependencies before its smoke check. If the installed tree is incomplete, it stops the service before deterministic `npm ci` to avoid Windows module locks, restores/restarts on failure, then proceeds through the normal health-gated update flow.

The Delivery Export shipment-currentness correction is deployed. `lib/delivery.js` uses `source_item_count` (not optional local scan rows) for mirrored shipment visibility and displayed counts, and presents only synchronized Innovations rows in the current screen. `server.js` limits a successful refresh to source rows refreshed by that request, so stale local mirrors cannot appear as open. The contents endpoint reads source shipment items on click. The authenticated external-browser check confirmed the deployed source-aligned open/closed counts and contents for a selected shipment in each group.

The update endpoints make a repeat apply request idempotent: while the update runner is active, they return an in-progress response instead of a conflict. The Host Monitor source renders that state and keeps the apply control disabled. The Host Monitor executable was rebuilt from the merged source and relaunched successfully. The server-side endpoint change was applied with a controlled application restart and the health harness confirmed the application and monitor are online.

The updater now persists `data/update-state.json` with a run ID, phase, percentage, message, timestamps, and failure details. The website update overlay and Host Monitor consume the same state across the service restart, while the website also displays the verbose update log tail. Application migrations checkpoint successfully applied files in `dbo.app_migrations`, allowing safe retries after a failed later step.

The update controller now releases its transient in-memory `applying` flag if the detached update runner fails before creating its durable state file. This repairs the observed false-stuck condition: the service remained healthy, but the update UI stayed locked because no runner, state file, or maintenance lock existed. A single controlled monitor repair restored the host monitor after the application restart; the final health harness and update-status check both passed.

RX alias cloud synchronization now keeps an acknowledged local alias snapshot. On a later successful committed sync, aliases absent from the current source-derived catalog are sent to the receiver with `is_active: false`, removing them from active website selection while retaining the receiver-side record for audit. The snapshot advances only after every batch succeeds, so a dry run, failed transfer, or partial response cannot lose a required deletion notice. This local change has not been deployed or used to send an external sync.

## Completed work and affected files

- `lib/metrics/inventory-trends.js`, `lib/metrics/context.js`, and `public/business-metrics-inventory.js`: classify invoiced stock lenses through Fulfillment and describe that classification accurately.
- `test/business-metrics-overview.test.js`: regression guard for Fulfillment order type and OPC matching.
- `lib/metrics/drill.js`, `lib/metrics/inventory.js`, `public/business-metrics-inventory.js`, `public/business-metrics-shared.js`, and `public/styles/pages/business-metrics.css`: inventory headline/item drills, invoice audit drill, misc SKU visibility, and full-screen wide drawers.

- `lib/credential-vault.js` and `public/credentials.html`: intentional vault deletions survive reload/lock cycles and revert visibly if persistence fails.
- `lib/operations/service.js`, `lib/operations/routes.js`, `public/supplier-email.*`, and `public/styles/pages/automation.css`: protected action/exception details and deep links to direct mapping or message remediation.
- `lib/operations/exception-digest.js`, `lib/operations/imap-mailbox.js`, `database/041-supplier-exception-digests.sql`, `.env.example`, and `lib/config.js`: opt-in SMTP daily digest, durable delivery state, and self-message suppression.
- `test/operations-exception-digest.test.js`: vault, remediation-route, and fake-SMTP digest coverage.

- `public/automation.html` and `public/styles/pages/automation.css`: collapsed Automation capabilities accordion.
- `lib/db.js` and `lib/operations/source-status-writeback.js`: separate source write pool and fail-closed configuration checks.
- `.env.example` and `test/operations-source-status-writeback.test.js`: document and test the required writer and allowlist gates.
- `lib/config.js` and `public/credentials.html`: Credentials Vault source-writer template and resolver, without read-identity fallback.
- `public/delivery-export.html`, `public/delivery-export.js`, and `public/styles/components.css`: redesigned shipment search, compact commercial-invoice workspace, shipment-defaults launcher/tab, tooltip, package dropdown, and accessible divider.
- `public/delivery-export.html`, `public/delivery-export.js`, `public/styles/components.css`, and `test/delivery-export-current-shipments.test.js`: square dense shipment-prep tables/panels, slim current-shipment toolbar, semantic column headers, and keyboard-operable shipment rows with retained focus.
- `lib/beswift-co.js`, `public/delivery-export.html`, `public/delivery-export.js`, `public/styles/components.css`, and `test/commercial-invoice-defaults.test.js`: shipment-prep reconciliation plus commercial-invoice defaults, tracking fallback, stock-order wording, declaration display, unit conversion, and focused coverage.
- `lib/beswift-co.js` and `test/commercial-invoice-defaults.test.js`: source-backed edged-work tariff classification and regression coverage.
- `lib/delivery.js`, `lib/source-innovations.js`, `server.js`, and `lib/beswift-co.js`: zero-item mirror suppression, read-only universal source search, clean shipping-marks format, and lens/item descriptions without a PO prefix.
- `server.js` and `test/delivery-document-preview.test.js`: transparent, above-line Commercial Invoice authorisation signature layout and regression coverage.
- `server.js`, `public/delivery-export.js`, and `test/delivery-document-preview.test.js`: explicit Barbados-dollar (`BBD $`) labels for Commercial Invoice printed/PDF amounts, totals, and workspace price columns.
- `test/delivery-export-current-shipments.test.js`: guards the zero-row query and universal-search coverage.
- `lib/delivery.js`, `server.js`, and `test/delivery-export-current-shipments.test.js`: deployed source-backed shipment counts, stale mirrored-row exclusion, and regression coverage on `codex/fix-shipment-screen-source-currentness`.
- `lib/beswift-co.js`, `public/delivery-export.html`, `public/delivery-export.js`, `public/styles/components.css`, `public/styles/system.css`, and `test/commercial-invoice-defaults.test.js`: square shared tabs/workspace and job list; calculated invoice amounts; authoritative edging tariff; and regenerated certificate line payloads for new job snapshots.
- `public/styles/components.css`, `public/styles/shell.css`, `public/shared.js`, `public/tools/pricing-automation/index.html`, `public/tools/pricing-automation/pricing.css`, and `test/design-system.test.js`: edge-to-edge Delivery Export shell with padded shipment fields; flat signed-in launch-pad greeting; compact public/admin-style launcher; non-modal header search dropdown; and readable Pricing group titles with a consistent action toolbar.
- `server.js` and `scripts/OptiLensHostMonitorLauncher.cs`: update-in-progress handling no longer presents `An update is already being applied.` as a failed update request.
- `scripts/apply-local-update.ps1`, `server.js`, `public/shared.js`, and `public/styles/shell.css`: durable updater progress state, website progress bar/live log, and cross-restart update status.
- `server.js`: clear a scheduled update if its detached runner never creates durable progress state, allowing a safe retry instead of an indefinite false in-progress lock.
- `lib/migrations.js`: durable application-migration checkpoints in `dbo.app_migrations`.
- `lib/innovations-sync.js` and `test/innovations-sync.test.js`: acknowledged lens-alias reconciliation sends inactive tombstones for source deletions and guards the behavior with regression coverage.
- `scripts/apply-local-update.ps1`: restores durable update-status persistence required by the guarded updater.
- `test/rx-generator.test.js` and `test/delivery-document-preview.test.js`: remove source-catalogue and Windows-line-ending assumptions that previously produced advisory false failures during guarded updates.

## Verification

- Read-only live MSSQL check confirmed `OrderType = 6` is `Fulfillment` and contains matching Progressive and Bifocal OPC stock-lens volume in the active analytics window; legacy 3/9 types contained none.
- `node --test test/business-metrics-overview.test.js` — 20 passed.
- `node --test test/business-metrics-overview.test.js` — 23 passed; `npm run check` and changed-file `node --check` passed. A full `npm test` started cleanly but did not finish within the 30-second local runner limit.
- Host deployment check: the correction commit is an ancestor of the authoritative checkout; host `npm test` — 4 passed; a controlled `npm run app:restart` was issued; `node scripts/monitor-harness.js verify` — all systems online.
- `node --check lib/metrics/inventory-trends.js`, `node --check lib/metrics/context.js`, `node --check public/business-metrics-inventory.js`, and `git diff --check` — passed.
- Direct live `getAddPowerTrends(24)` check — Progressive 9,874 units and Bifocal 5,331 units across all 11 add buckets.

- `node --test test/operations-exception-digest.test.js test/operations-supplier-status-auto-apply.test.js test/operations-source-status-writeback.test.js` — 17 passed.
- `node --check` on all changed server/operations/browser JavaScript files, `npm run check`, and `git diff --check` — passed.

- `node --check lib/db.js`
- `node --check lib/operations/source-status-writeback.js`
- `node --check public/automation.js`
- `node --test test/operations-source-status-writeback.test.js test/operations-supplier-status-auto-apply.test.js` — 13 passed
- `node --check lib/config.js`; `node --test test/credentials-source-writer.test.js test/operations-source-status-writeback.test.js test/operations-supplier-status-auto-apply.test.js`; and `git diff --check` — passed.
- `npm run check` — passed
- `npm test` did not finish within the local command runner's 30-second window; its first four tests passed before the runner stopped it.
- `node --check server.js` — passed.
- `node --test test/update-manager.test.js test/git-update-checker.test.js` — 4 passed.
- `npm run app:monitor:build` — passed after the Host Monitor was stopped; rebuilt executable was relaunched and `node scripts/monitor-harness.js verify` passed.
- `node --test test/delivery-document-preview.test.js test/innovations-sync-log.test.js test/update-manager.test.js test/git-update-checker.test.js` — 17 passed after merging the monitor-sync-error branch and current remote master.
- External Edge opened the local application, but it redirected to sign-in; no authenticated browser interaction was performed.
- `node --test test/commercial-invoice-defaults.test.js test/delivery-export-current-shipments.test.js` — 6 passed.
- `node --check lib/beswift-co.js`; `node --check public/delivery-export.js`; `node --test test/commercial-invoice-defaults.test.js test/delivery-document-preview.test.js test/design-system.test.js`; `npm run check`; and `git diff --check` — passed. `npm test` began with 4 passing tests but did not finish before the local runner's 30-second limit.
- `node --check public/delivery-export.js`; `node --test test/delivery-export-current-shipments.test.js test/design-system.test.js` — 8 passed. An isolated local fixture in external Edge confirmed the compact square layout, direct sequential typing, dark-mode selected-row contrast, and Enter-key selection with focus retained. No live data or write action was used.
- `npm run check` and `npm test` — passed; full suite 177/177.
- `node --test test/commercial-invoice-defaults.test.js` — 3 passed; `node --check lib/beswift-co.js` and `git diff --check` — passed.
- `node --check server.js`, `node --check public/delivery-export.js`, and `node --test --test-name-pattern="commercial invoice" test/delivery-document-preview.test.js` — passed (2 tests). `node scripts/monitor-harness.js verify` — all systems online. The full document-preview file still has two pre-existing CRLF-sensitive reusable-helper assertions; its two Commercial Invoice tests pass.
- Delivery Export has not yet been browser-verified in an authenticated external Edge/Chrome session.
- `node --test test/delivery-export-current-shipments.test.js` — 4 passed after the currentness correction.
- `node --check lib/delivery.js`, `node --check server.js`, and `git diff --check` — passed.
- Read-only MSSQL comparison and authenticated external-browser check confirmed the deployed current source result: 7 non-empty open shipments and 76 recent closed shipments, with contents loading for selected open and closed rows.
- `npm test` — passed (4 discovered tests).
- `npm run app:restart` — passed; the OptiLens Local service restarted healthy.
- `node scripts/monitor-harness.js verify` — passed; all systems online.
- `node --test --test-concurrency=1 test/update-manager.test.js test/git-update-checker.test.js` — updater-related tests passed; the combined command also exposed one pre-existing CRLF-sensitive document-preview assertion.
- Read-only `GET /api/monitor/updates` and `/api/monitor/updates/logs` — passed; no update was active and three diagnostic logs were returned.
- Update recovery: updater log showed the earlier run completed its restart and monitor steps; the later false in-progress status had no runner, durable state, or maintenance lock. `node --test test/update-manager.test.js test/git-update-checker.test.js` — 4 passed; `node --check server.js` and `git diff --check` — passed. A single `node scripts/monitor-harness.js repair` followed by `verify` — passed; final update status reports no update available or applying.
- `node scripts/verify-rx-catalog.js` — read-only source check passed: 4,093 aliases and no invalid alias or misc records.
- `node --test test/innovations-sync.test.js test/innovations-sync-log.test.js` — 12 passed; `npm run check` and `git diff --check` — passed.
- Guarded maintenance update — smoke check passed; service restart passed; `data/update-state.json` recorded `completed`; `data/update-status.json` recorded `succeeded`; `data/local-update.log` ends with `Update completed.`; loopback update check reported no available updates; Host Monitor process was relaunched. The advisory `npm test` result was 165 passed / 2 failed (the unrelated innovations-sync-log and rx-generator assertions described above).
- `node --test test/delivery-document-preview.test.js test/rx-generator.test.js test/innovations-sync-log.test.js` — 27 passed.
- `npm test` — 176 passed, 0 failed.
- `node --check public/shared.js`; `node --check public/delivery-export.js`; `node --test test/design-system.test.js test/commercial-invoice-defaults.test.js test/delivery-document-preview.test.js`; `npm run check`; and `git diff --check` — passed after the Delivery Export, Launch Pad, shared shell, and Pricing refinements.

## Required handoff fields

When work is incomplete, record:

- Objective and current state.
- Completed work and affected files.
- Commands/tests run and exact failures.
- Environment affected without private identifiers.
- Blocker and approval required.
- One exact executable next action.

## Blocker and next action

- Blocker: read-only Innovations source verification fails with `Login failed for user 'sql_reporting'. Reason: The password of the account has expired.`
- Approval required: deploy the scoped OptiLens gateway and hosted portal changes, then use a valid least-privilege read credential to run one customer-scoped invoice-line read and an authenticated external Edge/Chrome portal check. No production deployment or credential change was authorized in this task.
- Next action: restore the read-only source credential through the approved vault/credential process, deploy both scoped code changes, then click a posted statement row, a posted live-order row, and a delivery job in an authenticated external browser to confirm the invoice lines and BBD prices render.

- Blocker: the Commercial Invoice currency-label change is verified locally but cannot be committed or deployed because the shared worktree also has unrelated pending Credentials/source-writer changes (`lib/config.js`, `public/credentials.html`, and `test/credentials-source-writer.test.js`).
- Next action: preserve or complete those unrelated changes, then commit the scoped Commercial Invoice files, restart through the guarded local-update workflow, and rerun `node scripts/monitor-harness.js verify`.

- Blocker: the external Edge session is at OptiLens Local sign-in; no authenticated session is available for rendered verification.
- Next action: sign in to OptiLens Local in Edge, then open Business Metrics → Inventory and confirm `Sold as stock lenses` displays Fulfillment OPC volume for Progressive and Bifocal.

- Approval required: deploy the local Business Metrics inventory audit and drill changes through the guarded update workflow, then run health verification. This is a production application-code deployment; it does not write Innovations data.
- Next action: after deployment approval, in authenticated external Edge or Chrome open Inventory, drill Not moving, Units moved, and Items tracked, then open a zero-cost item and a zero-cost invoice row to confirm the full-screen drawer and read-only details.

- Approval required: deploy the local Delivery Export density/accessibility change and run the guarded health verification before treating it as live. The local external-Edge fixture proves rendering and keyboard behavior but not the deployed authenticated page.
- Next action: after deployment approval, apply the feature branch through the guarded update workflow, run `node scripts/monitor-harness.js verify`, then repeat the shipment search and keyboard-selection check in authenticated external Edge or Chrome.

- Approval required: deploy the local Delivery Export tab/invoice/fill-job refinement through the guarded update workflow, then run health verification. This changes production application code but does not submit a BeSwift fill job or write source data.
- Next action: after deployment approval, in authenticated external Edge or Chrome directly type a certificate-line price and quantity, verify its calculated amount/total and saved preview after reload, then queue only a test draft and inspect its snapshot without claiming or running the extension job.

- Approval required: deploy the local Delivery Export, Launch Pad, shared-shell, and Pricing presentation refinements through the guarded update workflow, then run health verification. This changes production application code only; it does not write business data or submit a BeSwift job.
- Next action: after deployment approval, inspect the Delivery Export workspace edge-to-edge at desktop width, the signed-in Launch Pad banner, Pricing action toolbar and matrix group title, then open the launcher and search dropdown in authenticated external Edge or Chrome.

- Current test-system authorization: the user explicitly authorized autonomous controlled testing for this Innovations file-drop scenario. It does not authorize production changes, credentials/permission changes, or non-test external sends.
- Current state: one controlled file-drop is pending watcher ingestion. The test helper now awaits and reports the watcher outcome reliably.
- Next action: perform a read-only follow-up on that existing file until the watcher reports `accepted` or `rejected`; do not submit another test file while it remains pending.

- For the new Automation work: after deployment/migration approval, configure SMTP Host, SMTP Port, and SMTP Secure on the intended Email vault entry and set `OPTILENS_SUPPLIER_EXCEPTION_DIGEST_ENABLED=true` only after a controlled recipient test. Use a dedicated source writer, enable flag, and status allowlist before setting `OPTILENS_SUPPLIER_STATUS_AUTO_APPLY=true`. Verify deletion persistence and detail/deep-link behavior in authenticated external Chrome or Edge.

- Blocker: the Credentials Vault source-writer entry change is local only; the live site will not display it until a production deployment is explicitly approved.
- Approval required: deploy the scoped Credentials Vault source-writer change and restart/health-check the application. This changes production application code but does not configure credentials or write source data.
- Next action: after approval, deploy the current checkout using `scripts/apply-local-update.ps1` and run `node scripts/monitor-harness.js verify`; then open Credentials → SQL Server → **Add source writer** and enter the new account locally.

- Approval required: deploy the local RX alias reconciliation change, then run one controlled committed `lens_aliases` sync and verify deleted aliases are inactive in the website catalog. This will write to the external website receiver.
- Next action: after approval, follow `docs/REMOTE_AGENT_OPERATIONS.md` to deploy and health-check the current checkout, then use the monitored Innovations sync control for `lens_aliases` and confirm its logged deactivation count.

- Blocker: the latest scheduled Innovations sync rejected one source contact with null `country` and one lens alias with null `material_code`; its committed external receiver write therefore finished with errors.
- Approval required: specify the approved source correction or deterministic receiver-side treatment for those two mandatory fields, then authorize a controlled external sync retry.
- Next action: inspect the two source records read-only and propose a field-specific remediation rule; do not submit a retry until approved.

When fully complete, remove stale steps and set `Status: Complete — no active handoff`.

## Baseline verification

Repository instructions, manifests, and continuity requirements were inspected. No host, database, synchronization, deployment, restart, or application test ran during this documentation rollout.
