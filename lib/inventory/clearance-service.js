"use strict";

// Read-only clearance projection. It never changes recommendations or source stock.
const { loadInventoryEvidence, loadLensIdentities, MAX_ROWS } = require("./source-adapter");
const { listRecommendations } = require("./recommendations-service");
const { listActiveSettings } = require("./settings-service");
const { getLatestCounts } = require("./count-service");
const { loadPolicy } = require("./policy");
const { evaluateConfidence } = require("./confidence");
const { calculateItemReplenishment } = require("./calculator");
const { unavailable } = require("./errors");

const REFRESH_MS = 24 * 60 * 60 * 1000;
// Owner-confirmed convention: the numeric LensItem.Cost is USD PER PAIR,
// despite its source field being presented as BBD PER LENS. Do not write it back.
function clearancePrice(pairCostUsd, unit = "each") {
  if (typeof pairCostUsd !== "number" || !Number.isFinite(pairCostUsd) || pairCostUsd <= 0) return null;
  const cents = Math.round((pairCostUsd * 266 / (unit === "pairs" ? 1 : 2)) + 1e-8);
  return Number.isSafeInteger(cents) && cents > 0 ? cents / 100 : null;
}

function reviewCandidates({ candidates, evidence, settings = new Map(), counts = new Map(), policy, now = Date.now() }) {
  if (evidence.truncated) throw unavailable("The inventory read was incomplete. No clearance catalogue was refreshed.", "INCOMPLETE_SOURCE");
  const live = new Map(evidence.items.map(item => [item.itemId, item]));
  const eligible = [];
  const exclusions = { noCurrentStock: 0, noLongerWriteOff: 0, invalidCost: 0 };
  for (const itemId of new Set(candidates)) {
    const item = live.get(itemId);
    if (!item || !Number.isFinite(item.onHand) || item.onHand <= 0) { exclusions.noCurrentStock++; continue; }
    const setting = settings.get(itemId) || null;
    const count = counts.get(itemId);
    const confidence = evaluateConfidence({
      ...item, settings: setting,
      stockFreshnessDays: count ? Math.max(0, Math.floor((now - new Date(count.countedAt).getTime()) / 86400000)) : item.stockFreshnessDays,
      lastVerifiedCountDate: count ? count.countedAt : item.lastVerifiedCountDate
    }, { confidenceThreshold: policy.confidenceThreshold });
    const calculation = calculateItemReplenishment({ ...item, settings: setting, confidence, policyOverrides: policy });
    if (calculation.recommendationType !== "WRITE_OFF_REVIEW") { exclusions.noLongerWriteOff++; continue; }
    const priceBbd = clearancePrice(item.unitCost);
    if (priceBbd == null) { exclusions.invalidCost++; continue; }
    eligible.push({ itemId, skuRight: item.skuRight || "", skuLeft: item.skuLeft || "", stock: item.stock || null, sku: item.sku || "", description: item.itemLabel, quantity: item.onHand, priceBbd, pairPriceBbd: clearancePrice(item.unitCost, "pairs") });
  }
  return { eligible, exclusions, candidatesReviewed: new Set(candidates).size };
}

// Explicit allowlist: no source costs, supplier ids, usage, internal keys or review notes.
function saleProjection(review, identities, asOf) {
  let missingIdentity = 0, noSaleUnits = 0;
  const items = review.eligible.flatMap(item => {
    const identity = identities[item.itemId];
    if (!identity || !identity.familyName || !identity.name || !identity.materialName || !identity.manufacturerName || !identity.lensTypeName || !identity.optionName) {
      missingIdentity++; return [];
    }
    const family = identity.familyName.trim();
    const singleVision = /^single vision$/i.test(family);
    const multifocal = /^(progressive|bifocal|trifocal|double segs)$/i.test(family);
    if (!singleVision && !multifocal) { missingIdentity++; return []; }
    const stock = item.stock;
    if (!stock || ["right","left","pairs"].some(key => !Number.isInteger(stock[key]) || stock[key] < 0)) {
      noSaleUnits++; return [];
    }
    const unit = singleVision ? "each" : "pairs";
    const quantity = singleVision ? stock.right + stock.left + 2 * stock.pairs : stock.pairs + Math.min(stock.right, stock.left);
    if (!quantity) { noSaleUnits++; return []; }
    if (![identity.base, identity.addPower, identity.diameter].every(value => typeof value === "number" && Number.isFinite(value))) {
      missingIdentity++; return [];
    }
    return [{
      sku: item.sku, skuRight: item.skuRight, skuLeft: item.skuLeft,
      description: item.description, name: identity.name,
      material: identity.materialName, manufacturer: identity.manufacturerName, family,
      design: identity.lensTypeName, option: identity.optionName,
      diameter: identity.diameter, base: identity.base, addPower: identity.addPower,
      verticalAxis: singleVision ? "Sphere" : "Base curve",
      horizontalAxis: singleVision ? "Cylinder" : "Add",
      unit, quantity, priceBbd: singleVision ? item.priceBbd : item.pairPriceBbd
    }];
  }).sort((a, b) => a.name.localeCompare(b.name) || a.sku.localeCompare(b.sku));
  return {
    currency: "BBD", asOf,
    expiresAt: new Date(new Date(asOf).getTime() + REFRESH_MS).toISOString(),
    refreshHours: 24, items,
    totals: {
      skus: items.length,
      eaches: items.filter(item => item.unit === "each").reduce((sum, item) => sum + item.quantity, 0),
      pairs: items.filter(item => item.unit === "pairs").reduce((sum, item) => sum + item.quantity, 0)
    },
    review: { candidatesReviewed: review.candidatesReviewed, exclusions: { ...review.exclusions, missingIdentity, noSaleUnits } }
  };
}
async function buildCatalogue() {
  const candidates = [];
  for (let offset = 0; ; offset += 500) {
    const page = await listRecommendations({ queue: "WRITE_OFF_REVIEW", status: "ACTIVE", limit: 500, offset });
    candidates.push(...page.items.map(item => item.itemId));
    if (offset + page.items.length >= page.total) break;
    if (!page.items.length || candidates.length > 100000) throw unavailable("The review queue could not be read completely.");
  }
  const [evidence, settings, counts, policy] = await Promise.all([
    loadInventoryEvidence({ limit: MAX_ROWS }), listActiveSettings(), getLatestCounts(), loadPolicy()
  ]);
  const review = reviewCandidates({ candidates, evidence, settings, counts, policy });
  const identities = {};
  for (let offset = 0; offset < review.eligible.length; offset += 200) {
    Object.assign(identities, await loadLensIdentities(review.eligible.slice(offset, offset + 200).map(item => item.itemId)));
  }
  return saleProjection(review, identities, evidence.asOf);
}

// Refresh on the first authenticated request after expiry, no installed task.
// An expired snapshot is never returned as current if refresh fails.
function createCatalogueCache(build = buildCatalogue, clock = Date.now) {
  let snapshot = null;
  let pending = null;
  return async function getCatalogue() {
    if (snapshot && clock() < new Date(snapshot.expiresAt).getTime()) return snapshot;
    if (!pending) pending = Promise.resolve().then(build).then(result => { snapshot = result; return result; }).finally(() => { pending = null; });
    return pending;
  };
}
const getClearanceCatalogue = createCatalogueCache();
module.exports = { REFRESH_MS, clearancePrice, reviewCandidates, saleProjection, buildCatalogue, createCatalogueCache, getClearanceCatalogue };
