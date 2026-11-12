# Innovations sync worker (always-on office sync)

Replaces the `OptiLens Innovations Sync` (hourly full push) and
`OptiLens Innovations Sync Requests` scheduled tasks. Those two shared one lock
and fired at the same minute, so website "Sync now" requests were deferred for
weeks, and every run re-sent every row.

The worker runs inside the OptiLens Local service (`lib/innovations-sync-worker.js`),
so the existing watchdog restarts it. It runs one job at a time:

| Priority | Job | When | Entities |
| --- | --- | --- | --- |
| 1 | Website "Sync now" requests | checked every 30 s | as requested (not `inn_*`) |
| 2 | Hot | every 2 min | customers, balances, order_activity, statements, statement_lines |
| 3 | Warm | every 15 min | banks, contacts, lens_aliases |
| 4 | Nightly | 02:00 host time | store_lenses, store_lens_power_rows, then the `inn_*` pricing mirror (committed) |

`customers` is in the hot tier so a new account reaches the website before its
first balance or statement.

## Only changed rows are sent

`lib/innovations-sync-delta.js` keeps a fingerprint of every delivered row per
entity in `data/sync-fingerprints/`. A run sends only new or changed rows. The
fingerprints advance only after the whole entity is delivered without a failure,
so anything unacknowledged is resent. The receiver never deletes rows it was not
sent, so skipping unchanged rows is safe. The pricing mirror keeps its own
`LastUpdated` watermark.

The first run after install has no fingerprints and sends everything once
(the store power rows take about two hours that first night).

## Self-healing

- Sunday's nightly run (`OPTILENS_SYNC_WEEKLY_FULL_DAY`, 0 = Sunday) resends
  every hot, warm and nightly row and re-reads the full pricing mirror.
- A failed nightly run retries hourly until it succeeds.
- Errors are logged to `data/logs/innovations-sync.jsonl` (`worker.*` events) and
  the next tick tries again.
- The website's `public.innovations_sync_freshness` view and the
  `platform-health-check` alert flag any entity older than its cadence
  (hot 10 min, warm 45 min, nightly 30 h).

## Settings (host-only, machine scope)

| Setting | Purpose |
| --- | --- |
| `OPTILENS_SYNC_WORKER=on` | Start the worker with the service |
| `OPTILENS_SYNC_PASSPHRASE` | Unlocks the vault for the CV API key (already set for the old tasks) |
| `OPTILENS_SYNC_USE_CREDENTIAL_VAULT=true` | Alternative: read the key from the Credentials Vault |
| `OPTILENS_SYNC_NIGHTLY_HOUR` | Default `2` |
| `OPTILENS_SYNC_WEEKLY_FULL_DAY` | Default `0` (Sunday) |

## Go-live

1. Deploy this branch to the host checkout and set `OPTILENS_SYNC_WORKER=on`.
2. Restart the OptiLens Local service and check
   `GET /api/connectors/innovations-sync/worker` (running, hot tier succeeding).
3. Run `scripts\retire-innovations-sync-tasks.ps1` as Administrator.
4. Merge the CV Web `innovations-sync-freshness` branch so the freshness alert
   goes live.

Manual CLI runs (`scripts/innovations-sync-cli.js`) still work; they take the
same lock, and the worker waits for them.
