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

Initial operation is reconciliation only. Keep
`OPTILENS_QBO_PRODUCTION_APPLY_ENABLED` unset.
