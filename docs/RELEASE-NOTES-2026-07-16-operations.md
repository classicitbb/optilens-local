# Release notes — Operations hardening, 2026-07-16

Branch: `operations-phase-1-zen-bridge`. This document is the pickup point for the
next dev: what changed today, how the deployment now works, and what is still open.

## TL;DR for a dev picking this up

- The app on INO-3FRC3Q3 now runs as a Windows **service** (`OptiLensLocal`), not a
  console window or watchdog task. Manage it with `Restart-Service OptiLensLocal`.
- The Zen → `innovations_mirror` sync runs **out-of-process** every 15 minutes via the
  scheduled task "OptiLens Zen Mirror Sync". The in-process worker is disabled by the
  service environment (`OPTILENS_MIRROR_SYNC_MINUTES=0`).
- The sync no longer OOMs (streams via ODBC cursor) and no longer aborts on Zen's
  unsigned integers or corrupt rows. All 25 tables sync; a few record warnings.
- Site answers on **http://ino-3frc3q3/** (port 80 → 8080 portproxy). A friendlier DNS
  alias still needs a record on the LAN DNS/router.
- `restart.bat` and `scripts/start-app.ps1` / the watchdog task are superseded by the
  service. Do not reinstall the watchdog.

## What changed in code

### `lib/zen-mirror-sync.js`
1. **Cursor streaming** (`streamZenQuery`): pulls flow through an ODBC cursor in
   `FETCH_SIZE` (1,000) row batches instead of materializing whole tables. The old
   `SELECT *`-into-an-array approach crashed node with a V8 "Fatal process out of
   memory: Zone" abort (exit 0xC0000409) on the first watermark-less pull of large
   tables (InvoiceLines ≈ 362k rows).
2. **Skip-and-warn fetch errors**: some Zen rows fail SQLFetch with HY107 "Row value
   was out of range" (dirty source data). A failed fetch loses at most one batch; the
   cursor continues. Skipped batches surface as `entry.warning` in the sync summary and
   are written to `sync.SyncState.last_error`. Five consecutive failures abort the
   table. When a "complete" pull had fetch errors, **hard-delete reconciliation is
   skipped** for that run so rows in lost batches aren't deleted from the mirror.
3. **Unsigned integer casts** (`buildZenSelectList`): Zen `USMALLINT`/`UTINYINT`/
   `UINTEGER` columns are selected as `CONVERT("Col", <wider signed type>) AS "Col"`.
   The Pervasive ODBC driver binds signed C types for these, so e.g.
   `RxArchive.RLensItem` = 50349 overflowed and failed *every* fetch — this is what
   made RxArchive error out entirely. Mirror-side DDL/bulk types were already wide
   enough; only the select list changed.
4. Retained from the parallel feature work (bc90fa3): **bounded initial sync** for
   Orders/RxArchive (first pull limited to `OPTILENS_MIRROR_INITIAL_ORDER_DAYS`,
   default 548, on ReceivedTime/RxDate) and **target nullability mapping** for
   full-table bulk loads.

