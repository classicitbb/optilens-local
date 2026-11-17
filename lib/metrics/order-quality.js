// Order quality review board — read-only against Innovations.
//
// Goal: customers should be able to order any lens we sell and have it arrive right with
// as little human touch-up as possible. Staff corrections after an order arrives are the
// measurable symptom, so this reads the correction history (dbo.JobChanges), the errors
// Innovations records on orders (dbo.Orders.LastResult) and the redirect rules
// (dbo.LensSubs, shown in Innovations as "Lens Redirects"), and turns recurring patterns
// into a short list a person can accept, mark fixed, or dismiss.
//
// It never writes to Innovations and never names staff: only how many accounts made a
// correction is shown. Decisions are stored by lib/metrics/order-quality-decisions.js.
//
// Verified against the live database 2026-11-16 (docs/ORDER_QUALITY_REVIEW.md):
//  - Orders.Source 2 is Lablink; those orders carry almost all of the lens corrections.
//  - JobChanges.PropertyName values used: Right/Left Design Name, Right/Left Lens Name, Misc Item.
//  - Placeholder values written when a name cannot be resolved: "Unknown item option" (lens)
//    and "Option Not Found" (design).

const { getSourcePool } = require("../db");
const { loadDecisions } = require("./order-quality-decisions");

const DEFAULT_DAYS = 90;
const MIN_ORDERS = 3;
const MIN_CUSTOMERS = 2;
const ROW_LIMIT = 100;
const UNRESOLVED = ["Unknown item option", "Option Not Found"];

const CHECKS = {
  "lens-swap": {
    label: "Lens or colour swapped by hand",
    detail: "The same lens design or colour is changed to another after the order arrives"
  },
  "lens-unresolved": {
    label: "Lens names Innovations cannot find",
    detail: "A lens name turns into “Unknown item option” or “Option Not Found” and is re-picked by hand"
  },
  "addon-by-hand": {
    label: "Add-ons added or removed by hand",
    detail: "The same add-on is repeatedly added to or removed from orders by staff"
  },
  "order-errors": {
    label: "Orders Innovations flagged with an error",
    detail: "Error text Innovations recorded on the order (pricing, lens selection, design set-up)"
  }
};

/* ─────────── pure helpers (unit tested) ─────────── */

function norm(value) {
  return String(value == null ? "" : value).toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
}

function isUnresolved(value) {
  return UNRESOLVED.some((u) => norm(u) === norm(value));
}

/** Stable key so a decision survives refreshes. Numbers are deliberately not part of it. */
function findingKey(code, ...parts) {
  return [code, ...parts.map((p) => norm(p))].join("|").slice(0, 300);
}

/**
 * Does a redirect already send `fromName` to `toName`? Staff edits carry short design names
 * ("Trans 8 Gray") while LensSubs holds full lens names, so this matches by containment and
 * is reported as approximate.
 */
function redirectFor(redirects, fromName, toName) {
  const from = norm(fromName);
  const to = norm(toName);
  if (!from || !to) return null;
  const hit = (Array.isArray(redirects) ? redirects : []).find((r) =>
    norm(r.DesignName).includes(from) && norm(r.DonorName).includes(to));
  return hit
    ? { exists: true, priority: hit.Priority, hasRule: hit.RuleID != null }
    : { exists: false };
}

/** What a person should do next, in plain words. */
function suggestSwap(pair, redirects) {
  const redirect = redirectFor(redirects, pair.oldValue, pair.newValue);
  if (redirect?.exists) {
    return {
      status: "redirect-bypassed",
      action: "A similar redirect exists (approximate match) but staff still make this swap by hand. " +
        "Check it covers the same material and lens type, and its rule and priority."
    };
  }
  return {
    status: "no-redirect",
    action: "No redirect found. Add a Lens Redirect in Innovations from the old lens to the new one " +
      "for the materials and lens types involved (approximate match)."
  };
}

function suggestUnresolved(row) {
  return row.direction === "lost"
    ? "A lens that orders arrive with can no longer be resolved. Check it is active in Innovations and its alias still exists."
    : "Staff are re-picking this lens after it failed to resolve. Check the alias and that the option is active.";
}

function suggestAddon(row) {
  return row.added
    ? "Staff add this by hand. If it is always wanted for these lenses, add it to the redirect or a rule."
    : "Staff remove this by hand. Check the rule or redirect that adds it.";
}

