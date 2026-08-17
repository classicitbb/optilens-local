// Matches the 49 Supabase `lenses` rows that are in the Stock Lens Pricelist
// (show_in_ws_pricelist=true, sell_price>0) but have no store_product_variants
// grid yet, against their ERP LensItem family key, using data/erp-lens-families.json
// (dumped by dump-wspl-erp-families.js). Read-only / analysis only — writes a
// candidates report to data/wspl-match-candidates.json for manual review.
const fs = require('fs');
const path = require('path');

const families = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'erp-lens-families.json'), 'utf8'));

// From live Supabase query 2026-08-15: lenses with show_in_ws_pricelist=true,
// sell_price>0, and no (or partial, still off-website) variant grid.
const TARGETS = [
  { id: '7f95754c-ecaf-4a37-967d-cf2ad39c7903', name: '1.50 FIN SV Regular Blue Cut SupHydro', notes: 'CR39 FSV BLUEPRO HMC GREEN CYL2', supplier: 'East Optical', brand: 'ZenVue', material: 'Plastic 1.50', mftype: 'Single Vision', lenstype: 'Regular', finish: 'Finished' },
  { id: 'aba5a1b2-76e0-4f86-9da2-36527c9b62ca', name: '1.50 FPAL PROG Brilliance Darkun BBLK +AR', notes: '1.56 SF PROGRESSIVE BLUEPRO+PHOTO GRAY HC 70/14MM', supplier: 'East Optical', brand: 'ZenVue', material: 'Plastic 1.50', mftype: 'Progressive', lenstype: 'Brilliance', finish: 'Finished PAL' },
  { id: 'ff6bcb21-8ebb-4209-ab0e-9a360357933b', name: '1.50 SF BF Flat Top 28 SRCoated', notes: null, supplier: 'Hoya', brand: 'Vision-Ease', material: 'Plastic 1.50', mftype: 'Bifocal', lenstype: 'Flat Top 28', finish: 'Semifinished' },
  { id: '5982dbe6-7c12-4262-a5ec-18cbd2b65a60', name: '1.50 SF BF Flat Top 28 Trans 8 Gray', notes: null, supplier: 'Younger', brand: 'Younger', material: 'Photochromic 1.50', mftype: 'Bifocal', lenstype: 'Flat Top 28', finish: 'Semifinished' },
  { id: '5926cb3e-4053-4be3-b7d7-7abe84869e4b', name: '1.50 SF BF Flat Top 28 UNCoated', notes: null, supplier: 'Younger', brand: 'Younger', material: 'Plastic 1.50', mftype: 'Bifocal', lenstype: 'Flat Top 28', finish: 'Semifinished' },
  { id: '9250a07a-58ce-4fec-b273-01c5ba1c2a30', name: '1.50 SF BF Flat Top 35 UNCoated', notes: null, supplier: 'Younger', brand: 'Younger', material: 'Plastic 1.50', mftype: 'Bifocal', lenstype: 'Flat Top 35', finish: 'Semifinished' },
  { id: '931eab2d-544e-4b1a-91ae-12ae26460b85', name: '1.50 SF BF Round 22 SRCoated', notes: null, supplier: 'Younger', brand: 'Younger', material: 'Plastic 1.50', mftype: 'Bifocal', lenstype: 'Round 22', finish: 'Semifinished' },
  { id: 'a193d18b-9b49-4dfa-86f3-24cf233cd3c4', name: '1.50 SF PROG Accolade SRCoated', notes: null, supplier: 'Essilor', brand: 'Silor', material: 'Plastic 1.50', mftype: 'Progressive', lenstype: 'Accolade', finish: 'Semifinished' },
  { id: '1248caa4-b88d-4a8a-ae59-66648defd420', name: '1.50 SF PROG Accolade Trans 8 Gray', notes: null, supplier: 'Essilor', brand: 'Silor', material: 'Photochromic 1.50', mftype: 'Progressive', lenstype: 'Accolade', finish: 'Semifinished' },
  { id: '12133a54-ece6-441d-adb4-16718de98a90', name: '1.50 SF PROG Brilliance Blue Block SRC', notes: '1.56 SF PROGRESSIVE BLUEPRO HC 70/14MM', supplier: 'East Optical', brand: 'ZenVue', material: 'Plastic 1.50', mftype: 'Progressive', lenstype: 'Brilliance', finish: 'Semifinished' },
  { id: 'ecc81093-b868-41ed-ae29-74f641eb1b9e', name: '1.50 SF PROG Brilliance Darkun', notes: '1.56 SF PROGRESSIVE BLUEPRO+PHOTO GRAY HC 70/14MM', supplier: 'East Optical', brand: 'ZenVue', material: 'Plastic 1.50', mftype: 'Progressive', lenstype: 'Brilliance', finish: 'Semifinished' },
  { id: '2875287d-e5fe-4df3-9811-cfd480de0056', name: '1.50 SF PROG Comfort 2 Trans 8 Gray', notes: null, supplier: 'Essilor', brand: 'Varilux', material: 'Photochromic 1.50', mftype: 'Progressive', lenstype: 'Comfort 2', finish: 'Semifinished' },
  { id: '10ca9eae-5902-4259-ae2a-fa117cfdfb11', name: '1.50 SF PROG Comfort 2 XtrActive NG', notes: null, supplier: 'Essilor', brand: 'Varilux', material: 'Photochromic 1.50', mftype: 'Progressive', lenstype: 'Comfort 2', finish: 'Semifinished' },
  { id: 'b526c31b-5659-429a-aa72-f0f604117f52', name: '1.50 SF PROG Image NuPolar Polarized', notes: null, supplier: 'Younger', brand: 'Younger', material: 'Polarized 1.50', mftype: 'Progressive', lenstype: 'Image', finish: 'Semifinished' },
  { id: '4b7ccf04-3e44-469b-8295-3f1023eba9d9', name: '1.50 SF PROG Image TGNS Gray', notes: null, supplier: 'Younger', brand: 'Younger', material: 'Photochromic 1.50', mftype: 'Progressive', lenstype: 'Image', finish: 'Semifinished' },
  { id: 'a98eecc5-f316-4d85-bceb-d060c3a6d6ce', name: '1.50 SF PROG Image Trans 8 Gray', notes: null, supplier: 'Younger', brand: 'Younger', material: 'Photochromic 1.50', mftype: 'Progressive', lenstype: 'Image', finish: 'Semifinished' },
  { id: '705ca3a1-f806-4d7f-8a0a-7ecd5a5be53b', name: '1.50 SF PROG Ovation TGNS Gray', notes: null, supplier: 'Essilor', brand: 'Silor', material: 'Photochromic 1.50', mftype: 'Progressive', lenstype: 'Ovation', finish: 'Semifinished' },
  { id: 'c2c720cb-0345-42e3-8126-2c49fcd347c2', name: '1.50 SF PROG Physio Trans 8 Gray', notes: null, supplier: 'Essilor', brand: 'Varilux', material: 'Photochromic 1.50', mftype: 'Progressive', lenstype: 'Physio', finish: 'Semifinished' },
  { id: 'e4313561-d043-4075-88cf-e537f47727af', name: '1.50 SF PROG Shoreview ES Activations Gray', notes: null, supplier: 'Essilor', brand: 'Shore Lens', material: 'Photochromic 1.50', mftype: 'Progressive', lenstype: 'Shoreview ES', finish: 'Semifinished' },
  { id: '30f39add-1561-425a-a348-8d0fa13f1d7c', name: '1.50 SF PROG Shoreview ES SRCoated', notes: null, supplier: 'Essilor', brand: 'Shore Lens', material: 'Plastic 1.50', mftype: 'Progressive', lenstype: 'Shoreview ES', finish: 'Semifinished' },
  { id: '7affc1c8-86ce-4fac-acb8-0abc57ca7402', name: '1.50 SF PROG Shoreview ES Trans 8 Gray', notes: null, supplier: 'Essilor', brand: 'Shore Lens', material: 'Photochromic 1.50', mftype: 'Progressive', lenstype: 'Shoreview ES', finish: 'Semifinished' },
  { id: '21589347-04c4-4b51-a6f9-4eb8f291b24c', name: '1.50 SF SV Regular TGNS Gray', notes: null, supplier: 'Younger', brand: 'Younger', material: 'Photochromic 1.50', mftype: 'Single Vision', lenstype: 'Regular', finish: 'Semifinished' },
  { id: '41236f0b-53d9-45b3-a291-c41fec6cae9b', name: '1.53 SF BF Flat Top 28 SRCoated', notes: null, supplier: 'Essilor', brand: 'X-Cel', material: 'Trivex 1.53', mftype: 'Bifocal', lenstype: 'Flat Top 28', finish: 'Semifinished' },
  { id: '0c97e3b2-609b-425c-bf8a-ccc15c6329aa', name: '1.53 SF PROG Accolade SRCoated', notes: null, supplier: 'Essilor', brand: 'Silor', material: 'Trivex 1.53', mftype: 'Progressive', lenstype: 'Accolade', finish: 'Semifinished' },
  { id: 'faa24101-d0f7-42ba-9a62-2e8a26e28021', name: '1.53 SF PROG Image TGNS', notes: null, supplier: 'Younger', brand: 'Younger', material: 'Trivex 1.53', mftype: 'Progressive', lenstype: 'Image', finish: 'Semifinished' },
  { id: 'ae372c16-862a-46f7-8c20-2e7cea047dbf', name: '1.53 SF PROG Ovation TGNS', notes: null, supplier: 'Essilor', brand: 'Silor', material: 'Trivex 1.53', mftype: 'Progressive', lenstype: 'Ovation', finish: 'Semifinished' },
  { id: '840425bf-37e7-4dfb-af13-a55184f543b5', name: '1.565 FIN SV Regular Darkun BBLK +AR', notes: '1.56 FSV PLUEPRO+PHOTO (FAST) HMC CYL2', supplier: 'East Optical', brand: 'ZenVue', material: 'Plastic 1.565', mftype: 'Single Vision', lenstype: 'Regular', finish: 'Finished' },
  { id: 'bc1974a3-b2c7-47b8-8939-4b67c6f48c08', name: '1.565 FIN SV Regular UV420 Spin PhtoGr', notes: null, supplier: 'Youli Optics', brand: 'Youli Lens', material: 'Plastic 1.565', mftype: 'Single Vision', lenstype: 'Regular', finish: 'Finished' },
  { id: '08f31704-afd2-45a8-9a5f-1d6d8f55814c', name: '1.565 SF SV Regular Darkun', notes: '1.56 SFSV BLUEPRO+PHOTOPRO (SPIN) HC 75MM', supplier: 'East Optical', brand: 'ZenVue', material: 'Plastic 1.565', mftype: 'Single Vision', lenstype: 'Regular', finish: 'Semifinished' },
  { id: '0fdcfc2c-5466-42c3-adf6-b0f2aeb42bad', name: '1.595 SF BF Flat Top 28 SRCoated', notes: null, supplier: 'Essilor', brand: 'Signet', material: 'High Index 1.595', mftype: 'Bifocal', lenstype: 'Flat Top 28', finish: 'Semifinished' },
  { id: 'b267d496-3661-4b49-a06a-e6090156cece', name: '1.67 SF PROG Accolade SRCoated', notes: null, supplier: 'Essilor', brand: 'Silor', material: '1.67 High Index', mftype: 'Progressive', lenstype: 'Accolade', finish: 'Semifinished' },
  { id: '15420a5a-2960-4d5f-956a-d85a20bad396', name: '1.67 SF PROG Accolade Trans 8 Gray', notes: null, supplier: 'Essilor', brand: 'Silor', material: '1.67 High Index', mftype: 'Progressive', lenstype: 'Accolade', finish: 'Semifinished' },
  { id: '9afab7d9-5b3a-4732-b0f8-a695100e155d', name: '1.67 SF PROG Ovation TGNS Gray', notes: null, supplier: 'Essilor', brand: 'Silor', material: '1.67 High Index', mftype: 'Progressive', lenstype: 'Ovation', finish: 'Semifinished' },
  { id: 'ac9abcd0-d430-4f92-9105-00279b7e171a', name: '1.67 SF SV Regular Darkun', notes: '1.67 SFSV BLUEPRO+PHOTOPRO (SPIN) HC (MR7) 75MM', supplier: 'East Optical', brand: 'ZenVue', material: '1.67 High Index', mftype: 'Single Vision', lenstype: 'Regular', finish: 'Semifinished' },
  { id: '11280252-3255-4893-8457-85df4af871c8', name: '1.67 SF SV Regular SR Coated', notes: '1.67 SFSV HC (MR7) 75MM', supplier: 'East Optical', brand: 'ZenVue', material: '1.67 High Index', mftype: 'Single Vision', lenstype: 'Regular', finish: 'Semifinished' },
  { id: '4d51b2bd-f734-4166-ba53-fdb0a33f4b56', name: 'POLY SF BF Flat Top 28 Photochromic', notes: null, supplier: 'Hoya', brand: 'Vision-Ease', material: 'Poly', mftype: 'Bifocal', lenstype: 'Flat Top 28', finish: 'Semifinished' },
  { id: '58431755-c40e-4ab4-8e2b-0540b642e9f0', name: 'POLY SF BF Flat Top 28 Photochromic', notes: null, supplier: 'Hoya', brand: 'Vision-Ease', material: 'Poly', mftype: 'Bifocal', lenstype: 'Flat Top 28', finish: 'Semifinished' },
  { id: 'ed6130e6-f7e2-4b33-9b6d-f550580f692d', name: 'POLY SF BF Flat Top 28 SRCoated', notes: 'HI-ADD', supplier: 'Hoya', brand: 'Vision-Ease', material: 'Poly', mftype: 'Bifocal', lenstype: 'Flat Top 28', finish: 'Semifinished' },
  { id: 'de537efb-2ff0-4949-b35e-f4ba19d75d33', name: 'POLY SF BF Flat Top 28 SRCoated', notes: null, supplier: 'Hoya', brand: 'Vision-Ease', material: 'Poly', mftype: 'Bifocal', lenstype: 'Flat Top 28', finish: 'Semifinished' },
  { id: '3315deda-7378-4279-841e-47af7f3a7b5c', name: 'POLY SF PROG Accolade SRCoated', notes: null, supplier: 'Essilor', brand: 'Silor', material: 'Poly', mftype: 'Progressive', lenstype: 'Accolade', finish: 'Semifinished' },
  { id: '9afa2b40-fdb0-4536-bf4e-e5535847fcdd', name: 'POLY SF PROG Accolade Xperio Gray-C', notes: null, supplier: 'Essilor', brand: 'Silor', material: 'Poly', mftype: 'Progressive', lenstype: 'Accolade', finish: 'Semifinished' },
  { id: '59f84eba-4ec9-484a-9767-290f080db6c4', name: 'POLY SF PROG Image XtrActive Gray', notes: null, supplier: 'Younger', brand: 'Younger', material: 'Poly', mftype: 'Progressive', lenstype: 'Image', finish: 'Semifinished' },
  { id: 'b3fea202-3b9a-4698-a4b6-6cd4f71aef03', name: 'POLY SF PROG Ovation TGNS Gray', notes: null, supplier: 'Essilor', brand: 'Silor', material: 'Poly', mftype: 'Progressive', lenstype: 'Ovation', finish: 'Semifinished' },
  { id: '0a724d4f-12a2-43a2-ba58-c31345469330', name: 'POLY SF PROG Shoreview ES Activations Gray', notes: null, supplier: 'Essilor', brand: 'Shore Lens', material: 'Poly', mftype: 'Progressive', lenstype: 'Shoreview ES', finish: 'Semifinished' },
  { id: 'f610b853-9cdd-458a-9a77-4c489f252af9', name: 'POLY SF PROG Shoreview ES SRCoated', notes: null, supplier: 'Essilor', brand: 'Shore Lens', material: 'Poly', mftype: 'Progressive', lenstype: 'Shoreview ES', finish: 'Semifinished' },
  { id: 'eef017ea-adb5-4e40-aafb-c48eb669b9f2', name: 'POLY SF PROG Shoreview ES SRCoated', notes: null, supplier: 'Essilor', brand: 'Shore Lens', material: 'Poly', mftype: 'Progressive', lenstype: 'Shoreview ES', finish: 'Semifinished' },
  { id: 'c240ee17-361b-4c5c-a5ca-53ec3a769cba', name: 'POLY SF PROG Shoreview ES TGNS Gray', notes: null, supplier: 'Essilor', brand: 'Shore Lens', material: 'Poly', mftype: 'Progressive', lenstype: 'Shoreview ES', finish: 'Semifinished' },
  { id: 'bcf72417-9daf-4866-bf71-e13ad02dfe73', name: 'POLY SF PROG Shoreview ES Trans 8 Gray', notes: null, supplier: 'Essilor', brand: 'Shore Lens', material: 'Poly', mftype: 'Progressive', lenstype: 'Shoreview ES', finish: 'Semifinished' },
];

