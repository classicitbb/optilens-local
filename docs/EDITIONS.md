# Editions

An edition decides which modules a site runs. Classic Visions runs the **full** edition (no manifest, nothing blocked). A licensed site, such as Value Optical, carries a signed manifest and runs only the core plus what it bought.

## What a licensed edition does

- **Routes.** Any page or API route that is not in the core or in an enabled module answers 404, as if it did not exist. Matching is by the longest rule, so `/api/admin/users` is core while `/api/admin/data-access` belongs to Privileged Data Access. Scripts, styles and images are not pages and are always served.
- **Migrations.** `lib/migrations.js` tags each migration with `core` or a module. A licensed site runs the core plus its enabled modules, in registry order. A new migration must be tagged.
- **Workers.** The supplier-mail poller, email sync and live gateway start only when their module is enabled.
- **Screens.** The Launch Pad, launcher, `/api/modules` and the user's `accessibleModules` list only enabled modules, and the AI assistant button is hidden unless Automation is enabled.
- **Fail closed.** A manifest that is missing (in a build marked `requireManifest`), tampered with, signed with another key or expired leaves only the core.

## Modules

`rx-capture`, `vault`, `delivery-export`, `pricing-automation`, `integrations`, `automation`, `email`, `business-metrics`, `inventory-intelligence`, `qbo`, `beswift`, `chemistry`, `privileged-data-access`. The route prefixes each one owns are in `lib/edition.js`.

Some modules build on others. Enabling one enables what it needs: `delivery-export` and `beswift` only migrate together, and `email` builds on `automation`. These were found by migrating each module on top of a fresh core + RX Capture database.

## Issue a manifest

The private signing key lives outside the repository, at `%USERPROFILE%\.optilens\edition-signing-ed25519.pem` (or `--key`, or `OPTILENS_EDITION_SIGNING_KEY`). Back it up. The matching public key is committed as `lib/edition-public-key.pem`.

```bash
node scripts/edition-sign.js --licensee "Value Optical Ltd" --edition value-optical --modules rx-capture,vault --expires 2027-10-15
node scripts/edition-sign.js --verify data/edition.json
```

The manifest is written to `data/edition.json` (not tracked). Restart the service to apply it. `GET /api/system/edition` (administrators) shows what is active. To trial a manifest without touching `data/`, set `OPTILENS_EDITION_FILE`.

## Site settings

The values that differ between labs are edited on the RX Capture page (gear button, administrators only), not in `data/rx/config.json`: lab number, customer sequence, remote operator, agent name, and the Innovations incoming, staging and archive folders. They are stored in `core.app_settings` (key `rx.site-settings`) and layered over the checked-in defaults: defaults, then site settings, then the Credentials Vault's incoming-folder entry. **Check folders** reports whether each folder is reachable and writable by the service without writing anything.

A licensed edition refuses to approve, submit or release any order until the lab number, remote operator and incoming folder are saved, so a new lab never sends a file under another lab's number. The full edition is not affected.

## Build a licensed edition

A licensed distribution is built from this repository, not copied by hand.

```bash
node scripts/build-edition.js --edition value-optical --check                   # classify and verify, write nothing
node scripts/build-edition.js --edition value-optical --out build/value-optical # write the tree
```

