# Payments sync implementation

## Repository ownership

- `classicitbb/optilens-local`: receipt reads, QuickBooks comparison, review UI, future approved posting and reconciliation.
- `classicitbb/optilens-1c39be6c`: future walk-in handoff, costing/AWB capture and status feedback.
- Innovations and QuickBooks are connected systems, not additional application repositories.

## Milestone 1: read-only payment review

Automation has a Payments tab and an authenticated `GET /api/automation/qbo-payments/review` endpoint, requiring `automation.read` and owned by the QBO edition. No migration, worker, schedule or transaction-write endpoint is introduced.

The service reads Innovations `FinARPayments`, `FinARPaymentLinks` and customer identity through the existing source adapter. It uses confirmed company-scoped customer mappings and the existing protected QuickBooks connection. Invoice lookups use exact invoice numbers, including historical invoices outside invoice-sync cutover/exclusion rules.

Comparisons use customer, date, amount and complete invoice allocations; markers cannot override conflicting evidence. Historical matches are candidates, not saved links. Payment and Deposit evidence are separate. Duplicate, missing, incomplete and inconsistent evidence is held. Discounts, allowances and unknown methods cannot become automatic posting proposals. Ready means ready for review only.

Receipt discovery defaults to 50 newest receipts in the last 90 days, with a maximum of 100 and an explicit truncation notice. QuickBooks pagination is bounded; incomplete comparisons hold all rows. Exact invoice reads are capped at 300 per comparison, with a two-minute comparison budget checked between requests. No card number, expiry or payment bank account is selected. Default date windows use the Barbados calendar.

The pure model is `lib/qbo-payment-review.js`; orchestration and HTTP authorization are separate modules. The Payments UI uses the shared Automation styles and header search, with semantic tables, keyboard-accessible tabs and explicit loading/error states.

## Remaining milestones

1. Verify source status/currency semantics, customer/method/account mappings and historical candidates on the service host.
2. Agree discount accounting, cash destination and cutover; introduce a durable ledger with separate Payment/Deposit states and approval snapshots before implementing writes.
3. Explicitly authorize and verify a controlled QuickBooks payment pilot.
4. Implement the CV Web receipt outbox and supported Innovations write/acknowledgement contract, then a separately approved walk-in pilot.
5. Build reviewed shipment Bills, distinguishing supplier, customs/clearing and carrier freight identities. Handle AWB adjustments against the original bill.
6. Add bounded batches and reconciliation. Automatic posting remains a separate activation decision.

## Validation

The initial focused payment/production-safety/edition checks passed (31 tests). All QuickBooks and edition checks passed (95 tests). Synthetic browser checks passed at desktop and mobile sizes for filtering, details, keyboard tabs and clearing stale evidence after a failure, with zero transaction writes and zero page errors. A harmless company read verified the development sandbox connector. The development source connection timed out; no connection settings were changed.

Both `npm test` and `node --test --test-force-exit test/*.test.js` stopped progressing after 132 passing tests and were interrupted. This is an unresolved full-suite limitation, not a passing full-suite result. Production deployment validation is recorded in the handoff.
