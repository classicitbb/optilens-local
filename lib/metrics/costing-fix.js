// Cost Check — prepare a correction to Innovations. PREPARES ONLY; it never executes.
//
// Innovations is a read-only source. The one sanctioned way to write to it is the privileged
// data-access challenge (lib/privileged-data-access.js): the SQL is shown to an administrator,
// bound to their session and to a digest of the exact text, and only runs when they send back
// the matching `EXECUTE <digest>` and `WRITE <digest>` confirmations. Each run is audited.
//
// This module's job is to make that flow safe to drive from a phone. The browser never supplies
// SQL: it names a target (an invoice line, or an item master) and a new cost, the server reads
// the CURRENT value itself, validates the new one, and builds a statement that
//   - touches exactly one named row per statement,
//   - is guarded by the value that was read (`AND Cost = <old>`), so if anyone else changed it in
//     the meantime the statement affects zero rows instead of overwriting their work,
//   - changes only the cost column (and LastUpdated).
//
// Three targets exist:
//   line-cost  dbo.InvoiceLines.CostPrice  fixes THIS order's costing
//   line-costs several lines of one order at once (moving a cost to the line it belongs to)
//   item-cost  dbo.LensItem.Cost / dbo.MiscItems.Cost  fixes future orders for the item
// Fixing an item does not rewrite past invoices; fix those lines individually if they matter.

const sql = require("mssql");
const { getSourcePool } = require("../db");
const { createPrivilegedDataAccess } = require("../privileged-data-access");

const SOURCE = "source-mssql";
const MAX_COST = 100000;
const MAX_ITEM_IDS = 10;
const MAX_LINE_CHANGES = 6;

function httpError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function positiveInt(value, label) {
  const v = Number(value);
  if (!Number.isInteger(v) || v <= 0 || v > 2147483647) throw httpError(`${label} is not a valid id.`);
  return v;
}

/**
 * A new cost: a finite positive number, at most 4 decimals, bounded to catch fat-fingers. Zero is
 * only accepted where a cost is being moved off a line (`allowZero`), never as a plain correction.
 */
function validCost(value, { allowZero = false } = {}) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    throw httpError("Enter a cost for every line you are changing.");
  }
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0 || (v === 0 && !allowZero)) throw httpError("Enter a cost greater than zero.");
  if (v > MAX_COST) throw httpError(`A cost above ${MAX_COST.toLocaleString("en-US")} is almost certainly a typo.`);
  return Math.round(v * 10000) / 10000;
}

/** SQL money literal. Built from a validated number, never from client text. */
function money(value) {
  return Number(value).toFixed(4);
}

function buildLineCostStatement({ lineId, oldCost, newCost }) {
  return (
    "UPDATE dbo.InvoiceLines SET CostPrice = " + money(newCost) + ", LastUpdated = SYSDATETIMEOFFSET() " +
    "WHERE InvoiceLineID = " + positiveInt(lineId, "Line") + " AND ISNULL(CostPrice, 0) = " + money(oldCost) + ";"
  );
}

function buildItemCostStatement({ kind, id, oldCost, newCost }) {
  const table = kind === "lens" ? "dbo.LensItem" : kind === "misc" ? "dbo.MiscItems" : null;
  const key = kind === "lens" ? "LensItemID" : "MiscItemID";
  if (!table) throw httpError("Unknown item kind.");
  return (
    "UPDATE " + table + " SET Cost = " + money(newCost) + ", LastUpdated = SYSDATETIMEOFFSET() " +
    "WHERE " + key + " = " + positiveInt(id, "Item") + " AND ISNULL(Cost, 0) = " + money(oldCost) + ";"
  );
}

async function readLine(pool, lineId) {
  const row = (await pool.request().input("id", sql.Int, lineId).query(`
    SELECT l.InvoiceLineID, l.CostPrice, l.InvoicePrice, l.Quantity, l.Description, l.SKU, i.OrderID
    FROM dbo.InvoiceLines l INNER JOIN dbo.Invoices i ON i.InvoiceID = l.InvoiceID
    WHERE l.InvoiceLineID = @id;`)).recordset[0];
  if (!row) throw httpError("That invoice line no longer exists.", 404);
  return row;
}

async function readItems(pool, kind, ids) {
  const [table, key] = kind === "lens" ? ["dbo.LensItem", "LensItemID"] : ["dbo.MiscItems", "MiscItemID"];
  const request = pool.request();
  ids.forEach((id, i) => request.input(`i${i}`, sql.Int, id));
  const list = ids.map((_, i) => `@i${i}`).join(",");
  const rows = (await request.query(`SELECT ${key} AS id, Cost FROM ${table} WHERE ${key} IN (${list});`)).recordset;
  if (rows.length !== ids.length) throw httpError("An item no longer exists in the item master.", 404);
  return rows;
}

