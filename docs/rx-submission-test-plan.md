# Rx order → Innovations submission — test plan

Covers the full loop: CVWeb RxOrderForm (quotations app) → `rx_order_submissions` outbox →
`RxSubmissionsPage` release → optilens-local (`rx-order-submitter.js`) → Innovations
(`\\INNOVA-SVR\Innovations\Incoming` file-drop or InnovaAPI `/process_rxi`).

## 1. Automated (done, runs today)

`test/rx-order-submitter.test.js` (part of `npm test`) — fixture-based, no network/DB needed:

- Uncut web order reproduces the real UNCUT sample's `frame_source`/`frame_status`/
  `frame_tracing`/`frame_edge` exactly.
- Edged web order never claims `TRACED`/`TRACE - UNCUT`/the old `FRAME TRACE` bug value.
- Rendered output uses colon-delimited `key:value` lines and CRLF, matching real exports.
- Missing Innovations alias mapping is rejected before it can reach the lab.
- Missing ERP account number is rejected before it can reach the lab.

Run: `cd C:\DEV\optilens-local && npm test -- test/rx-order-submitter.test.js` (or `npm test` for
the full suite). All 15 rx-related assertions pass as of this change (2026-08-09).

**Gap:** this only tests `buildOrder()` in isolation with a synthetic payload. It does not touch
the outbox table, the claim/complete edge function calls, or the actual file-drop. That's
necessarily a live test — see part 2.

## 2. Live end-to-end (needs a human or computer-use on Russell's desktop — this sandbox has no
network path to ino-3frc3q3 or \\INNOVA-SVR)

Russell confirmed (2026-08-09): the server in use for this is a **test environment** — safe to
post real-looking test orders, he'll review. Use an obviously-fake patient name regardless
(e.g. `CLAUDE TEST, DO NOT PROCESS`) so anyone glancing at the Incoming folder can tell it's a
drill, not a real fabrication order.

Steps:

1. **Confirm the outbox is live.** Check (in CVWeb admin or via Supabase) that migrations
   `20260801130000` / `131000` / `132000` have actually been run — per [[rx-order-pipeline]]
   memory they were still pending as of 2026-08-02. If not run, no quote will ever reach
   `rx_order_submissions` and nothing downstream can be tested. **This is the first thing to
   check** — everything below assumes it's done.
2. **Place a test Rx order** through the real RxOrderForm (`/admin/website/quotations/new-rx` or
   the portal `/rx-order`), patient name `CLAUDE TEST, DO NOT PROCESS`, a lens that has a
   confirmed Innovations alias mapping (check Admin → Pricing → Alias Mapping first — an
   unmapped lens throws at release, not at order time).
3. **Pay/confirm the order** so it lands in `rx_order_submissions` as `pending_review`.
4. **Check `RxSubmissionsPage`** (`/admin/website/rx-submissions`) — the row should appear,
   labeled with the test customer/account, status `pending_review`.
5. **Release it** (staff click) → status moves to `approved`.
6. **Trigger the office worker.** Until `scripts/install-rx-submissions-task.ps1` is registered
   as a scheduled task on INO-3FRC3Q3 (it isn't yet — see below), nothing polls automatically.
   For this test, call the endpoint directly once the vault is unlocked:
   `POST /api/connectors/rx-submissions/process` with the session token, or run
   `node scripts/rx-submissions-cli.js --use-credential-vault` on the host.
7. **Verify the result:**
   - `RxSubmissionsPage` row flips to `submitted` (or `failed` with a readable error) and shows
     `transport: file drop` (since InnovaAPI creds may not be configured, or `api` if they are).
   - A file named `{order_id}_CLAUDE_TEST_DO_NOT_PROCESS.rx` exists in
     `\\INNOVA-SVR\Innovations\Incoming` — **this is the step nobody has confirmed works**;
     the Node process on INO-3FRC3Q3 reaching that UNC share at all is unverified.
   - Open the dropped file and diff its header/frame/lens/rx fields against
     `templates/rx-samples/sample-sv-distance-uncut.rx` (or the enclosed/traced sample if you
     used an edged job) using `docs/rx-format-field-map.md` as the field-by-field reference.
8. **Confirm Innovations actually ingests it** (if you have any visibility into their intake —
   ask Russell/the lab) rather than just landing in the folder inert.

## 3. Wiring the loop so it doesn't need a manual trigger

`scripts/rx-submissions-cli.js` + `scripts/install-rx-submissions-task.ps1` were added
2026-08-09 (mirrors the existing `install-innovations-sync-task.ps1 -ServeRequests` pattern —
until now `rx-submissions/process` was an HTTP endpoint nothing ever called). To activate:

```powershell
cd C:\DEV\optilens-local
scripts\install-rx-submissions-task.ps1 -IntervalMinutes 5
```

Requires `OPTILENS_SYNC_PASSPHRASE` set at machine scope first (same requirement as the existing
sync task — see that script's comments). This needs to run **on INO-3FRC3Q3** (the host serving
the app), not just in the dev checkout — same distinction the project's own CLAUDE.md draws
between `C:\DEV\optilens-local` and `\\INO-3FRC3Q3\GitHub\optilens-local`.

## Known open risks going into a live test

- `folders.incoming` pointing at the real UNC share has never been proven reachable from the
  app's Node process (flagged in [[innova-stockhashref-format]] memory too).
- Enclosed-but-not-traced frame enum values are a best guess (see field-map doc) — first live
  edged-job test is also the first real validation of that guess.
- `rx_order_submissions` migration status is unconfirmed as of this writing — check step 1 before
  assuming anything downstream works.
