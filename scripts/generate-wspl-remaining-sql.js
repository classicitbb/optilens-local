// Generates INSERT SQL for store_product_variant_settings + store_product_variants
// for the 43 Stock Lens Pricelist (WSPL) lens families confirmed against the live
// Innovations ERP catalog on 2026-08-15 (see match-wspl-lens-families.js and the
// manual review that followed it — several auto-matches were wrong and got
// hand-corrected here; do not regenerate this MAPPING from the scorer blindly).
//
// Unlike the earlier 11-family project, every one of these `lenses` rows already
// exists (this is filling in variant grids on existing WSPL shells, not creating
// new lens rows) — so each entry only needs lensId + confirmed ERP key + chiral
// flag. sell_price is read from the live `lenses` row via the values embedded
// below (captured 2026-08-15) and must NOT be recomputed from cost.
//
// Row-level filter matches established convention (generate-remaining-stock-lens-sql.js):
// keep a power row if it currently has stock OR its OPC sold on a Stock order in
// the mirror's ~90-day window.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sql = require('mssql');
const { getConfig } = require('../lib/config');
const { getSourcePool } = require('../lib/db');

// erp: [MaterialGroup, Material, MFType, LensType, Option, Manufacturer, Fin_Semi]
const MAPPING = [
  { id: '7f95754c-ecaf-4a37-967d-cf2ad39c7903', name: '1.50 FIN SV Regular Blue Cut SupHydro', sellPrice: 15.00, chiral: false, erp: [1,1,1,1,146,183,1] },
  { id: 'aba5a1b2-76e0-4f86-9da2-36527c9b62ca', name: '1.50 FPAL PROG Brilliance Darkun BBLK +AR', sellPrice: 30.00, chiral: true, erp: [4,4,3,2,3,183,1] },
  { id: 'ff6bcb21-8ebb-4209-ab0e-9a360357933b', name: '1.50 SF BF Flat Top 28 SRCoated', sellPrice: 54.60, chiral: true, erp: [1,1,2,2,2,6,0] },
  { id: '5982dbe6-7c12-4262-a5ec-18cbd2b65a60', name: '1.50 SF BF Flat Top 28 Trans 8 Gray', sellPrice: 266.70, chiral: true, erp: [1,7,2,2,39,19,0] },
  { id: '5926cb3e-4053-4be3-b7d7-7abe84869e4b', name: '1.50 SF BF Flat Top 28 UNCoated', sellPrice: 54.60, chiral: true, erp: [1,1,2,2,1,19,0] },
  { id: '9250a07a-58ce-4fec-b273-01c5ba1c2a30', name: '1.50 SF BF Flat Top 35 UNCoated', sellPrice: 68.25, chiral: true, erp: [1,1,2,3,1,19,0] },
  { id: 'a193d18b-9b49-4dfa-86f3-24cf233cd3c4', name: '1.50 SF PROG Accolade SRCoated', sellPrice: 176.40, chiral: true, erp: [1,1,4,171,1,2,0] },
  { id: '1248caa4-b88d-4a8a-ae59-66648defd420', name: '1.50 SF PROG Accolade Trans 8 Gray', sellPrice: 325.50, chiral: true, erp: [1,7,4,68,8,2,5] },
  { id: '12133a54-ece6-441d-adb4-16718de98a90', name: '1.50 SF PROG Brilliance Blue Block SRC', sellPrice: 85.00, chiral: true, erp: [1,4,4,860,2,183,0] },
  { id: 'ecc81093-b868-41ed-ae29-74f641eb1b9e', name: '1.50 SF PROG Brilliance Darkun', sellPrice: 195.30, chiral: true, erp: [1,4,4,860,1,183,0] },
  { id: '2875287d-e5fe-4df3-9811-cfd480de0056', name: '1.50 SF PROG Comfort 2 Trans 8 Gray', sellPrice: 325.50, chiral: true, erp: [1,7,4,242,11,13,5] },
  { id: '10ca9eae-5902-4259-ae2a-fa117cfdfb11', name: '1.50 SF PROG Comfort 2 XtrActive NG', sellPrice: 330.50, chiral: true, erp: [1,7,4,242,3,13,0] },
  { id: 'b526c31b-5659-429a-aa72-f0f604117f52', name: '1.50 SF PROG Image NuPolar Polarized', sellPrice: 249.90, chiral: true, erp: [1,9,4,4,4,19,0], note: 'No literal NuPolar option in ERP — picked Gray-C SRC (highest-stock, gray/coated default). Confirm color with the user before treating as final.' },
  { id: '4b7ccf04-3e44-469b-8295-3f1023eba9d9', name: '1.50 SF PROG Image TGNS Gray', sellPrice: 325.50, chiral: true, erp: [1,7,4,17,19,19,0] },
  { id: 'a98eecc5-f316-4d85-bceb-d060c3a6d6ce', name: '1.50 SF PROG Image Trans 8 Gray', sellPrice: 325.50, chiral: true, erp: [1,7,4,17,15,19,0] },
  { id: '705ca3a1-f806-4d7f-8a0a-7ecd5a5be53b', name: '1.50 SF PROG Ovation TGNS Gray', sellPrice: 280.00, chiral: true, erp: [1,7,4,39,12,2,0] },
  { id: 'e4313561-d043-4075-88cf-e537f47727af', name: '1.50 SF PROG Shoreview ES Activations Gray', sellPrice: 195.30, chiral: true, erp: [1,7,4,412,4,104,0] },
  { id: '30f39add-1561-425a-a348-8d0fa13f1d7c', name: '1.50 SF PROG Shoreview ES SRCoated', sellPrice: 84.00, chiral: true, erp: [1,1,4,347,1,104,0] },
  { id: '7affc1c8-86ce-4fac-acb8-0abc57ca7402', name: '1.50 SF PROG Shoreview ES Trans 8 Gray', sellPrice: 268.80, chiral: true, erp: [1,7,4,412,5,104,0] },
  { id: '21589347-04c4-4b51-a6f9-4eb8f291b24c', name: '1.50 SF SV Regular TGNS Gray', sellPrice: 215.00, chiral: false, erp: [1,7,1,1,246,19,1] },
  { id: '0c97e3b2-609b-425c-bf8a-ccc15c6329aa', name: '1.53 SF PROG Accolade SRCoated', sellPrice: 237.30, chiral: true, erp: [1,18,4,95,1,2,0] },
  { id: 'faa24101-d0f7-42ba-9a62-2e8a26e28021', name: '1.53 SF PROG Image TGNS', sellPrice: 346.50, chiral: true, erp: [1,18,4,2,9,19,0] },
  { id: '840425bf-37e7-4dfb-af13-a55184f543b5', name: '1.565 FIN SV Regular Darkun BBLK +AR', sellPrice: 105.00, chiral: false, erp: [1,10,1,1,9,183,1] },
  { id: 'bc1974a3-b2c7-47b8-8939-4b67c6f48c08', name: '1.565 FIN SV Regular UV420 Spin PhtoGr', sellPrice: 195.00, chiral: false, erp: [4,4,2,1,5,57,0] },
  { id: '08f31704-afd2-45a8-9a5f-1d6d8f55814c', name: '1.565 SF SV Regular Darkun', sellPrice: 195.00, chiral: false, erp: [1,10,1,1,9,183,1], note: 'Only real-stock East Optical match is the +AR option (178 in stock) — same key as the FIN BBLK+AR row above but this is the SF shell; kept distinct lens_id, same ERP source family.' },
  { id: 'b267d496-3661-4b49-a06a-e6090156cece', name: '1.67 SF PROG Accolade SRCoated', sellPrice: 262.50, chiral: true, erp: [1,8,4,40,1,2,0] },
  { id: '15420a5a-2960-4d5f-956a-d85a20bad396', name: '1.67 SF PROG Accolade Trans 8 Gray', sellPrice: 409.50, chiral: true, erp: [1,8,4,40,10,2,5] },
  { id: '9afab7d9-5b3a-4732-b0f8-a695100e155d', name: '1.67 SF PROG Ovation TGNS Gray', sellPrice: 409.50, chiral: true, erp: [1,8,4,17,13,2,0] },
  { id: 'ac9abcd0-d430-4f92-9105-00279b7e171a', name: '1.67 SF SV Regular Darkun', sellPrice: 249.90, chiral: false, erp: [1,8,1,4,227,183,0] },
  { id: '11280252-3255-4893-8457-85df4af871c8', name: '1.67 SF SV Regular SR Coated', sellPrice: 138.60, chiral: false, erp: [1,8,1,4,2,183,0] },
  { id: '4d51b2bd-f734-4166-ba53-fdb0a33f4b56', name: 'POLY SF BF Flat Top 28 Photochromic', sellPrice: 207.90, chiral: true, erp: [1,3,2,2,21,6,0] },
  { id: '58431755-c40e-4ab4-8e2b-0540b642e9f0', name: 'POLY SF BF Flat Top 28 Photochromic', sellPrice: 207.90, chiral: true, erp: [1,3,2,2,21,6,0], note: 'Duplicate lenses row (same name/price/ERP source as 4d51b2bd) — imported independently, same grid data.' },
  { id: 'ed6130e6-f7e2-4b33-9b6d-f550580f692d', name: 'POLY SF BF Flat Top 28 SRCoated', sellPrice: 165.90, chiral: true, erp: [1,3,2,2,1,6,0], note: 'notes="HI-ADD" but no separate ERP LensType exists for a Hi-Add FT28 Poly — same source family as de537efb.' },
  { id: 'de537efb-2ff0-4949-b35e-f4ba19d75d33', name: 'POLY SF BF Flat Top 28 SRCoated', sellPrice: 165.90, chiral: true, erp: [1,3,2,2,1,6,0] },
  { id: '3315deda-7378-4279-841e-47af7f3a7b5c', name: 'POLY SF PROG Accolade SRCoated', sellPrice: 204.75, chiral: true, erp: [1,3,4,92,1,2,0] },
  { id: '9afa2b40-fdb0-4536-bf4e-e5535847fcdd', name: 'POLY SF PROG Accolade Xperio Gray-C', sellPrice: 360.15, chiral: true, erp: [1,3,4,92,7,2,5] },
  { id: '59f84eba-4ec9-484a-9767-290f080db6c4', name: 'POLY SF PROG Image XtrActive Gray', sellPrice: 354.90, chiral: true, erp: [1,3,4,31,17,19,0] },
  { id: 'b3fea202-3b9a-4698-a4b6-6cd4f71aef03', name: 'POLY SF PROG Ovation TGNS Gray', sellPrice: 361.20, chiral: true, erp: [1,3,4,36,17,2,0] },
  { id: '0a724d4f-12a2-43a2-ba58-c31345469330', name: 'POLY SF PROG Shoreview ES Activations Gray', sellPrice: 207.90, chiral: true, erp: [1,3,4,749,2,104,0] },
  { id: 'c240ee17-361b-4c5c-a5ca-53ec3a769cba', name: 'POLY SF PROG Shoreview ES TGNS Gray', sellPrice: 281.40, chiral: true, erp: [1,3,4,749,5,104,0] },
  { id: 'bcf72417-9daf-4866-bf71-e13ad02dfe73', name: 'POLY SF PROG Shoreview ES Trans 8 Gray', sellPrice: 281.40, chiral: true, erp: [1,3,4,749,3,104,0] },
];

