/**
 * Read-only source adapter for Innovations MSSQL inventory and usage evidence.
 *
 * SAFETY RULES:
 * 1. Strictly read-only. The only statement this module sends to the source is
 *    one SELECT; assertReadOnlySql() refuses anything else before it is sent.
 * 2. Uses getLiveSourcePool() - the vendor Innovations database. The Zen-fed
 *    mirror has no stock tables.
 * 3. When the source cannot be reached the load FAILS. It never substitutes
 *    synthetic data. Synthetic fixtures exist for automated tests only.
 * 4. Evidence is reported as it is. Facts the source does not provide (when a
 *    shelf was last counted, whether PO lines were received) are returned as
 *    null so the confidence engine can say so, not invented as "fresh".
 *
 * Identity: a lens is the six-part compound key
 * (MaterialGroup, Material, MFType, LensType, Option, Num). LensItem.Num alone
 * is not unique.
 *
 * Population: every active lens that is stocked now, on order now, or moved in
 * the last 90 days - the same "stocked OR moved" universe as the Inventory tab,
 * so an item burned down to zero is still evaluated.
 *
 * Known limits, carried in `source.caveats`: usage comes from RxArchive job
 * history and only ~63% of jobs carry a lens-item reference, so it undercounts
 * by roughly a third; open PO quantity is the LensItem.OnOrder_* balance, not a
 * walk of individual PO lines.
 */

const sql = require("mssql");
const db = require("../db");
const store = require("./store");
const { badRequest, unavailable } = require("./errors");

const MAX_ROWS = 20000;
const DEFAULT_ROWS = 5000;
const MAX_TARGETED_ITEMS = 200;

const SOURCE_CAVEATS = Object.freeze([
  "Usage is counted from RxArchive job history; only about 63% of jobs carry a lens-item reference, so usage undercounts by roughly a third, unevenly across items.",
  "Open PO quantity is the item-level on-order balance in Innovations (LensItem.OnOrder_*); individual PO lines are not checked for receipt or cancellation.",
  "On-hand is the current Innovations balance (LensItem.OnHand_*); it carries no history and may not match the shelf."
]);

const FORBIDDEN_SQL = /\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute|grant|revoke|into)\b/i;

/** Throws unless the statement is a single read-only SELECT. */
function assertReadOnlySql(text) {
  const stripped = String(text).replace(/--.*$/gm, "").trim();
  if (!/^(with|select)\b/i.test(stripped) || FORBIDDEN_SQL.test(stripped) || stripped.includes(";" + "\n" + "SELECT")) {
    throw new Error("Inventory source access is read-only; refused a non-SELECT statement.");
  }
}

function lensItemId(mg, mt, mf, lt, op, it) {
  return `${mg}:${mt}:${mf}:${lt}:${op}:${it}`;
}

function parseLensItemId(itemId) {
  const parts = String(itemId).split(":");
  if (parts.length !== 6 || parts.some((p) => !/^-?\d+$/.test(p))) return null;
  return parts.map(Number);
}

