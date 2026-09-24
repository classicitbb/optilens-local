// Prescription validation shared by the RX Capture review form (browser) and
// the draft-save endpoint (server). Limits mirror the CV website rx-order form
// and the stricter Innovations submission builder (lib/rx-capture/order-builder.js),
// so a value that would be rejected at submit time is flagged while it is edited.
//
// Two tiers:
//   errors   - the value is invalid or unproducible; saving is blocked.
//   warnings - incomplete or unusual; the draft can still be saved.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RxValidation = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const LIMITS = {
    sphere: { min: -20, max: 18 },
    cylinder: { min: -8, max: 0 },
    add: { min: 0.25, max: 4 },
    monocularPd: { min: 20, max: 45 },
    binocularPd: { min: 40, max: 80 },
    nearPd: { min: 18, max: 45 },
    height: { min: 12, max: 35, progressiveMin: 14 },
    frame: { a: 78, b: 60, ed: 88, dbl: 30 },
    maxBlank: 80
  };
  // Sent in place of blank measurements so an edged job can be submitted
  // before the frame is measured.
  const FRAME_DEFAULTS = { a: 55, b: 45, dbl: 18 };
  const EYES = [["od", "OD", "Od"], ["os", "OS", "Os"]];
  const BASE_PATTERN = /^(?:BI|BO|BU|BD|IN|OUT|UP|DOWN)$/;

  function str(value) { return value === null || value === undefined ? "" : String(value).trim(); }

  // null when blank, NaN when not a number, otherwise the number. Plano wording
  // counts as 0 so "PL" does not need to be retyped.
  function num(value) {
    const text = str(value).replace(/[−–]/g, "-").replace(",", ".");
    if (!text) return null;
    if (/^(?:pl|pla|plano|sph|bal|balance|neutral|ds)$/i.test(text)) return 0;
    const match = /^([+-]?)\s*(\d*\.?\d+)\s*(?:ds|dc|d|mm)?$/i.exec(text);
    if (!match) return NaN;
    return Number(`${match[1]}${match[2]}`);
  }

  const isQuarter = (n) => Math.abs(n * 4 - Math.round(n * 4)) < 1e-6;
  const fixed = (n, digits = 2) => n.toFixed(digits);
  const signed = (n) => `${n > 0 ? "+" : ""}${fixed(n)}`;
  const normalizeAxis = (n) => { const a = ((Math.round(n) % 180) + 180) % 180; return a === 0 ? 180 : a; };

  // ED estimate used by the CV website rx-order form: sqrt(A^2 + B^2), rounded up to 0.1 mm.
  function edFor(a, b) {
    const width = num(a);
    const height = num(b);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return Math.ceil(Math.sqrt(width * width + height * height) * 10) / 10;
  }

  function lensText(order) {
    return [order?.lensRequest?.lensType, order?.lensRequest?.design].map(str).filter(Boolean).join(" ");
  }
  const isSingleVision = (order) => /\b(?:single[ -]?vision|sv)\b/i.test(lensText(order));
  const isProgressive = (order) => !isSingleVision(order) && /\b(?:progressive|occupational)\b/i.test(lensText(order));
  const isMultifocal = (order) => !isSingleVision(order) && /\b(?:progressive|bifocal|trifocal|multifocal|occupational)\b/i.test(lensText(order));

  // Converts a plus-cylinder eye to the minus-cylinder form Innovations needs:
  // sph' = sph + cyl, cyl' = -cyl, axis' = axis +/- 90 (kept within 1-180).
  function toMinusCylinder(eye) {
    const sphere = num(eye?.sphere);
    const cylinder = num(eye?.cylinder);
    const axis = num(eye?.axis);
    if (!Number.isFinite(sphere) || !Number.isFinite(cylinder) || !Number.isFinite(axis) || cylinder <= 0) return null;
    return {
      sphere: signed(Math.round((sphere + cylinder) * 100) / 100),
      cylinder: signed(-cylinder),
      axis: normalizeAxis(axis + 90)
    };
  }

  // Lossless tidy-up used when a field loses focus: pad decimals and add signs
  // only when doing so does not change the value that was typed.
  function formatField(path, raw) {
    const text = str(raw);
    if (!text) return raw;
    if (/\.base$/.test(path)) return text.toUpperCase();
    const n = num(text);
    if (!Number.isFinite(n)) return raw;
    if (/\.(?:sphere|cylinder)$/.test(path)) return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6 ? signed(n) : raw;
    if (/\.add$/.test(path)) return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6 ? signed(n) : raw;
    if (/\.prism$/.test(path)) return n >= 0 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6 ? fixed(n) : raw;
    if (/^(?:pd\.|frame\.(?:a|b|dbl|ed|segHeight))/.test(path)) return Math.abs(n * 10 - Math.round(n * 10)) < 1e-6 ? fixed(n, 1) : raw;
    return raw;
  }

  function validateOrder(order) {
    const errors = [];
    const warnings = [];
    const error = (path, message, fix) => errors.push({ path, message, ...(fix ? { fix } : {}) });
    const warn = (path, message, fix) => warnings.push({ path, message, ...(fix ? { fix } : {}) });
    const rx = order?.prescription || {};
    const pd = order?.pd || {};
    const frame = order?.frame || {};
    const progressive = isProgressive(order);
    const singleVision = isSingleVision(order);

    const name = str(order?.patient?.name);
    if (name && !/^[A-Za-z][A-Za-z '\-]*(?:,\s*[A-Za-z][A-Za-z '\-]*)?$/.test(name)) {
      warn("patient.name", "Patient name has characters Innovations will reject; use letters, spaces, apostrophes and hyphens (LASTNAME, FIRSTNAME).");
    }

    const spheres = {};
    for (const [side, label, suffix] of EYES) {
      const eye = rx[side] || {};
      const at = (field) => `prescription.${side}.${field}`;

      const sphere = num(eye.sphere);
      spheres[side] = sphere;
      if (Number.isNaN(sphere)) error(at("sphere"), `${label} sphere must be a number such as -2.25, or PL for plano.`);
      else if (sphere !== null && (sphere < LIMITS.sphere.min || sphere > LIMITS.sphere.max)) error(at("sphere"), `${label} sphere ${signed(sphere)} is outside the producible range (${signed(LIMITS.sphere.max)} to ${signed(LIMITS.sphere.min)}).`);
      else if (sphere !== null && !isQuarter(sphere)) error(at("sphere"), `${label} sphere must be in 0.25 steps.`);

      const cylinder = num(eye.cylinder);
      if (Number.isNaN(cylinder)) error(at("cylinder"), `${label} cylinder must be a number such as -1.25.`);
      else if (cylinder !== null && cylinder < LIMITS.cylinder.min) error(at("cylinder"), `${label} cylinder ${signed(cylinder)} is beyond ${signed(LIMITS.cylinder.min)}; it needs a lab consult.`);
      else if (cylinder !== null && !isQuarter(cylinder)) error(at("cylinder"), `${label} cylinder must be in 0.25 steps.`);
      else if (cylinder !== null && cylinder > 0) {
        const converted = toMinusCylinder(eye);
        warn(at("cylinder"), `${label} cylinder is in plus form. Innovations needs minus cylinder${converted ? ` (${converted.sphere} ${converted.cylinder} x ${converted.axis})` : "; enter the axis to convert it"}.`,
          converted ? { type: "minus-cylinder", side, values: converted, label: "Convert to minus cylinder" } : null);
      }
      const hasCylinder = Number.isFinite(cylinder) && cylinder !== 0;

      const axisText = str(eye.axis);
      const axis = axisText === "" ? null : Number(axisText);
      if (axis !== null && (!Number.isInteger(axis) || axis < 1 || axis > 180)) error(at("axis"), `${label} axis must be a whole number from 1 to 180.`);
      else if (hasCylinder && axis === null) warn(at("axis"), `${label} has a cylinder but no axis; the axis is needed before this can be submitted.`);
      else if (axis !== null && Number.isFinite(cylinder) && cylinder === 0) warn(at("axis"), `${label} has an axis but no cylinder. Is the cylinder missing?`);
      else if (axis !== null && cylinder === null) warn(at("axis"), `${label} has an axis but no cylinder. Is the cylinder missing?`);

      const add = num(eye.add);
      if (Number.isNaN(add)) error(at("add"), `${label} ADD must be a number such as +2.00.`);
      else if (add !== null && add <= 0) error(at("add"), `${label} ADD must be a positive power.`);
      else if (add !== null && add > LIMITS.add.max) error(at("add"), `${label} ADD ${signed(add)} is above the maximum ${signed(LIMITS.add.max)} we can produce.`);
      else if (add !== null && !isQuarter(add)) error(at("add"), `${label} ADD must be in 0.25 steps.`);
      else if (add !== null && singleVision) warn(at("add"), `${label} has an ADD but the lens is single vision; the ADD will not be sent.`);
      else if (add === null && isMultifocal(order)) warn(at("add"), `${label} ADD is needed for this lens type.`);

      const prism = num(eye.prism);
      const base = str(eye.base).toUpperCase();
      if (Number.isNaN(prism) || (prism !== null && prism < 0)) error(at("prism"), `${label} prism must be a positive number of prism dioptres.`);
      else if (prism !== null && prism > 0 && !base) warn(at("base"), `${label} prism needs a base direction (BI, BO, BU, BD or degrees).`);
      else if (!prism && base) warn(at("prism"), `${label} has a base direction but no prism amount.`);
      if (base && !BASE_PATTERN.test(base) && !(/^\d{1,3}$/.test(base) && Number(base) <= 360)) warn(at("base"), `${label} base "${base}" is not recognised; use BI, BO, BU, BD or degrees.`);

      const height = num(frame[`segHeight${suffix}`]);
      const heightPath = `frame.segHeight${suffix}`;
      if (Number.isNaN(height)) error(heightPath, `${label} OC height must be a number of millimetres.`);
      else if (height !== null && (height <= 0 || height > LIMITS.height.max)) error(heightPath, `${label} OC height ${fixed(height, 1)} mm is outside 0-${LIMITS.height.max} mm.`);
      else if (height !== null && progressive && height < LIMITS.height.progressiveMin) error(heightPath, `${label} fitting height ${fixed(height, 1)} mm; progressives cannot be cut below ${LIMITS.height.progressiveMin} mm.`);
      else if (height !== null && height < LIMITS.height.min && isMultifocal(order)) warn(heightPath, `${label} fitting height ${fixed(height, 1)} mm is very low; check the measurement.`);
      else if (height === null && isMultifocal(order) && frame.status !== "UNCUT") warn(heightPath, `${label} fitting height is needed for this lens type.`);

      const distance = num(pd[side]);
      if (Number.isNaN(distance)) error(`pd.${side}`, `${label} distance PD must be a number of millimetres.`);
      else if (distance !== null && (distance < LIMITS.monocularPd.min || distance > LIMITS.monocularPd.max)) {
        error(`pd.${side}`, `${label} PD ${fixed(distance, 1)} mm is outside ${LIMITS.monocularPd.min}-${LIMITS.monocularPd.max} mm per eye${distance > LIMITS.monocularPd.max ? "; a value this wide is likely a binocular PD, which belongs in Binocular PD" : ""}.`);
      }
      const near = num(pd[side === "od" ? "nearOd" : "nearOs"]);
      const nearPath = `pd.${side === "od" ? "nearOd" : "nearOs"}`;
      if (Number.isNaN(near)) error(nearPath, `${label} near PD must be a number of millimetres.`);
      else if (near !== null && (near < LIMITS.nearPd.min || near > LIMITS.nearPd.max)) error(nearPath, `${label} near PD ${fixed(near, 1)} mm is outside ${LIMITS.nearPd.min}-${LIMITS.nearPd.max} mm.`);
      else if (near !== null && Number.isFinite(distance) && near > distance) error(nearPath, `${label} near PD is wider than the distance PD; check the measurement.`);
    }

    const binocular = num(pd.binocular);
    if (Number.isNaN(binocular)) error("pd.binocular", "Binocular PD must be a number of millimetres.");
    else if (binocular !== null && (binocular < LIMITS.binocularPd.min || binocular > LIMITS.binocularPd.max)) error("pd.binocular", `Binocular PD ${fixed(binocular, 1)} mm is outside ${LIMITS.binocularPd.min}-${LIMITS.binocularPd.max} mm.`);
    const od = num(pd.od);
    const os = num(pd.os);
    if (Number.isFinite(binocular) && Number.isFinite(od) && Number.isFinite(os) && Math.abs(od + os - binocular) > 1) {
      warn("pd.binocular", `OD + OS PD (${fixed(od + os, 1)} mm) does not match the binocular PD (${fixed(binocular, 1)} mm); the distance PDs are the ones submitted.`);
    }

    if (Number.isFinite(spheres.od) && Number.isFinite(spheres.os) && spheres.od * spheres.os < 0) {
      warn("prescription.os.sphere", `Right eye is ${signed(spheres.od)} and left is ${signed(spheres.os)}: opposing signs. Unusual but possible; confirm it matches the prescription.`);
    }

    const box = {};
    for (const [key, max] of Object.entries(LIMITS.frame)) {
      const value = num(frame[key]);
      box[key] = value;
      const label = key.toUpperCase();
      if (Number.isNaN(value)) error(`frame.${key}`, `Frame ${label} must be a number of millimetres.`);
      else if (value !== null && value <= 0) error(`frame.${key}`, `Frame ${label} must be greater than zero.`);
      else if (value !== null && value > max) error(`frame.${key}`, `Frame ${label} ${fixed(value, 1)} mm is over the ${max} mm maximum we can cut.`);
    }
    if (Number.isFinite(box.ed) && Number.isFinite(box.a) && Number.isFinite(box.b) && box.ed < Math.max(box.a, box.b)) {
      error("frame.ed", `Frame ED ${fixed(box.ed, 1)} mm cannot be smaller than the larger of A and B (${fixed(Math.max(box.a, box.b), 1)} mm).`);
    }
    if (frame.status === "MEASURED") {
      const missing = ["a", "b", "dbl"].filter((key) => box[key] === null);
      if (missing.length) warn(`frame.${missing[0]}`, `Frame workflow says measurements are available, but ${missing.map((key) => key.toUpperCase()).join(", ")} ${missing.length > 1 ? "are" : "is"} blank; the default${missing.length > 1 ? "s" : ""} (${missing.map((key) => `${key.toUpperCase()} ${FRAME_DEFAULTS[key]}`).join(", ")}) will be sent.`);
    }
    if (Number.isFinite(box.a) && Number.isFinite(box.dbl) && Number.isFinite(box.ed)) {
      const eyes = Number.isFinite(binocular) ? [binocular / 2] : [od, os].filter(Number.isFinite);
      if (eyes.length) {
        const decentration = Math.abs((box.a + box.dbl) / 2 - Math.min(...eyes));
        const blank = Math.ceil(box.ed + 2 * decentration + 2);
        if (blank > LIMITS.maxBlank) warn("frame.ed", `This frame needs about a ${blank} mm blank (ED + 2 x decentration + 2); the largest blank is ${LIMITS.maxBlank} mm, so it may not be producible.`);
      }
    }

    const printedDesign = str(order?.lensRequest?.design);
    const chosenType = str(order?.lensRequest?.lensType);
    const printedKind = visionKind(printedDesign);
    const chosenKind = visionKind(chosenType);
    if (printedKind && chosenKind && printedKind !== chosenKind) {
      warn("lensRequest.lensType", `The prescription prints "${printedDesign}" but the chosen lens type is "${chosenType}"; confirm they match.`);
    }

    return { errors, warnings };
  }

  function visionKind(value) {
    const text = str(value);
    if (/\b(?:single[ -]?vision|sv)\b/i.test(text)) return "single";
    return /\b(?:progressive|bifocal|trifocal|multifocal|occupational)\b/i.test(text) ? "multifocal" : null;
  }

  return { LIMITS, FRAME_DEFAULTS, edFor, num, formatField, toMinusCylinder, validateOrder, isProgressive, isMultifocal };
});
