# Work Handoff

- Repository: `classicitbb/optilens-local`
- Status: Pending protected source-write configuration and authorized Host Monitor executable refresh — Delivery Export shipment-currentness correction deployed
- Last synchronized: 2026-08-27

## Objective and current state

The Automation capability overview is now a collapsed native accordion. Source status write-back now requires a separate least-privilege source writer, an explicit enabled flag, and a non-empty CurrentStatusID allowlist before it can connect or write. The current local environment has no dedicated source writer or allowlist, so the change remains safely unavailable rather than reusing the read identity.

Delivery Export now uses one current-shipment universal search, compact invoice controls, per-shipment defaults, and an accessible resizable shipment split. Read-only source and local checks found six zero-item rows in the local mirror while the current source had none; current empty Innovations mirrors are now omitted from the operational list without deleting local history. The commodity default no longer prepends PO text, and shipping marks are regenerated as seller / buyer account / shipment ID.

The Delivery Export shipment-currentness correction is deployed. `lib/delivery.js` uses `source_item_count` (not optional local scan rows) for mirrored shipment visibility and displayed counts, and presents only synchronized Innovations rows in the current screen. `server.js` limits a successful refresh to source rows refreshed by that request, so stale local mirrors cannot appear as open. The contents endpoint reads source shipment items on click. The authenticated external-browser check confirmed the deployed source-aligned open/closed counts and contents for a selected shipment in each group.

The update endpoints now make a repeat apply request idempotent: while the update runner is active, they return an in-progress response instead of a conflict. The Host Monitor source renders that state and keeps the apply control disabled. The currently running Host Monitor executable is locked, so its replacement has not been built or deployed.

## Completed work and affected files

- `public/automation.html` and `public/styles/pages/automation.css`: collapsed Automation capabilities accordion.
- `lib/db.js` and `lib/operations/source-status-writeback.js`: separate source write pool and fail-closed configuration checks.
- `.env.example` and `test/operations-source-status-writeback.test.js`: document and test the required writer and allowlist gates.
- `public/delivery-export.html`, `public/delivery-export.js`, and `public/styles/components.css`: redesigned shipment search, compact commercial-invoice workspace, shipment-defaults launcher/tab, tooltip, package dropdown, and accessible divider.
- `lib/delivery.js`, `lib/source-innovations.js`, `server.js`, and `lib/beswift-co.js`: zero-item mirror suppression, read-only universal source search, clean shipping-marks format, and lens/item descriptions without a PO prefix.
- `test/delivery-export-current-shipments.test.js`: guards the zero-row query and universal-search coverage.
- `lib/delivery.js`, `server.js`, and `test/delivery-export-current-shipments.test.js`: deployed source-backed shipment counts, stale mirrored-row exclusion, and regression coverage on `codex/fix-shipment-screen-source-currentness`.
- `server.js` and `scripts/OptiLensHostMonitorLauncher.cs`: update-in-progress handling no longer presents `An update is already being applied.` as a failed update request.

## Verification

- `node --check lib/db.js`
- `node --check lib/operations/source-status-writeback.js`
- `node --check public/automation.js`
- `node --test test/operations-source-status-writeback.test.js test/operations-supplier-status-auto-apply.test.js` — 13 passed
- `npm run check` — passed
- `npm test` did not finish within the local command runner's 30-second window; its first four tests passed before the runner stopped it.
- `node --check server.js` — passed.
- `node --test test/update-manager.test.js test/git-update-checker.test.js` — 4 passed.
- `npm run app:monitor:build` — source compiled, but Windows could not replace the running `OptiLensHostMonitor.exe` because it is in use.
- External Edge opened the local application, but it redirected to sign-in; no authenticated browser interaction was performed.
- Delivery Export has not yet been browser-verified in an authenticated external Edge/Chrome session.
- `node --test test/delivery-export-current-shipments.test.js` — 4 passed after the currentness correction.
- `node --check lib/delivery.js`, `node --check server.js`, and `git diff --check` — passed.
- Read-only MSSQL comparison and authenticated external-browser check confirmed the deployed current source result: 7 non-empty open shipments and 76 recent closed shipments, with contents loading for selected open and closed rows.

## Blocker and approval required

Configure a protected dedicated source writer outside the repository and explicitly approve the CurrentStatusID targets that may be written. Do not reuse the existing read identity. The exact guard message is: `Dedicated source write credentials are not configured.`


## Next action

After authorized Host Monitor shutdown/restart, run `npm run app:monitor:build` to replace the executable, then use Check for updates twice during one update to confirm the second request reports progress rather than an error. Separately, run `node --test test/delivery-export-current-shipments.test.js` and then open the authenticated Delivery Export page in an external Edge/Chrome session to verify direct search typing, the zero-row suppression, settings launch, and invoice layout.


## Required handoff fields

When work is incomplete, record:

- Objective and current state.
- Completed work and affected files.
- Commands/tests run and exact failures.
- Environment affected without private identifiers.
- Blocker and approval required.
- One exact executable next action.

When fully complete, remove stale steps and set `Status: Complete — no active handoff`.

## Baseline verification

Repository instructions, manifests, and continuity requirements were inspected. No host, database, synchronization, deployment, restart, or application test ran during this documentation rollout.