/** Resolve current source descriptions in one bounded read; saved recommendations stay unchanged. */
async function loadLensIdentities(itemIds) {
  const ids = [...new Set(itemIds)];
  if (ids.length > MAX_TARGETED_ITEMS) throw badRequest("Too many lens identifiers.");
  const keys = ids.map(parseLensItemId);
  if (keys.some((key) => !key)) throw badRequest("Lens item is not a valid identifier.");
  if (!keys.length) return {};
  const filter = keys.map((_, i) => `(li.MaterialGroup = @mg${i} AND li.Material = @mt${i}
    AND li.MFType = @mf${i} AND li.LensType = @lt${i} AND li.[Option] = @op${i} AND li.Num = @it${i})`).join(" OR ");
  const query = `
    SELECT
      li.MaterialGroup AS mg, li.Material AS mt, li.MFType AS mf,
      li.LensType AS lt, li.[Option] AS op, li.Num AS it,
      mtl.Name AS materialName, lm.Name AS manufacturerName,
      lt.Name AS lensTypeName, lo.Name AS optionName, li.Name AS itemName,
      li.Diameter / 100.0 AS diameter, li.Base_Sphere / 100.0 AS base,
      li.Add_Cyl / 100.0 AS addPower,
      mf.Name AS familyName, li.Bin_R AS binRight, li.Bin_L AS binLeft
    FROM dbo.LensItem li
    LEFT JOIN dbo.Materials mtl ON mtl.GroupNum = li.MaterialGroup AND mtl.MtrlNum = li.Material
    LEFT JOIN dbo.LensMfgr lm ON lm.Num = li.Manufacturer
    LEFT JOIN dbo.MFTypes mf ON mf.GroupNum = li.MaterialGroup AND mf.MtrlNum = li.Material AND mf.MFNum = li.MFType
    LEFT JOIN dbo.LensType lt ON lt.GroupNum = li.MaterialGroup AND lt.MatlNum = li.Material
                              AND lt.MFNum = li.MFType AND lt.LNum = li.LensType
    LEFT JOIN dbo.LensOptions lo ON lo.GroupNum = li.MaterialGroup AND lo.MatlNum = li.Material
                                AND lo.MFNum = li.MFType AND lo.LNum = li.LensType AND lo.Num = li.[Option]
    WHERE ${filter};
  `;
  assertReadOnlySql(query);
  try {
    const pool = await db.getLiveSourcePool();
    const request = pool.request();
    keys.forEach((key, i) => ["mg", "mt", "mf", "lt", "op", "it"].forEach((part, index) => request.input(part + i, sql.Int, key[index])));
    const result = await request.query(query);
    return Object.fromEntries(result.recordset.map((row) => {
      const parts = [row.materialName, row.manufacturerName, row.lensTypeName, row.optionName]
        .map((part) => String(part || "").trim()).filter(Boolean);
      return [lensItemId(row.mg, row.mt, row.mf, row.lt, row.op, row.it), {
        materialName: row.materialName || null, manufacturerName: row.manufacturerName || null,
        lensTypeName: row.lensTypeName || null, optionName: row.optionName || null,
        name: parts.join(" · ") || row.itemName || null,
        diameter: row.diameter == null ? null : Number(row.diameter),
        base: row.base == null ? null : Number(row.base),
        addPower: row.addPower == null ? null : Number(row.addPower),
        familyName: String(row.familyName || "").trim() || null,
        bins: { right: String(row.binRight || "").trim() || null, left: String(row.binLeft || "").trim() || null }
      }];
    }));
  } catch (error) {
    const wrapped = unavailable("Lens name is temporarily unavailable from Innovations.", "SOURCE_UNAVAILABLE");
    wrapped.cause = error;
    throw wrapped;
  }
}

async function loadLensIdentity(itemId) {
  const identities = await loadLensIdentities([itemId]);
  const key = parseLensItemId(itemId).join(":");
  return identities[key] || null;
}

function buildEvidenceQuery(targetedKeys) {
  let keyFilter = "";
  let rightItemFilter = "";
  let leftItemFilter = "";
  if (targetedKeys && targetedKeys.length) {
    keyFilter = "AND (" + targetedKeys.map((_, i) =>
      `(li.MaterialGroup = @mg${i} AND li.Material = @mt${i} AND li.MFType = @mf${i} AND li.LensType = @lt${i} AND li.[Option] = @op${i} AND li.Num = @it${i})`
    ).join(" OR ") + ")";
    // Narrow the usage scan to these item numbers too (a superset: Num alone is not unique,
    // the six-part join below is what picks the exact lens).
    const itemList = targetedKeys.map((_, i) => `@it${i}`).join(", ");
    rightItemFilter = `AND RLensItem IN (${itemList})`;
    leftItemFilter = `AND LLensItem IN (${itemList})`;
  }

  return `
    WITH mv AS (
      SELECT RLensMG AS mg, RLensMatl AS mt, RLensMF AS mf, RLensType AS lt,
             RLensOption AS op, RLensItem AS it, ShipDate AS d
      FROM dbo.RxArchive
      WHERE ShipDate >= DATEADD(day, -90, GETDATE()) AND RLensItem > 0 ${rightItemFilter}
      UNION ALL
      SELECT LLensMG, LLensMatl, LLensMF, LLensType, LLensOption, LLensItem, ShipDate
      FROM dbo.RxArchive
      WHERE ShipDate >= DATEADD(day, -90, GETDATE()) AND LLensItem > 0 ${leftItemFilter}
    ),
    u AS (
      SELECT mg, mt, mf, lt, op, it,
             COUNT(*) AS units90,
             SUM(CASE WHEN d >= DATEADD(day, -30, GETDATE()) THEN 1 ELSE 0 END) AS units30,
             MAX(d) AS lastMoved
      FROM mv
      GROUP BY mg, mt, mf, lt, op, it
    )
    SELECT TOP (@rowLimit)
      li.MaterialGroup AS mg, li.Material AS mt, li.MFType AS mf,
      li.LensType AS lt, li.[Option] AS op, li.Num AS it,
      li.Name AS itemName,
      li.Cost AS unitCost,
      li.OPC_R AS skuR, li.OPC_L AS skuL,
      li.OnHand_R AS onHandRight, li.OnHand_L AS onHandLeft, li.OnHand_P AS onHandPairs,
      (li.OnHand_R + li.OnHand_L + li.OnHand_P * 2) AS onHand,
      (li.OnOrder_R + li.OnOrder_L + li.OnOrder_P * 2) AS onOrder,
      li.Manufacturer AS manufacturerNum,
      lm.Num AS supplierNum,
      lm.Name AS supplierName,
      ISNULL(u.units30, 0) AS usage30,
      ISNULL(u.units90, 0) AS usage90,
      u.lastMoved AS lastMoved,
      GETDATE() AS asOf
    FROM dbo.LensItem li
    LEFT JOIN dbo.LensMfgr lm ON lm.Num = li.Manufacturer
    LEFT JOIN u ON u.mg = li.MaterialGroup AND u.mt = li.Material AND u.mf = li.MFType
               AND u.lt = li.LensType AND u.op = li.[Option] AND u.it = li.Num
    WHERE li.Flags & 2 = 0
      AND ((li.OnHand_R + li.OnHand_L + li.OnHand_P * 2) <> 0
           OR (li.OnOrder_R + li.OnOrder_L + li.OnOrder_P * 2) <> 0
           OR u.it IS NOT NULL)
      ${keyFilter}
    ORDER BY li.MaterialGroup, li.Material, li.MFType, li.LensType, li.[Option], li.Num;
  `;
}

