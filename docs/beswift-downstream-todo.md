# BeSwift / Export standardisation — downstream backlog

Deferred "nice to have" items to implement later. Captured 2026-07-07.

## 1. Resume automation from any stage (page-state aware) — DONE (double-entry variant, 2026-07-07)
Realised as **idempotent re-run / double-entry protection** rather than a stage
jump: because the paused flow is an in-memory `await` that already continues
where it left off, the real gap was re-running `fillHeader`/`fillItems` on a
partially-filled form (after a reload or restart) re-entering everything. The
fill now treats the **live DOM as source of truth**:
- `setByLabel` / `pickByLabel` skip any field that's already committed. If it
  matches the payload → skip silently; if it's filled but **wrong**, it's left
  as-is and flagged to the feed + `log_json` (`flagAlreadyFilled`) — never
  overwritten (Russell's call: leave + flag).
- `fillItems` counts existing saved item rows (`countExistingItemRows`) and
  resumes the loop past them, so a re-run never adds duplicate customs lines.
- Remaining nicety (deferred): reconcile the *last logged stage* explicitly and
  handle an item dialog left **open** mid-entry. Field/item idempotency covers
  the double-entry risk today.
- ⚠ `countExistingItemRows`' items-table selector is best-effort (matches a data
  table whose header reads Commodity/Description/HS/Gross Weight) and defaults to
  0 (fill all) when unsure — **confirm against BeSwift's saved-items grid live.**

## 2. Make dropdown option-index hints data-driven — DONE (2026-07-07)
`OPTION_INDEX_HINTS` moved out of `content.js` into `delivery.standards_catalog`
via **migration 020** (`beswift_option_index` column, seeded Country of Origin=3,
Package Type=18). `getBeswiftOptionIndexHints()` in `lib/standards-catalog.js`
resolves label→index from the default option; `buildPayloadFromShipment` carries
it as `payload.optionIndexHints`; `runFill` merges it over the built-in
`OPTION_INDEX_HINTS_FALLBACK`. Operators can now correct a position by editing the
catalog row — no code change. **Run `database/020-standards-catalog-option-index.sql`
(rollback alongside it) to add the column.**

## 3. Auto-learn / self-verify BeSwift option positions — DONE (suggest-only, 2026-07-07)
When a positional hint points at the wrong row, `tryIndexPick` locates where the
option actually is in the open list and logs a **suggestion** to the feed +
`log_json` (`maybeSuggestOptionIndex`): "Package Type found at index 17, catalog
hint is 18 — set beswift_option_index = 17 to apply." **Suggest-only** — the hint
is never rewritten automatically (Russell's call). Deduped once per field per
fill. Only fires for fields that have a hint but drifted; unhinted fields aren't
learned yet (acceptable for v1).

## 4. Commercial-invoice UI polish (still deferred)
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
