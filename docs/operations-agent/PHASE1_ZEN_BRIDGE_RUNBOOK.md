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