// Confirmed to have NO real ERP counterpart (checked exhaustively 2026-08-15) —
// intentionally excluded from this pass; report to the user rather than guess.
const SKIPPED = [
  { id: 'c2c720cb-0345-42e3-8126-2c49fcd347c2', name: '1.50 SF PROG Physio Trans 8 Gray', reason: 'Varilux Physio photochromic only goes up to Trans 7 Gray in the ERP — no Trans 8 tier exists for this design.' },
  { id: '41236f0b-53d9-45b3-a291-c41fec6cae9b', name: '1.53 SF BF Flat Top 28 SRCoated', reason: 'X-Cel Trivex 1.53 Flat Top 28 has only Trans-tinted options + UNCoated in the ERP — no SRCoated/clear-coated variant.' },
  { id: 'ae372c16-862a-46f7-8c20-2e7cea047dbf', name: '1.53 SF PROG Ovation TGNS', reason: "Silor does not offer the Ovation design in Trivex 1.53 material at all (only Plastic 1.50, Photochromic 1.50, Poly 1.59, 1.67)." },
  { id: '0fdcfc2c-5466-42c3-adf6-b0f2aeb42bad', name: '1.595 SF BF Flat Top 28 SRCoated', reason: "Signet's 1.595 High Index material doesn't come in Bifocal Flat Top 28 form in the ERP — only Plastic 1.50 / Photochromic 1.50 do." },
  { id: '931eab2d-544e-4b1a-91ae-12ae26460b85', name: '1.50 SF BF Round 22 SRCoated', reason: 'Younger Round 22 Bifocal in Plastic 1.50 only exists as UNCoated in the ERP — no SRCoated variant.' },
];