function erpManufacturer(t) {
  return t.brand === 'ZenVue' ? 'East Optical' : t.brand;
}

// Known cases where our `lenses.name`-derived lens_type/material don't literally
// match ERP text (confirmed by inspecting the live family dump 2026-08-15):
// East Optical's "Brilliance" progressive design is CV's own catalog name — ERP
// carries it under LensType "Finished PAL AR" (finished) / "ZenVue PAL 14" (semi-
// finished), material group "Plastic-User 1.56 MidIndex"/"Resin 1.565", NOT the
// "Plastic 1.50" stored on the `lenses` row (a real data-quality mislabel — these
// rows' own `notes` field literally starts "1.56 SF PROGRESSIVE...").
const LENSTYPE_OVERRIDE = {
  'aba5a1b2-76e0-4f86-9da2-36527c9b62ca': ['Finished PAL AR'],
  '12133a54-ece6-441d-adb4-16718de98a90': ['ZenVue PAL 14'],
  'ecc81093-b868-41ed-ae29-74f641eb1b9e': ['ZenVue PAL 14'],
};
const MATERIAL_OVERRIDE_FREE = new Set(Object.keys(LENSTYPE_OVERRIDE));

function materialMatches(fam, material) {
  const g = (fam.material_group || '').toLowerCase();
  const m = (fam.material || '').toLowerCase();
  const combined = `${g} ${m}`;
  switch (material) {
    case 'Plastic 1.50': return /\b1\.50\b|plastic/.test(combined) && !/photo|trivex|poly|polar/.test(combined);
    case 'Photochromic 1.50': return /photo/.test(combined) && /1\.50|plastic/.test(combined);
    case 'Polarized 1.50': return /polar/.test(combined) && !/photo/.test(combined);
    case 'Trivex 1.53': return /trivex|1\.53/.test(combined);
    case 'Plastic 1.565': return /1\.56|1\.565/.test(combined) && !/photo/.test(combined);
    case 'High Index 1.595': return /1\.59|1\.595/.test(combined);
    case '1.67 High Index': return /1\.67/.test(combined);
    case 'Poly': return /poly/.test(combined) && !/polar/.test(combined);
    default: return false;
  }
}

