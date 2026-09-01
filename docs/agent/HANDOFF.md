# Work Handoff

- Repository: `classicitbb/optilens-local`
- Status: In progress — Business Metrics correction deployed; authenticated external-browser verification pending; scheduled cloud-sync data exceptions require remediation
- Last synchronized: 2026-09-01

## Objective and current state

Maintenance recovery on 2026-09-01 completed successfully. The guarded local updater had a missing `Write-UpdateStatus` helper, causing a requested runtime update to exit before it created its durable status record. `scripts/apply-local-update.ps1` now persists state, message, revisions, smoke-check, and advisory test-suite results to `data/update-status.json`. A controlled guarded run passed its smoke check, restarted the service, relaunched the host monitor, wrote `Update completed.`, and the loopback update check reported no available runtime or Git updates. The full suite remains advisory and reported two pre-existing unrelated failures: an innovations-sync log expectation that omits an undefined `warnings` field, and an RX-generator source-validated-lens assertion.

The application, private app database, source database, and Host Monitor are online. The health screen still correctly reports the scheduled Innovations-to-Classic-Visions sync as failed. Its latest committed run completed all other entities but rejected one contact with a null mandatory `country` field and one lens alias with a null mandatory `material_code` field at the receiver. Do not supply guessed values or retry this external write until a data-remediation rule or source correction is approved.

Business Metrics' add-power `Sold as stock lenses` channel uses the live Innovations `Fulfillment` order type (`OrderType = 6`) rather than the legacy `Stock` / `Stock Debit` types (3/9). The former types yielded no current stock-lens volume, while fulfillment invoices contain the relevant OPC SKU lines. The source query continues to resolve all right, left, and pair OPC fields and reports both Progressive and Bifocal volume. The authoritative host checkout already contained the correction; its focused regression and full test suite passed, a controlled restart was issued, and the final health harness reported all systems online on 2026-08-31. External Edge reaches the live application but is currently at its sign-in page, so authenticated rendered verification remains pending.

Credentials Vault deletion now persists an operator-selected removal without template reseeding on a later read, lock, or unlock. Supplier Automation now exposes protected action/exception detail routes, actionable mapping deep links, and a daily unresolved-items digest path. The digest is fail-closed: it remains disabled unless the explicit digest flag and Email-vault SMTP fields are configured; it sends only to the configured mailbox account and self-marked messages are ignored by the IMAP poller. New migration `041-supplier-exception-digests.sql` is registered but has not been applied. No SMTP delivery or source status write-back was enabled.

The Automation capability overview is now a collapsed native accordion. Source status write-back requires a separate least-privilege source writer, an explicit enabled flag, and a non-empty CurrentStatusID allowlist before it can connect or write. No protected writer configuration was added; the capability remains safely unavailable rather than reusing the read identity.

Delivery Export now uses one current-shipment universal search, compact invoice controls, per-shipment defaults, and an accessible resizable shipment split. Shipment prep has a page-header search, explicit active selection, and a viewport-filling preview. Commercial Invoice now defaults freight to 62, packages to 1, and delivery terms to Free on Board; uses a single pounds/kilos gross-weight input persisted as kilograms; defaults Customer order no. to the primary contact; traces shipment tracking before reference fallbacks; and labels stock/fulfillment commodity specifications. Read-only source and local checks found six zero-item rows in the local mirror while the current source had none; current empty Innovations mirrors are now omitted from the operational list without deleting local history. The commodity default no longer prepends PO text, and shipping marks are regenerated as seller / buyer account / shipment ID.

Commercial Invoice now classifies a lens as finished spectacles (`90049000`, displayed as `9004.90.00.000`) when the source price-list item is marked edged or any invoice line records billed edging (including the established trigger rows). The source query uses a one-row aggregate lookup per invoice line, avoiding duplicate invoice rows when multiple price-list records share an ID. This local change is not deployed.

Delivery Export now has a reusable on-page document-preview module for Commercial Invoice and Packing Slip. The browser host has no trusted native print bridge, so Print accurately invokes the browser print dialog for the exact preview document. Save now rasterizes that preview into high-resolution Letter pages and downloads a real PDF with the existing sanitized document filename. The new Classic Visions packing slip is available from Shipment prep for either classification and includes shipment/customer/job/signature details. The Delivery Checklist tab is deliberately disabled for local shipments with an explanatory title, while the separate packing-slip action remains available. A shipment composed solely of stock/fulfillment orders replaces its printable and on-screen invoice rows with `STOCK ORDER - SEE ATTACHED DOCUMENTS.`; mixed shipments retain their ordinary lines.

Commercial Invoice previews now reserve a transparent signature image area above a distinct signing line, with signer text below. This prevents an authorisation PNG from straddling the line, renders any white backdrop invisibly on the white document, and clips the narrow image-edge frame without touching the signature strokes. The local renderer change is not deployed.

