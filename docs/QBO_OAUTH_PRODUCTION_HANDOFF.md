# QBO production OAuth handoff

CV Web owns the public OAuth gateway at `qbo.classicvisions.net`; this internal
service must never be publicly reachable for QBO OAuth.

The Local worker must claim a single encrypted authorization-code handoff from
CV Web, validate its transaction identifier, expiry, environment, and exact
redirect URI, exchange it against Intuit production, and atomically persist the
rotated refresh token in host-only Windows-protected storage. It must return
only a sanitized connection result to CV Web.

The existing browser-accessible Credentials Vault is not an approved QBO
production secret store. No Local browser route may reveal QBO client secrets,
access tokens, refresh tokens, or unmasked realm IDs.

Required host-only configuration:

- `OPTILENS_QBO_GATEWAY_URL=https://qbo.classicvisions.net`
- `OPTILENS_QBO_HANDOFF_TOKEN` (the same secret configured in Vercel as
  `QBO_LOCAL_HANDOFF_TOKEN`)

Run `npm run qbo:auth:exchange -- <transaction-id>` after the admin callback,
and arrange `npm run qbo:commands:run` as a host task for queued reconciliation
and disconnect requests. The callback realm ID is passed only through the
encrypted server-to-server handoff and is persisted exclusively in the
Windows-protected Local store.

Initial operation is reconciliation only. Keep
`OPTILENS_QBO_PRODUCTION_APPLY_ENABLED` unset.