function finishMatches(fam, finish) {
  // Fin_Semi is NOT a clean binary flag — distinct values 0-9 observed across the
  // live catalog (confirmed 2026-08-15), and legitimate semi-finished stock (real
  // OnHand) shows up under fs=5 as often as fs=0 (e.g. Silor 1.67 Accolade Trans 8
  // Gray only exists at fs=5). Only fs=1 reliably means Finished. Don't hard-filter
  // on this — treat it as a soft tiebreaker only (see rank()).
  if (finish === 'Finished' || finish === 'Finished PAL') return true; // filtered by rank() instead
  return true;
}

function scoreOption(fam, target) {
  const hay = `${fam.option_name}`.toLowerCase();
  const text = `${target.name} ${target.notes || ''}`.toLowerCase();
  let score = 0;
  // Keep digit tokens (6/7/8 = tint generation, the exact thing that
  // differentiates "Trans 6 Gray" from "Trans 8 Gray") — do not drop short tokens.
  const tokens = hay.split(/[\s+/()-]+/).filter((t) => t.length > 0);
  for (const tok of tokens) {
    if (text.includes(tok)) score += tok.length <= 2 ? 0.5 : 1;
  }
  return score;
}

function finishRank(fam, finish) {
  // Tiebreaker only, applied after option-name score. Prefer real stock always;
  // among equal stock, prefer fs matching the expected finish family loosely.
  const wantFinished = finish === 'Finished' || finish === 'Finished PAL';
  if (wantFinished) return fam.fs === 1 ? 1 : 0;
  return fam.fs !== 1 ? 1 : 0;
}

