// Add-power trending across three independent channels.
//
// The question this answers is not "which add is most common" — it is "where do
// the three populations DISAGREE", because that gap is the ordering and
// promotion signal:
//
//   A. PRESCRIBED   what patients were prescribed        (RxArchive RAdd/LAdd, Rx orders)
//   B. CONSUMED     which blank adds were pulled from stock (RxArchive -> LensItem.Add_Cyl)
//   C. STOCK SOLD   adds sold as stock lenses            (InvoiceLines -> SKU -> Add_Cyl)
//
// plus D. HELD — the add mix currently on the shelf, as a point-in-time
// comparison rather than a series.
//
// A prescribed add that consistently outruns the held mix is an under-buy; a
// held add that no channel consumes is dead capital in a specific power.
//
// ── Why share of mix, not raw counts ─────────────────────────────────────────
// Channel C is ~2% the size of channel A (484 units vs 23,131 eyes over 24
// months). Plotted as raw counts it is a flat line at the axis and tells you
// nothing. Each channel is therefore normalised to its own monthly total, so
// its SHAPE stays legible; the bundled view keeps absolute volume so nobody
// mistakes C for a channel that matters by size.
//
// ── Why 1.00 to 3.50 ─────────────────────────────────────────────────────────
// Measured: that range covers 22,796 of 23,131 lens-eyes (98.6%) over 24
// months. Adds outside it are real but rare (0.25-0.85 = 284 eyes, 3.75-4.50 =
// 51) and are aggregated into an explicit "outside range" bucket rather than
// dropped, so the shares still sum to 100.

const sql = require("mssql");
const { getLiveSourcePool } = require("../db");

// Add powers are stored x100 on LensItem (Add_Cyl 250 = +2.50) and as floats on
// RxArchive (RAdd 2.5). Everything here works in x100 integers to avoid float
// equality comparisons on quarter-dioptre steps.
const ADD_MIN = 100;
const ADD_MAX = 350;
const ADD_STEP = 25;

const MF_TYPES = ["Progressive", "Bifocal"];

const ADD_STEPS = (() => {
  const steps = [];
  for (let a = ADD_MIN; a <= ADD_MAX; a += ADD_STEP) steps.push(a);
  return steps;
})();

function num(v) { return v == null ? 0 : Number(v); }

/** "+2.50" from 250. */
function addLabel(x100) {
  return "+" + (x100 / 100).toFixed(2);
}

/** Snap a raw add to its quarter-dioptre bucket, or null if outside the range. */
function bucketOf(x100) {
  const rounded = Math.round(x100 / ADD_STEP) * ADD_STEP;
  return rounded >= ADD_MIN && rounded <= ADD_MAX ? rounded : null;
}

/**
 * Least-squares slope of share against month index, in percentage points per
 * month. Used only to RANK adds as rising or falling — it is a trend direction,
 * not a forecast, and is reported as such.
 */
