// Innovations names photochromics by brand ("Trans 7 Gray", "XtrActive Gray",
// "Sensity Gray DH", "Photo Gray") as well as by the "Photochromic" material.
const PHOTOCHROMIC = /photochromic|transition|\btrans\b|\bphoto|xtractive|activation|sensity|sunsync|sunrx|sunsensor|neochrom|vantage|suntec|q shade/;

const OWN_LENSES = /own lens|supplied|customer s lens|customers lens|cust lens|customer lens|pt lens|patient s lens|patients lens|cut only|edge only|custom lens/;

// Innovations spells the customer-supplied style both "Custom Lens" and
// "Custom lens" (different style codes, so different aliases). Operators see
// one "Custom Lens" design per lens type with the colours combined. Where both
// spellings offer the same material and colour, the "Custom Lens" alias is
// kept (then the lowest alias). Source rows are untouched, so the RX file still
// carries Innovations' exact alias and style description.
const OWN_LENS_STYLE = "Custom Lens";

function mergeOwnLensStyles(catalog) {
  const merged = new Map();
  const rest = [];
  const preferred = (left, right) => {
    const rank = (lens) => (lens.styleDescription === OWN_LENS_STYLE ? 0 : 1);
    return rank(left) - rank(right) || String(left.alias).localeCompare(String(right.alias));
  };
  for (const lens of Array.isArray(catalog) ? catalog : []) {
    if (!lens?.customerSupplied || normalize(lens.styleDescription) !== "custom lens") {
      rest.push(lens);
      continue;
    }
    const key = [lens.materialGroupCode, lens.materialDescription, lens.mfType, lens.colorDescription].join("\u0001");
    const current = merged.get(key);
    if (!current || preferred(lens, current) < 0) merged.set(key, { ...lens, displayStyle: OWN_LENS_STYLE });
  }
  return [...rest, ...merged.values()].sort((left, right) => String(left.alias).localeCompare(String(right.alias)));
}

