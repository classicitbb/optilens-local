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

## Limits to know

- Gating hides and blocks; it does not remove code. A site that holds the full source could delete the manifest. A licensed distribution is therefore built from an allowlist of modules and carries `lib/edition-build.json` with `{ "requireManifest": true }`, so a missing manifest does not unlock anything.
- The signing key protects the manifest, not the source.
- On a fresh database the supplier-mail migrations (027 and 028) fail because `ops.SupplierRecords` has no `patient_name` column until application code adds it. This predates editions and does not affect RX Capture, but a full-edition install on an empty database needs that fixed first.
- Value Optical's migration set (core + RX Capture) was run on an empty SQL Server 2022 Express database and completes cleanly.
