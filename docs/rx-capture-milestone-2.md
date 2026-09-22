# RX Capture Milestone 2

Milestone 2 converts a fully reviewed RX Capture order into an approved, immutable local staging artifact. It does not release files to Innovations.

## Workflow

1. The capture owner corrects the extracted order until it is `READY_FOR_REVIEW`.
2. The owner saves exact production selections: customer number, ship name, source-validated lens alias, optional source-validated item SKUs, and explicit frame mode.
3. A different employee with `rx-capture.approve` approves the order. Approval writes one immutable `.rx` payload, SHA-256, filename, and semantic snapshot to the private app database.
4. An employee with `rx-capture.stage` stages only that stored payload locally. Staging never calls the existing RX release route and never writes to an Innovations folder.

Unknown aliases, item SKUs, frame trace data, and unresolved or uncertain prescription values are rejected. Catalogue matching is exact; no fuzzy substitutions are made.

## Verification

Run the focused checks:

```text
node --test test/rx-capture-order-builder.test.js test/rx-capture.test.js
node --check lib/rx-capture/order-builder.js
node --check lib/rx-capture/service.js
node --check lib/rx-capture/routes.js
node --check public/rx-capture.js
git diff --check
```

Assigned repository build work has standing authorization for the guarded deployment, app-database migration, restart, and health verification. Before any staged-file acceptance test, use a synthetic non-production order. An actual external file release remains a controlled business action and must be in the assigned task scope.
