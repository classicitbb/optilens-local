// One-off dump of every distinct active LensItem "family" (the same grain as
// the never-run store_lenses sync in lib/innovations-sync.js) to a local JSON
// file, for matching against the 49 Supabase `lenses` rows that are in the
// Stock Lens Pricelist (show_in_ws_pricelist=true, sell_price>0) but have no
// store_product_variants grid yet. Read-only against the live Innovations
// MSSQL source.
const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const { getConfig } = require('../lib/config');

async function main() {
  const cfg = getConfig().sourceMssql;
  const pool = new sql.ConnectionPool({
    server: cfg.server, database: cfg.database, user: cfg.user, password: cfg.password,
    options: { encrypt: cfg.encrypt, trustServerCertificate: cfg.trustServerCertificate },
    connectionTimeout: 8000, requestTimeout: 120000
  });
  await pool.connect();

  try {
    const result = await pool.request().query(`
      SELECT
        li.MaterialGroup AS mg, li.Material AS mt, li.MFType AS mf, li.LensType AS lt,
        li.[Option] AS op, li.Manufacturer AS mfr, li.Fin_Semi AS fs,
        lm.Name AS manufacturer, mg2.Name AS material_group, m.Name AS material,
        mft.Name AS mf_type, lty.Name AS lens_type, lo.Name AS option_name,
        COUNT(*) AS power_row_count,
        SUM(CASE WHEN (li.OnHand_R + li.OnHand_L + li.OnHand_P*2) > 0 THEN 1 ELSE 0 END) AS in_stock_count
      FROM dbo.LensItem li
      INNER JOIN dbo.LensMfgr lm ON lm.Num = li.Manufacturer
      INNER JOIN dbo.MaterialGroup mg2 ON mg2.Groupnum = li.MaterialGroup
      INNER JOIN dbo.Materials m ON m.GroupNum = li.MaterialGroup AND m.MtrlNum = li.Material
      INNER JOIN dbo.MFTypes mft ON mft.GroupNum = li.MaterialGroup AND mft.MtrlNum = li.Material AND mft.MFNum = li.MFType
      INNER JOIN dbo.LensType lty ON lty.GroupNum = li.MaterialGroup AND lty.MatlNum = li.Material AND lty.MFnum = li.MFType AND lty.Lnum = li.LensType
      INNER JOIN dbo.LensOptions lo ON lo.GroupNum = li.MaterialGroup AND lo.MatlNum = li.Material AND lo.MFnum = li.MFType AND lo.Lnum = li.LensType AND lo.Num = li.[Option]
      WHERE li.Flags & 2 = 0
      GROUP BY li.MaterialGroup, li.Material, li.MFType, li.LensType, li.[Option], li.Manufacturer, li.Fin_Semi,
        lm.Name, mg2.Name, m.Name, mft.Name, lty.Name, lo.Name
      ORDER BY lm.Name, mg2.Name, m.Name, mft.Name, lty.Name, lo.Name
    `);
    console.log(`Distinct active families: ${result.recordset.length}`);
    const outPath = path.join(__dirname, '..', 'data', 'erp-lens-families.json');
    fs.writeFileSync(outPath, JSON.stringify(result.recordset, null, 0), 'utf8');
    console.log(`Wrote ${outPath}`);
  } finally {
    await pool.close();
  }
}

main().catch((err) => { console.error('ERROR:', err.message); process.exit(1); });
