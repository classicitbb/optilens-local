// Inventory recommendations — advisory only, never automatic.
//
// Turns the classification into a ranked list of things worth doing, each
// carrying the evidence that produced it so a reader can disagree with it.
//
// Design rules, settled with the user:
//   - Nothing acts on its own. This produces suggestions and records decisions.
//   - Alerts fire ONLY where on-hand > 0. You cannot write off, discount or
//     clear stock you do not hold, so a dead catalogue line is not a finding.
//   - Ranked by money at stake, not by count. 2,346 non-movers is a wall; the
//     forty holding real value is a morning's work.
//   - Every recommendation states the numbers behind it. A prompt a manager
//     cannot audit is a prompt they will learn to ignore.
//
// Speed answers "is this selling"; COVER answers "do I have too much of it".
// Both are needed: 4 units a year with 2 on hand is healthy, 4 a year with 60
// on hand is dead capital. Rules below key off cover wherever a quantity
// judgement is involved.

const sql = require("mssql");
const { getAppPool } = require("../db");
const { getUniverse, getInventoryTrendsSection, loadThresholds } = require("./inventory");

// Below this, an item is not worth a manager's attention whatever its ratios.
// Stops the list filling with $12 of dead stock while $4,000 sits further down.
const MIN_VALUE_AT_STAKE = 150;

// A fast mover with less than this much cover risks running out.
const REORDER_COVER_MONTHS = 2;

const KINDS = {
  write_off: {
    label: "Write off or clear",
    action: "Nothing has moved in the window. Write it off, or clear it at a discount while it still has value.",
    severity: "critical"
  },
  discount: {
    label: "Discount or promote",
    action: "Still selling, but you hold far more than the run rate justifies. Promote it or discount to clear the excess.",
    severity: "warning"
  },
  reorder: {
    label: "Reorder — running thin",
    action: "Selling steadily with little cover left. Reorder before it stocks out.",
    severity: "serious"
  },
  trending_up: {
    label: "Trending up — consider buying",
    action: "Demand for this add power is rising and you hold less than demand implies.",
    severity: "good"
  },
  over_bought: {
    label: "Stop buying this add",
    action: "You hold materially more of this add power than demand justifies.",
    severity: "warning"
  }
};

function num(v) { return v == null ? 0 : Number(v); }
function round2(v) { return Math.round(v * 100) / 100; }

/* ─────────── decisions (app DB) ─────────── */

/**
 * Decisions already taken, keyed so a recommendation can check itself.
 * A snooze that has expired stops suppressing, which is the point of a snooze.
 */
async function loadDecisions() {
  const empty = { map: new Map(), total: 0 };
  try {
    const pool = await getAppPool();
    const result = await pool.request().query(`
      SELECT item_kind, material_group, material, mf_type, lens_type, lens_option,
             item_num, misc_item_id, recommendation_kind, decision, reason,
             snooze_until, created_at, created_by
      FROM metrics.inventory_recommendation_actions
      WHERE decision IN (N'dismissed', N'snoozed', N'actioned');
    `);

    for (const row of result.recordset) {
      // An expired snooze is no longer a decision.
      if (row.decision === "snoozed" && row.snooze_until && new Date(row.snooze_until) < new Date()) {
        continue;
      }
      const key = row.item_kind === "lens"
        ? [row.material_group, row.material, row.mf_type, row.lens_type, row.lens_option, row.item_num].join(":")
        : String(row.misc_item_id);
      empty.map.set(`${key}|${row.recommendation_kind}`, {
        decision: row.decision,
        reason: row.reason,
        snoozeUntil: row.snooze_until,
        decidedAt: row.created_at,
        decidedBy: row.created_by
      });
      empty.total += 1;
    }
    return empty;
  } catch {
    return empty;
  }
}

/* ─────────── rules ─────────── */