The Delivery Export shipment-currentness correction is deployed. `lib/delivery.js` uses `source_item_count` (not optional local scan rows) for mirrored shipment visibility and displayed counts, and presents only synchronized Innovations rows in the current screen. `server.js` limits a successful refresh to source rows refreshed by that request, so stale local mirrors cannot appear as open. The contents endpoint reads source shipment items on click. The authenticated external-browser check confirmed the deployed source-aligned open/closed counts and contents for a selected shipment in each group.

The update endpoints make a repeat apply request idempotent: while the update runner is active, they return an in-progress response instead of a conflict. The Host Monitor source renders that state and keeps the apply control disabled. The Host Monitor executable was rebuilt from the merged source and relaunched successfully. The server-side endpoint change was applied with a controlled application restart and the health harness confirmed the application and monitor are online.

The updater now persists `data/update-state.json` with a run ID, phase, percentage, message, timestamps, and failure details. The website update overlay and Host Monitor consume the same state across the service restart, while the website also displays the verbose update log tail. Application migrations checkpoint successfully applied files in `dbo.app_migrations`, allowing safe retries after a failed later step.

The update controller now releases its transient in-memory `applying` flag if the detached update runner fails before creating its durable state file. This repairs the observed false-stuck condition: the service remained healthy, but the update UI stayed locked because no runner, state file, or maintenance lock existed. A single controlled monitor repair restored the host monitor after the application restart; the final health harness and update-status check both passed.

RX alias cloud synchronization now keeps an acknowledged local alias snapshot. On a later successful committed sync, aliases absent from the current source-derived catalog are sent to the receiver with `is_active: false`, removing them from active website selection while retaining the receiver-side record for audit. The snapshot advances only after every batch succeeds, so a dry run, failed transfer, or partial response cannot lose a required deletion notice. This local change has not been deployed or used to send an external sync.

## Completed work and affected files

- `lib/metrics/inventory-trends.js`, `lib/metrics/context.js`, and `public/business-metrics-inventory.js`: classify invoiced stock lenses through Fulfillment and describe that classification accurately.
- `test/business-metrics-overview.test.js`: regression guard for Fulfillment order type and OPC matching.

- `lib/credential-vault.js` and `public/credentials.html`: intentional vault deletions survive reload/lock cycles and revert visibly if persistence fails.
- `lib/operations/service.js`, `lib/operations/routes.js`, `public/supplier-email.*`, and `public/styles/pages/automation.css`: protected action/exception details and deep links to direct mapping or message remediation.
- `lib/operations/exception-digest.js`, `lib/operations/imap-mailbox.js`, `database/041-supplier-exception-digests.sql`, `.env.example`, and `lib/config.js`: opt-in SMTP daily digest, durable delivery state, and self-message suppression.
- `test/operations-exception-digest.test.js`: vault, remediation-route, and fake-SMTP digest coverage.

- `public/automation.html` and `public/styles/pages/automation.css`: collapsed Automation capabilities accordion.
- `lib/db.js` and `lib/operations/source-status-writeback.js`: separate source write pool and fail-closed configuration checks.
- `.env.example` and `test/operations-source-status-writeback.test.js`: document and test the required writer and allowlist gates.
- `public/delivery-export.html`, `public/delivery-export.js`, and `public/styles/components.css`: redesigned shipment search, compact commercial-invoice workspace, shipment-defaults launcher/tab, tooltip, package dropdown, and accessible divider.
- `lib/beswift-co.js`, `public/delivery-export.html`, `public/delivery-export.js`, `public/styles/components.css`, and `test/commercial-invoice-defaults.test.js`: shipment-prep reconciliation plus commercial-invoice defaults, tracking fallback, stock-order wording, declaration display, unit conversion, and focused coverage.
- `lib/beswift-co.js` and `test/commercial-invoice-defaults.test.js`: source-backed edged-work tariff classification and regression coverage.
- `lib/delivery.js`, `lib/source-innovations.js`, `server.js`, and `lib/beswift-co.js`: zero-item mirror suppression, read-only universal source search, clean shipping-marks format, and lens/item descriptions without a PO prefix.
- `server.js` and `test/delivery-document-preview.test.js`: transparent, above-line Commercial Invoice authorisation signature layout and regression coverage.
- `test/delivery-export-current-shipments.test.js`: guards the zero-row query and universal-search coverage.
- `lib/delivery.js`, `server.js`, and `test/delivery-export-current-shipments.test.js`: deployed source-backed shipment counts, stale mirrored-row exclusion, and regression coverage on `codex/fix-shipment-screen-source-currentness`.
- `server.js` and `scripts/OptiLensHostMonitorLauncher.cs`: update-in-progress handling no longer presents `An update is already being applied.` as a failed update request.
- `scripts/apply-local-update.ps1`, `server.js`, `public/shared.js`, and `public/styles/shell.css`: durable updater progress state, website progress bar/live log, and cross-restart update status.
- `server.js`: clear a scheduled update if its detached runner never creates durable progress state, allowing a safe retry instead of an indefinite false in-progress lock.
- `lib/migrations.js`: durable application-migration checkpoints in `dbo.app_migrations`.
- `lib/innovations-sync.js` and `test/innovations-sync.test.js`: acknowledged lens-alias reconciliation sends inactive tombstones for source deletions and guards the behavior with regression coverage.
- `scripts/apply-local-update.ps1`: restores durable update-status persistence required by the guarded updater.