function resolveLensAlias(normalizedOrder, catalog) {
  const request = normalizedOrder?.lensRequest || {};
  // Coatings are separate RX items. They must not influence a lens-alias match
  // (for example, a blue-blocker coating must not select a blue lens option).
  const description = normalize([request.lensType, request.design, request.material, request.option].filter(Boolean).join(" "));
  const expectsPhotochromic = PHOTOCHROMIC.test(description);
  const requestedColor = colorFrom(request.option) || (expectsPhotochromic ? "gray" : "srcoated");
  const material = materialFrom(request.material || description);
  const type = typeFrom([request.lensType, request.design].filter(Boolean).join(" "));
  const ranked = (Array.isArray(catalog) ? catalog : [])
    .filter(isActiveCompatibleLens)
    .filter((lens) => matchesRequestedLens(lens, { expectsPhotochromic, requestedColor, material, type }))
    .map((lens) => ({ lens, score: scoreLens(lens, { description, expectsPhotochromic, requestedColor, material, type }) }))
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

// Best-effort prefill for the review form. Unlike resolveLensAlias it never
// filters on the extracted wording, so any partial signal yields the closest
// active group-1 lens; the employee confirms or corrects all three choices.
function guessLens(lensRequest, catalog) {
  const request = lensRequest || {};
  const description = normalize([request.lensType, request.design, request.material, request.option].filter(Boolean).join(" "));
  if (!description) return null;
  const expectsPhotochromic = PHOTOCHROMIC.test(description);
  const expected = {
    description,
    expectsPhotochromic,
    requestedColor: colorFrom(request.option) || (expectsPhotochromic ? "gray" : "srcoated"),
    material: materialFrom(request.material || description),
    type: typeFrom([request.lensType, request.design].filter(Boolean).join(" "))
  };
  const best = (Array.isArray(catalog) ? catalog : [])
    .filter((lens) => isActiveCompatibleLens(lens) && String(lens.materialGroupCode || "1") === "1")
    .map((lens) => ({ lens, score: scoreLens(lens, expected) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || String(left.lens.alias).localeCompare(String(right.lens.alias)))[0];
  if (!best) return null;
  return {
    alias: String(best.lens.alias),
    material: best.lens.materialDescription || null,
    lensType: best.lens.mfType || best.lens.category || null,
    style: best.lens.displayStyle || best.lens.styleDescription || null,
    option: best.lens.colorDescription || null
  };
}

function scoreLens(lens, expected) {
  const source = normalize([lens.mfType, lens.category, lens.materialDescription, lens.styleDescription, lens.colorDescription].filter(Boolean).join(" "));
  let score = 0;
  if (expected.type) score += source.includes(expected.type) ? 22 : -14;
  if (expected.material) score += source.includes(expected.material) ? 14 : -4;
  if (expected.expectsPhotochromic) score += PHOTOCHROMIC.test(source) ? 12 : -18;
  if (expected.requestedColor) score += source.includes(expected.requestedColor) ? 12 : -5;
  if (!expected.expectsPhotochromic && expected.requestedColor === "srcoated" && /\bclear\b/.test(source)) score += 5;
  if (/transition/.test(expected.description) && /\btrans\b|transition/.test(source)) score += 6;
  if (!expected.expectsPhotochromic && PHOTOCHROMIC.test(source)) score -= 3;
  if (!/polar/.test(expected.description) && /polar/.test(source)) score -= 3;
  // Most jobs here are lenses the customer sends in to be cut, so for an
  // otherwise equal match the customer-supplied ("Custom Lens") alias wins;
  // wording that says so on the prescription makes it decisive.
  if (lens.customerSupplied) score += OWN_LENSES.test(expected.description) ? 30 : 8;
  const segment = /\b(?:ft|flat top|d seg|round|rd)\s?(\d{2})\b/.exec(expected.description)?.[1];
  if (segment) score += new RegExp(`\\b${segment}\\b`).test(normalize(lens.styleDescription)) ? 4 : -2;
  for (const token of tokenList(expected.description)) if (source.includes(token) && token.length > 3) score += 1;
  return score;
}

function isActiveCompatibleLens(lens) {
  return lens && lens.active !== false && /^\d{13}$/.test(String(lens.alias || ""));
}

function matchesRequestedLens(lens, expected) {
  const source = normalize([lens.mfType, lens.category, lens.materialDescription, lens.styleDescription, lens.colorDescription].filter(Boolean).join(" "));
  if (expected.type && !source.includes(expected.type)) return false;
  if (expected.material && !source.includes(expected.material)) return false;
  if (expected.expectsPhotochromic && !PHOTOCHROMIC.test(source)) return false;
  if (expected.requestedColor && !source.includes(expected.requestedColor)) return false;
  return true;
}

function publicLens(lens) {
  return {
    alias: String(lens.alias),
    material: lens.materialDescription || null,
    design: lens.styleDescription || null,
    color: lens.colorDescription || null,
    type: lens.mfType || lens.category || null,
    label: [lens.mfType || lens.category, lens.materialDescription, lens.styleDescription, lens.colorDescription].filter(Boolean).join(" · ")
  };
}

function suggestionReason(expected) {
  const details = [];
  if (expected.type) details.push(expected.type);
  if (expected.material) details.push(expected.material);
  if (expected.expectsPhotochromic) details.push(`photochromic ${expected.requestedColor}`);
  if (expected.requestedColor && !expected.expectsPhotochromic) details.push(expected.requestedColor === "srcoated" ? "clear / SR-coated default" : expected.requestedColor);
  return `Showing active catalogue choices matching ${details.join(", ") || "the reviewed lens details"}. Select the described lens to fill its exact alias.`;
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
  // Catalogue materials carry their index ("Poly 1.59", "Trivex 1.53", "Plastic 1.50").
  if (/polycarbonate|\bpoly\b|\bpc\b/.test(normalized)) return "1.59";
  if (/trivex/.test(normalized)) return "1.53";
  if (/\bcr ?39\b|hard resin|\bplastic\b/.test(normalized)) return "1.50";
  return null;
}

function typeFrom(value) {
  const normalized = normalize(value);
  if (/single vision|\bsv\b/.test(normalized)) return "single vision";
  if (/progressive|multifocal|\bpal\b/.test(normalized)) return "progressive";
  if (/trifocal|\bft ?7 ?x|\b7x\d{2}\b/.test(normalized)) return "trifocal";
  if (/bifocal|\bft ?\d{2}\b|flat top|\bd seg|executive|round seg/.test(normalized)) return "bifocal";
  return null;
}

function colorFrom(value) {
  const normalized = normalize(value).replace(/\bgrey\b/g, "gray");
  return ["gray", "brown", "green", "blue", "pink", "purple", "yellow", "clear"].find((color) => new RegExp(`\\b${color}\\b`).test(normalized)) || null;
}

module.exports = { OWN_LENS_STYLE, guessLens, mergeOwnLensStyles, resolveLensAlias };
