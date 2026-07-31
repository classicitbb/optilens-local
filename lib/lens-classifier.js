/**
 * lens-classifier.js — SINGLE SOURCE OF TRUTH for lens classification.
 *
 * Both the static Excel importer (build-data.js) and the live pulls
 * (optilens-connector.js / cv-api-connector.js) require this module, so the
 * static export and the live API always reuse exactly the same mapping.
 *
 * Keep an identical copy at pricelist-automation/lens-classifier.js.
 * Exports: APPROVED, TIER_MAP, QUOTE_ONLY, normMaterial, normTreatment, tierFor.
 */
'use strict';

// ── Approved suppliers ──────────────────────────────────────────────────────
const APPROVED = [
  // In-house / primary labs
  'TOG Rx Lab', 'Optex Laboratories', 'Vision Rx Lab', 'SkyLab',
  // Conventional houses + finishing labs (added 2026-06-24)
  'Essilor', 'Essilor Lab', 'Hoya', 'East Optical', 'Younger',
  'Shore Lens', 'Lab-Tech', 'Quest Optical', 'IOT America', 'Youli Optics', 'TOG USA',
];

// ── Material normalization ──────────────────────────────────────────────────
// Prefer the Name prefix; fall back to the Material column. null if unrecognized.
function normMaterial(name, materialCol) {
  const src = `${name || ''} ${materialCol || ''}`.toLowerCase();
  if (/\b1\.74\b/.test(src)) return '1.74';
  if (/\b1\.67\b/.test(src)) return '1.67';
  if (/\b1\.60\b|1\.6 /.test(src)) return '1.60';
  if (/\b1\.59/.test(src)) return '1.59';
  if (/trivex|1\.53/.test(src)) return 'TRIVEX';
  if (/\bpoly\b|polycarb/.test(src)) return 'POLY';
  if (/1\.565|1\.56\b/.test(src)) return '1.56';
  if (/\bglass\b/.test(src)) return 'GLASS';
  if (/\b1\.50\b|plastic|photochromic 1\.50|cr-?39/.test(src)) return '1.50';
  return null;
}

// ── Treatment (group) classification ────────────────────────────────────────
// Derived from the Name tokens. Order matters (most specific first).
function normTreatment(name) {
  const n = (name || '').toLowerCase();
  const isBrown = /brown|amber/.test(n);
  if (/xtractive/.test(n) && /polar/.test(n)) return 'Trans® XtrActive® Polarized';
  if (/xtractive/.test(n)) return 'Trans® XtrActive® New Gen';
  if (/trans\s*8|tgns|trans\s*gen|trans8/.test(n)) return 'Trans Gen S™';
  if (/drivewear/.test(n)) return 'Polarized';
  if (/polar/.test(n)) return 'Polarized';
  if (/photo/.test(n) || /\bpch\b/.test(n)) return isBrown ? 'Photochromic - Brown' : 'Photochromic - Gray';
  if (/uv\s*420|blue|bluv/.test(n)) return 'UV420';
  if (/sr\s*coat|srcoat|\buc\b|\bhc\b|\bhmc\b|clear|coated/.test(n)) return 'Clear';
  return 'Clear'; // default: an untreated lens is Clear
}

