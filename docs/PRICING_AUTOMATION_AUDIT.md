# Pricing Automation — Audit

_Audited 2026-07-07 against the OptiLens Local goal: "keep prices up to date with our website, our file system and our lab management system (Innovations)" and "issue pricelists confidently while managing many suppliers and prices."_

## Verdict

The pricing engine itself is genuinely good — a clean, pure, testable margin engine with a real safety guarantee. The workflow around it (classify → price → save → publish) is well built and the UI is mature. But measured against the stated goal, it is **not yet true pricing automation**: it is a well-engineered **assisted pricing workbench**. Three things stop it from "keeping prices up to date" and "issuing pricelists confidently" on its own: the catalog is not wired to the live cost sources, the publish loop back to the website is not operational, and the anchor-pricing rule silently overprices whenever mixed-cost suppliers share a bucket.

## What is working well

The money logic in `lib/pricing-engine.js` is the strongest part. It is pure and side-effect free, prices off landed cost (freight + duty + levies + clearance, correctly excluding recoverable VAT), enforces a floor-margin guarantee, applies a wholesale floor with upward-only rounding, and smooths ladders so a better lens is never cheaper than a lesser one. I ran it across all 363 live combos at default settings: **0 combos priced below the 15% floor and 0 unpriceable** — the guarantee holds in practice, not just in theory.

The workbench around it is also solid: per-pricelist supplier priority and exclusion, per-combo and per-supplier disable, manual-override with a confirmation flow that names which supplier(s) make the entered price acceptable, a publish-time profit guard (`plValidatePricedRowsForProfit` refuses to publish below-floor prices), a single-source-of-truth classifier shared by every import path, and persisted classification overrides (the Sourcing Review tag pills) that re-bucket without re-pulling. Credentials are encrypted in a passphrase-locked vault. This is careful, defensible engineering.

## Findings, by severity

### High — the standard price anchors to the most-expensive supplier, which overprices mixed buckets

The engine sets the standard price off the **most expensive available approved supplier** so that any lab which fills the order clears 15%. That is safe, but it means one outlier cost drags the whole price up. Measured on the live catalog, **10 of 363 combos have a priciest supplier ≥5× the cheapest**, and the effect is large:

- `Clear · Single Vision Regular · 1.50` — costs range **$0.98 to $30.40 (31×)**; standard price lands at **$36**, while the preferred source costs $5.38 (already 85% margin).
- `Clear · Progressive Adept · 1.50` — **$5.56 to $55 (10×)** → priced at **$65**, preferred cost $5.56.
- `Clear · Progressive Adept · POLY` — **$9 to $80** → priced at **$94.50**.

In every case a $22–$80 supplier (an in-house digital lab or a likely data error) is sitting in the same bucket as $1–$10 conventional houses, and the anchor rule prices to the top of that range. The result is a pricelist that is 3–30× higher than it needs to be on those lines, which is the opposite of "issuing prices confidently." The mitigations exist (exclude/disable a supplier per list) but they are manual whack-a-mole across 363 combos. **Recommendation:** either (a) anchor on the *preferred/cheapest reliable* supplier and use the max only to compute the floor guarantee, or (b) add an automatic outlier guard that flags/quarantines a supplier cost that is an N× multiple of the bucket median before it can set the anchor.

### High — the catalog is not connected to Innovations or the file system; it pulls only from the CV/Supabase catalog

The goal names three cost sources: the website, the file system, and Innovations (the lab management system, via ODBC/MS-SQL). In reality the pricing catalog is pulled **only** from the Classic Visions / Optilens Supabase catalog (`optilens-connector.js` and `cv-api-connector.js`). Innovations feeds customers, contacts and shipments (`innovations-sync.js`), but **supplier costs never come directly from Innovations, Access, CSV, Excel or a watched folder** — they arrive pre-aggregated from the cloud catalog, which is itself downstream. So "keep prices up to date with our lab management system" is not actually happening in this app; it depends on some other process keeping the Supabase catalog current. The last live pull wrote the generated catalog on **2026-06-24** — two weeks stale as of this audit, with no scheduled refresh. **Recommendation:** add a direct Innovations/ODBC cost feed (or a file-drop importer) as a first-class source alongside the Supabase pull, and schedule the refresh rather than relying on a manual "Pull" click.