function severityFor(orders) {
  return orders >= 20 ? "high" : orders >= 8 ? "medium" : "low";
}

/**
 * Attach any earlier decision. Handled findings are hidden unless includeDecided, except a
 * finding marked fixed that has been seen again since the decision, which comes back flagged.
 */
function applyDecisions(rows, decisions, { includeDecided = false } = {}) {
  const open = [];
  const handled = [];
  for (const row of rows) {
    const d = decisions.get(row.findingKey) || null;
    const decidedAt = d?.decidedAt ? new Date(d.decidedAt).getTime() : null;
    const lastSeen = row.lastSeen ? new Date(row.lastSeen).getTime() : null;
    const cameBack = Boolean(d && d.decision === "fixed" && decidedAt && lastSeen && lastSeen > decidedAt + 24 * 3600 * 1000);
    const enriched = { ...row, decision: d ? d.decision : null, decisionReason: d ? d.reason : null, cameBack };
    if (!d || cameBack) open.push(enriched);
    else handled.push(enriched);
  }
  return { open, handled: includeDecided ? handled : [], handledCount: handled.length };
}

/* ─────────── queries ─────────── */

const PRODUCT_PROPS = "'Right Design Name','Left Design Name','Right Lens Name','Left Lens Name'";

function windowClause(days) {
  return `jc.ChangeTime >= DATEADD(day, -${Number(days) | 0}, SYSDATETIMEOFFSET())`;
}

