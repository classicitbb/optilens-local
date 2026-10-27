# Innovations Console

A replica of the vendor's Innovations REST web client (the `htdocs` site served
from `https://classicmain/app/`): **Tracking**, **Status Update**, **Rx Job
Details** and **Stock**, in the same layout (purple top bar, side nav, cards,
underline inputs, striped tables, vendor skin colours and logo from `GetSkin`).

It is a separate module from Job Floor. Code: `lib/innovations-console.js`
(service), `lib/innovations-console-routes.js`, `public/innovations-console.*`,
`public/styles/pages/innovations-console.css`. Page: `/modules/innovations-console`.

## How it works

The browser never talks to the vendor service. OptiLens signs in once with a
service account and relays each call, so credentials stay on the host:

| Page | OptiLens route | Vendor REST call |
|------|----------------|------------------|
| Tracking | `GET /api/innovations-console/tracking?searchType=&value=` | `GetTrackingData/` |
| Status Update (list) | `GET .../status-items` | `GetStatusItemList/` |
| Status Update (write) | `POST .../status-update` | `UpdateStatus/` |
| Rx Job Details | `GET .../rx-details?trayId=` | `GetRxDetails/` |
| Stock (read) | `GET .../stock?opc=` | `GetDescription/` |
| Stock (write) | `POST .../stock-adjust` | `AdjustStock/` |
| Skin | `GET .../skin` | `GetSkin/` |

Each vendor call is a JSON body carrying the session JWT; the reply is
`{ result: [ payload ] }`. Login is `GetLogin/` with `{user, password}`.

## Configuration (host only; never commit credentials)

One of, in this order:

1. Environment: `INNOVATIONS_REST_BASE` (for example `https://classicmain/rest/`),
   `INNOVATIONS_REST_USER`, `INNOVATIONS_REST_PASSWORD`. Add
   `INNOVATIONS_REST_INSECURE_TLS=true` if the server uses a self-signed certificate.
2. A credential-vault entry whose name contains "Innovations REST" with fields
   `baseurl`, `username`, `password` (and optional `insecuretls`).
3. `data/innovations-rest.json`: `{ "baseUrl", "username", "password", "insecureTls" }`.

Use an Innovations account dedicated to OptiLens so audit history is attributable.
Until it is configured, the page shows a banner and lookups return 503.

## Permissions and write safety

- `innovations-console.read`: every lookup. `innovations-console.manage`: the two writes.
  Both are role-assignable under Users and Access ("Innovations Console").
- The two writes (status update, stock adjustment) change the source system and are
  **off by default**. They run only when the `innovations_console.writes_enabled` app
  setting (or `INNOVATIONS_CONSOLE_WRITES_ENABLED`) is `true`. The buttons show as
  disabled until then.
- Every write attempt, refusal and failure is recorded in `core.audit_events` under
  module `innovations-console`.
- Stock quantities must be non-zero whole numbers (|qty| <= 10000) and the page asks
  for confirmation before adjusting.

## Not replicated

The vendor client's tracing, assignment, OMA and ProcessRXI/ProcessRemote calls exist in
its JS library but no page uses them, so they are not exposed. RX submission stays in
RX Capture.
