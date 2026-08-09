// Read-only report: which lens "options" (material_group/material/mf_type/
// lens_type/option/manufacturer/fin_semi — the same compound key the
// store_lenses sync uses as innovations_lens_id) have actually moved on Stock
// orders (OrderType=3) recently, as opposed to Rx lab orders (OrderType=1).
//
// Two-hop join because these tables live on different servers:
//   1) Orders/Invoices/InvoiceLines live on the Zen-fed MIRROR (app SQL Server).
//   2) LensItem (the stock-lens dimension table) lives only on the LIVE
//      Innovations MSSQL (per lib/metrics/inventory.js's documented reason —
//      the mirror carries no stock tables).
// So: pull Stock-order lens SKUs from the mirror, then look those exact SKUs
// up against LensItem on the live pool, then aggregate client-side.
//
// Safe, read-only, no writes anywhere. Pass a window size in days as argv[2]
// (default 180).
const sql = require('mssql');
const { getMirrorPool } = require('../lib/db');
const { getConfig } = require('../lib/config');

const DAYS = Number(process.argv[2]) || 180;

// The shared getLiveSourcePool() pool caps requests at 15s, too short for a
// full-catalog LensItem scan (1.5M rows). Build a dedicated one-off pool with
// a longer timeout instead of touching the shared pool's defaults.
async function getLiveSourcePoolLongTimeout() {
  const cfg = getConfig().sourceMssql;
  const pool = new sql.ConnectionPool({
    server: cfg.server,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    options: { encrypt: cfg.encrypt, trustServerCertificate: cfg.trustServerCertificate },
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 8000,
    requestTimeout: 120000
  });
  await pool.connect();
  return pool;
}