const SQL = {
  swaps: (days) => `
    SELECT LEFT(jc.OldValue, 110) AS oldValue, LEFT(jc.NewValue, 110) AS newValue,
           COUNT(DISTINCT jc.OrderID) AS orders, COUNT(DISTINCT o.CustomerID) AS customers,
           COUNT(DISTINCT jc.UserAccountID) AS staffAccounts, MAX(jc.ChangeTime) AS lastSeen
    FROM dbo.JobChanges jc JOIN dbo.Orders o ON o.OrderID = jc.OrderID
    WHERE ${windowClause(days)} AND jc.PropertyName IN ('Right Design Name','Left Design Name')
      AND ISNULL(jc.OldValue,'') <> ISNULL(jc.NewValue,'')
      AND ISNULL(jc.OldValue,'') <> '' AND ISNULL(jc.NewValue,'') <> ''
      AND jc.OldValue NOT IN ('Option Not Found','Unknown item option')
      AND jc.NewValue NOT IN ('Option Not Found','Unknown item option')
    GROUP BY LEFT(jc.OldValue, 110), LEFT(jc.NewValue, 110)
    HAVING COUNT(DISTINCT jc.OrderID) >= ${MIN_ORDERS} AND COUNT(DISTINCT o.CustomerID) >= ${MIN_CUSTOMERS}
    ORDER BY orders DESC`,

  unresolved: (days) => `
    SELECT CASE WHEN jc.NewValue IN ('Option Not Found','Unknown item option') THEN 'lost' ELSE 'recovered' END AS direction,
           LEFT(CASE WHEN jc.NewValue IN ('Option Not Found','Unknown item option') THEN jc.OldValue ELSE jc.NewValue END, 110) AS name,
           COUNT(DISTINCT jc.OrderID) AS orders, COUNT(DISTINCT o.CustomerID) AS customers,
           COUNT(DISTINCT jc.UserAccountID) AS staffAccounts, MAX(jc.ChangeTime) AS lastSeen
    FROM dbo.JobChanges jc JOIN dbo.Orders o ON o.OrderID = jc.OrderID
    WHERE ${windowClause(days)} AND jc.PropertyName IN (${PRODUCT_PROPS})
      AND (jc.NewValue IN ('Option Not Found','Unknown item option') OR jc.OldValue IN ('Option Not Found','Unknown item option'))
      AND ISNULL(jc.OldValue,'') <> ISNULL(jc.NewValue,'')
      AND ISNULL(CASE WHEN jc.NewValue IN ('Option Not Found','Unknown item option') THEN jc.OldValue ELSE jc.NewValue END,'') <> ''
    GROUP BY CASE WHEN jc.NewValue IN ('Option Not Found','Unknown item option') THEN 'lost' ELSE 'recovered' END,
             LEFT(CASE WHEN jc.NewValue IN ('Option Not Found','Unknown item option') THEN jc.OldValue ELSE jc.NewValue END, 110)
    HAVING COUNT(DISTINCT jc.OrderID) >= ${MIN_ORDERS}
    ORDER BY orders DESC`,

  addons: (days) => `
    SELECT LEFT(CASE WHEN ISNULL(jc.OldValue,'') IN ('','None') THEN jc.NewValue ELSE jc.OldValue END, 110) AS name,
           CASE WHEN ISNULL(jc.OldValue,'') IN ('','None') THEN 1 ELSE 0 END AS added,
           COUNT(DISTINCT jc.OrderID) AS orders, COUNT(DISTINCT o.CustomerID) AS customers,
           COUNT(DISTINCT jc.UserAccountID) AS staffAccounts, MAX(jc.ChangeTime) AS lastSeen
    FROM dbo.JobChanges jc JOIN dbo.Orders o ON o.OrderID = jc.OrderID
    WHERE ${windowClause(days)} AND jc.PropertyName = 'Misc Item'
      AND ISNULL(jc.OldValue,'') <> ISNULL(jc.NewValue,'')
      AND (ISNULL(jc.OldValue,'') IN ('','None') OR ISNULL(jc.NewValue,'') IN ('','None'))
    GROUP BY LEFT(CASE WHEN ISNULL(jc.OldValue,'') IN ('','None') THEN jc.NewValue ELSE jc.OldValue END, 110),
             CASE WHEN ISNULL(jc.OldValue,'') IN ('','None') THEN 1 ELSE 0 END
    HAVING COUNT(DISTINCT jc.OrderID) >= ${MIN_ORDERS} AND COUNT(DISTINCT o.CustomerID) >= ${MIN_CUSTOMERS}
    ORDER BY orders DESC`,

  errors: (days) => `
    SELECT o.LastResult AS code, LEFT(ISNULL(o.LastResultMessage,''), 140) AS message,
           COUNT(*) AS orders, COUNT(DISTINCT o.CustomerID) AS customers,
           MIN(o.OrderID) AS sampleOrderId, MAX(o.RecordCreated) AS lastSeen
    FROM dbo.Orders o
    WHERE o.OrderType IN (1,3) AND o.RecordCreated >= DATEADD(day, -${Number(days) | 0}, SYSDATETIMEOFFSET())
      AND ISNULL(o.LastResult,0) <> 0
    GROUP BY o.LastResult, LEFT(ISNULL(o.LastResultMessage,''), 140)
    ORDER BY orders DESC`,

  redirects: () => `SELECT DesignName, DonorName, Priority, RuleID FROM dbo.LensSubs`,

  // Share of Rx orders that needed a lens change: last 30 days against the 30 before.
  editRate: () => `
    SELECT win, COUNT(*) AS orders, SUM(edited) AS edited
    FROM (
      SELECT CASE WHEN o.RecordCreated >= DATEADD(day,-30,SYSDATETIMEOFFSET()) THEN 'recent' ELSE 'prior' END AS win,
             CASE WHEN EXISTS (SELECT 1 FROM dbo.JobChanges jc WHERE jc.OrderID = o.OrderID
                  AND jc.PropertyName IN (${PRODUCT_PROPS}) AND ISNULL(jc.OldValue,'') <> ISNULL(jc.NewValue,'')) THEN 1 ELSE 0 END AS edited
      FROM dbo.Orders o
      WHERE o.OrderType = 1 AND o.RecordCreated >= DATEADD(day,-60,SYSDATETIMEOFFSET())
    ) x
    GROUP BY win`
};

/* ─────────── assembly ─────────── */

function num(v) { return v == null ? 0 : Number(v); }

