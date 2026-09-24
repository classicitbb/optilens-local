// Deterministic checks applied to a text (voice or typed) extraction. The model
// proposes values with the verbatim words that produced them; this code decides
// which values stay trusted. Anything that fails becomes an uncertain field with
// a reason the review form shows next to it.
const { OPTICAL_FIELDS, valueAtPath } = require("./normalized-order");

const SIGNED_POWER = /^prescription\.(?:od|os)\.(?:sphere|cylinder)$/;
// Fields whose value is always a default, not something the speaker said.
const NOT_SPOKEN = new Set(["frame.status", "frame.supplied", "frame.mounting", "lensRequest.materialGroup", "lensRequest.style", "lensRequest.coatingSku", "lensRequest.catalogAlias"]);

// Both sides of an evidence check are compared in this form, so "-2.50",
// "−2.5" and "minus 2.50" all match.
function normalizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[−–—]/g, "-")
    .replace(/\bminus\s*/g, "-")
    .replace(/\bplus\s*/g, "+")
    .replace(/([+-])\s+(?=\d)/g, "$1")
    .replace(/(\d)\.(\d*?)0+\b/g, (_match, whole, fraction) => (fraction ? `${whole}.${fraction}` : whole))
    .replace(/[,;:!?"'()[\]]/g, " ")
    .replace(/\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function spokenSign(text) {
  const normalized = normalizeForMatch(text);
  if (/(?:^| )(?:plano|pl|piano|0|0\.0*|zero)(?: |$)/.test(normalized)) return "plano";
  return /(?:^| )[+-]\d|(?:^| )[+-](?: |$)/.test(normalized) ? "signed" : null;
}

function numbersIn(text) {
  return (normalizeForMatch(text).match(/[+-]?\d+(?:\.\d+)?/g) || []).map(Number);
}

function isPlanoValue(value) {
  return /^(?:pl|plano|0|0\.0+|[+-]0\.0+|[+-]0)$/i.test(String(value).trim());
}

function spokenFields(order) {
  return OPTICAL_FIELDS.filter((path) => !NOT_SPOKEN.has(path) && valueAtPath(order, path) !== null && valueAtPath(order, path) !== undefined);
}

// order: normalized extraction; evidence: [{ field, text }]; sourceText: the
// submitted transcript. Returns { uncertainFields, flags } to merge in.
function applyVoiceRules(order, evidence, sourceText) {
  const source = normalizeForMatch(sourceText);
  const byField = new Map();
  for (const item of Array.isArray(evidence) ? evidence : []) {
    const field = String(item?.field || "");
    const text = String(item?.text || "").trim();
    if (!OPTICAL_FIELDS.includes(field) || !text) continue;
    if (!byField.has(field)) byField.set(field, []);
    byField.get(field).push(text);
  }

  const flags = {};
  const flag = (path, reason, quoted) => {
    if (!flags[path]) flags[path] = { reason, evidence: quoted || null };
  };

  for (const path of spokenFields(order)) {
    const value = valueAtPath(order, path);
    const quotes = byField.get(path) || [];
    if (!quotes.length) {
      flag(path, "No spoken words support this value");
      continue;
    }
    const missing = quotes.find((quote) => !source.includes(normalizeForMatch(quote)));
    if (missing) {
      flag(path, "The quoted words are not in the transcript", missing);
      continue;
    }
    if (typeof value === "number" || /^[+-]?\d/.test(String(value))) {
      const distinct = [...new Set(quotes.map((quote) => numbersIn(quote).map((number) => Math.abs(number)).join("/")).filter(Boolean))];
      if (distinct.length > 1) {
        flag(path, "Two different values were spoken", quotes.join(" / "));
        continue;
      }
    }
    if (SIGNED_POWER.test(path) && !isPlanoValue(value)) {
      if (!/^[+-]/.test(String(value).trim()) || !quotes.some((quote) => spokenSign(quote))) {
        flag(path, "No plus or minus was spoken", quotes[0]);
      }
    }
  }

  return { uncertainFields: Object.keys(flags), flags };
}

// A customer named in the dictation that is not the selected one. The note is
// informational: the selected customer is never changed by voice.
function customerMismatch(spokenCustomer, customer) {
  const spoken = comparable(spokenCustomer);
  if (!spoken || !customer) return null;
  const name = comparable(customer.name);
  const account = comparable(customer.account);
  if (name && (name.includes(spoken) || spoken.includes(name))) return null;
  if (account && spoken.split(" ").includes(account)) return null;
  const spokenWords = spoken.split(" ").filter((word) => word.length > 2);
  if (spokenWords.length && spokenWords.every((word) => name.split(" ").includes(word))) return null;
  return `The dictation mentions "${String(spokenCustomer).trim().slice(0, 120)}", but this order is for ${customer.name}.`;
}

function comparable(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(?:the|ltd|limited|inc|optical|opticians?|eye ?care|vision)\b/g, " ").replace(/\s+/g, " ").trim();
}

module.exports = { applyVoiceRules, customerMismatch, normalizeForMatch, spokenSign };
