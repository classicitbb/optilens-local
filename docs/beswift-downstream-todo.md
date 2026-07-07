# BeSwift / Export standardisation — downstream backlog

Deferred "nice to have" items to implement later. Captured 2026-07-07.

## 1. Resume automation from any stage (page-state aware)
Today "Resume automation" continues the paused flow but does not re-derive where
the form actually is. Make resume **read the live page**, detect the current
section/stage and scroll position (which section headings are present, which
fields are already committed, whether an item dialog is open and how many item
rows exist), and resume from that detected stage instead of assuming linear
position. Should let an operator fix something out of order and resume safely.
Builds on the existing checkpoint log (`log_json`) — reconcile the last logged
stage against the DOM before continuing.

## 2. Make dropdown option-index hints data-driven
`OPTION_INDEX_HINTS` in `content.js` (Country of Origin = 3, Package Type = 18)
is currently hardcoded to BeSwift's list order. Move these to
`delivery.standards_catalog` (add a `beswift_option_index` column) and carry them
in the payload, so operators can correct positions without a code change and the
extension stays in sync when BeSwift reorders a list.

## 3. Auto-learn / self-verify BeSwift option positions
Extend the item field audit to record the position at which each option was
actually found (or failed), so the catalog's index hints become self-correcting
over time — similar to the co-item catalog "learn" pattern.

## 4. Commercial-invoice UI polish
- Add CSS for the compliance panel (`.ci-compliance`, `.ci-compliance-ok`,
  `.ci-compliance-warn`, `.ci-check-ok`, `.ci-check-miss`, `.ci-compliance-*`)
  in `public/styles.css` — currently renders unstyled but functional.
- Wire the commercial-invoice delivery-terms / currency / package-type / port
  inputs to `GET /api/standards-catalog` so operators pick from the curated
  Incoterms/shortlist values instead of free text.

## Done (moved out of backlog)
- FCA "Free Carrier" is the confirmed BeSwift dropdown string for air delivery
  terms (Russell confirmed 2026-07-07).
- Field finder resolves label-only inputs; Presenting Bank selects first option;
  item dropdowns verify-and-retry (text → positional → keyboard).