function buildItemRecommendations(items, thresholds, kind, excluded) {
  const out = [];

  for (const item of items) {
    // Only things actually on the shelf can be acted on.
    if (item.onHand <= 0) continue;

    const value = Math.abs(num(item.stockValue));
    const cover = item.coverMonths;

    if (item.speedClass === "non_mover") {
      if (value < MIN_VALUE_AT_STAKE) {
        excluded.count += 1;
        excluded.value = round2(excluded.value + value);
        continue;
      }
      out.push(make(item, kind, "write_off", value, {
        onHand: item.onHand,
        unitsInWindow: 0,
        stockValue: value,
        lastMoved: item.lastMoved || null,
        why: `No movement in ${thresholds.windowMonths} months. ${item.onHand} units on hand, ${fmt(value)} tied up.`
      }));
      continue;
    }

    // Over-covered: still selling, but the stock will outlast any sane horizon.
    if (cover != null && cover >= thresholds.coverCriticalMonths) {
      const excessUnits = Math.max(0, item.onHand - Math.round((item.units / thresholds.windowMonths) * thresholds.coverWarnMonths));
      const excessValue = round2(excessUnits * num(item.cost));
      if (excessValue < MIN_VALUE_AT_STAKE) {
        excluded.count += 1;
        excluded.value = round2(excluded.value + excessValue);
        continue;
      }
      out.push(make(item, kind, "discount", excessValue, {
        onHand: item.onHand,
        unitsInWindow: item.units,
        coverMonths: cover,
        excessUnits,
        excessValue,
        why: `${cover} months of cover at the current run rate (${item.units} units in ${thresholds.windowMonths} months). About ${excessUnits} units — ${fmt(excessValue)} — beyond a ${thresholds.coverWarnMonths}-month holding.`
      }));
      continue;
    }

    // Running thin: real demand, little left.
    if (cover != null && cover < REORDER_COVER_MONTHS
        && (item.speedClass === "fast" || item.speedClass === "regular")) {
      const monthlyRate = item.units / thresholds.windowMonths;
      // What a stockout would cost: roughly a month of sales at cost.
      const atRisk = round2(monthlyRate * num(item.cost));
      out.push(make(item, kind, "reorder", atRisk, {
        onHand: item.onHand,
        unitsInWindow: item.units,
        coverMonths: cover,
        monthlyRate: Math.round(monthlyRate * 10) / 10,
        why: `${cover} months of cover left at ${Math.round(monthlyRate * 10) / 10} units a month. ${item.onHand} on hand.`
      }));
    }
  }

  return out;
}

/**
 * Add-power level signals from Phase 2. These are about a POWER, not a SKU, so
 * they carry no item key and cannot be dismissed per-item — they are dismissed
 * against the add power itself.
 */
function buildAddRecommendations(trends) {
  const out = [];
  const mismatch = (trends.addPowers && trends.addPowers.mismatch) || {};
  const prescribed = trends.addPowers && trends.addPowers.channels.prescribed;

  for (const mfType of Object.keys(mismatch)) {
    const slopes = new Map();
    const series = prescribed && prescribed.byType[mfType] && prescribed.byType[mfType].series;
    if (series) for (const s of series) slopes.set(s.addX100, s.slope);

    for (const row of mismatch[mfType]) {
      const slope = slopes.get(row.addX100);

      if (row.verdict === "under_stocked") {
        // Rising AND under-stocked is the strongest buy signal available.
        const rising = slope != null && slope > 0.02;
        out.push({
          id: `add:${mfType}:${row.addX100}:${rising ? "trending_up" : "trending_up"}`,
          kind: "trending_up",
          scope: "add_power",
          itemKind: "add",
          label: `${mfType} add ${row.label}`,
          valueAtStake: round2(row.heldValue),
          severity: rising ? "serious" : "good",
          evidence: {
            demandShare: row.demandShare,
            heldShare: row.heldShare,
            gapPoints: row.gap,
            demandUnits: row.demandUnits,
            heldUnits: row.heldUnits,
            slopePointsPerMonth: slope,
            why: `${row.demandShare}% of ${mfType.toLowerCase()} demand but only ${row.heldShare}% of stock held` +
                 (rising ? `, and rising ${slope} points a month.` : ".")
          },
          action: KINDS.trending_up.action,
          actionLabel: KINDS.trending_up.label
        });
        continue;
      }

      if (row.verdict === "over_stocked" && row.heldValue >= MIN_VALUE_AT_STAKE) {
        out.push({
          id: `add:${mfType}:${row.addX100}:over_bought`,
          kind: "over_bought",
          scope: "add_power",
          itemKind: "add",
          label: `${mfType} add ${row.label}`,
          valueAtStake: round2(row.heldValue),
          severity: "warning",
          evidence: {
            demandShare: row.demandShare,
            heldShare: row.heldShare,
            gapPoints: row.gap,
            demandUnits: row.demandUnits,
            heldUnits: row.heldUnits,
            slopePointsPerMonth: slope,
            why: `${row.heldShare}% of stock held against ${row.demandShare}% of demand — ${fmt(row.heldValue)} in this power.`
          },
          action: KINDS.over_bought.action,
          actionLabel: KINDS.over_bought.label
        });
      }
    }
  }

  return out;
}