function buildRows(raw, redirects) {
  const rows = { "lens-swap": [], "lens-unresolved": [], "addon-by-hand": [], "order-errors": [] };

  for (const r of raw.swaps) {
    const pair = { oldValue: r.oldValue, newValue: r.newValue };
    const s = suggestSwap(pair, redirects);
    rows["lens-swap"].push({
      findingKey: findingKey("lens-swap", r.oldValue, r.newValue),
      oldValue: r.oldValue, newValue: r.newValue,
      orders: num(r.orders), customers: num(r.customers), staffAccounts: num(r.staffAccounts),
      lastSeen: r.lastSeen, redirect: s.status, suggestion: s.action, severity: severityFor(num(r.orders))
    });
  }
  for (const r of raw.unresolved) {
    rows["lens-unresolved"].push({
      findingKey: findingKey("lens-unresolved", r.direction, r.name),
      name: r.name, direction: r.direction,
      orders: num(r.orders), customers: num(r.customers), staffAccounts: num(r.staffAccounts),
      lastSeen: r.lastSeen, suggestion: suggestUnresolved(r), severity: severityFor(num(r.orders))
    });
  }
  for (const r of raw.addons) {
    const added = Boolean(num(r.added));
    rows["addon-by-hand"].push({
      findingKey: findingKey("addon-by-hand", added ? "added" : "removed", r.name),
      name: r.name, change: added ? "Added by hand" : "Removed by hand", added,
      orders: num(r.orders), customers: num(r.customers), staffAccounts: num(r.staffAccounts),
      lastSeen: r.lastSeen, suggestion: suggestAddon({ added }), severity: severityFor(num(r.orders))
    });
  }
  for (const r of raw.errors) {
    rows["order-errors"].push({
      findingKey: findingKey("order-errors", r.code, r.message),
      code: num(r.code), message: r.message || "(no message)",
      orders: num(r.orders), customers: num(r.customers), sampleOrderId: r.sampleOrderId,
      lastSeen: r.lastSeen,
      suggestion: /design \d+ not properly set up/i.test(r.message || "")
        ? "A lens design is not set up for the lens data service. Set the design up in Innovations."
        : /price/i.test(r.message || "")
          ? "Orders could not be priced. Look for a missing price or cost for the lens, add-on or customer."
          : "Open a sample order in Job Entry to see what was missing.",
      severity: severityFor(num(r.orders))
    });
  }
  return rows;
}

async function getOrderQuality({ days = DEFAULT_DAYS, includeDecided = false } = {}) {
  const windowDays = Math.min(Math.max(Number(days) || DEFAULT_DAYS, 7), 365);
  const pool = await getSourcePool();
  const run = async (text) => (await pool.request().query(text)).recordset;

  const [swaps, unresolved, addons, errors, redirects, editRate, decisions] = await Promise.all([
    run(SQL.swaps(windowDays)), run(SQL.unresolved(windowDays)), run(SQL.addons(windowDays)),
    run(SQL.errors(windowDays)), run(SQL.redirects()), run(SQL.editRate()), loadDecisions()
  ]);

  const built = buildRows({ swaps, unresolved, addons, errors }, redirects);
  const checks = [];
  const outRows = {};
  let handledTotal = 0;
  for (const code of Object.keys(CHECKS)) {
    const applied = applyDecisions(built[code], decisions.map, { includeDecided });
    handledTotal += applied.handledCount;
    const list = [...applied.open, ...applied.handled].slice(0, ROW_LIMIT);
    outRows[code] = list;
    checks.push({
      code, ...CHECKS[code],
      count: applied.open.length,
      orders: applied.open.reduce((sum, r) => sum + r.orders, 0),
      handled: applied.handledCount,
      cameBack: applied.open.filter((r) => r.cameBack).length,
      truncated: list.length < applied.open.length + applied.handled.length,
      severity: applied.open.some((r) => r.severity === "high") ? "high"
        : applied.open.length ? "medium" : "ok"
    });
  }

  const rate = (win) => {
    const row = editRate.find((r) => r.win === win);
    return row && num(row.orders) ? { orders: num(row.orders), edited: num(row.edited), pct: Math.round((100 * num(row.edited)) / num(row.orders)) } : null;
  };

  return {
    online: true,
    generatedAt: new Date().toISOString(),
    windowDays,
    thresholds: { minOrders: MIN_ORDERS, minCustomers: MIN_CUSTOMERS },
    checks,
    rows: outRows,
    editRate: { recent: rate("recent"), prior: rate("prior") },
    redirectRules: redirects.length,
    decisions: { available: decisions.available, handled: handledTotal }
  };
}

module.exports = {
  getOrderQuality, buildRows, applyDecisions, findingKey, redirectFor, suggestSwap, isUnresolved,
  norm, severityFor, SQL, CHECKS, MIN_ORDERS, MIN_CUSTOMERS
};
