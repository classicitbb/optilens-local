// Second pass for the remaining 8 approved stock-order lens families.
// Differences from the first pass:
//   - Where a matching catalog shell already exists (found by reviewing the
//     live lenses table — Silor turned out to be Essilor's own conventional
//     brand, and the catalog already carries empty-grid shells for most of
//     these designs), reuse that lens id instead of creating a duplicate.
//   - Rows are filtered to "relevant": keep a power if it currently has stock
//     OR its OPC appears anywhere in the last-90-days Stock-order sales
//     history (not just within this option) — a power that's momentarily at
//     zero but was recently sold is still real demand; one that's simply
//     never moved and never in stock is dead combinatorial noise (this is
//     what shrinks the two 500+/250+-row single-vision grids).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sql = require('mssql');
const { getConfig } = require('../lib/config');
const { getMirrorPool } = require('../lib/db');

const REF = {
  material: {
    'Photochromic 1.50': 'ef3d3a44-7787-486d-94f1-c994a8531b17',
    'Plastic 1.50': 'add13458-b8e9-433d-beaf-130147311ab3',
    'Plastic 1.565': 'b0215924-2109-46f2-aee6-08bf4a7179fb',
    '1.56': 'a9bc9d43-f2db-424f-afd5-b327b31bda5e',
  },
  mftype: {
    Progressive: 'bf0a4473-fd25-4047-9b15-96804ff76674',
    'Single Vision': 'cc806f76-a032-4b97-87e2-27f5be80921c',
  },
  lenstype: {
    'Shoreview ES': '5dc446d7-9912-4ee1-98f6-0369a265e422',
    'Flat Top 28': '34a8aac2-7cf5-47a8-9f60-3945578fc6e4',
    Image: '858fd041-5e04-45c9-a4c3-314e149e34ee',
    Regular: 'dd3ec876-8d56-4477-bc5a-054c88b51d95',
    'ZenVue FPAL': 'ed6981f6-35db-49d6-bddc-8efdbd6b8be8',
  },
  finish: {
    0: '16833b67-c9e1-4a26-8ca9-97340d0fc6ec', // Semifinished
    1: '9df9728a-7055-4652-b74b-a68b8ff4c6fe', // Finished
  },
  supplier: {
    'Shore Lens': '43ff6c03-1644-4a20-9a96-310ec47d02ea',
    Essilor: 'a21fb022-567b-4e7c-bc07-5cda8503263c',
    Younger: '74115422-0807-4489-bcb9-0d659f9868a1',
    'East Optical': '2a6a7a67-cccd-401e-9096-56ccec16e460',
  },
  brand: {
    'Shore Lens': '88e97647-abec-40ef-be37-1f21ff7c800f',
    Silor: '4157e92b-e48d-48a6-99d4-a2a97046b8eb',
    Younger: '7bd916d2-836b-4167-8219-2daa370a8635',
    ZenVue: '85ca67d0-4057-439d-9048-71967e4b12af',
  },
};

