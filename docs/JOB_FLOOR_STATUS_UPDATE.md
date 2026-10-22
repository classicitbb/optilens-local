# Job Floor: direct-database status update

The Job Floor page updates an order's status by writing to the Innovations
database itself, the way the Innovations Mobile app's server (InnovaAPI) does,
instead of calling InnovaAPI. The module is status-update only: job staging and
job queues were removed and nothing in it calls InnovaAPI. Code: `lib/job-floor-source.js` (data layer), `lib/job-floor.js`
(gating, audit), `lib/job-floor-routes.js`, `public/job-floor.*`.

## What InnovaAPI actually writes

Confirmed from an Extended Events trace of one real status update (order 138998,
status 79, performed through InnovaAPI on 2026-10-22). Statement order, one
connection:

1. `INSERT OrderStatuses` — `OrderID`, `StatusItemID`, `TransactionID = NULL`,
   `UserAccountID`, `EndDate = NULL`, `Iteration`, `StatusDate = now`,
   `RecordCreated`/`LastUpdated = SYSDATETIMEOFFSET()`.
2. `UPDATE OrderStatuses SET EndDate = now` on the previous open history row.
3. `UPDATE Orders SET CurrentHistoryID, CurrentStatusID, CurrentStatusDate,
   NumberOfStatuses, UpdatedBy, LastUpdated = dbo.now()`.
4. Housekeeping InnovaAPI also performs and this module deliberately skips: a
   `Locks` row on `TransactionIDs` while it bumps the `TransactionIDs` counter
   (the new id was not stored on the history row or in `Transactions`), the
   release of an `RxJob` cooperative lock, and `SysActiveSessions` session upkeep.

Observations that shaped the design:

- No triggers on `Orders`/`OrderStatuses`; no foreign keys. All status logic is
  application code. A status update needs no `QueuedChanges` row.
- `Iteration` is copied from the previous history row (it only increments on
  statuses this module refuses).
- `NumberOfStatuses` = number of history rows excluding the `StatusItemID = -5`
  marker rows, including the new one.
- `-5` marker rows follow originating statuses (those that also take a
  `TransactionID`). Plain mobile-app statuses do not write one.
- `Orders.CurrentHistoryID`, `NumberOfStatuses` and `CurrentStatusDate` already
  drift from the history table in the live data, so the module finds the
  previous row as the latest non-`-5` row, not through `CurrentHistoryID`.

## Safety model

- **Dry run by default.** A preview reads current state (read login, no locks)
  and reports the three writes it would make.
- **Writes gate.** Live writes need `job_floor.writes_enabled` (or
  `JOB_FLOOR_WRITES_ENABLED`) = `true`, `dryRun:false`, and the
  `automation.manage` permission. Every attempt, refusal and failure is audited.
- **Attribution.** `job_floor.source_user_account_id` (or
  `JOB_FLOOR_SOURCE_USER_ACCOUNT_ID`) names the Innovations `UserAccounts` row
  the history is attributed to. It must exist and be active. Create a dedicated
  OptiLens user in Innovations for this; do not reuse a person's account.
- **Separate write login.** Uses the `source-mssql` write profile, which must
  differ from the read login. Minimum grants: `SELECT` on `Orders`,
  `OrderStatuses`, `StatusItems`, `GenStatus`, `UserAccounts`, `TrayTransactions`; `INSERT`+`UPDATE`
  on `OrderStatuses`; `UPDATE` on `Orders`. Nothing else.
- **Status allow-list from flags.** Only statuses with `ShowInMobileApp = 1`,
  `Inactive = 0` and none of `Originating`, `Terminating`, `Cancellation`,
  `Unship`, `CheckHoldConditions`, `ReceiveFarmout`, `UseFarmoutLabStatus`,
  `StockFlags` (7 statuses at the time of writing). Statuses that run hold
  checks, stock moves or farm-out logic in the desktop app are refused until
  that logic is replicated.
- **Transactional.** One transaction; `UPDLOCK, ROWLOCK` on the order and its
  latest history row; optional `expectedCurrentStatusId` stale check; the order
  update is conditional on the status that was read; a read-back must match
  before commit; any failure rolls everything back.
- **Idempotent.** An order already at the target status is a verified no-op.
- **Finding the order.** By order ID, RX number (`Orders.JobID`), or tray number.
  A tray's current job is its most recent `TrayTransactions` row for that
  `TrayID` (highest `TrayTransactionID`); if that row has a `DateOut` the tray is
  empty and the update is refused (`tray_empty`), because older rows for a tray
  are frequently never closed. This resolution is inferred from the data; the
  tray write itself was not traced, so it makes the same three writes as any
  other update and does not touch `TrayTransactions`.
- Orders must be live (`OrderType` 1 or 3, active `GenStatus`, non-empty
  `JobID`). An RX number matching more than one order is refused.
- Not supported (rejected explicitly, never dropped silently): notes and e-mail.

## Known gaps

- The desktop `RxJob` cooperative lock (`Locks` table) is not taken, so a
  person editing the same job in the desktop app at the same instant is only
  protected by the row lock and the stale check.
- Hold-condition logic (`HoldConditions`, `HoldConditionLinks`) is not
  replicated; see the allow-list above.
- Tray *changes* (moving a job between trays: `TrayTransactions`, `SMTrays`) are out of scope; only status updates found by tray number are supported.

## Enabling

Do not enable until a dedicated Innovations user and a least-privilege write
login exist. Then, on the host, set the source user setting, run a preview
against a known test order, and only then turn `job_floor.writes_enabled` on.