- `editions/<name>.json` says which modules the edition includes, the downstream repository, the `package.json` fields to override, and lab-specific defaults to blank (the donor lab's number, customer, operator and incoming folder in `data/rx/config.json`).
- `editions/file-map.json` gives every tracked file an owner: `core`, a module id, or `never`. The first matching rule wins. A tracked file no rule matches fails the build, so adding a file to core means deciding where it goes. `database/NNN` files take their owner from the tags in `lib/migrations.js`.
- The build writes `lib/edition-build.json` (`{"requireManifest": true}`) into the output only. Do not commit it to core: it would lock the full edition.
- It also writes `edition-sync.json`, the list of files the build owns with their hashes.
- `--strict` fails the build if code from a module the edition does not include has to ship (see below). `--allow-dirty` builds with uncommitted changes to tracked files.

**What the allowlist removes today.** It removes the other modules' pages, scripts, migrations, extensions, docs and tests. It cannot yet remove their server code: `server.js` requires most of `lib/` when it starts, so everything it reaches ships as dormant code (listed in the build output, 72 files for Value Optical). Dormant code is blocked by the edition gate and has no pages or migrations. Removing it needs `server.js` to load module handlers only when the module is enabled; `--strict` will pass once it does.

## Sync core to a licensed repository

`.github/workflows/edition-sync.yml` runs when a `v*` tag is pushed to core (or by hand with a dry-run option). It checks the allowlist, builds the edition, runs the built tree's own tests, applies the build to a checkout of the downstream repository, runs the tests again with the downstream files in place, and opens a pull request there. It never pushes to the downstream main branch. The workflow needs one secret in core, `EDITION_SYNC_TOKEN`, a token that can push branches and open pull requests in the downstream repository.

The sync replaces only the files listed in the downstream `edition-sync.json`, adds new ones, and removes the ones core stopped shipping. Files that exist only downstream, such as the Zen adapter, are left alone. If a synced file was edited downstream the sync stops and lists it: send the change to core as a pull request instead. `--force` overwrites anyway.

`.github/workflows/edition-check.yml` runs the allowlist check and the edition tests on every pull request, so an unclassified file is caught before a release.

To rehearse locally:

```bash
node scripts/build-edition.js --edition value-optical --out build/value-optical
node scripts/build-edition.js --apply-build build/value-optical --apply ../optilens-value-optical
```

## Trials and remote renewal

A trial is a signed manifest with `trial: true` and an end date. It runs the licensed modules until that moment, then the licensed modules stop and only the core stays (sign-in, users, dashboard, settings). Pages and APIs of the licensed modules answer 402 with the reason (an HTML page for browsers, JSON `licence_inactive` for the API) instead of 404. Nothing is deleted. A banner shows the days left in the last week and a dismissible notice before that.

```bash
# 1. Start a 30-day trial. Publish licences/value-optical.json at the renew address.
node scripts/edition-sign.js --licensee "Value Optical Ltd" --edition value-optical --modules rx-capture,vault      --trial-days 30 --renew-url https://licences.example.com/value-optical.json --out licences/value-optical.json

# 2. They pay: turn it into a licence with a year to run, same licence id.
node scripts/edition-sign.js --from licences/value-optical.json --paid --expires 2027-10-15 --out licences/value-optical.json

# 3. Or give more time, or withdraw it.
node scripts/edition-sign.js --from licences/value-optical.json --trial-days 14 --out licences/value-optical.json
node scripts/edition-sign.js --from licences/value-optical.json --revoke --out licences/value-optical.json
```

The site starts with the manifest from step 1 in `data/edition.json`. Its `renewUrl` is an HTTPS address of your choosing; any static host works because the file is signed and carries nothing secret. At start-up and every 6 hours the site fetches that address, and replaces its manifest when the new one

- is signed with the vendor key,
- has the same licence id and edition, and
- was issued later than the one on disk (an old file cannot roll a licence back).

An administrator can check at once with `POST /api/system/edition/refresh`; `GET /api/system/edition` shows the trial state and the last renewal result. Changed modules take effect for requests immediately. Background workers (supplier mail, email sync, live gateway) start or stop at the next service restart.

If the site cannot reach the address, nothing changes and the trial still ends on its own date, so a blocked network does not extend it. The service also remembers the latest time it has seen in `data/edition-clock.json`, so setting the clock back does not stretch a trial. Someone with full access to the machine can still delete that file or the manifest check; a trial is a commercial control, not a defence against a determined administrator. For that reason the licensed build ships with `requireManifest`, and the contract, not the code, is what protects the source.

## Limits to know

- Gating hides and blocks; it does not remove code. A site that holds the full source could delete the manifest. A licensed distribution is therefore built from an allowlist of modules (see Build a licensed edition) and carries `lib/edition-build.json` with `{ "requireManifest": true }`, so a missing manifest does not unlock anything.
- The signing key protects the manifest, not the source. Losing it means no further renewals can be signed, and a site cannot be moved to a new key without a new build.
- On a fresh database the supplier-mail migrations (027 and 028) fail because `ops.SupplierRecords` has no `patient_name` column until application code adds it. This predates editions and does not affect RX Capture, but a full-edition install on an empty database needs that fixed first.
- Value Optical's migration set (core + RX Capture) was run on an empty SQL Server 2022 Express database and completes cleanly.