// existingLensId: reuse a found empty catalog shell instead of creating a new row.
// existingPrice: that shell's already-set sell_price (skip the cost+15% placeholder).
const GROUPS = [
  { name: 'Shore Lens Photochromic 1.50 Progressive Shoreview ES Activations Gray', material: 'Photochromic 1.50', mftype: 'Progressive', lenstype: 'Shoreview ES', finSemi: 0, supplier: 'Shore Lens', brand: 'Shore Lens', erp: [1,7,4,412,4,104,0], chiral: true, existingLensId: 'f2b81e94-0ff8-4aa6-a558-a2db12657123', existingPrice: null },
  { name: 'Essilor Photochromic 1.50 Bifocal Flat Top 28 Trans 8 Gray SRC', material: 'Photochromic 1.50', mftype: 'Progressive', lenstype: 'Flat Top 28', finSemi: 0, supplier: 'Essilor', brand: 'Silor', erp: [1,7,2,2,39,2,0], chiral: true, existingLensId: 'feadd28a-1c8f-4236-9c2c-101639aed2ce', existingPrice: 266.70, mftypeOverride: '81143a5a-6910-48ba-9562-efff5924e846' },
  { name: 'Shore Lens Photochromic 1.50 Progressive Shoreview ES TGNS Gray', material: 'Photochromic 1.50', mftype: 'Progressive', lenstype: 'Shoreview ES', finSemi: 0, supplier: 'Shore Lens', brand: 'Shore Lens', erp: [1,7,4,412,6,104,0], chiral: true, existingLensId: '26f2d195-5559-4c72-b3ca-55de43ca8f25', existingPrice: null },
  { name: 'Younger Photochromic 1.50 Progressive Image XtrActive Gray', material: 'Photochromic 1.50', mftype: 'Progressive', lenstype: 'Image', finSemi: 0, supplier: 'Younger', brand: 'Younger', erp: [1,7,4,17,9,19,0], chiral: true, existingLensId: '129389bb-9bcf-48ad-b2ba-cf8ded7e5da0', existingPrice: 330.50 },
  { name: 'East Optical 1.56 Single Vision Regular BLUEPRO+PH GR AR+', material: '1.56', mftype: 'Single Vision', lenstype: 'Regular', finSemi: 1, supplier: 'East Optical', brand: 'ZenVue', erp: [1,10,1,1,9,183,1], chiral: false, existingLensId: null, existingPrice: null },
  { name: 'East Optical Plastic 1.50 Single Vision Regular BLUEPRO SHMC', material: 'Plastic 1.50', mftype: 'Single Vision', lenstype: 'Regular', finSemi: 1, supplier: 'East Optical', brand: 'ZenVue', erp: [1,1,1,1,146,183,1], chiral: false, existingLensId: null, existingPrice: null },
  { name: 'Younger Photochromic 1.50 Single Vision Regular TGNS Gray (Finished)', material: 'Photochromic 1.50', mftype: 'Single Vision', lenstype: 'Regular', finSemi: 1, supplier: 'Younger', brand: 'Younger', erp: [1,7,1,1,246,19,1], chiral: false, existingLensId: 'cfa834b3-e607-4efe-963f-785d28b7d3c2', existingPrice: 215.00 },
  { name: 'East Optical Plastic 1.565 Progressive ZenVue FPAL Ph Gry Sp BPRoHMC', material: 'Plastic 1.565', mftype: 'Progressive', lenstype: 'ZenVue FPAL', finSemi: 1, supplier: 'East Optical', brand: 'ZenVue', erp: [1,4,4,174,4,183,1], chiral: true, existingLensId: null, existingPrice: null },
];

function sqlStr(v) { return `'${String(v).replace(/'/g, "''")}'`; }
function sqlNum(v) { return Number.isFinite(v) ? String(v) : 'NULL'; }