function sqlStr(v) { return `'${String(v).replace(/'/g, "''")}'`; }
function sqlNum(v) { return Number.isFinite(v) ? String(v) : 'NULL'; }

async function main() {
  const mirrorPool = await getSourcePool();
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

  const cfg = getConfig().sourceMssql;
  const pool = new sql.ConnectionPool({
    server: cfg.server, database: cfg.database, user: cfg.user, password: cfg.password,
    options: { encrypt: cfg.encrypt, trustServerCertificate: cfg.trustServerCertificate },
    connectionTimeout: 8000, requestTimeout: 60000
  });
  await pool.connect();

  const lines = [];
  const summary = [];
  try {
    for (const g of MAPPING) {
      const [mg, mt, mf, lt, op, mfr, gfs] = g.erp;
      const result = await pool.request()
        .input('mg', mg).input('mt', mt).input('mf', mf).input('lt', lt).input('op', op).input('mfr', mfr).input('fs', gfs)
        .query(`
          SELECT Num AS itemNum, Diameter/100.0 AS diameter, Base_Sphere/100.0 AS sphere, Add_Cyl/100.0 AS cylinder,
                 OPC_R AS opcR, OPC_L AS opcL, (OnHand_R+OnHand_L+OnHand_P*2) AS onHand, Cost AS cost
          FROM dbo.LensItem
          WHERE MaterialGroup=@mg AND Material=@mt AND MFType=@mf AND LensType=@lt AND [Option]=@op AND Manufacturer=@mfr AND Fin_Semi=@fs AND Flags & 2 = 0
          ORDER BY Base_Sphere, Add_Cyl, Diameter
        `);
      const allRows = result.recordset;
      let rows = allRows.filter((r) => {
        const onHand = Number(r.onHand || 0);
        if (onHand > 0) return true;
        const opcR = String(r.opcR || '').trim();
        const opcL = String(r.opcL || '').trim();
        return (opcR && soldSkus.has(opcR)) || (opcL && soldSkus.has(opcL));
      });

      // This family is business-approved (already priced on the WSPL pricelist) —
      // unlike the discovery-driven prior project, a filtered-to-zero result here
      // means "no current momentum", not "not a real product". Fall back to the
      // full combinatorial range so every confirmed family still gets a grid.
      let usedFullRange = false;
      if (rows.length === 0 && allRows.length > 0) { rows = allRows; usedFullRange = true; }

      console.log(`${g.name} [${g.id}]: ${allRows.length} total power rows -> ${rows.length} kept${usedFullRange ? ' (FULL RANGE — no stock/recent sales, no filtering applied)' : ' (in-stock or recently sold)'}`);
      summary.push({ id: g.id, name: g.name, totalRows: allRows.length, keptRows: rows.length, usedFullRange });
      if (rows.length === 0) { console.error(`WARNING: 0 total power rows exist for ${g.name} (${g.id}) — ERP key may be wrong, skipping insert, needs review`); continue; }

      const settingsId = crypto.randomUUID();
      const rowLabel = 'Sphere';
      const columnLabel = g.chiral ? 'Add' : 'Cylinder';
      lines.push(`-- ${g.name} [${g.id}] (${rows.length}/${allRows.length} power rows kept, ERP key ${g.erp.join(':')})${g.note ? ' -- NOTE: ' + g.note : ''}`);
      lines.push(`DELETE FROM public.store_product_variant_settings WHERE product_type='lens' AND product_id=${sqlStr(g.id)};`);
      lines.push(`INSERT INTO public.store_product_variant_settings (id, product_type, product_id, variant_mode, config) VALUES (` +
        `${sqlStr(settingsId)}, 'lens', ${sqlStr(g.id)}, 'lens_grid', ` +
        `'${JSON.stringify({ is_chiral: g.chiral, row_label: rowLabel, column_label: columnLabel }).replace(/'/g, "''")}'::jsonb);`);
      lines.push(`DELETE FROM public.store_product_variants WHERE product_type='lens' AND product_id=${sqlStr(g.id)};`);

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
        return `(${sqlStr(crypto.randomUUID())}, 'lens', ${sqlStr(g.id)}, ${sqlStr(title)}, ${sqlStr(variantKey)}, ${sqlStr(sku)}, ` +
          `${opcCode ? sqlStr(opcCode) : 'NULL'}, '${JSON.stringify(attributes).replace(/'/g, "''")}'::jsonb, '${JSON.stringify(metadata).replace(/'/g, "''")}'::jsonb, ` +
          `${sqlNum(g.sellPrice)}, ${sqlNum(Number(r.cost || 0))}, ${sqlNum(Number(r.onHand || 0))}, true, ${idx})`;
      });

      lines.push(`INSERT INTO public.store_product_variants (id, product_type, product_id, title, variant_key, sku, opc_code, attributes, metadata, price, cost, stock_qty, is_active, sort_order) VALUES`);
      lines.push(valuesRows.join(',\n') + ';');
      lines.push('');
    }
  } finally {
    await pool.close();
  }

  const outPath = path.join(__dirname, '..', 'data', 'wspl-remaining-insert.sql');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`\nWrote ${outPath}`);

  const summaryPath = path.join(__dirname, '..', 'data', 'wspl-remaining-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({ summary, skipped: SKIPPED }, null, 2), 'utf8');
  console.log(`Wrote ${summaryPath}`);
}

main().catch((err) => { console.error('ERROR:', err.message); process.exit(1); });