/**
 * Builds the statement(s) for one correction and opens a privileged-access challenge for them.
 * `service` is injectable for tests.
 */
async function prepareCostFix(body, actor, deps = {}) {
  const type = String(body && body.type || "");
  const pool = deps.pool || (await getSourcePool());
  const service = deps.service || createPrivilegedDataAccess();
  let statements = [];
  let preview;

  if (type === "line-cost") {
    const newCost = validCost(body.newCost);
    const lineId = positiveInt(body.lineId, "Line");
    const line = await readLine(pool, lineId);
    const oldCost = Number(line.CostPrice) || 0;
    if (Math.abs(oldCost - newCost) < 0.00005) throw httpError("That is already the cost on this line.");
    statements = [buildLineCostStatement({ lineId, oldCost, newCost })];
    preview = {
      target: "Invoice line",
      what: `Order ${line.OrderID}, line ${lineId}: ${String(line.Description || "").trim()}`,
      changes: [{ label: "Line cost", before: oldCost, after: newCost }]
    };
  } else if (type === "line-costs") {
    // Several lines of ONE order in one reviewed change, so a cost can be moved from the line it
    // was entered on to the line it belongs to without ever leaving the order half-fixed.
    const requested = Array.isArray(body.changes) ? body.changes : [];
    if (requested.length < 1 || requested.length > MAX_LINE_CHANGES) {
      throw httpError(`Change between 1 and ${MAX_LINE_CHANGES} lines at a time.`);
    }
    const seen = new Set();
    const changes = requested.map((c) => {
      const lineId = positiveInt(c && c.lineId, "Line");
      if (seen.has(lineId)) throw httpError("A line can only appear once in a change.");
      seen.add(lineId);
      return { lineId, newCost: validCost(c.newCost, { allowZero: true }) };
    });
    const rows = [];
    for (const c of changes) rows.push(await readLine(pool, c.lineId));
    if (new Set(rows.map((r) => r.OrderID)).size !== 1) throw httpError("Those lines are not all on the same order.");
    const moving = [];
    changes.forEach((c, i) => {
      const oldCost = Number(rows[i].CostPrice) || 0;
      if (Math.abs(oldCost - c.newCost) < 0.00005) return;
      statements.push(buildLineCostStatement({ lineId: c.lineId, oldCost, newCost: c.newCost }));
      moving.push({ label: `Line ${c.lineId}: ${String(rows[i].Description || "").trim()}`, before: oldCost, after: c.newCost });
    });
    if (!moving.length) throw httpError("Those lines already carry these costs.");
    preview = { target: "Invoice lines", what: `Order ${rows[0].OrderID}`, changes: moving };
  } else if (type === "item-cost") {
    const newCost = validCost(body.newCost);
    const kind = body.kind === "lens" ? "lens" : body.kind === "misc" ? "misc" : null;
    if (!kind) throw httpError("Unknown item kind.");
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : [body.id]).map((v) => positiveInt(v, "Item")))];
    if (!ids.length || ids.length > MAX_ITEM_IDS) throw httpError(`Choose between 1 and ${MAX_ITEM_IDS} items.`);
    const rows = await readItems(pool, kind, ids);
    const changing = rows.filter((r) => Math.abs((Number(r.Cost) || 0) - newCost) >= 0.00005);
    if (!changing.length) throw httpError("That is already the master cost.");
    statements = changing.map((r) => buildItemCostStatement({ kind, id: r.id, oldCost: Number(r.Cost) || 0, newCost }));
    preview = {
      target: kind === "lens" ? "Lens item master" : "Misc item master",
      what: String(body.label || "").trim().slice(0, 200) || `${changing.length} item(s)`,
      changes: changing.map((r) => ({ label: `${kind === "lens" ? "LensItemID" : "MiscItemID"} ${r.id}`, before: Number(r.Cost) || 0, after: newCost })),
      note: "Changes the master for future orders. Existing invoice lines keep the cost they were created with."
    };
  } else {
    throw httpError("Unknown fix type.");
  }

  const challenge = service.requestChallenge({ source: SOURCE, mode: "write", sql: statements.join("\n") }, actor);
  return { challenge, preview };
}

/** True when privileged writes are enabled and credentials exist, so the page can hide dead buttons. */
function canWriteSource(deps = {}) {
  try {
    (deps.service || createPrivilegedDataAccess()).getSource(SOURCE, "write");
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  prepareCostFix,
  canWriteSource,
  buildLineCostStatement,
  buildItemCostStatement,
  validCost
};
