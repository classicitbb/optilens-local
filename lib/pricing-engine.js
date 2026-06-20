/**
 * pricing-engine.js — Phase 2: the money logic (pure, testable, UI-free)
 *
 * Implements IMPLEMENTATION_PLAN.md §2:
 *   - Standard price anchored on the most expensive AVAILABLE approved supplier
 *     (scope = approved & available; excluded labs drop out of the anchor).
 *   - Floor margin applied to whichever lab is the anchor (default 15%).
 *     Guarantee: sourcing from ANY available lab yields margin >= floorMargin.
 *   - Per-pricelist supplier priority shapes the *preferred/displayed* source,
 *     never the safety floor.
 *   - Zero-/low-margin manual override -> finds the supplier(s) that make the
 *     entered price acceptable and returns them for the user to CONFIRM
 *     (nothing auto-applied); on confirm the line is source-constrained.
 *   - $10 wholesale floor + clean upward rounding (never breaches the floor).
 *   - Retail = separate list derived from wholesale via a configurable markup.
 *
 * Works in Node (module.exports) and the browser (window.PricingEngine).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PricingEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // Default supplier desirability, most-desired first (least at the end).
  const DEFAULT_PRIORITY = ['TOG Rx Lab', 'Vision Rx Lab', 'Optex Laboratories', 'SkyLab'];

  const DEFAULTS = {
    floorMargin: 0.15,      // thin minimum margin on the anchor (worst case)
    minMargin: 0.15,        // lowest acceptable margin for override sourcing
    rounding: 0.5,          // round standard prices up to nearest this increment
    wholesaleFloor: 10,     // $10 USD minimum (wholesale only)
    priority: DEFAULT_PRIORITY,
    excluded: [],           // supplier names excluded for this pricelist
    costModel: null,        // null => landed cost == supplier price (see landedCostFor)
  };

  // ── Landed cost (§2.7) ──────────────────────────────────────────────────
  // True cost to land an uncut lens in Barbados, per supplier, per pair:
  //   CIF    = FOB supplier price × (1 + freight/insurance%)   [origin-specific]
  //   landed = CIF × (1 + duty% + environmental levy% + clearance%) + brokerage/pair
  // VAT is NOT included — for a VAT-registered reseller it is a recoverable input
  // credit, so baking it into cost would overprice you. Edging is excluded (separate page).
  function landedCostFor(price, supplier, cm) {
    if (!cm) return price;
    const freight = (cm.freightPct && (cm.freightPct[supplier] != null ? cm.freightPct[supplier] : cm.freightPct.default)) || 0;
    const cif = price * (1 + freight);
    const uplift = (cm.dutyPct || 0) + (cm.leviesPct || 0) + (cm.clearancePct || 0);
    return round2(cif * (1 + uplift) + (cm.brokeragePerPair || 0));
  }
  // Return a combo clone whose supplier costs are LANDED costs (raw kept on _raw).
  function landCombo(combo, cm) {
    if (!cm) return combo;
    const landed = {};
    for (const [s, c] of Object.entries(combo.suppliers || {})) landed[s] = landedCostFor(Number(c), s, cm);
    return Object.assign({}, combo, { suppliers: landed, _raw: combo.suppliers });
  }

  // ── helpers ───────────────────────────────────────────────────────────
  function ceilTo(value, inc) {
    if (!inc || inc <= 0) return value;
    return Math.ceil((value - 1e-9) / inc) * inc;
  }
  function marginAt(price, cost) {
    if (!(price > 0)) return -Infinity;
    return (price - cost) / price;
  }
  function round2(n) { return Math.round(n * 100) / 100; }

  // suppliers that actually offer this combo, minus excluded labs
  function availableSuppliers(combo, excluded) {
    const ex = new Set(excluded || []);
    return Object.entries(combo.suppliers || {})
      .filter(([s]) => !ex.has(s))
      .map(([s, c]) => ({ supplier: s, cost: Number(c) }))
      .filter(s => Number.isFinite(s.cost) && s.cost > 0);
  }

  // the anchor = most expensive available (the worst case you could be forced to)
  function anchorOf(combo, excluded) {
    const av = availableSuppliers(combo, excluded);
    if (!av.length) return null;
    return av.reduce((a, b) => (b.cost > a.cost ? b : a));
  }

  // preferred = first supplier in priority order that is available
  function preferredOf(combo, excluded, priority) {
    const av = availableSuppliers(combo, excluded);
    if (!av.length) return null;
    const order = priority || DEFAULT_PRIORITY;
    for (const name of order) {
      const hit = av.find(s => s.supplier === name);
      if (hit) return hit;
    }
    // any supplier not in the priority list -> fall back to cheapest available
    return av.reduce((a, b) => (b.cost < a.cost ? b : a));
  }

  /**
   * Standard (wholesale) price for one combo.
   * Returns null-ish { available:false } when no supplier can fill it (a true gap).
   */
  function standardPrice(combo, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const lc = landCombo(combo, o.costModel);   // operate on LANDED costs
    const anchor = anchorOf(lc, o.excluded);
    if (!anchor) {
      return { available: false, reason: 'no available supplier', combo: combo.key };
    }
    // price off the anchor at the floor margin, round UP so we never breach it
    let price = anchor.cost / (1 - o.floorMargin);
    price = ceilTo(price, o.rounding);
    if (o.wholesaleFloor) price = Math.max(price, o.wholesaleFloor);

    const preferred = preferredOf(lc, o.excluded, o.priority);
    const av = availableSuppliers(lc, o.excluded);
    // worst-case margin (on the anchor) and best expected (on preferred source)
    const floorMarginActual = marginAt(price, anchor.cost);
    const preferredMargin = marginAt(price, preferred.cost);
    // guarantee check: every available supplier must clear the floor
    const minMarginAcrossSuppliers = Math.min(...av.map(s => marginAt(price, s.cost)));
    const raw = lc._raw || combo.suppliers || {};

    return {
      available: true,
      key: combo.key,
      priceUSD: round2(price),
      anchorSupplier: anchor.supplier,
      anchorCost: round2(anchor.cost),               // LANDED cost of the anchor
      anchorSupplierPrice: raw[anchor.supplier] != null ? round2(Number(raw[anchor.supplier])) : null,
      floorMargin: round2(floorMarginActual),
      preferredSupplier: preferred.supplier,
      preferredCost: round2(preferred.cost),         // LANDED cost of preferred source
      preferredSupplierPrice: raw[preferred.supplier] != null ? round2(Number(raw[preferred.supplier])) : null,
      preferredMargin: round2(preferredMargin),
      minMarginAcrossSuppliers: round2(minMarginAcrossSuppliers),
      supplierCount: av.length,
      safe: minMarginAcrossSuppliers >= o.floorMargin - 1e-9,
    };
  }

  /**
   * Evaluate a manual price the user typed against the anchor.
   * If it clears the floor on the anchor -> ok, no constraint.
   * If not -> return the supplier(s) that make it acceptable, for the user to
   * CONFIRM. The cheapest acceptable supplier becomes the proposed constraint.
   */
  function evaluateOverride(combo, enteredPriceUSD, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const lc = landCombo(combo, o.costModel);   // compare against LANDED costs
    const anchor = anchorOf(lc, o.excluded);
    if (!anchor) return { available: false };
    const av = availableSuppliers(lc, o.excluded);
    const anchorMargin = marginAt(enteredPriceUSD, anchor.cost);

    if (anchorMargin >= o.minMargin - 1e-9) {
      return { ok: true, needsConfirmation: false, anchorMargin: round2(anchorMargin) };
    }
    // entered price too low for the anchor — who CAN we source from acceptably?
    const acceptable = av
      .filter(s => marginAt(enteredPriceUSD, s.cost) >= o.minMargin - 1e-9)
      .sort((a, b) => a.cost - b.cost);
    return {
      ok: false,
      needsConfirmation: acceptable.length > 0,
      anchorMargin: round2(anchorMargin),
      // propose the cheapest acceptable lab as the sourcing constraint
      constraint: acceptable.length
        ? { supplier: acceptable[0].supplier, cost: round2(acceptable[0].cost), margin: round2(marginAt(enteredPriceUSD, acceptable[0].cost)) }
        : null,
      acceptableSuppliers: acceptable.map(s => ({ supplier: s.supplier, cost: round2(s.cost), margin: round2(marginAt(enteredPriceUSD, s.cost)) })),
      message: acceptable.length
        ? `At $${enteredPriceUSD}, source only from ${acceptable[0].supplier} (or cheaper). Confirm?`
        : `At $${enteredPriceUSD} no approved supplier clears ${Math.round(o.minMargin * 100)}% margin — price is a loss.`,
    };
  }

  // Retail price derived from a wholesale price. markup: {type:'pct'|'flat', value}
  function retailFrom(wholesaleUSD, markup) {
    if (!markup) return wholesaleUSD;
    if (markup.type === 'flat') return round2(wholesaleUSD + markup.value);
    // default percentage markup (value 100 => +100% => 2x)
    return round2(wholesaleUSD * (1 + (markup.value || 0) / 100));
  }

  /**
   * Gap-smoothing across an ordered ladder of prices (e.g. one treatment column
   * ordered worst->best tier, or one tier across material indices).
   * Enforces non-decreasing order (better never cheaper than lesser) and tidy
   * rounding. Operates on an array of {key, priceUSD}; returns adjusted copy.
   * Adjustments only ever raise a price (never below its own floor).
   */
  function smoothLadder(rungs, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const out = rungs.map(r => Object.assign({}, r));
    let prev = -Infinity;
    for (const r of out) {
      if (r.priceUSD == null) continue;
      let p = r.priceUSD;
      if (p < prev) p = prev;               // no inversion: never cheaper than a lesser lens
      p = ceilTo(p, o.rounding);
      r.priceUSD = round2(p);
      prev = r.priceUSD;
    }
    return out;
  }

  return {
    DEFAULT_PRIORITY,
    DEFAULTS,
    marginAt,
    landedCostFor,
    landCombo,
    availableSuppliers,
    anchorOf,
    preferredOf,
    standardPrice,
    evaluateOverride,
    retailFrom,
    smoothLadder,
  };
});
