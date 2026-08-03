const { getLiveSourcePool } = require("../lib/db");

async function main() {
  const pool = await getLiveSourcePool();
  const result = await pool.request().query(`
    SELECT m.MiscItemID, m.SKU, m.Desc1, m.Cost, m.OnHand, g.MiscItemGroupName
    FROM dbo.MiscItems m
    LEFT JOIN dbo.MiscItemGroups g ON g.MiscItemGroupID = m.MiscItemGroupID
    WHERE (m.Flags & 4) <> 0 AND (m.Flags & 1) = 0
      AND NULLIF(LTRIM(RTRIM(m.SKU)), '') IS NOT NULL
    ORDER BY m.MiscItemID
  `);
  console.log(JSON.stringify(result.recordset));
  process.exit(0);
}
main().catch((err) => { console.error("ERROR:", err.message); process.exit(1); });
