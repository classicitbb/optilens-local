# Phase 1 Zen Mirror Bridge Runbook

This phase gives OptiLens Local a read-only source failover path while the vendor
Innovations MSSQL database is unreliable.

## Configuration

Set credentials through environment variables or the credentials vault. Do not
commit real secrets.

```text
OPTILENS_MIRROR_DB_SERVER=MSSQL-SVR
OPTILENS_MIRROR_DB_NAME=innovations_mirror
OPTILENS_MIRROR_DB_USER=optilens_app
OPTILENS_MIRROR_DB_PASSWORD=...
OPTILENS_MIRROR_SYNC_MINUTES=15
OPTILENS_MIRROR_RETENTION_DAYS=92
```

The Zen source still uses the existing `OPTILENS_SOURCE_PSQL_*` settings. The
vendor MSSQL source still uses `OPTILENS_SOURCE_MSSQL_*`.

## Create Or Review Mirror DDL

Generate reviewable DDL from the Zen catalog:

```powershell
node scripts/zen-mirror-ddl.js --out database/innovations_mirror.generated.sql
```

Provision the mirror database and missing tables:

```powershell
node scripts/setup-zen-mirror.js
```

The setup script is rerunnable. It creates `innovations_mirror`, the `sync`
schema, `sync.SyncState`, and missing `dbo` mirror tables. It reports column
drift on existing tables instead of changing them in place.

## Run Sync

One incremental run:

```powershell
node scripts/run-zen-mirror-sync.js
```

Full run with delete reconciliation:

```powershell
node scripts/run-zen-mirror-sync.js --full
```

Transactional mirror tables are intentionally bounded by
`OPTILENS_MIRROR_RETENTION_DAYS` (default 92). This applies to shipments,
shipment items, orders, Rx archive rows, invoices, invoice lines, sales journal
rows, statements, and statement items. Reference tables still fully reload so
recent rows can be interpreted.

To purge the existing accumulated transactional mirror data and resync only the
retained window:

```powershell
node scripts/reset-zen-mirror-retention.js
node scripts/reset-zen-mirror-retention.js --confirm-delete
node scripts/run-zen-mirror-sync.js --full
```

The reset script writes only to `innovations_mirror`. Its default mode is a dry
run that prints the row counts that would be deleted.

If SQL Server reports `innovations_mirror` is full due to `LOG_BACKUP`, the
mirror is still in full recovery without log backups. Because this database is a
temporary cache, switch only the mirror database to SIMPLE recovery during reset:

```powershell
node scripts/reset-zen-mirror-retention.js --set-simple-recovery --confirm-delete
```

To inspect or compact the mirror transaction log afterward:

```powershell
node scripts/maintain-zen-mirror-log.js
node scripts/maintain-zen-mirror-log.js --confirm-shrink --target-mb=256
```

Confirmed mode refuses to run unless the connected database is exactly
`innovations_mirror`. A compacted SIMPLE-recovery mirror log should report
`log_reuse_wait=NOTHING`.

The web service also starts `lib/zen-mirror-worker.js` automatically when
`OPTILENS_MIRROR_SYNC_MINUTES` is greater than zero and Zen credentials are
available.

## Switch Source Backend

Open `/modules/integrations` and use the `Innovations source backend` card.

The switch:

- checks the target backend is online;
- compares `Customers`, `Shipments`, and `Orders` row counts;
- blocks on parity drift above 2 percent unless the operator confirms a forced
  switch;
- persists `core.app_settings.source_backend`;
- resets the shared source MSSQL pool;
- records an audit event when the platform audit table is available.

All source consumers continue to use `getSourcePool()`. Do not hardcode
`innovations_mirror` in downstream modules.

## Verification

```powershell
npm run check
npm test
```

Manual smoke checks when databases are available:

```text
GET  /api/connectors/source-backend
POST /api/connectors/zen-mirror/sync
GET  /api/connectors/zen-mirror/status
POST /api/connectors/source-backend/switch
```

## Disable

Set sync scheduling to zero and restart:

```text
OPTILENS_MIRROR_SYNC_MINUTES=0
```

Switch the active source profile back to `live` from the integrations page when
vendor MSSQL is healthy and row-count parity passes.

When the bridge is retired, disable the scheduled task "OptiLens Zen Mirror
Sync" before dropping `innovations_mirror`. Keep source Innovations, Zen/PSQL,
Access, and `optilens_local` untouched.
