// Machine-readable context for Business Metrics sections.
//
// Serves /api/business-metrics/context/:section — the same figures the tab
// renders, wrapped with the things a reader needs in order not to misread them:
// what each measure means, which thresholds produced it, where the data came
// from, and what it is known to get wrong.
//
// The design rule behind this endpoint: an assistant answers from PRECOMPUTED
// figures, never by generating SQL. Text-to-SQL against a live production ERP
// (1.9M StockItems, 1.5M LensItem rows) risks a table scan that stalls the lab
// and a hallucinated join that reports a confidently wrong money figure.
// Grounding on numbers the server already computed makes a wrong answer
// checkable against the same payload.
//
// It is deliberately verbose about limitations. A model reading only the totals
// would report "$134,227 of dead stock" as fact; reading `caveats` it learns
// velocity undercounts by roughly a third and will say so.

const { getInventorySection, SPEED_LABELS } = require("./inventory");

/** Prose definitions of every measure, so nothing has to be inferred from a key name. */
const INVENTORY_GLOSSARY = {
  universe:
    "Active lens items (LensItem.Flags & 2 = 0) that either hold stock now or moved within the window. "
    + "Excludes the ~1.07M active catalogue rows never stocked, which would otherwise swamp the non-mover list.",
  speedClass:
    "Demand band from units consumed in the window: non_mover = 0, slow = 1 to slowMaxUnits, "
    + "regular = up to regularMaxUnits, fast = above that. Cut points are configurable and are reported in `thresholds`.",
  coverMonths:
    "Months of supply = on-hand divided by monthly consumption rate. Null (not infinite) when nothing moved, "
    + "because cover is undefined for a non-mover. This — not speed — is what makes a slow item urgent: "
    + "4 units a year with 2 on hand is healthy, 4 a year with 60 on hand is dead capital.",
  turnRate:
    "Units consumed in the window divided by units on hand. Higher means stock is cycling faster.",
  stockValue: "On-hand quantity multiplied by LensItem.Cost (or MiscItems.Cost). Currency is BBD.",
  onHand:
    "For lenses: OnHand_R + OnHand_L + (OnHand_P * 2), so a pair counts as two units. For misc: MiscItems.OnHand.",
  treatmentGroup:
    "Clear / Photochromic / Polarized / Other coatings / Unclassified, derived from option and material names. "
    + "Unclassified is shown rather than defaulted, so coverage gaps stay visible instead of inflating Clear.",
  miscSold:
    "Misc items with invoiced sales in the window (Chemistrie clip-ons, snap-ons, magnets, bridges, frames). "
    + "Measured from invoice lines — a real turn rate.",
  miscConsumed:
    "Misc items with no sales but with purchase or stock activity (Satisloh parts, lab extras, misc supplies). "
    + "Rate is a PURCHASING PROXY from PO receipts, NOT measured consumption — Innovations records no usage for these.",
  negativeQty:
    "Active SKUs recording less than zero on hand. A counting error, not a buying signal: correct by physical "
    + "count before trusting any valuation or reorder figure for that item.",
  zeroCost:
    "Active SKUs holding quantity at zero cost. They record no COGS when used, silently inflating gross margin. "
    + "Written-off stock deliberately held at zero cost can be suppressed with a recorded reason."
};

const SOURCES = {
  database: "Innovations (MSSQL), read-only",
  lensVelocity: "dbo.RxArchive job history, joined on the six-part lens compound key",
  lensStock: "dbo.LensItem OnHand_R/L/P and Cost — current values, no history",
  miscSales: "dbo.InvoiceLines CategoryType = 9, joined to MiscItems via RecordID",
  miscPurchases: "dbo.POReceiptDetails via POItems and StockItems (StockItemType = 3)",
  stockTakes: "dbo.CycleCounts / dbo.CycleCountItems",
  notUsed:
    "dbo.StockTransactions is NOT used for consumption — it recorded 93 'Rx Usage' rows in 12 months "
    + "against ~8,700 jobs, is dominated by Manual Change and Cancellation Return, and its quantity signs "
    + "are inconsistent (PO Receipt sums negative)."
};

async function inventoryContext() {
  const data = await getInventorySection();

  return {
    section: "inventory",
    title: "Inventory turnover analysis",
    generatedAt: data.generatedAt,
    currency: "BBD",

    thresholds: data.thresholds,
    window: data.window,
    glossary: INVENTORY_GLOSSARY,
    sources: SOURCES,
    caveats: data.caveats,

    figures: {
      headline: data.headline,
      speedBands: data.speedBands.map((b) => ({
        speedClass: b.speedClass,
        label: SPEED_LABELS[b.speedClass],
        items: b.items,
        onHandUnits: b.onHand,
        stockValue: b.stockValue,
        unitsMoved: b.units
      })),
      byTreatment: data.byTreatment,
      byMaterial: data.byMaterial,
      misc: data.misc,
      exceptions: {
        negative: {
          count: data.exceptions.negative.count,
          units: data.exceptions.negative.units,
          value: data.exceptions.negative.value
        },
        zeroCost: {
          count: data.exceptions.zeroCost.count,
          units: data.exceptions.zeroCost.units
        },
        suppressed: { count: data.exceptions.suppressed.count }
      }
    },

    // Named so a caller can fetch the rows behind any figure above.
    drills: {
      "inventory-speed": "params: class = non_mover | slow | regular | fast",
      "inventory-treatment": "params: group = Clear | Photochromic | Polarized | Other coatings | Unclassified",
      "inventory-negative": "no params — active SKUs with negative on hand",
      "inventory-zero-cost": "no params — active SKUs holding stock at zero cost",
      "inventory-suppressed": "no params — items excluded by an override, with reasons",
      "inventory-misc": "params: panel = sold | consumed"
    },
    drillEndpoint: "/api/business-metrics/drill/:kind"
  };
}

const BUILDERS = { inventory: inventoryContext };

async function getSectionContext(section) {
  const build = BUILDERS[section];
  if (!build) {
    const error = new Error(
      `No context is published for section "${section}". Available: ${Object.keys(BUILDERS).join(", ")}.`
    );
    error.statusCode = 404;
    throw error;
  }
  return build();
}

module.exports = { getSectionContext, INVENTORY_GLOSSARY, SOURCES };
