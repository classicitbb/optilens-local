# OptiLens live-data gateway runbook

The live gateway is an outbound-only worker that delivers approved, customer-
scoped reads to CV Web on demand. It does not expose an inbound office endpoint
and does not periodically copy customer data.

## Supported reads

- Innovations account balance and recent statement headers.
- One Innovations statement and its visible line items.
- Recent Innovations order status for the exact linked account number.
- OptiLens Local delivery status for the exact linked account number.

The operation registry is in `lib/live-data-gateway.js`. Arbitrary paths, SQL,
and customer searches are not accepted.

## Starting the worker

Open **Integrations → Website feeds**, enter the credentials-vault passphrase, and
select **Start live gateway**. The screen reports the last heartbeat and request
count.

For unattended startup, set `OPTILENS_SYNC_PASSPHRASE` in the Windows service
environment. The server starts the worker after the vault unlocks. The worker
uses the existing CV API base URL and API key stored in the vault. It does not
use InnovaAPI.

Full setup guide: `docs/cv-live-data-api-guide.md`.

## Health expectations

- Heartbeat: every five seconds.
- Request polling: approximately every 750 milliseconds.
- Private query timeout: 18 seconds.
- Cloud request expiry: 30 seconds.
- Source failures are returned to the requesting page; no stale financial data
  is substituted.

