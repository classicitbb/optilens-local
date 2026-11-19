# Dev preview and ship flow

Edit in an isolated checkout, watch it update in the browser, then publish to the live site with one command. The live site only ever changes through the guarded updater, so every publish gets the smoke check, a restart, deep health verification and automatic rollback.

## One-time setup

If the service runs from its own folder (not the checkout you develop in), set `OPTILENS_LIVE_CHECKOUT` to that folder as a user environment variable so `ship` applies the update there:

```powershell
[Environment]::SetEnvironmentVariable('OPTILENS_LIVE_CHECKOUT', '<service folder>', 'User')
```

```powershell
npm run dev:setup      # from the production checkout
```

Creates a git worktree beside it (`<checkout>-dev`) on its own `dev/<user>` branch, copies the gitignored `.env`, and runs `npm ci` there. Edits in the dev checkout cannot reach the running service.

## Daily loop

```powershell
cd <checkout>-dev
npm run dev:preview    # http://127.0.0.1:8090 (next free port if busy)
```

- `public/*`, styles, templates: the browser reloads itself; CSS-only saves swap in place without a reload.
- `scripts/ui/*`: rebuilt automatically, then the page reloads.
- `server.js`, `lib/*`: the server restarts and the page reloads when it is back.
- A small orange "DEV PREVIEW" pill marks every page so it is never mistaken for production.

The preview is a viewer, not a second production service. `OPTILENS_DEV_PREVIEW=1` forces off: write-back, privileged data access, supplier mailbox poller, email sync, live gateway, Innovations/QBO workers, TLS front, RX recovery, update checks and the host stop/restart/repair controls. It listens on 127.0.0.1 only (`OPTILENS_DEV_HOST` to change).

The preview reads the real source and app databases, and saved settings are real. To isolate writes, create a scratch app database and set `OPTILENS_DEV_DB_NAME`. This selection overrides a saved vault database only in preview mode. If the preview needs a different database listener, set `OPTILENS_DEV_DB_SERVER` in the preview process environment; it is honored only alongside an explicit scratch database. Neither setting changes saved production configuration.

Before running migrations in a separate Node process, set `OPTILENS_DEV_PREVIEW=1` and call `applyDevPreviewEnv` before loading configuration. Verify the actual connected database before applying. New databases need the base `core`, `delivery`, `integration`, and `archive` schemas from the bootstrap script. The migration runner retargets legacy `USE` statements to its configured database. A fresh scratch database presents first-admin setup; complete that separately through the normal UI. It contains no production users or invoice history.

`npm run dev:preview` refuses to run inside the production checkout (its watchdog log is fresh); pass `--here` only if you accept that edits there are served immediately.

## Publish

```powershell
npm run ship -- -m "What changed"
```

1. Refuses credential-like files (`.env*`, `*.pem`, `vault.json`, `*.protected`).
2. Syntax-checks changed JS, rebuilds the UI if its sources changed, runs the test suite (advisory, like the updater; `--strict` blocks, `--fast` skips).
3. Commits, rebases on `origin/master`, pushes the branch, opens and squash-merges a pull request with `gh` (`--direct` fast-forwards master instead; without `gh` it prints the compare link).
4. Runs `scripts/apply-local-update.ps1 -PullGit` in the production checkout and then `node scripts/monitor-harness.js verify`.
5. Resets the dev checkout to the new `origin/master`.

Expect roughly a minute and a half end to end: the updater's advisory test run and restart dominate.

Useful flags: `--dry-run` (change nothing), `--no-live` (publish, let the host updater apply within 5 minutes), `--apply-only` (apply what is already on master), `--revert [sha]` (undo the newest commit on master through the same pipeline).

The guarded updater refuses a production checkout with tracked local changes. If `ship` reports that, commit or discard those changes in the production checkout first.