async function main() {
  // 1) Full stock-order lens-line sales history from the mirror, last 90 days.
  const mirrorPool = await getMirrorPool();
  let soldSkus;
  try {
    const result = await mirrorPool.request().input('days', 90).query(`
      SELECT DISTINCT il.SKU
      FROM dbo.Orders o
      INNER JOIN dbo.Invoices i ON i.OrderID = o.OrderID
      INNER JOIN dbo.InvoiceLines il ON il.InvoiceID = i.InvoiceID
      WHERE o.OrderType = 3 AND il.ItemType = 1
        AND o.RecordCreated >= DATEADD(day, -90, GETDATE())
    `);
    soldSkus = new Set(result.recordset.map((r) => String(r.SKU || '').trim()).filter(Boolean));
  } finally {
    await mirrorPool.close();
  }
  console.log(`Stock-order sold SKUs in window: ${soldSkus.size}`);

  // 2) Live LensItem pool with a long timeout (mega-catalog scans).
  const cfg = getConfig().sourceMssql;
  const pool = new sql.ConnectionPool({
    server: cfg.server, database: cfg.database, user: cfg.user, password: cfg.password,
    options: { encrypt: cfg.encrypt, trustServerCertificate: cfg.trustServerCertificate },
    connectionTimeout: 8000, requestTimeout: 60000
  });
  await pool.connect();

  const lines = [];
  try {
    for (const g of GROUPS) {
      const [mg, mt, mf, lt, op, mfr, fs] = g.erp;
      const result = await pool.request()
        .input('mg', mg).input('mt', mt).input('mf', mf).input('lt', lt).input('op', op).input('mfr', mfr).input('fs', fs)
        .query(`
          SELECT Num AS itemNum, Diameter/100.0 AS diameter, Base_Sphere/100.0 AS sphere, Add_Cyl/100.0 AS cylinder,
                 OPC_R AS opcR, OPC_L AS opcL, (OnHand_R+OnHand_L+OnHand_P*2) AS onHand, Cost AS cost
          FROM dbo.LensItem
          WHERE MaterialGroup=@mg AND Material=@mt AND MFType=@mf AND LensType=@lt AND [Option]=@op AND Manufacturer=@mfr AND Fin_Semi=@fs AND Flags & 2 = 0
          ORDER BY Base_Sphere, Add_Cyl, Diameter
        `);
      const allRows = result.recordset;
      const rows = allRows.filter((r) => {
        const onHand = Number(r.onHand || 0);
        if (onHand > 0) return true;
        const opcR = String(r.opcR || '').trim();
        const opcL = String(r.opcL || '').trim();
        return (opcR && soldSkus.has(opcR)) || (opcL && soldSkus.has(opcL));
      });

      console.log(`${g.name}: ${allRows.length} total power rows -> ${rows.length} kept (in-stock or recently sold)`);
      if (rows.length === 0) { console.error(`WARNING: 0 rows survive filter for ${g.name}`); continue; }

      const spheres = rows.map(r => Number(r.sphere));
      const cylinders = rows.map(r => Number(r.cylinder));
      const avgCost = rows.reduce((s, r) => s + Number(r.cost || 0), 0) / rows.length;
      const basePrice = Math.round(avgCost * 100) / 100;
      const sellPrice = g.existingPrice != null ? g.existingPrice : Math.round(avgCost * 1.15 * 100) / 100;

      const lensId = g.existingLensId || crypto.randomUUID();
      const materialId = REF.material[g.material];
      const mftypeId = g.mftypeOverride || REF.mftype[g.mftype];
      const lenstypeId = REF.lenstype[g.lenstype];
      const finishtypeId = REF.finish[g.finSemi];
      const supplierId = REF.supplier[g.supplier];
      const brandId = REF.brand[g.brand];
      if (!materialId || !mftypeId || !lenstypeId || !finishtypeId || !supplierId || !brandId) {
        throw new Error(`Missing reference id for group: ${g.name}`);
      }

      lines.push(`-- ${g.name} (${rows.length}/${allRows.length} power rows kept, ERP key ${g.erp.join(':')}, ${g.existingLensId ? 'REUSE existing lens ' + lensId : 'NEW lens ' + lensId})`);

      if (!g.existingLensId) {
        lines.push(`INSERT INTO public.lenses (id, supplier_id, brand_id, material_id, mftype_id, lenstype_id, finishtype_id, name, index_value, base_price, sell_price, sph_min, sph_max, cyl_min, cyl_max, is_active, show_on_website, show_in_pricelist, show_in_ws_pricelist, full_lab, notes) VALUES (` +
          `${sqlStr(lensId)}, ${sqlStr(supplierId)}, ${sqlStr(brandId)}, ${sqlStr(materialId)}, ${sqlStr(mftypeId)}, ${sqlStr(lenstypeId)}, ${sqlStr(finishtypeId)}, ` +
          `${sqlStr(g.name)}, 0, ${sqlNum(basePrice)}, ${sqlNum(sellPrice)}, ${sqlNum(Math.min(...spheres))}, ${sqlNum(Math.max(...spheres))}, ${sqlNum(Math.min(...cylinders))}, ${sqlNum(Math.max(...cylinders))}, ` +
          `true, false, false, false, false, ${sqlStr('Auto-created from Stock-order sales report ' + new Date().toISOString().slice(0,10) + '. base_price/sell_price are a mechanical cost+15% PLACEHOLDER (avg ERP cost across ' + rows.length + ' power rows was ' + avgCost.toFixed(4) + ') — review before publishing. ERP identity ' + g.erp.join(':') + '. Rows filtered to in-stock-or-recently-sold-on-Stock-orders.')});`);
      } else {
        lines.push(`UPDATE public.lenses SET supplier_id=${sqlStr(supplierId)}, brand_id=${sqlStr(brandId)} WHERE id=${sqlStr(lensId)};`);
      }

      const rowLabel = 'Sphere';
      const columnLabel = g.chiral ? 'Add' : 'Cylinder';
      const settingsId = crypto.randomUUID();
      lines.push(`DELETE FROM public.store_product_variant_settings WHERE product_type='lens' AND product_id=${sqlStr(lensId)};`);
      lines.push(`INSERT INTO public.store_product_variant_settings (id, product_type, product_id, variant_mode, config) VALUES (` +
        `${sqlStr(settingsId)}, 'lens', ${sqlStr(lensId)}, 'lens_grid', ` +
        `'${JSON.stringify({ is_chiral: g.chiral, row_label: rowLabel, column_label: columnLabel }).replace(/'/g, "''")}'::jsonb);`);
      lines.push(`DELETE FROM public.store_product_variants WHERE product_type='lens' AND product_id=${sqlStr(lensId)};`);

      const valuesRows = rows.map((r, idx) => {
        const sphere = Number(r.sphere), cylinder = Number(r.cylinder), diameter = Number(r.diameter);
        const variantKey = `sphere:${sphere}|cylinder:${cylinder}|diameter:${diameter}`;
        const title = `${rowLabel.toUpperCase()} ${sphere.toFixed(2)} / ${columnLabel.toUpperCase()} ${cylinder.toFixed(2)}`;
        const sku = `LENS-${sphere.toFixed(2)}-${cylinder.toFixed(2)}-${diameter.toFixed(2)}`;
        const opcCode = g.chiral ? null : (r.opcR || r.opcL || null);
        const metadata = g.chiral
          ? { is_chiral: true, opc_by_eye: { left: r.opcL || null, right: r.opcR || null } }
          : { is_chiral: false };
        const attributes = { sphere, cylinder, diameter };
        return `(${sqlStr(crypto.randomUUID())}, 'lens', ${sqlStr(lensId)}, ${sqlStr(title)}, ${sqlStr(variantKey)}, ${sqlStr(sku)}, ` +
          `${opcCode ? sqlStr(opcCode) : 'NULL'}, '${JSON.stringify(attributes).replace(/'/g, "''")}'::jsonb, '${JSON.stringify(metadata).replace(/'/g, "''")}'::jsonb, ` +
          `${sqlNum(sellPrice)}, ${sqlNum(Number(r.cost || 0))}, ${sqlNum(Number(r.onHand || 0))}, true, ${idx})`;
      });

      lines.push(`INSERT INTO public.store_product_variants (id, product_type, product_id, title, variant_key, sku, opc_code, attributes, metadata, price, cost, stock_qty, is_active, sort_order) VALUES`);
      lines.push(valuesRows.join(',\n') + ';');
      lines.push('');
    }
  } finally {
    await pool.close();
  }

  const outPath = path.join(__dirname, '..', 'data', 'stock-lens-catalog-insert-pass2.sql');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => { console.error('ERROR:', err.message); process.exit(1); });