function make(item, itemKind, kind, valueAtStake, evidence) {
  return {
    id: `${itemKind}:${item.key}:${kind}`,
    kind,
    scope: "item",
    itemKind,
    itemKey: item.key,
    miscItemId: itemKind === "misc" ? item.miscItemId : null,
    label: item.label,
    sku: item.sku || item.skuR || null,
    treatment: item.treatment || null,
    speedClass: item.speedClass,
    valueAtStake: round2(valueAtStake),
    severity: KINDS[kind].severity,
    evidence,
    action: KINDS[kind].action,
    actionLabel: KINDS[kind].label
  };
}

function fmt(v) {
  return "BBD " + Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/* ─────────── public ─────────── */

/**
 * The ranked list. Decisions already taken are attached rather than removed, so
 * the caller can show or hide them — a dismissal is a record, not a deletion.
 */
async function getRecommendations({ includeDecided = false } = {}) {
  const thresholds = await loadThresholds();
  const [{ lensItems, miscItems }, decisions] = await Promise.all([
    getUniverse(),
    loadDecisions()
  ]);

  let trends = null;
  try {
    trends = await getInventoryTrendsSection();
  } catch {
    // Add-power signals are a bonus; item-level recommendations stand alone.
    trends = null;
  }

  const excluded = { count: 0, value: 0 };

  // Two scopes, ranked separately and never merged. An add-power signal
  // aggregates hundreds of SKUs, so its value at stake (~BBD 21k) dwarfs any
  // single item's (~BBD 400). Ranking them together is apples to oranges: it
  // put every add signal above every item action and buried the work someone
  // can actually do this morning.
  const itemActions = [
    ...buildItemRecommendations(lensItems, thresholds, "lens", excluded),
    ...buildItemRecommendations(miscItems.filter((m) => m.isActive), thresholds, "misc", excluded)
  ];
  const addSignals = trends ? buildAddRecommendations(trends) : [];

  for (const rec of [...itemActions, ...addSignals]) {
    const key = rec.scope === "item" ? rec.itemKey : rec.id;
    rec.decision = decisions.map.get(`${key}|${rec.kind}`) || null;
  }

  const split = (list) => {
    const open = list.filter((r) => !r.decision).sort((a, b) => b.valueAtStake - a.valueAtStake);
    const decided = list.filter((r) => r.decision).sort((a, b) => b.valueAtStake - a.valueAtStake);
    return { open, decided };
  };

  const items = split(itemActions);
  const adds = split(addSignals);

  const byKind = {};
  for (const rec of [...items.open, ...adds.open]) {
    if (!byKind[rec.kind]) {
      byKind[rec.kind] = {
        kind: rec.kind, label: KINDS[rec.kind].label, scope: rec.scope, count: 0, valueAtStake: 0
      };
    }
    byKind[rec.kind].count += 1;
    byKind[rec.kind].valueAtStake = round2(byKind[rec.kind].valueAtStake + rec.valueAtStake);
  }

  return {
    generatedAt: new Date().toISOString(),
    thresholds,
    minValueAtStake: MIN_VALUE_AT_STAKE,
    reorderCoverMonths: REORDER_COVER_MONTHS,

    summary: {
      openItemActions: items.open.length,
      openAddSignals: adds.open.length,
      decided: items.decided.length + adds.decided.length,
      itemValueAtStake: round2(items.open.reduce((t, r) => t + r.valueAtStake, 0)),
      addValueAtStake: round2(adds.open.reduce((t, r) => t + r.valueAtStake, 0)),
      byKind: Object.values(byKind).sort((a, b) => b.valueAtStake - a.valueAtStake)
    },

    // Specific SKUs, ranked by money at stake — the morning's work.
    itemActions: items.open,
    // Buying-strategy signals about a whole add power.
    addSignals: adds.open,
    decided: includeDecided ? [...items.decided, ...adds.decided] : [],

    // Never silently truncate: say what the value threshold left out.
    belowThreshold: {
      count: excluded.count,
      value: excluded.value,
      note: `${excluded.count} further items fall below the ${fmt(MIN_VALUE_AT_STAKE)} threshold, holding ${fmt(excluded.value)} in total. They are real but individually too small to action; export the non-mover drill for the full list.`
    },

    addSignalsAvailable: Boolean(trends),
    notes: [
      "Advisory only — nothing here acts on its own, and nothing is written back to Innovations.",
      "Only items with stock on hand appear: you cannot write off, discount or clear what you do not hold.",
      "Item actions and add-power signals are ranked separately. An add signal covers hundreds of SKUs, so its value is not comparable to a single item's.",
      "Ranked by money at stake, not by count.",
      "Dismissals and snoozes are recorded with a reason and stay visible; an expired snooze returns to the list."
    ]
  };
}

/** Record a human decision. The only write path in this module. */
async function recordDecision({ recommendation, decision, reason, snoozeDays, actorUserId, actorName }) {
  if (!recommendation || !recommendation.id) {
    throw Object.assign(new Error("A recommendation is required."), { statusCode: 400 });
  }
  if (!["dismissed", "snoozed", "actioned"].includes(decision)) {
    throw Object.assign(new Error(`Unknown decision "${decision}".`), { statusCode: 400 });
  }
  if (!reason || !String(reason).trim()) {
    // The reason is the whole value of the audit trail.
    throw Object.assign(new Error("A reason is required so the decision can be audited later."), { statusCode: 400 });
  }

  const pool = await getAppPool();
  const isLens = recommendation.itemKind === "lens";
  const parts = isLens && recommendation.itemKey
    ? recommendation.itemKey.split(":").map(Number)
    : [null, null, null, null, null, null];

  const snoozeUntil = decision === "snoozed"
    ? new Date(Date.now() + (Number(snoozeDays) || 30) * 86400000)
    : null;

  await pool.request()
    .input("item_kind", sql.NVarChar(10), isLens ? "lens" : "misc")
    .input("mg", sql.Int, parts[0])
    .input("mt", sql.Int, parts[1])
    .input("mf", sql.Int, parts[2])
    .input("lt", sql.Int, parts[3])
    .input("op", sql.Int, parts[4])
    .input("it", sql.Int, parts[5])
    .input("misc_item_id", sql.Int, recommendation.miscItemId || null)
    .input("kind", sql.NVarChar(40), recommendation.kind)
    .input("decision", sql.NVarChar(20), decision)
    .input("reason", sql.NVarChar(500), String(reason).slice(0, 500))
    .input("snooze_until", sql.DateTime2, snoozeUntil)
    // Freeze the numbers as they stood, so a later reader can tell whether the
    // situation has changed since the decision was taken.
    .input("context_json", sql.NVarChar(sql.MAX), JSON.stringify({
      label: recommendation.label,
      valueAtStake: recommendation.valueAtStake,
      severity: recommendation.severity,
      evidence: recommendation.evidence || null
    }))
    .input("created_by_user_id", sql.UniqueIdentifier, actorUserId || null)
    .input("created_by", sql.NVarChar(100), actorName || null)
    .query(`
      INSERT INTO metrics.inventory_recommendation_actions
        (item_kind, material_group, material, mf_type, lens_type, lens_option, item_num,
         misc_item_id, recommendation_kind, decision, reason, snooze_until, context_json,
         created_by_user_id, created_by)
      VALUES
        (@item_kind, @mg, @mt, @mf, @lt, @op, @it, @misc_item_id, @kind, @decision,
         @reason, @snooze_until, @context_json, @created_by_user_id, @created_by);
    `);

  return { ok: true, decision, snoozeUntil: snoozeUntil ? snoozeUntil.toISOString() : null };
}

module.exports = { getRecommendations, recordDecision, KINDS, MIN_VALUE_AT_STAKE };
