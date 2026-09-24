// Voice/text intake for RX Capture, shared by the capture page (browser) and
// the server. It only splits a transcript into labelled pieces for the
// employee to check; it never rewrites or interprets what was said. Values are
// read later by the extractor, which treats these labels as hints only.
//
// A segment starts at the first trigger phrase and runs until the next one.
// Text before the first trigger is Unassigned. Edit TRIGGERS to add house
// shorthand; the UI and server pick the change up without other edits.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RxVoice = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const SEGMENTS = [
    { key: "right", label: "Right eye (OD)" },
    { key: "left", label: "Left eye (OS)" },
    { key: "both", label: "Both eyes (OU)" },
    { key: "measure", label: "Add / PD / heights" },
    { key: "prism", label: "Prism" },
    { key: "lens", label: "Lens" },
    { key: "frame", label: "Frame" },
    { key: "patient", label: "Patient" },
    { key: "instructions", label: "Instructions" },
    { key: "unassigned", label: "Unassigned" }
  ];
  const SEGMENT_KEYS = SEGMENTS.map((segment) => segment.key);

  const TRIGGERS = {
    right: ["right eye", "right", "od", "r"],
    left: ["left eye", "left", "os", "l"],
    both: ["same both", "both eyes", "both", "ou"],
    measure: ["near pd", "fitting height", "add", "pd", "pupil", "height", "seg", "oc"],
    prism: ["prism", "base in", "base out", "base up", "base down", "base"],
    lens: ["single vision", "anti reflective", "lens", "lenses", "material", "index", "poly", "polycarbonate", "trivex", "sv", "progressive", "varifocal", "bifocal", "coating", "ar", "photochromic", "transitions", "trans", "tint"],
    // "supplied", "colour" and "ED" are left out: they also occur in own-lens
    // wording, lens tints and names, and would split those pieces apart.
    frame: ["to follow", "to trace", "frame", "uncut", "model", "dbl"],
    patient: ["patient", "name", "reference", "ref", "job"],
    instructions: ["instructions", "notes", "note", "please", "rush", "urgent"]
  };
  // Lens indices spoken as numbers. A quarter-step value (1.50) is also a
  // power, so it only opens a Lens segment outside the eye and measure pieces.
  const INDEX_NUMBERS = ["1.5", "1.50", "1.53", "1.56", "1.59", "1.6", "1.60", "1.67", "1.74"];
  const EYE_KEYS = new Set(["right", "left", "both"]);
  const EYE_WORDS = new Set(["right", "left", "od", "os", "ou", "both", "r", "l"]);
  // Words that describe an eye value; they never open a segment of their own.
  const EYE_VALUE_WORDS = new Set(["sphere", "sph", "plano", "pl", "cyl", "cylinder", "axis", "x", "add", "plus", "minus", "prism", "base", "pd", "height",
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "fifteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "quarter", "half"]);
  const EYE_ATTACHED = new Set(["prism", "base in", "base out", "base up", "base down", "base"]);
  const PER_EYE_MEASURE = new Set(["pd", "near pd", "height", "fitting height", "seg", "oc"]);
  const CORRECTION_WORDS = ["scratch that", "i mean", "correction", "actually", "sorry", "no"];

  const PHRASES = Object.entries(TRIGGERS)
    .flatMap(([key, phrases]) => phrases.map((phrase) => ({ key, phrase, words: phrase.split(" ") })))
    .sort((left, right) => right.words.length - left.words.length);

  function normalizeWord(raw) {
    return String(raw).toLowerCase().replace(/[−–]/g, "-").replace(/^[^\w+.-]+|[^\w.]+$/g, "").replace(/\.$/, "");
  }

  function tokenize(text) {
    const tokens = [];
    const pattern = /\S+/g;
    let match;
    while ((match = pattern.exec(text))) {
      tokens.push({ raw: match[0], word: normalizeWord(match[0]), start: match.index, end: match.index + match[0].length });
    }
    return tokens;
  }

  function isNumeric(word) {
    return /^[+-]?\d/.test(word);
  }

  function isEyeValue(word) {
    return isNumeric(word) || EYE_VALUE_WORDS.has(word);
  }

  function startsPhrase(tokens, index, text) {
    if (index === 0) return true;
    const previous = tokens[index - 1];
    return /[.,;:!?]$/.test(previous.raw) || /\n/.test(text.slice(previous.end, tokens[index].start));
  }

  // "right"/"left" only open an eye when an eye value follows within four
  // words, before any other eye is named ("that's right, left eye minus one").
  function eyeValueFollows(tokens, index) {
    for (let next = index + 1; next < tokens.length && next <= index + 4; next += 1) {
      const word = tokens[next].word;
      if (word === "eye" || word === "eyes") continue;
      if (EYE_WORDS.has(word)) return false;
      if (isEyeValue(word)) return true;
    }
    return false;
  }

  function matchTrigger(tokens, index, text, current) {
    const word = tokens[index].word;
    if (INDEX_NUMBERS.includes(word)) {
      const previous = tokens[index - 1]?.word;
      if (previous === "minus" || previous === "plus" || /^[+-]/.test(tokens[index].raw)) return null;
      const quarterStep = Number.isInteger(Number(word) * 4);
      if (quarterStep && (EYE_KEYS.has(current.key) || current.key === "measure")) return null;
      return { key: "lens", length: 1 };
    }
    for (const candidate of PHRASES) {
      const length = candidate.words.length;
      if (index + length > tokens.length) continue;
      if (!candidate.words.every((part, offset) => tokens[index + offset].word === part)) continue;
      if (candidate.key === "right" || candidate.key === "left") {
        if (candidate.phrase.length === 1 && !startsPhrase(tokens, index, text)) continue;
        if (!["od", "os"].includes(candidate.phrase) && !eyeValueFollows(tokens, index + length - 1)) continue;
      }
      if (EYE_KEYS.has(current.key)) {
        // Prism, and PD or heights named straight after the eye, belong to that eye.
        if (EYE_ATTACHED.has(candidate.phrase)) return { key: current.key, length, attached: true };
        if (PER_EYE_MEASURE.has(candidate.phrase) && !current.hasNumber) return { key: current.key, length, attached: true };
      }
      return { key: candidate.key, length };
    }
    return null;
  }

  // Returns the pieces in spoken order: [{ key, text }]. Joining every piece's
  // text with single spaces reproduces the transcript's words exactly.
  function splitTranscript(text) {
    const source = String(text || "");
    const tokens = tokenize(source);
    const pieces = [];
    let current = { key: "unassigned", start: 0, hasNumber: false };
    const close = (end) => {
      const piece = source.slice(current.start, end).trim();
      if (piece) pieces.push({ key: current.key, text: piece });
    };
    for (let index = 0; index < tokens.length; index += 1) {
      const trigger = matchTrigger(tokens, index, source, current);
      // A trigger for the segment already open ("lens … 1.67") continues it.
      if (trigger && !trigger.attached && trigger.key !== current.key) {
        close(tokens[index].start);
        current = { key: trigger.key, start: tokens[index].start, hasNumber: false };
      }
      if (trigger) index += trigger.length - 1;
      if (isNumeric(tokens[index].word)) current.hasNumber = true;
    }
    close(source.length);
    return pieces;
  }

  // Groups pieces into one entry per segment, appending to what is already
  // there. A new clip never carries on the previous clip's segment.
  function mergeIntoSegments(existing, pieces) {
    const merged = Object.fromEntries(SEGMENT_KEYS.map((key) => [key, String(existing?.[key] || "")]));
    for (const piece of pieces) {
      const key = SEGMENT_KEYS.includes(piece.key) ? piece.key : "unassigned";
      merged[key] = merged[key] ? `${merged[key]}\n${piece.text}` : piece.text;
    }
    return merged;
  }

  function correctionWords(text) {
    const words = tokenize(String(text || "")).map((token) => token.word).join(" ");
    return CORRECTION_WORDS.filter((phrase) => new RegExp(`(?:^| )${phrase}(?: |$)`).test(words));
  }

  // The extractor input: labelled segments in a fixed order.
  function segmentsToText(segments) {
    return SEGMENTS
      .map(({ key, label }) => ({ label, text: String(segments?.[key] || "").trim() }))
      .filter((segment) => segment.text)
      .map((segment) => `[${segment.label}]\n${segment.text}`)
      .join("\n\n");
  }

  function cleanSegments(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return Object.fromEntries(SEGMENT_KEYS.map((key) => [key, String(source[key] ?? "").replace(/\r\n?/g, "\n").trim().slice(0, 4000)]));
  }

  return { SEGMENTS, SEGMENT_KEYS, TRIGGERS, CORRECTION_WORDS, splitTranscript, mergeIntoSegments, correctionWords, segmentsToText, cleanSegments, tokenize };
});
