function resolveLensAlias(normalizedOrder, catalog) {
  const request = normalizedOrder?.lensRequest || {};
  const description = normalize([request.lensType, request.design, request.material, request.option, request.coating].filter(Boolean).join(" "));
  const expectsPhotochromic = /photochromic|transition/.test(description);
  const requestedColor = colorFrom(description) || (expectsPhotochromic ? "gray" : "srcoated");
  const material = materialFrom(request.material || description);
  const type = typeFrom([request.lensType, request.design].filter(Boolean).join(" "));
  const ranked = (Array.isArray(catalog) ? catalog : []).map((lens) => ({ lens, score: scoreLens(lens, { description, expectsPhotochromic, requestedColor, material, type }) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || String(left.lens.alias).localeCompare(String(right.lens.alias)));
  const best = ranked[0];
  const next = ranked[1];
  if (!best) return { status: "needs-selection", reason: "No catalogue alias matched the extracted lens details.", candidates: [] };
  const unambiguous = best.score >= 28 && (!next || best.score >= next.score + 4);
  return {
    status: unambiguous ? "suggested" : "needs-selection",
    reason: suggestionReason({ expectsPhotochromic, requestedColor, material, type }),
    suggestedAlias: unambiguous ? String(best.lens.alias) : null,
    candidates: ranked.slice(0, 5).map(({ lens }) => publicLens(lens))
  };
}

function scoreLens(lens, expected) {
  const source = normalize([lens.mfType, lens.category, lens.materialDescription, lens.styleDescription, lens.colorDescription].filter(Boolean).join(" "));
  let score = 0;
  if (expected.type) score += source.includes(expected.type) ? 22 : -14;
  if (expected.material) score += source.includes(expected.material) ? 14 : -4;
  if (expected.expectsPhotochromic) score += /photochromic|transition/.test(source) ? 12 : -18;
  if (expected.requestedColor) score += source.includes(expected.requestedColor) ? 12 : -5;
  if (!expected.expectsPhotochromic && expected.requestedColor === "srcoated" && /\bclear\b/.test(source)) score += 5;
  for (const token of tokenList(expected.description)) if (source.includes(token) && token.length > 3) score += 1;
  return score;
}

function publicLens(lens) {
  return {
    alias: String(lens.alias),
    material: lens.materialDescription || null,
    design: lens.styleDescription || null,
    color: lens.colorDescription || null,
    type: lens.mfType || lens.category || null
  };
}

function suggestionReason(expected) {
  const details = [];
  if (expected.type) details.push(expected.type);
  if (expected.material) details.push(expected.material);
  details.push(expected.expectsPhotochromic ? `photochromic ${expected.requestedColor}` : expected.requestedColor === "srcoated" ? "clear / SR-coated default" : expected.requestedColor);
  return `Matched ${details.join(", ")}. Confirm the exact catalogue alias before saving.`;
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
}

function tokenList(value) {
  return normalize(value).split(" ").filter(Boolean);
}

function materialFrom(value) {
  const normalized = normalize(value);
  const index = normalized.match(/\b1\.\d{2}\b/);
  if (index) return index[0];
  if (/polycarbonate/.test(normalized)) return "polycarbonate";
  if (/trivex/.test(normalized)) return "trivex";
  return null;
}

function typeFrom(value) {
  const normalized = normalize(value);
  if (/single vision|\bsv\b/.test(normalized)) return "single vision";
  if (/progressive|multifocal/.test(normalized)) return "progressive";
  if (/bifocal/.test(normalized)) return "bifocal";
  if (/trifocal/.test(normalized)) return "trifocal";
  return null;
}

function colorFrom(value) {
  const normalized = normalize(value);
  return ["gray", "grey", "brown", "green", "blue", "pink", "purple", "yellow", "clear"].find((color) => new RegExp(`\\b${color}\\b`).test(normalized)) || null;
}

module.exports = { resolveLensAlias };
