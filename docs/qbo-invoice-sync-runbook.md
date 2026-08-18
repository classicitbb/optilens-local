# Innovations → QuickBooks invoice sync

The integration reads `FinARSalesJournal` through the existing read-only Innovations source adapter and writes only to QuickBooks plus the private `optilens_local` database. It does not write to Innovations.

## Credential setup

The server resolves QuickBooks credentials from the Credentials Vault entry named `QuickBooks Online`. Required fields are `clientId`, `clientSecret`, `refreshToken`, `accessToken`, `realmId`, `createdAt`, and `environment`. Optional fields are `vatZeroTaxCodeId` and `vatStandardTaxCodeId`.

The existing sandbox scaffold can be reauthorized at `http://localhost:8000/connect`, then the rotated token can be migrated with:

```powershell
npm run qbo:auth:migrate-vault
```

Do not use the sandbox `.env` or `data/tokens.json` as the long-term server credential store.

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