async function main() {
  const mirrorPool = await getMirrorPool();
  let stockLensLines;
  try {
    const result = await mirrorPool.request()
      .input('days', DAYS)
      .query(`
        SELECT il.SKU, il.Quantity, o.RecordCreated AS orderDate, o.OrderID
        FROM dbo.Orders o
        INNER JOIN dbo.Invoices i ON i.OrderID = o.OrderID
        INNER JOIN dbo.InvoiceLines il ON il.InvoiceID = i.InvoiceID
        WHERE o.OrderType = 3 AND il.ItemType = 1
          AND o.RecordCreated >= DATEADD(day, -@days, GETDATE())
      `);
    stockLensLines = result.recordset;
  } finally {
    await mirrorPool.close();
  }

  console.log(`Stock-order lens lines in the last ${DAYS} days: ${stockLensLines.length}`);
  const distinctSkus = [...new Set(stockLensLines.map((r) => String(r.SKU || '').trim()).filter(Boolean))];
  console.log(`Distinct SKUs (OPC codes) to resolve: ${distinctSkus.length}`);

  const livePool = await getLiveSourcePoolLongTimeout();
  let lensRows;
  try {
    const result = await livePool.request()
      .input('skuJson', JSON.stringify(distinctSkus))
      .query(`
        SELECT li.OPC_R AS opcR, li.OPC_L AS opcL, li.Num AS itemNum,
               li.MaterialGroup AS mg, li.Material AS mt, li.MFType AS mf,
               li.LensType AS lt, li.[Option] AS op, li.Manufacturer AS mfr, li.Fin_Semi AS finSemi,
               lm.Name AS manufacturer, mtl.Name AS materialName, mft.Name AS mfTypeName,
               lt2.Name AS lensTypeName, lo.Name AS optionName
        FROM dbo.LensItem li
        INNER JOIN dbo.LensMfgr lm ON lm.Num = li.Manufacturer
        INNER JOIN dbo.Materials mtl ON mtl.GroupNum = li.MaterialGroup AND mtl.MtrlNum = li.Material
        INNER JOIN dbo.MFTypes mft ON mft.GroupNum = li.MaterialGroup AND mft.MtrlNum = li.Material AND mft.MFNum = li.MFType
        INNER JOIN dbo.LensType lt2 ON lt2.GroupNum = li.MaterialGroup AND lt2.MatlNum = li.Material AND lt2.MFNum = li.MFType AND lt2.LNum = li.LensType
        INNER JOIN dbo.LensOptions lo ON lo.GroupNum = li.MaterialGroup AND lo.MatlNum = li.Material AND lo.MFNum = li.MFType AND lo.LNum = li.LensType AND lo.Num = li.[Option]
        WHERE li.Flags & 2 = 0 AND li.OPC_R IN (SELECT value FROM OPENJSON(@skuJson))
        UNION
        SELECT li.OPC_R AS opcR, li.OPC_L AS opcL, li.Num AS itemNum,
               li.MaterialGroup AS mg, li.Material AS mt, li.MFType AS mf,
               li.LensType AS lt, li.[Option] AS op, li.Manufacturer AS mfr, li.Fin_Semi AS finSemi,
               lm.Name AS manufacturer, mtl.Name AS materialName, mft.Name AS mfTypeName,
               lt2.Name AS lensTypeName, lo.Name AS optionName
        FROM dbo.LensItem li
        INNER JOIN dbo.LensMfgr lm ON lm.Num = li.Manufacturer
        INNER JOIN dbo.Materials mtl ON mtl.GroupNum = li.MaterialGroup AND mtl.MtrlNum = li.Material
        INNER JOIN dbo.MFTypes mft ON mft.GroupNum = li.MaterialGroup AND mft.MtrlNum = li.Material AND mft.MFNum = li.MFType
        INNER JOIN dbo.LensType lt2 ON lt2.GroupNum = li.MaterialGroup AND lt2.MatlNum = li.Material AND lt2.MFNum = li.MFType AND lt2.LNum = li.LensType
        INNER JOIN dbo.LensOptions lo ON lo.GroupNum = li.MaterialGroup AND lo.MatlNum = li.Material AND lo.MFNum = li.MFType AND lo.LNum = li.LensType AND lo.Num = li.[Option]
        WHERE li.Flags & 2 = 0 AND li.OPC_L IN (SELECT value FROM OPENJSON(@skuJson))
      `);
    lensRows = result.recordset;
  } finally {
    await livePool.close();
  }

  console.log(`LensItem rows matched: ${lensRows.length}`);

  const opcToLens = new Map();
  for (const r of lensRows) {
    if (r.opcR) opcToLens.set(String(r.opcR).trim(), r);
    if (r.opcL) opcToLens.set(String(r.opcL).trim(), r);
  }

  const groups = new Map();
  let unmatchedQty = 0;
  let unmatchedLines = 0;
  const unmatchedSkusSample = new Set();

  for (const line of stockLensLines) {
    const sku = String(line.SKU || '').trim();
    const lens = opcToLens.get(sku);
    if (!lens) {
      unmatchedQty += Number(line.Quantity || 0);
      unmatchedLines += 1;
      if (unmatchedSkusSample.size < 15) unmatchedSkusSample.add(sku);
      continue;
    }
    const optionKey = `${lens.mg}:${lens.mt}:${lens.mf}:${lens.lt}:${lens.op}:${lens.mfr}:${lens.finSemi}`;
    if (!groups.has(optionKey)) {
      groups.set(optionKey, {
        optionKey,
        manufacturer: lens.manufacturer, materialName: lens.materialName, mfTypeName: lens.mfTypeName,
        lensTypeName: lens.lensTypeName, optionName: lens.optionName, finSemi: lens.finSemi,
        itemNums: new Set(), orderIds: new Set(), totalQty: 0, lastSold: null
      });
    }
    const g = groups.get(optionKey);
    g.itemNums.add(lens.itemNum);
    g.orderIds.add(line.OrderID);
    g.totalQty += Number(line.Quantity || 0);
    const d = new Date(line.orderDate);
    if (!g.lastSold || d > g.lastSold) g.lastSold = d;
  }

  const sorted = [...groups.values()].sort((a, b) => b.totalQty - a.totalQty);

  console.log(`\n=== Distinct lens options sold on Stock orders (last ${DAYS} days): ${sorted.length} ===\n`);
  for (const g of sorted) {
    console.log(`- ${g.manufacturer} · ${g.materialName} · ${g.mfTypeName} · ${g.lensTypeName} · ${g.optionName} [Fin/Semi ${g.finSemi}]`);
    console.log(`    innovations_lens_id=${g.optionKey}  distinct_items_sold=${g.itemNums.size}  orders=${g.orderIds.size}  units=${g.totalQty}  last_sold=${g.lastSold.toISOString().slice(0, 10)}`);
  }

  console.log(`\nUnmatched lines (SKU not found in active LensItem): ${unmatchedLines} lines, ${unmatchedQty} units`);
  if (unmatchedSkusSample.size) console.log('Sample unmatched SKUs:', [...unmatchedSkusSample].join(', '));
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