function mapRow(r, asOf) {
  const supplierMapped = r.supplierNum != null;
  return {
    itemId: lensItemId(r.mg, r.mt, r.mf, r.lt, r.op, r.it),
    itemKind: "lens",
    sku: r.skuR || r.skuL || null,
    skuRight: r.skuR || null, skuLeft: r.skuL || null,
    stock: { right: Number(r.onHandRight || 0), left: Number(r.onHandLeft || 0), pairs: Number(r.onHandPairs || 0) },
    itemLabel: r.itemName || lensItemId(r.mg, r.mt, r.mf, r.lt, r.op, r.it),
    supplierId: supplierMapped ? String(r.supplierNum) : null,
    supplierName: supplierMapped ? (r.supplierName || null) : null,
    onHand: Number(r.onHand || 0),
    openPoQuantity: Math.max(0, Number(r.onOrder || 0)),
    usage30: Number(r.usage30 || 0),
    usage90: Number(r.usage90 || 0),
    unitCost: Number(r.unitCost || 0),
    lastMoved: r.lastMoved ? new Date(r.lastMoved).toISOString() : null,
    // Not available from the source; filled from this app's own count records.
    stockFreshnessDays: null,
    lastVerifiedCountDate: null,
    // Not verifiable from the item-level balance.
    poComplete: null,
    poFreshnessDays: null,
    supplierMappingQuality: supplierMapped ? "CONFIRMED" : "UNMAPPED",
    asOf
  };
}

/**
 * Loads read-only inventory evidence.
 *
 * @param {Object} [options]
 * @param {string[]} [options.itemIds]   evaluate only these items (max 200)
 * @param {number}   [options.limit]     row cap (default 5000, max 20000)
 * @param {boolean}  [options.useFixtures]  synthetic data; honoured in test mode only
 * @returns {Promise<{items: Object[], asOf: string, truncated: boolean, source: Object}>}
 */
