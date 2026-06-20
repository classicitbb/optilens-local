# OptiLens Local Hardening Audit

Date: 2026-06-19

## Implemented in this pass

- Added database-backed user credentials in `core.user_credentials`.
- Added seeded permissions for platform admin, user management, dashboard writes, credentials management, delivery read/write, pricing read/write, and integration read/manage.
- Added a fresh-install default administrator seed, `optilens` / `optilens`, only when no password credentials exist yet.
- Added first-admin bootstrap through `/api/auth/bootstrap-state` and `/api/auth/bootstrap`.
- Added login, logout, and current-user endpoints backed by HttpOnly SameSite cookies.
- Added `/admin/users` for administrator-controlled account creation and account enable/disable.
- Protected change-capable and sensitive APIs:
  - Dashboard layout saves.
  - Delivery and source lookup APIs.
  - Pricing automation APIs and saved pricelists.
  - Connector and credential vault APIs.
  - Migrations and cleanup actions. Migration stays open only while no platform credential exists, so fresh installs can create the auth tables before first-admin bootstrap.
- Updated delivery and pricing audit calls so authenticated actor IDs are recorded on app-owned changes.
- Added baseline HTTP hardening headers and a 1 MB JSON body limit.
- Tightened static path resolution to use `path.relative()` instead of a plain string prefix check.

## Current connection posture

- Private app MSSQL remains the only write target for OptiLens Local.
- Source MSSQL Innovations stays read-only through the existing source connection helper.
- Access, CSV, Excel, text, and file-system repository connections still need connector-specific adapters before production use.
- Connector secrets remain server-side only. Browser JavaScript receives masked status or unlock tokens, not raw stored credentials unless an authorized credential-management user explicitly reveals them.

## UI audit notes

- Shared sign-in is injected by `public/shared.js` across existing pages.
- Direct typing remains supported in login and admin forms; no normal data-entry workflow requires `navigator.clipboard`.
- The app uses ordinary editable `input` controls. No global `keydown`, `beforeinput`, `input`, `paste`, or `focus` blockers were added.
- Existing module pages can still be opened directly, but protected data calls return `401` until the user signs in.

## Remaining hardening work

- Persist platform sessions in SQL if users need sessions to survive Node restarts.
- Add password-change flow for users with `must_change_password = 1`.
- Replace the bootstrap default `optilens` account with named user accounts before production use.
- Add role-edit and password-reset controls to `/admin/users`; the first pass supports create and enable/disable.
- Add HTTPS behind IIS before relying on browser PWA install or stronger cookie transport guarantees on LAN clients.
- Add connector adapters for Access, CSV, Excel, text files, and customer file repositories with explicit read/write modes.
- Add file repository path validation so customer document folders cannot escape approved roots.
- Add integration-run audit entries for every external pull/push job.
- Add automated browser verification in an external browser, using real typing rather than clipboard-based filling.