const report = [];
for (const t of TARGETS) {
  const mfr = erpManufacturer(t);
  const lensTypeOk = (f) => (LENSTYPE_OVERRIDE[t.id] ? LENSTYPE_OVERRIDE[t.id].includes(f.lens_type) : f.lens_type === t.lenstype);
  const materialOk = (f) => (MATERIAL_OVERRIDE_FREE.has(t.id) ? /1\.56/.test(`${f.material_group} ${f.material}`.toLowerCase()) : materialMatches(f, t.material));
  let candidates = families.filter((f) =>
    f.manufacturer === mfr &&
    f.mf_type === t.mftype &&
    lensTypeOk(f) &&
    materialOk(f) &&
    finishMatches(f, t.finish)
  );
  candidates = candidates.map((f) => ({ ...f, _score: scoreOption(f, t), _finishRank: finishRank(f, t.finish) }));

  // Collapse duplicate option_name rows (same option text can appear at several
  // fs sub-codes) — keep the single best variant per option_name: highest score,
  // then real stock, then finish-family tiebreak.
  const byOption = new Map();
  for (const c of candidates) {
    const key = c.option_name;
    const existing = byOption.get(key);
    if (!existing) { byOption.set(key, c); continue; }
    const better =
      c._score > existing._score ||
      (c._score === existing._score && c.in_stock_count > existing.in_stock_count) ||
      (c._score === existing._score && c.in_stock_count === existing.in_stock_count && c._finishRank > existing._finishRank);
    if (better) byOption.set(key, c);
  }
  candidates = [...byOption.values()];
  candidates.sort((a, b) => b._score - a._score || b.in_stock_count - a.in_stock_count || b._finishRank - a._finishRank);

  report.push({
    target: t,
    erpManufacturer: mfr,
    candidateCount: candidates.length,
    top: candidates.slice(0, 8).map((c) => ({
      key: `${c.mg}:${c.mt}:${c.mf}:${c.lt}:${c.op}:${c.mfr}:${c.fs}`,
      option_name: c.option_name, material_group: c.material_group, material: c.material,
      power_row_count: c.power_row_count, in_stock_count: c.in_stock_count, score: c._score, fs: c.fs,
    })),
  });
}

const outPath = path.join(__dirname, '..', 'data', 'wspl-match-candidates.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

const noCandidates = report.filter((r) => r.candidateCount === 0);
const ambiguous = report.filter((r) => r.candidateCount > 0 && (r.top[0]._score === 0 || (r.top[1] && r.top[1].score === r.top[0].score)));
console.log(`Targets: ${report.length}`);
console.log(`Zero candidates (material/lenstype/mfr filter matched nothing): ${noCandidates.length}`);
noCandidates.forEach((r) => console.log(`  NO MATCH: ${r.target.name} [${r.erpManufacturer}, ${r.target.material}, ${r.target.mftype}, ${r.target.lenstype}, ${r.target.finish}]`));
console.log(`Single clean top candidate (score>0, no tie): ${report.length - noCandidates.length - ambiguous.length}`);
console.log(`Ambiguous/zero-score top: ${ambiguous.length}`);
ambiguous.forEach((r) => console.log(`  AMBIGUOUS: ${r.target.name} -> ${r.top.map(c=>`${c.option_name}(${c.score})`).join(', ')}`));
console.log(`\nWrote ${outPath}`);