## Verification

- Read-only live MSSQL check confirmed `OrderType = 6` is `Fulfillment` and contains matching Progressive and Bifocal OPC stock-lens volume in the active analytics window; legacy 3/9 types contained none.
- `node --test test/business-metrics-overview.test.js` — 20 passed.
- Host deployment check: the correction commit is an ancestor of the authoritative checkout; host `npm test` — 4 passed; a controlled `npm run app:restart` was issued; `node scripts/monitor-harness.js verify` — all systems online.
- `node --check lib/metrics/inventory-trends.js`, `node --check lib/metrics/context.js`, `node --check public/business-metrics-inventory.js`, and `git diff --check` — passed.
- Direct live `getAddPowerTrends(24)` check — Progressive 9,874 units and Bifocal 5,331 units across all 11 add buckets.

- `node --test test/operations-exception-digest.test.js test/operations-supplier-status-auto-apply.test.js test/operations-source-status-writeback.test.js` — 17 passed.
- `node --check` on all changed server/operations/browser JavaScript files, `npm run check`, and `git diff --check` — passed.

- `node --check lib/db.js`
- `node --check lib/operations/source-status-writeback.js`
- `node --check public/automation.js`
- `node --test test/operations-source-status-writeback.test.js test/operations-supplier-status-auto-apply.test.js` — 13 passed
- `npm run check` — passed
- `npm test` did not finish within the local command runner's 30-second window; its first four tests passed before the runner stopped it.
- `node --check server.js` — passed.
- `node --test test/update-manager.test.js test/git-update-checker.test.js` — 4 passed.
- `npm run app:monitor:build` — passed after the Host Monitor was stopped; rebuilt executable was relaunched and `node scripts/monitor-harness.js verify` passed.
- `node --test test/delivery-document-preview.test.js test/innovations-sync-log.test.js test/update-manager.test.js test/git-update-checker.test.js` — 17 passed after merging the monitor-sync-error branch and current remote master.
- External Edge opened the local application, but it redirected to sign-in; no authenticated browser interaction was performed.
- `node --test test/commercial-invoice-defaults.test.js test/delivery-export-current-shipments.test.js` — 6 passed.
- `node --test test/commercial-invoice-defaults.test.js` — 3 passed; `node --check lib/beswift-co.js` and `git diff --check` — passed.
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

## Required handoff fields

When work is incomplete, record:

- Objective and current state.
- Completed work and affected files.
- Commands/tests run and exact failures.
- Environment affected without private identifiers.
- Blocker and approval required.
- One exact executable next action.

## Blocker and next action

- Blocker: the external Edge session is at OptiLens Local sign-in; no authenticated session is available for rendered verification.
- Next action: sign in to OptiLens Local in Edge, then open Business Metrics → Inventory and confirm `Sold as stock lenses` displays Fulfillment OPC volume for Progressive and Bifocal.

- For the new Automation work: after deployment/migration approval, configure SMTP Host, SMTP Port, and SMTP Secure on the intended Email vault entry and set `OPTILENS_SUPPLIER_EXCEPTION_DIGEST_ENABLED=true` only after a controlled recipient test. Use a dedicated source writer, enable flag, and status allowlist before setting `OPTILENS_SUPPLIER_STATUS_AUTO_APPLY=true`. Verify deletion persistence and detail/deep-link behavior in authenticated external Chrome or Edge.

- Approval required: deploy the local RX alias reconciliation change, then run one controlled committed `lens_aliases` sync and verify deleted aliases are inactive in the website catalog. This will write to the external website receiver.
- Next action: after approval, follow `docs/REMOTE_AGENT_OPERATIONS.md` to deploy and health-check the current checkout, then use the monitored Innovations sync control for `lens_aliases` and confirm its logged deactivation count.

- Blocker: the latest scheduled Innovations sync rejected one source contact with null `country` and one lens alias with null `material_code`; its committed external receiver write therefore finished with errors.
- Approval required: specify the approved source correction or deterministic receiver-side treatment for those two mandatory fields, then authorize a controlled external sync retry.
- Next action: inspect the two source records read-only and propose a field-specific remediation rule; do not submit a retry until approved.

When fully complete, remove stale steps and set `Status: Complete — no active handoff`.

## Baseline verification

Repository instructions, manifests, and continuity requirements were inspected. No host, database, synchronization, deployment, restart, or application test ran during this documentation rollout.