function slopeOf(points) {
  const n = points.length;
  if (n < 3) return null;
  const meanX = points.reduce((t, p, i) => t + i, 0) / n;
  const meanY = points.reduce((t, p) => t + p, 0) / n;
  let numerator = 0;
  let denominator = 0;
  points.forEach((y, i) => {
    numerator += (i - meanX) * (y - meanY);
    denominator += (i - meanX) ** 2;
  });
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

async function getAddPowerTrends(windowMonths) {
  const pool = await getLiveSourcePool();

  // Start on the FIRST of the month, not "today minus N months". Anchoring to
  // today makes the opening bucket a fragment of a month — measured at 0 units
  // against a 722-unit median — which draws every sparkline starting from the
  // floor and biases every slope upward, so the rising/falling ranking came out
  // systematically wrong.
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - windowMonths + 1, 1);
  const windowStart = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-01`;
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const request = pool.request()
    .input("windowMonths", sql.Int, windowMonths)
    .input("windowStart", sql.Date, windowStart);

  const result = await request.query(`
    -- A. PRESCRIBED: the add on the prescription, per eye, on Rx orders.
    WITH rxEyes AS (
      SELECT FORMAT(r.ShipDate, 'yyyy-MM') AS ym, mf.Name AS mfType,
             CAST(ROUND(r.RAdd * 100, 0) AS int) AS addX100
      FROM dbo.RxArchive r
      INNER JOIN dbo.MFTypes mf ON mf.GroupNum = r.RLensMG AND mf.MtrlNum = r.RLensMatl
                               AND mf.MFNum = r.RLensMF
      WHERE r.ShipDate >= @windowStart AND r.RAdd > 0
      UNION ALL
      SELECT FORMAT(r.ShipDate, 'yyyy-MM'), mf.Name,
             CAST(ROUND(r.LAdd * 100, 0) AS int)
      FROM dbo.RxArchive r
      INNER JOIN dbo.MFTypes mf ON mf.GroupNum = r.LLensMG AND mf.MtrlNum = r.LLensMatl
                               AND mf.MFNum = r.LLensMF
      WHERE r.ShipDate >= @windowStart AND r.LAdd > 0
    )
    SELECT ym, mfType, addX100, COUNT(*) AS units FROM rxEyes
    GROUP BY ym, mfType, addX100;

    -- B. CONSUMED: the add of the BLANK actually pulled from stock. Joined on
    -- the six-part compound key, because LensItem.Num alone is not unique.
    WITH consumed AS (
      SELECT FORMAT(r.ShipDate, 'yyyy-MM') AS ym, mf.Name AS mfType, li.Add_Cyl AS addX100
      FROM dbo.RxArchive r
      INNER JOIN dbo.LensItem li ON li.MaterialGroup = r.RLensMG AND li.Material = r.RLensMatl
                                AND li.MFType = r.RLensMF AND li.LensType = r.RLensType
                                AND li.[Option] = r.RLensOption AND li.Num = r.RLensItem
      INNER JOIN dbo.MFTypes mf ON mf.GroupNum = li.MaterialGroup AND mf.MtrlNum = li.Material
                               AND mf.MFNum = li.MFType
      WHERE r.ShipDate >= @windowStart
        AND r.RLensItem > 0 AND li.Add_Cyl > 0
      UNION ALL
      SELECT FORMAT(r.ShipDate, 'yyyy-MM'), mf.Name, li.Add_Cyl
      FROM dbo.RxArchive r
      INNER JOIN dbo.LensItem li ON li.MaterialGroup = r.LLensMG AND li.Material = r.LLensMatl
                                AND li.MFType = r.LLensMF AND li.LensType = r.LLensType
                                AND li.[Option] = r.LLensOption AND li.Num = r.LLensItem
      INNER JOIN dbo.MFTypes mf ON mf.GroupNum = li.MaterialGroup AND mf.MtrlNum = li.Material
                               AND mf.MFNum = li.MFType
      WHERE r.ShipDate >= @windowStart
        AND r.LLensItem > 0 AND li.Add_Cyl > 0
    )
    SELECT ym, mfType, addX100, COUNT(*) AS units FROM consumed
    GROUP BY ym, mfType, addX100;

    -- C. STOCK SOLD: lenses invoiced on stock orders (OrderType 3 Stock, 9
    -- Stock Debit), reached by SKU because CompoundKeyVal() does not exist here.
    SELECT FORMAT(i.InvoiceTime, 'yyyy-MM') AS ym, mf.Name AS mfType,
           li.Add_Cyl AS addX100, SUM(il.Quantity) AS units
    FROM dbo.InvoiceLines il
    INNER JOIN dbo.Invoices i ON i.InvoiceID = il.InvoiceID
    INNER JOIN dbo.Orders o ON o.OrderID = i.OrderID
    INNER JOIN dbo.LensItem li ON li.OPC_R = il.SKU OR li.OPC_L = il.SKU OR li.OPC_P = il.SKU
    INNER JOIN dbo.MFTypes mf ON mf.GroupNum = li.MaterialGroup AND mf.MtrlNum = li.Material
                             AND mf.MFNum = li.MFType
    WHERE i.InvoiceTime >= @windowStart
      AND il.CategoryType = 1 AND o.OrderType IN (3, 9) AND li.Add_Cyl > 0
    GROUP BY FORMAT(i.InvoiceTime, 'yyyy-MM'), mf.Name, li.Add_Cyl;

    -- D. HELD: the add mix on the shelf right now. A position, not a series.
    SELECT mf.Name AS mfType, li.Add_Cyl AS addX100,
           COUNT(*) AS items,
           SUM(li.OnHand_R + li.OnHand_L + li.OnHand_P * 2) AS units,
           CAST(SUM((li.OnHand_R + li.OnHand_L + li.OnHand_P * 2) * ISNULL(li.Cost, 0)) AS decimal(18,2)) AS stockValue
    FROM dbo.LensItem li
    INNER JOIN dbo.MFTypes mf ON mf.GroupNum = li.MaterialGroup AND mf.MtrlNum = li.Material
                             AND mf.MFNum = li.MFType
    WHERE li.Flags & 2 = 0 AND li.Add_Cyl > 0
      AND (li.OnHand_R + li.OnHand_L + li.OnHand_P * 2) > 0
    GROUP BY mf.Name, li.Add_Cyl;
  `);

  const [prescribed, consumed, stockSold, held] = result.recordsets;

  const months = [...new Set(
    [...prescribed, ...consumed, ...stockSold].map((r) => r.ym).filter(Boolean)
  )].sort();

  // The month in progress is incomplete by definition. It stays visible — the
  // most recent data is the most interesting — but is excluded from the slope,
  // so a partial month never reads as a downturn.
  const completeMonths = months.filter((m) => m !== currentMonth);

  const channels = {
    prescribed: buildChannel(prescribed, months, completeMonths, "Prescribed", "What patients were prescribed"),
    consumed: buildChannel(consumed, months, completeMonths, "Consumed from stock", "Add power of the blank actually pulled"),
    stockSold: buildChannel(stockSold, months, completeMonths, "Sold as stock", "Lenses invoiced on stock orders")
  };

  return {
    months,
    completeMonths,
    currentMonth,
    addSteps: ADD_STEPS.map((a) => ({ addX100: a, label: addLabel(a) })),
    mfTypes: MF_TYPES,
    channels,
    held: buildHeld(held),
    // The comparison that carries the decision.
    mismatch: buildMismatch(channels.prescribed, buildHeld(held)),
    coverage: {
      range: `${addLabel(ADD_MIN)} to ${addLabel(ADD_MAX)}`,
      note: "Adds outside the range are aggregated into an explicit 'outside range' bucket, not dropped, so shares still total 100%."
    }
  };
}

/**
 * One channel: per MF type, a per-add monthly share series plus a trend slope.
 * Shares are of that channel's own monthly total, so a small channel stays
 * readable next to a large one.
 */
function buildChannel(rows, months, completeMonths, label, description) {
  const byType = {};
  const completeCount = completeMonths.length;

  for (const mfType of MF_TYPES) {
    const typeRows = rows.filter((r) => r.mfType === mfType);
    const monthTotals = new Map(months.map((m) => [m, 0]));
    const cells = new Map();          // `${ym}|${bucket}` -> units
    let outsideRange = 0;
    let total = 0;

    for (const row of typeRows) {
      const units = num(row.units);
      const bucket = bucketOf(num(row.addX100));
      total += units;
      monthTotals.set(row.ym, (monthTotals.get(row.ym) || 0) + units);
      if (bucket === null) { outsideRange += units; continue; }
      const key = `${row.ym}|${bucket}`;
      cells.set(key, (cells.get(key) || 0) + units);
    }

    const series = ADD_STEPS.map((bucket) => {
      const shares = months.map((m) => {
        const denominator = monthTotals.get(m) || 0;
        const units = cells.get(`${m}|${bucket}`) || 0;
        return denominator > 0 ? Math.round((units / denominator) * 1000) / 10 : 0;
      });
      const units = months.reduce((t, m) => t + (cells.get(`${m}|${bucket}`) || 0), 0);
      return {
        addX100: bucket,
        label: addLabel(bucket),
        units,
        share: total > 0 ? Math.round((units / total) * 1000) / 10 : 0,
        monthlyShare: shares,
        // Slope over complete months only — the trailing partial month would
        // otherwise pull every add's trend downward.
        slope: slopeOf(shares.slice(0, completeCount))
      };
    });

    byType[mfType] = {
      total,
      outsideRange,
      monthlyTotals: months.map((m) => monthTotals.get(m) || 0),
      series
    };
  }

  return { label, description, byType };
}

function buildHeld(rows) {
  const byType = {};
  for (const mfType of MF_TYPES) {
    const typeRows = rows.filter((r) => r.mfType === mfType);
    const total = typeRows.reduce((t, r) => t + num(r.units), 0);
    const buckets = new Map();
    let outsideRange = 0;

    for (const row of typeRows) {
      const bucket = bucketOf(num(row.addX100));
      if (bucket === null) { outsideRange += num(row.units); continue; }
      const existing = buckets.get(bucket) || { units: 0, items: 0, stockValue: 0 };
      buckets.set(bucket, {
        units: existing.units + num(row.units),
        items: existing.items + num(row.items),
        stockValue: existing.stockValue + num(row.stockValue)
      });
    }

    byType[mfType] = {
      total,
      outsideRange,
      series: ADD_STEPS.map((bucket) => {
        const cell = buckets.get(bucket) || { units: 0, items: 0, stockValue: 0 };
        return {
          addX100: bucket,
          label: addLabel(bucket),
          units: cell.units,
          items: cell.items,
          stockValue: Math.round(cell.stockValue * 100) / 100,
          share: total > 0 ? Math.round((cell.units / total) * 1000) / 10 : 0
        };
      })
    };
  }
  return { label: "Held in stock", description: "Add mix on the shelf right now", byType };
}

/**
 * Demand share minus held share, per add. Positive = you hold less of this add
 * than demand implies (under-stocked); negative = you hold more (over-stocked).
 * This is the line that tells someone what to order.
 */
function buildMismatch(prescribed, held) {
  const byType = {};
  for (const mfType of MF_TYPES) {
    const demand = prescribed.byType[mfType];
    const stock = held.byType[mfType];
    if (!demand || !stock) continue;

    byType[mfType] = ADD_STEPS.map((bucket, i) => {
      const demandShare = demand.series[i].share;
      const heldShare = stock.series[i].share;
      const gap = Math.round((demandShare - heldShare) * 10) / 10;
      return {
        addX100: bucket,
        label: addLabel(bucket),
        demandShare,
        heldShare,
        gap,
        demandUnits: demand.series[i].units,
        heldUnits: stock.series[i].units,
        heldValue: stock.series[i].stockValue,
        verdict: gap > 3 ? "under_stocked" : gap < -3 ? "over_stocked" : "balanced"
      };
    }).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  }
  return byType;
}

module.exports = { getAddPowerTrends, ADD_STEPS, addLabel, slopeOf, bucketOf };
