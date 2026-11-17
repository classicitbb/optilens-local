# Order quality review (Business Metrics tab)

Goal: customers can order any lens we sell and the order arrives right with as little human
touch-up as possible. Staff corrections after an order arrives are the measurable symptom, so
this tab turns recurring corrections and recorded order errors into a short review list.

Where: Business Metrics > **Order quality**. Needs `business-metrics.read` to view and
`business-metrics.manage` to record a decision.

## What it reads (Innovations, read-only, live)
| Check | Source | Shown when |
|---|---|---|
| Lens or colour swapped by hand | `dbo.JobChanges` Right/Left Design Name, old -> new | 3+ orders and 2+ customers in 90 days |
| Lens names Innovations cannot find | `JobChanges` Lens/Design Name changing to or from "Unknown item option" / "Option Not Found" | 3+ orders |
| Add-ons added or removed by hand | `JobChanges` Misc Item | 3+ orders and 2+ customers |
| Orders flagged with an error | `dbo.Orders.LastResult` / `LastResultMessage` (non-zero) | any |
| Redirect lookup | `dbo.LensSubs` (shown in Innovations as Lens Redirects) | for the swap check |

The headline tile is the share of Rx orders that needed a lens change in the last 30 days against the
30 before. If the review work is paying off, it falls.

Staff are counted ("staff accounts"), never named. Redirect matches are approximate: staff edits carry
short names ("Trans 8 Gray") while redirects hold full lens names.

## Decisions (app database only)
Each finding can be **Accepted** (will be changed in Innovations), marked **Fixed**, or **Dismissed**, with a
reason. Stored in `metrics.order_quality_decisions` (`database/060-order-quality-review.sql`) and audited.
Handled findings disappear from the list. A finding marked Fixed returns, flagged, if it is seen again after
the decision, which is how "did the fix work" is checked. Nothing here writes to Innovations.

## Known limits
- Fixes themselves are still made by a person in Innovations (Lens Redirects, aliases, rules, set-up); this tab
  says where to look.
- Redirects that exist but do not fire are reported as "Similar redirect exists". Why they are bypassed is not
  yet established; see the Innova Training notes (`docs/error-monitor-design.md`).
- Rejected status scan files live in the Innovations transfer folder and are not read here.
- Error codes other than the message text are not interpreted.

## Files
`lib/metrics/order-quality.js`, `lib/metrics/order-quality-decisions.js`, section `order-quality` in
`lib/metrics/detail.js`, route `POST /api/business-metrics/order-quality/decision` in `server.js`,
tab in `public/business-metrics.html` / `public/business-metrics-tabs.js`, multi-button row actions in
`public/business-metrics-shared.js`, tests in `test/order-quality.test.js`.
