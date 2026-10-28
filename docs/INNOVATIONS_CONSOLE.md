# Innovations Console

A replica of the vendor's Innovations web client (the `htdocs` site served from
`https://classicmain/app/`): **Tracking**, **Status Update**, **Rx Job Details**
and **Stock**, in the same layout (purple top bar, side nav, cards, underline
inputs, striped tables).

It is a separate module from Job Floor. Code: `lib/innovations-console.js`
(service), `lib/innovations-console-db.js` (database reads),
`lib/innovations-console-routes.js`, `public/innovations-console.*`,
`public/styles/pages/innovations-console.css`. Page: `/modules/innovations-console`.

## How it works

The console reads the Innovations source database directly through the same
read-only pool every other OptiLens module uses (`db.getSourcePool`). There is no
vendor REST service, service account or extra credential to configure. Responses
keep the vendor's shapes, so the page is unchanged from the original client.

| Page | OptiLens route | Source tables |
|------|----------------|---------------|
| Tracking | `GET /api/innovations-console/tracking?searchType=&value=` | `Orders`, `OrderStatuses`, `StatusItems`, `Invoices`, `Customers`, `Shipments`, `Farmouts` |
| Status Update (list) | `GET .../status-items` | `StatusItems` |
| Rx Job Details | `GET .../rx-details?trayId=` | `RxJobs`, `Materials`, `LensType` |
| Stock | `GET .../stock?opc=` | `LensItem`, `LensMfgr`, `Materials` |

Tracking searches by Tray (`Orders.JobID`), Order ID, Rx number (`RxJobs.RxNum`),
Patient (prefix match) or Account. Tray, Order and Rx return one job with its status
history; Patient and Account return a list.

## Permissions

- `innovations-console.read`: every lookup. `innovations-console.manage`: the two write routes.
  Both are role-assignable under Users and Access ("Innovations Console").

## Writes are not performed

Status Update and Stock "Adjust" change the source system, and the vendor application's
own rules (stock effects, hold checks, farm-out handling) are not replicated here. Both
routes validate their input, are **refused with 403**, and the refusal is recorded in
`core.audit_events` under module `innovations-console`. The buttons show as disabled.
Status writes are done through Job Floor's guarded writer or in Innovations itself.

## Not replicated

The vendor client's tracing, assignment, OMA and ProcessRXI/ProcessRemote calls exist in
its JS library but no page uses them, so they are not exposed. RX submission stays in
RX Capture. The vendor skin (logo, colours) came from a service call; the console uses the
default vendor colours.