### `scripts/run-zen-mirror-sync.js`
Prints per-table `WARNING …` after the status when batches were skipped. Exit code is
0 when no table *errored* (warnings don't fail the run).

### `test/zen-mirror-sync.test.js`
Covers the new select-list casts; the bounded-initial tests now expect explicit column
lists instead of `SELECT *`.

## Deployment state on INO-3FRC3Q3 (Windows Server 2019, workgroup RETL1)

| Piece | Detail |
|---|---|
| App service | `OptiLensLocal` ("OptiLens Local"), WinSW wrapper in `C:\ProgramData\OptiLens\service\`. Runs `server.js` from `C:\Users\Administrator\Documents\GitHub\optilens-local`, as `.\Administrator` (User-scope env vars hold DB credentials), auto-start, restart-on-failure after 10 s. |
| Service env | `OPTILENS_PORT=8080`, `OPTILENS_MIRROR_SYNC_MINUTES=0` (set in `OptiLensLocal.xml`). |
| Logs | `C:\ProgramData\OptiLens\service\logs\` — `OptiLensLocal.out.log`/`.err.log` (app, rolled at 10 MB), `OptiLensLocal.wrapper.log` (WinSW), `zen-sync.log` (sync task output, one `==== date ====` header per run). |
| Zen sync | Scheduled task **"OptiLens Zen Mirror Sync"**: `node scripts\run-zen-mirror-sync.js` every 15 min as Administrator (password logon, runs while logged off), 2 h execution limit. |
| Other tasks | "OptiLens Innovations Sync" (cloud push, pre-existing, untouched). The old "OptiLens Local Watchdog" was **removed** (Interactive logon type meant it silently refused to run when logged off — error 0x800710E0 — and a hung instance blocked restarts). |
| Port 80 | `netsh interface portproxy` 0.0.0.0:80 → 127.0.0.1:8080. IIS Default Web Site stopped + autostart off (it only served the stock placeholder). Firewall rules "OptiLens Local (Port 80)" and "(Port 8080)". |
| Node | `C:\Users\Administrator\AppData\Local\hermes\node\node.exe` (v22.22.3). |

### Operating cheatsheet

```powershell
# from any machine on the LAN with the Administrator credential:
Invoke-Command -ComputerName ino-3frc3q3 -Credential Administrator -ScriptBlock {
  Restart-Service OptiLensLocal                                  # restart app
  Start-ScheduledTask -TaskName 'OptiLens Zen Mirror Sync'       # force a sync
  Get-Content C:\ProgramData\OptiLens\service\logs\zen-sync.log -Tail 40
}
```

Notes: SSH password auth does **not** work non-interactively; use WinRM. The host repo
cannot `git pull` in a WinRM session (no GitHub credential helper) — deploy files with
`Copy-Item -ToSession` or pull from an interactive session on the host.

## Sync status (last verified run)

All 25 tables sync. Expect these standing warnings until source data is cleaned:

- `FinARSalesJournal`, `FinARStatementItems`: 1 skipped batch each (≤1,000 rows) —
  HY107 dirty rows near row 63k / 77k of the initial pull. Incrementals are clean.
- `RxArchive`: syncs after the unsigned-cast fix; has no primary key on the Zen side,
  so it falls back to destructive full reload each run, and may log occasional HY107
  batch warnings (it also has some dirty rows).

## Known issues / next steps

1. **Mirror tables lack primary keys** (created before PK-aware DDL): Customers,
   Shipments, ShipmentItems, Orders, Invoices, InvoiceLines, FinARSalesJournal,
   FinARStatements, FinARStatementItems, FinARAgingPeriods and others —
   `setup-zen-mirror.js` reports `DRIFT … primary key is missing`. Hard-delete
   reconciliation and MERGE performance depend on them. Fix: drop + recreate each
   table (or add the PK constraint) during a quiet window, then run a `--full` sync.
2. **Dirty Zen rows** (HY107): identify the offending rows in FinARSalesJournal /
   FinARStatementItems / RxArchive at the source if the skipped batches matter for
   finance reporting. `sync.SyncState.last_error` records the warnings.
3. **DNS alias**: add an A/CNAME on the LAN DNS (router) pointing e.g. `optilens` →
   INO-3FRC3Q3's IP; the server side is already listening on 80.
4. **Password coupling**: the service and the sync task run as `.\Administrator` — if
   that password changes, update the service (`sc.exe config OptiLensLocal password=`)
   and re-register the task.
5. **Concurrent agents**: a Codex agent commits to this branch from the host (it has
   twice committed unresolved conflict markers — fixed in 6b0d3e1). Before editing
   `lib/zen-mirror-sync.js`, check `git log`/`grep -c '<<<<<<<'` and pull first.