### High — the publish-back-to-website loop is not operational

"Keeping the website up to date" requires writing prices out. Two publish paths exist and neither completes a live write today:

- `optilens-connector.push()` is hard-disabled — it returns `"Live write disabled pending first-connect schema confirmation."`
- `cv-api-connector.publish()` is implemented (POST `/catalog` into a draft version) but depends on CV **api-v1**, which per project history is returning 500s on all authenticated endpoints (an ambiguous-`id` SQL bug in the key-auth path). So a real commit would fail at runtime.

The build/preview/save side is complete, but the "issue the pricelist" side stops at dry-run. Until the api-v1 blocker is fixed server-side and one connector's commit path is proven end-to-end, this is a builder that can't yet deliver. **Recommendation:** treat the api-v1 fix as the gating item, then run one real dry-run→commit→verify cycle and capture the draft-version id it returns.

### Medium — approved-supplier list is a hardcoded allowlist; unknown suppliers vanish silently

`APPROVED` in `lens-classifier.js` is a fixed array. Any supplier not on it is dropped from pricing with no surface in the main view. The live raw feed contains **`Wilsdorf Lab` (34 rows)** and any future supplier — all silently excluded. For a tool whose job is "manage many suppliers," a new lab appearing in the feed should raise a visible "unapproved supplier — approve?" prompt, not disappear. The Sourcing Review rows do carry a "Supplier not approved" reason, but nothing pulls the operator's attention to a *newly appeared* supplier. **Recommendation:** surface unapproved-but-present suppliers as an alert on the Sources/Sourcing view, and make approval a one-click action instead of a code edit.

### Medium — 140 of 363 combos (39%) are single-supplier

For 39% of price points there is exactly one approved supplier, so there is no competitive anchor and no fallback if that lab can't fill the order — the "worst case" and the "only case" are the same. This is a sourcing/coverage risk more than an engine bug, but it is invisible today. **Recommendation:** add a coverage indicator (e.g. a "single-source" pill) so these lines are visible when issuing a list, and feed them to sourcing as gaps to fill.

### Medium — no automated tests on the money logic

`pricing-engine.js` is pure and eminently testable, but there is no test file and no `test` script in `package.json`. The margin guarantee, ladder monotonicity, override sourcing, and landed-cost math are exactly the invariants you want locked down before every publish. **Recommendation:** add a small unit suite asserting the floor guarantee, no ladder inversions, wholesale-floor behavior, and override-constraint selection; wire it into a pre-publish check.

### Low — two parallel, disconnected pricing systems

There is a second, older SQL rules engine (`lib/pricing.js` + `pricing.price_rules` / `price_calculations`, exposed at `/api/pricing/*`) that is entirely separate from the Pricelist Builder (`/api/v2/*` + `pricing-engine.js`). It does generic markup-rule math and is not referenced by the builder UI. It is dead weight and a source of confusion about "which pricing engine is authoritative." **Recommendation:** either retire `/api/pricing/*` or document it explicitly as the customer-account rules layer and connect it; don't leave two engines implying different answers.

### Low — data-integrity signals aren't acted on

The `$30.40` SkyLab single-vision cost and similar outliers are almost certainly miscategorized products or bad data landing in the wrong bucket. Right now they flow straight into the anchor. Pairing the outlier guard (High finding above) with a "confirm this cost" review step would turn a silent overpricing into a caught data error.

## Bottom line

Keep the engine — it's the good part and it does what it claims. To reach the goal, close the loop in this order: (1) fix the api-v1 blocker and prove one live publish end-to-end; (2) add a direct Innovations/file cost feed plus a scheduled refresh so "up to date" is automatic; (3) fix the anchor/outlier overpricing so issued prices are trustworthy without per-line babysitting; (4) make new/unapproved suppliers and single-source lines visible; (5) lock the money logic with tests. Items 1–3 are what stand between "assisted workbench" and "pricing automation you can trust to issue lists on its own."