// ── Strict treatment classification (inventory analytics) ───────────────────
// Same rules as normTreatment, but returns null instead of falling back to
// 'Clear', and knows two brand/finish cases the pricing path never needed.
//
// Why a second function rather than a fix to the first: normTreatment feeds
// pricing (build-data.js, optilens-connector.js, cv-api-connector.js) through
// TIER_MAP, so changing what it returns would silently move lenses between
// price tiers. This one is read-only analytics and can afford to be honest.
//
// The 'Clear' fallback is a real misclassification, not a theoretical one. In
// the live stocked catalogue it files Xperio (Essilor's POLARIZED brand) and
// the mirror finishes as Clear, understating polarized turn.
function normTreatmentStrict(name) {
  const n = (name || '').toLowerCase();
  const isBrown = /brown|amber/.test(n);
  // The catalogue abbreviates heavily: XtrActvNG, Trans SFT, Xpo, Trans Vantge.
  if (/xtractive|xtractv/.test(n) && /polar/.test(n)) return 'Trans® XtrActive® Polarized';
  if (/xtractive|xtractv/.test(n)) return 'Trans® XtrActive® New Gen';
  if (/trans\s*8|tgns|trans\s*gen|trans8/.test(n)) return 'Trans Gen S™';
  // Any remaining "Trans …" is a Transitions photochromic, as is Activations.
  if (/\btrans\b|trans\s*\d|activations/.test(n)) {
    return isBrown ? 'Photochromic - Brown' : 'Photochromic - Gray';
  }
  if (/drivewear|xperio|\bxpo\b/.test(n)) return 'Polarized';
  if (/polar/.test(n)) return 'Polarized';
  // Photochromic wins over blue-blocking: BLUEPRO+PH is both, and which lens to
  // buy is driven by the photochromic, not the blue filter.
  if (/photo|photochromic/.test(n) || /\bpch\b/.test(n) || /\bphot\b/.test(n)
      || /\bphto\b/.test(n) || /\bph\b/.test(n)) {
    return isBrown ? 'Photochromic - Brown' : 'Photochromic - Gray';
  }
  // `blue` stays a loose substring on purpose — the catalogue writes BLUEPRO and
  // BlueGuard unhyphenated, and a \b anchor silently drops 365 stocked items.
  if (/uv\s*420|blue|bluv/.test(n)) return 'UV420';
  if (/mirror|chrome/.test(n)) return 'Mirror';
  if (/gradient/.test(n)) return 'Tinted';
  if (/sr\s*coat|srcoat|crizal|\buc\b|\bunc\b|\buncoated\b|\bhc\b|\bhmc\b|shmc|clear|coated/.test(n)) return 'Clear';
  return null; // unrecognised — surfaced as "Unclassified", never silently Clear
}

// Headline rollup for the Inventory tab: the four groups a buying decision
// actually distinguishes. Sub-treatments stay available on the drill-down.
function treatmentGroup(treatment) {
  if (!treatment) return 'Unclassified';
  if (treatment === 'Clear') return 'Clear';
  if (treatment === 'Polarized') return 'Polarized';
  if (/photochromic|trans/i.test(treatment)) return 'Photochromic';
  return 'Other coatings';
}

