# Innovations → QuickBooks invoice sync

The integration reads `FinARSalesJournal` through the existing read-only Innovations source adapter and writes only to QuickBooks plus the private `optilens_local` database. It does not write to Innovations.

## Credential setup

The server resolves QuickBooks credentials only from host-only Windows-protected
stores, never from the browser-accessible Credentials Vault. Sandbox and
production credentials use different files and cannot overwrite each other:

- `data/qbo-sandbox-secrets.json` for sandbox.
- `data/qbo-production-secrets.json` for production.

Both files are DPAPI-protected for the Windows host account. Required fields
are `clientId`, `clientSecret`, `refreshToken`, `accessToken`, `realmId`,
`createdAt`, and `environment`. Optional fields are `vatZeroTaxCodeId` and
`vatStandardTaxCodeId`.

The existing sandbox scaffold can be reauthorized at `http://localhost:8000/connect`, then the rotated token can be migrated with:

```powershell
npm run qbo:auth:migrate-vault
```

This imports into the protected **sandbox** store. It refuses production values.
After a successful dry run, remove the legacy sandbox `.env` and
`data/tokens.json` manually. Do not use either as a long-term server credential
store.

Select the environment explicitly with the machine-level setting
`OPTILENS_QBO_ENVIRONMENT`. It defaults to `sandbox` when unset. Do not set it
to `production` during the sandbox pilot.

## Modes

Preview only (default):

```powershell
npm run qbo:invoice-sync
```

Apply to the configured QBO environment:

```powershell
npm run qbo:invoice-sync:apply
```

The scheduled-task installer defaults to dry-run. Apply mode requires an explicit `-Apply`:

```powershell
npm run qbo:invoice-sync:task:install
powershell -File scripts/install-qbo-invoice-sync-task.ps1 -Apply
```

## Production cutover and approval policy

Production is reconciliation-first and fail-closed. A production run never creates
or updates a QBO transaction directly, including when `--apply` is used. For each
Innovations invoice it searches both QBO `Invoice` and `CreditMemo` records by
`DocNumber`, then accepts only one record whose private note is exactly
`OptiLens source Innovations invoice {InvoiceID}`.

- One exact existing match is linked to the private ledger without changing QBO.
- No match becomes a durable `pending_approval` create proposal.
- A changed source invoice linked to a QBO transaction becomes a durable
  `pending_approval` update proposal.
- Zero, multiple, wrong-type, or incorrectly marked matches are exceptions. The
  integration does not guess or create a duplicate.

An authenticated automation manager may apply one pending proposal through:

`POST /api/automation/qbo-invoices/{sourceInvoiceId}/approve`

That operation re-reads the Innovations invoice, QBO mappings, and QBO record.
For updates it also compares the live QBO transaction with the snapshot captured
during reconciliation. Any change since review blocks the write and requires a new
reconciliation. Production writes additionally require the host-only setting:

```text
OPTILENS_QBO_PRODUCTION_APPLY_ENABLED=true
```

Leave the setting absent or false during reconciliation and review. Do not add it
to committed `.env` files. The ledger and append-only audit log retain the proposal,
approver, QBO ID, snapshot hash, and final result.

## Records and audit

`qbo.invoice_sync_ledger` is the idempotency and reconciliation ledger. It stores one row per Innovations invoice and QBO realm, source totals and timestamps, QBO transaction IDs, payload hash, status, retry count, and errors.

`core.audit_events` is the append-only audit trail. It records discovery exceptions and successful QBO create/update actions with actor, source invoice, QBO realm, transaction type, and result. The ledger answers “what is the current sync state?”; the audit trail answers “what action occurred, when, and under which trigger or actor?”

The authenticated read endpoint is:

`GET /api/automation/qbo-invoices/ledger`

## Current scope

- Invoice source: `FinARSalesJournal`.
- One source invoice becomes one QBO `Invoice`.
- Credit source rows become QBO `CreditMemo` records.
- Customer and service-item matching is exact and exception-based.
- VAT code IDs must be configured in the vault; no tax code is guessed.
- Freight, discounts, payments, cancellations, and automatic credit application are not enabled.
- The default discovery window is the last 90 days; manual date filters are supported by the API.