async function loadInventoryEvidence(options = {}) {
  if (options.useFixtures) {
    if (!store.isTestMode()) {
      throw badRequest("Synthetic inventory fixtures are available in automated tests only.");
    }
    let items = getSyntheticFixtures();
    if (options.itemIds) items = items.filter((i) => options.itemIds.includes(i.itemId));
    return {
      items,
      asOf: new Date().toISOString(),
      truncated: false,
      source: { system: "synthetic-fixtures", caveats: ["Synthetic test data."] }
    };
  }

  const rowLimit = Math.max(1, Math.min(MAX_ROWS, Number(options.limit) || DEFAULT_ROWS));

  let targetedKeys = null;
  if (options.itemIds) {
    if (options.itemIds.length > MAX_TARGETED_ITEMS) {
      throw badRequest(`A targeted recalculation is limited to ${MAX_TARGETED_ITEMS} items.`);
    }
    targetedKeys = options.itemIds.map(parseLensItemId).filter(Boolean);
    if (targetedKeys.length === 0) {
      return { items: [], asOf: new Date().toISOString(), truncated: false, source: describeSource() };
    }
  }

  const text = buildEvidenceQuery(targetedKeys);
  assertReadOnlySql(text);

  let pool;
  try {
    pool = await db.getLiveSourcePool();
  } catch (error) {
    const wrapped = unavailable("Source inventory data (Innovations) is currently unavailable; no recommendations were changed.", "SOURCE_UNAVAILABLE");
    wrapped.cause = error;
    throw wrapped;
  }

  const req = pool.request().input("rowLimit", sql.Int, rowLimit);
  if (targetedKeys) {
    targetedKeys.forEach((k, i) => {
      req.input(`mg${i}`, sql.Int, k[0]).input(`mt${i}`, sql.Int, k[1]).input(`mf${i}`, sql.Int, k[2])
        .input(`lt${i}`, sql.Int, k[3]).input(`op${i}`, sql.Int, k[4]).input(`it${i}`, sql.Int, k[5]);
    });
  }

  let result;
  try {
    result = await req.query(text);
  } catch (error) {
    const wrapped = unavailable("Source inventory data (Innovations) could not be read; no recommendations were changed.", "SOURCE_UNAVAILABLE");
    wrapped.cause = error;
    throw wrapped;
  }

  const asOf = new Date().toISOString();
  const items = result.recordset.map((r) => mapRow(r, asOf));
  return {
    items,
    asOf,
    truncated: result.recordset.length >= rowLimit,
    source: describeSource()
  };
}

function describeSource() {
  return {
    system: "Innovations MSSQL (read-only)",
    onHand: "LensItem.OnHand_R + OnHand_L + OnHand_P x 2",
    openPo: "LensItem.OnOrder_R + OnOrder_L + OnOrder_P x 2",
    usage: "RxArchive lens references by ShipDate, last 30 and 90 days",
    caveats: SOURCE_CAVEATS.slice()
  };
}

/**
 * Deterministic synthetic fixtures covering every queue and edge case.
 * Used only by automated tests (loadInventoryEvidence enforces this).
 */
function getSyntheticFixtures() {
  const base = {
    itemKind: "lens",
    stockFreshnessDays: null,
    lastVerifiedCountDate: null,
    poComplete: null,
    poFreshnessDays: null,
    supplierMappingQuality: "CONFIRMED"
  };
  return [
    { ...base, itemId: "1:1:1:1:1:101", sku: "CR39-SV-65", itemLabel: "CR-39 Single Vision 65mm Clear", supplierId: "101", supplierName: "Thai Optical Lab", onHand: 4, openPoQuantity: 0, usage30: 45, usage90: 120, unitCost: 12.5 },
    { ...base, itemId: "1:1:1:1:1:102", sku: "POLY-PROG-70", itemLabel: "Polycarbonate Progressive 70mm AR", supplierId: "101", supplierName: "Thai Optical Lab", onHand: 6, openPoQuantity: 50, usage30: 30, usage90: 85, unitCost: 35 },
    { ...base, itemId: "1:1:1:1:1:103", sku: "HI-INDEX-167", itemLabel: "High Index 1.67 Aspheric Clear", supplierId: "102", supplierName: "OptiVendor Direct", onHand: 180, openPoQuantity: 20, usage30: 2, usage90: 8, unitCost: 48 },
    { ...base, itemId: "1:1:1:1:1:104", sku: "GLASS-BIFOCAL-FT28", itemLabel: "Crown Glass Flat Top 28mm Bifocal", supplierId: "103", supplierName: "Vintage Optics", onHand: 42, openPoQuantity: 0, usage30: 0, usage90: 0, unitCost: 22 },
    { ...base, itemId: "1:1:1:1:1:105", sku: "POLAR-GREY-75", itemLabel: "Polarized Grey 75mm Finished", supplierId: "102", supplierName: "OptiVendor Direct", onHand: -2, openPoQuantity: 10, usage30: 15, usage90: 40, unitCost: 28.5 },
    { ...base, itemId: "1:1:1:1:1:106", sku: "TRANS-GEN8-BROWN", itemLabel: "Transitions Gen 8 Brown Poly", supplierId: null, supplierName: null, onHand: 8, openPoQuantity: 0, usage30: 20, usage90: 55, unitCost: 52, supplierMappingQuality: "UNMAPPED" }
  ];
}

module.exports = {
  MAX_ROWS,
  MAX_TARGETED_ITEMS,
  SOURCE_CAVEATS,
  assertReadOnlySql,
  buildEvidenceQuery,
  parseLensItemId,
  lensItemId,
  loadLensIdentity,
  loadLensIdentities,
  loadInventoryEvidence,
  getSyntheticFixtures
};