// ── Tier (category) classification ──────────────────────────────────────────
// Keyed by `${MF Type}|${Lens Type}`. Anything not here is reported UNMAPPED.
const TIER_MAP = {
  // Progressive
  'Progressive|Endless Steady':   'Progressive - Best',
  'Progressive|Essential Steady': 'Progressive - Better',
  'Progressive|Classic PAL':      'Progressive - Good',
  'Progressive|Endless Offc 1.3m':'Specific Use - Office',
  'Progressive|Endless Office':   'Specific Use - Office',
  'Progressive|Reader II':        'Specific Use - Office',
  'Progressive|Endless Plus':     'Anti-Fatigue',
  'Progressive|Endless Plus - Antifatigue': 'Anti-Fatigue',
  'Progressive|AcomodaII':        'Anti-Fatigue',
  'Progressive|Endless Sport':    'Specific Use - Sport',
  // Single Vision
  'Single Vision|Endless SV':     'Single Vision - HD',
  'Single Vision|Camber':         'Single Vision - HD',
  'Single Vision|AntiFatigue':    'Anti-Fatigue',
  'Single Vision|AcomodaII':      'Anti-Fatigue',
  'Single Vision|Endless Plus - Antifatigue': 'Anti-Fatigue',
  'Single Vision|Regular':        'Single Vision - Regular',
  'Single Vision|Classic SV':     'Single Vision - Regular',
  'Single Vision|Pro Regular':    'Single Vision - Regular',
  'Single Vision|NuPolar':        'Single Vision - Regular',
  'Single Vision|Polarized':      'Single Vision - Regular',
  'Progressive|Endless SV':       'Single Vision - HD', // FLAG: MF mislabel (Endless SV is single vision)

  // Conventional progressives → ADEPT (below Good, above Office)
  'Progressive|Physio':           'Progressive - Adept',
  'Progressive|Physio DRx':       'Progressive - Adept',
  'Progressive|Ovation':          'Progressive - Adept',
  'Progressive|Ovation Digital':  'Progressive - Adept',
  'Progressive|Shoreview ES':     'Progressive - Adept',
  'Progressive|Shoreview DG':     'Progressive - Adept',
  'Progressive|Ideal':            'Progressive - Adept',
  'Progressive|QLDS iLux S':      'Progressive - Adept',
  'Progressive|QLDS Omnilux':     'Progressive - Adept',
  'Progressive|Image':            'Progressive - Adept',
  'Progressive|Accolade':         'Progressive - Adept',
  'Progressive|Small Fit':        'Progressive - Adept',
  'Progressive|Brilliance':       'Progressive - Adept',
  'Progressive|Comfort 2':        'Progressive - Adept',
  'Progressive|Comfort2DRx':      'Progressive - Adept',
  'Progressive|Precise':          'Progressive - Adept',
  'Progressive|Novel':            'Progressive - Adept',
  'Progressive|Novel Coppertone': 'Progressive - Adept',
  'Progressive|Eyezen+ 0':        'Progressive - Adept', // FLAG: Essilor digital — confirm Adept vs Anti-Fatigue
  'Progressive|Ideal Sport':      'Specific Use - Sport', // FLAG: routed to Sport

  // Bifocal: only Endless BF Round is digital (Endless); all conventional → Adept Bifocal
  'Bifocal|Endless BF Round':     'Specific Use - Bifocal',
  'Bifocal|Flat Top 28':          'Specific Use - Adept Bifocal',
  'Bifocal|Flat Top 35':          'Specific Use - Adept Bifocal',
  'Bifocal|Round 28':             'Specific Use - Adept Bifocal',
  'Bifocal|Round 24':             'Specific Use - Adept Bifocal',
  'Bifocal|Round 22':             'Specific Use - Adept Bifocal',
  'Bifocal|C25':                  'Specific Use - Adept Bifocal',
  'Bifocal|C28':                  'Specific Use - Adept Bifocal',
  'Bifocal|D45':                  'Specific Use - Adept Bifocal',
  'Bifocal|Executive':            'Specific Use - Adept Bifocal',
  'Bifocal|Round Seg 24':         'Specific Use - Adept Bifocal',
  'Bifocal|NuPolar FT28':         'Specific Use - Adept Bifocal',
  'Bifocal|Flat Top 7x28':        'Specific Use - Adept Bifocal',
  'Bifocal|Flat Top 28 J':        'Specific Use - Adept Bifocal',
  'Bifocal|Essilor FT28':         'Specific Use - Adept Bifocal',
  'Trifocal|Flat Top 7x28':       'Specific Use - Adept Bifocal',
  'Trifocal|Flat Top 8x35':       'Specific Use - Adept Bifocal',

  // Conventional single vision → SV Regular
  'Single Vision|Single Vision':   'Single Vision - Regular',
  'Single Vision|SingleVision':    'Single Vision - Regular',
  'Single Vision|Free Form':       'Single Vision - Regular',
  'Single Vision|Flat Base':       'Single Vision - Regular',
  'Single Vision|LabTech Asph':    'Single Vision - Regular',
  'Single Vision|Lensco Asph':     'Single Vision - Regular',
  'Single Vision|Asph Thin & Lite':'Single Vision - Regular',
  'Single Vision|Essilor Asph':    'Single Vision - Regular',
  'Single Vision|Shore Aspheric':  'Single Vision - Regular',
  'Single Vision|Shore Select':    'Single Vision - Regular',
  'Single Vision|Shore Select Asph':'Single Vision - Regular',
};

// Kept in the dataset but flagged quote-only — NOT shown in the standard matrix.
const QUOTE_ONLY = new Set([
  'Progressive|Navigator', 'Progressive|Navigator Short', 'Progressive|Amplitude',
  'Progressive|Hrz Adapt', 'Progressive|Individual FF',
  'Lenticular|Lenticular', 'Speciality|Omega',
]);

function tierFor(mf, lt) {
  return TIER_MAP[`${mf}|${lt}`] || null;
}

module.exports = {
  APPROVED, TIER_MAP, QUOTE_ONLY,
  normMaterial, normTreatment, normTreatmentStrict, treatmentGroup, tierFor
};
