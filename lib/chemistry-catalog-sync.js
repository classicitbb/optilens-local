// Populates chemistry.item_catalog_cache from Innovations dbo.MiscItems, so
// the Chemistrie clip tablet page can resolve a scanned SKU without a live
// Innovations round trip per scan. Read-only against the source (per
// AGENTS.md's discovery-is-read-only rule); this module never writes to
// Innovations.
//
// Reuses the exact "Stocked Item" filter already reviewed and documented in
// lib/innovations-sync.js's `supplies` entity (bit 2 = Stocked Item, bit 0 =
// Inactive when set, confirmed against live data -- see that file's comment
// for the audit trail). Deliberately does not reuse that entity's sync
// pipeline itself: `supplies` posts to the public Classic Visions website's
// Product Catalog via a Supabase edge function, an entirely different
// destination from this module's private, app-owned inventory cache.
const sql = require("mssql");
const { getLiveSourcePool, getAppPool } = require("./db");

const SOURCE_QUERY = `
  SELECT m.MiscItemID, m.SKU, m.Desc1, m.Cost, m.OnHand,
         g.MiscItemGroupName
  FROM dbo.MiscItems m
  LEFT JOIN dbo.MiscItemGroups g ON g.MiscItemGroupID = m.MiscItemGroupID
  WHERE (m.Flags & 4) <> 0 AND (m.Flags & 1) = 0
    AND NULLIF(LTRIM(RTRIM(m.SKU)), '') IS NOT NULL
  ORDER BY m.MiscItemID
`;

async function syncChemistryCatalog() {
  const sourcePool = await getLiveSourcePool();
  const sourceResult = await sourcePool.request().query(SOURCE_QUERY);
  const rows = sourceResult.recordset;

  const appPool = await getAppPool();
  let upserted = 0;

  for (const row of rows) {
    await appPool.request()
      .input("innovations_misc_item_id", sql.Int, Number(row.MiscItemID))
      .input("sku", sql.NVarChar(40), String(row.SKU || "").trim())
      .input("name", sql.NVarChar(300), String(row.Desc1 || "").trim())
      .input("category", sql.NVarChar(120), String(row.MiscItemGroupName || "").trim() || null)
      .input("on_hand", sql.Decimal(10, 2), row.OnHand != null ? Number(row.OnHand) : null)
      .query(`
        MERGE chemistry.item_catalog_cache AS target
        USING (SELECT @innovations_misc_item_id AS innovations_misc_item_id) AS source
        ON target.innovations_misc_item_id = source.innovations_misc_item_id
        WHEN MATCHED THEN
          UPDATE SET sku = @sku, name = @name, category = @category, on_hand = @on_hand,
                     last_synced_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (innovations_misc_item_id, sku, name, category, on_hand, last_synced_at)
          VALUES (@innovations_misc_item_id, @sku, @name, @category, @on_hand, SYSUTCDATETIME());
      `);
    upserted += 1;
  }

  return { read: rows.length, upserted, syncedAt: new Date().toISOString() };
}

module.exports = { syncChemistryCatalog, SOURCE_QUERY };
