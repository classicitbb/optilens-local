const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  emptyNormalizedOrder,
  extractionJsonSchema,
  normalizeOpticalOrder,
  unresolvedFields
} = require("../lib/rx-capture/normalized-order");
const { extractPrescriptionFromImages, loadRxAiConfig } = require("../lib/rx-capture/openai-extractor");
const { applyLensGuess, parseImages, publicOrder, resolutionDefaults } = require("../lib/rx-capture/service");
const { guessLens, resolveLensAlias } = require("../lib/rx-capture/alias-resolver");

test("normalizes optical order values without inventing prescription data", () => {
  const order = normalizeOpticalOrder({
    patient: { name: "  HUNTE, RUSSELL  " },
    prescription: {
      od: { sphere: "-5.50", cylinder: "-1.25", axis: "30" },
      os: { sphere: "-5.50", cylinder: "-1.25", axis: 181 }
    },
    pd: { od: 33, os: 33 },
    missingFields: ["prescription.os.axis", "made.up"],
    uncertainFields: ["prescription.od.cylinder", "prescription.od.cylinder"]
  });

  assert.equal(order.patient.name, "HUNTE, RUSSELL");
  assert.equal(order.prescription.od.axis, 30);
  assert.equal(order.prescription.os.axis, null);
  assert.equal(order.pd.od, "33");
  assert.deepEqual(order.missingFields, ["prescription.os.axis"]);
  assert.deepEqual(order.uncertainFields, ["prescription.od.cylinder"]);
  assert.equal(order.prescription.od.add, null);
});

test("normalizes unpunctuated patient names to last-name-first", () => {
  const order = normalizeOpticalOrder({ patient: { name: "Jordan Alexis Smith" } });
  assert.equal(order.patient.name, "Smith, Jordan Alexis");
  assert.equal(normalizeOpticalOrder({ patient: { name: "Smith, Jordan Alexis" } }).patient.name, "Smith, Jordan Alexis");
});

test("lens alias resolution defaults unspecified photochromic color to gray and clear to SR-coated", () => {
  const catalog = [
    { alias: "0000000000001", mfType: "Single Vision", materialDescription: "Photochromic 1.56", styleDescription: "Regular", colorDescription: "Gray SRC" },
    { alias: "0000000000002", mfType: "Single Vision", materialDescription: "Photochromic 1.56", styleDescription: "Regular", colorDescription: "Brown SRC" },
    { alias: "0000000000003", mfType: "Single Vision", materialDescription: "Plastic 1.56", styleDescription: "Regular", colorDescription: "SRCoated" },
    { alias: "0000000000004", mfType: "Single Vision", materialDescription: "Plastic 1.56", styleDescription: "Regular", colorDescription: "Clear AR" }
  ];
  const transitions = resolveLensAlias({ lensRequest: { lensType: "Single Vision", material: "1.56", option: "Transitions" } }, catalog);
  const clear = resolveLensAlias({ lensRequest: { lensType: "Single Vision", material: "1.56" } }, catalog);
  assert.equal(transitions.suggestedAlias, "0000000000001");
  assert.equal(clear.suggestedAlias, "0000000000003");
});

test("lens alias candidates exclude inactive records and never treat a coating as a lens option", () => {
  const catalog = [
    { alias: "0000000000001", mfType: "Progressive", materialDescription: "Plastic 1.50", styleDescription: "Progressive", colorDescription: "SRCoated", active: true },
    { alias: "0000000000002", mfType: "Progressive", materialDescription: "Plastic 1.50", styleDescription: "Progressive", colorDescription: "Blue", active: false },
    { alias: "0000000000003", mfType: "Single Vision", materialDescription: "Plastic 1.50", styleDescription: "Single Vision", colorDescription: "Blue", active: true }
  ];
  const result = resolveLensAlias({ lensRequest: { lensType: "Multifocal", design: "Progressive", material: "1.50", option: "", coating: "Blue Blocker" } }, catalog);
  assert.deepEqual(result.candidates.map((candidate) => candidate.alias), ["0000000000001"]);
  assert.match(result.candidates[0].label, /Progressive.*Plastic 1\.50.*SRCoated/);
});

test("lens guess always proposes the closest active group-1 lens from partial wording", () => {
  const catalog = [
    { alias: "0000000100000", materialGroupCode: "1", mfType: "Single Vision", materialDescription: "Plastic 1.50", styleDescription: "Regular", colorDescription: "UNCoated" },
    { alias: "0010002800096", materialGroupCode: "1", mfType: "Bifocal", materialDescription: "Poly 1.59", styleDescription: "Flat Top 28", colorDescription: "XtrActive Gray" },
    { alias: "0010002800001", materialGroupCode: "1", mfType: "Bifocal", materialDescription: "Poly 1.59", styleDescription: "Flat Top 28", colorDescription: "SRCoated" },
    { alias: "2010002800001", materialGroupCode: "2", mfType: "Bifocal", materialDescription: "Glass 1.52", styleDescription: "Flat Top 28", colorDescription: "SRCoated" },
    { alias: "0010002800002", materialGroupCode: "1", mfType: "Bifocal", materialDescription: "Poly 1.59", styleDescription: "Flat Top 28", colorDescription: "Gray SRC", active: false }
  ];
  assert.deepEqual(guessLens({ lensType: "Bifocal", design: "FT28", material: "Polycarbonate", option: "gray transitions" }, catalog), {
    alias: "0010002800096", material: "Poly 1.59", lensType: "Bifocal", style: "Flat Top 28", option: "XtrActive Gray"
  });
  assert.equal(guessLens({ lensType: "Bifocal" }, catalog).option, "SRCoated");
  assert.equal(guessLens({}, catalog), null);
  assert.equal(guessLens({ lensType: "Bifocal" }, catalog.filter((lens) => lens.materialGroupCode === "2")), null);
});

test("customer-supplied Custom Lens aliases are preferred for an otherwise equal guess", () => {
  const stock = { alias: "0000000100001", materialGroupCode: "1", mfType: "Single Vision", materialDescription: "1.67 Index", styleDescription: "Regular", colorDescription: "Trans 7 Gray" };
  const own = { alias: "0000199900700", materialGroupCode: "1", mfType: "Single Vision", materialDescription: "1.67 Index", styleDescription: "Custom Lens", colorDescription: "Trans 7 Gray", customerSupplied: true };
  const progressive = { alias: "0000500000001", materialGroupCode: "1", mfType: "Progressive", materialDescription: "1.67 Index", styleDescription: "Physio", colorDescription: "Trans 7 Gray" };
  assert.equal(guessLens({ lensType: "Single Vision", material: "1.67", option: "Transitions gray" }, [stock, own]).alias, own.alias);
  assert.equal(guessLens({ lensType: "Progressive", material: "1.67", option: "Transitions gray" }, [own, progressive]).alias, progressive.alias);
  const ownPoly = { ...own, alias: "0010199900700", materialDescription: "Poly 1.59" };
  assert.equal(guessLens({ lensType: "Single Vision", material: "1.67", design: "pt own lenses, cut only", option: "gray" }, [stock, ownPoly]).alias, ownPoly.alias);
});

test("the two Innovations Custom Lens spellings merge into one design with combined colours", () => {
  const { mergeOwnLensStyles } = require("../lib/rx-capture/alias-resolver");
  const row = (alias, style, option, extra = {}) => ({ alias, materialGroupCode: "1", mfType: "Single Vision", materialDescription: "Photochromic 1.50", styleDescription: style, colorDescription: option, customerSupplied: true, ...extra });
  const catalog = [
    row("0210199900096", "Custom lens", "XtrActive Gray"),
    row("0210127700096", "Custom Lens", "XtrActive Gray"),
    row("0210199900500", "Custom lens", "Trans 8 Gray"),
    row("0210127700600", "Custom Lens", "Photo Brown"),
    { alias: "0000000100001", materialGroupCode: "1", mfType: "Single Vision", materialDescription: "Plastic 1.50", styleDescription: "Regular", colorDescription: "SRCoated" },
    row("0210300000001", "Custom AllPurp 12", "SRCoated", { customerSupplied: false })
  ];
  const merged = mergeOwnLensStyles(catalog);
  const own = merged.filter((lens) => lens.displayStyle === "Custom Lens");
  assert.deepEqual(own.map((lens) => lens.colorDescription).sort(), ["Photo Brown", "Trans 8 Gray", "XtrActive Gray"]);
  assert.equal(own.find((lens) => lens.colorDescription === "XtrActive Gray").alias, "0210127700096");
  assert.equal(own.find((lens) => lens.colorDescription === "Trans 8 Gray").styleDescription, "Custom lens");
  assert.equal(merged.length, 5);
  assert.equal(guessLens({ lensType: "Single Vision", material: "Photochromic", option: "Trans 8 Gray" }, merged).style, "Custom Lens");
});

test("catalogue sync recognises the Innovations Custom Lens style as customer-supplied", () => {
  const { isCustomerSuppliedLens } = require("../lib/rx-catalog-sync");
  assert.equal(isCustomerSuppliedLens("Custom Lens", "Trans 7 Gray"), true);
  assert.equal(isCustomerSuppliedLens("Flat Top 28", "Custom Lens"), true);
  assert.equal(isCustomerSuppliedLens("Custom AllPurp 12", "SRCoated"), false);
  assert.equal(isCustomerSuppliedLens("Regular", "Custom Gray"), false);
});

test("manual entry creates an empty ready-to-review draft without images or extraction", async () => {
  const { createRxCaptureService } = require("../lib/rx-capture/service");
  const rows = new Map();
  const events = [];
  const pool = {
    request() {
      const params = {};
      const request = {
        input(name, _type, value) { params[name] = value; return request; },
        async query(text) {
          if (/INSERT INTO rx_capture\.orders/.test(text)) {
            rows.set(params.capture_order_id, { ...params, extracted_json: params.draft_json, validated_json: params.draft_json, created_by_user_id: params.created_by_user_id, last_updated_at: params.created_at });
            return { recordset: [] };
          }
          if (/order_events/.test(text)) { events.push(params); return { recordset: [] }; }
          return { recordset: [...rows.values()].filter((row) => row.capture_order_id === params.capture_order_id) };
        }
      };
      return request;
    }
  };
  let scheduled = false;
  const service = createRxCaptureService({ getAppPool: async () => pool, schedule: () => { scheduled = true; }, extractPrescriptionFromImages: async () => { throw new Error("must not extract"); } });
  const actor = { userId: "11111111-1111-1111-1111-111111111111", username: "employee" };
  const order = await service.createOrder({ manual: true, customer: { id: 7, account: "5000150", name: "Anka Optical Broad Street" } }, actor);
  assert.equal(order.status, "READY_FOR_REVIEW");
  assert.equal(scheduled, false);
  assert.equal(order.normalizedOrder.lensGuessed, false);
  assert.equal(order.normalizedOrder.lensRequest.materialGroup, "1");
  assert.equal(order.normalizedOrder.patient.name, null);
  assert.equal(order.customer.account, "5000150");
  assert.equal([...rows.values()][0].source_image_paths_json, undefined);
  assert.ok(events.length >= 1);
});

test("extracted wording stays as evidence while the draft starts from the guessed lens", () => {
  const extracted = normalizeOpticalOrder({ lensRequest: { lensType: "Bifocal", material: "Polycarbonate", option: "Gray" } });
  const draft = applyLensGuess(extracted, { alias: "0010002800096", material: "Poly 1.59", lensType: "Bifocal", style: "Flat Top 28", option: "XtrActive Gray" });
  assert.equal(extracted.lensRequest.material, "Polycarbonate");
  assert.equal(draft.lensRequest.material, "Poly 1.59");
  assert.equal(draft.lensRequest.style, "Flat Top 28");
  assert.equal(draft.lensRequest.catalogAlias, "0010002800096");
  assert.equal(draft.lensRequest.materialGroup, "1");
  assert.equal(draft.lensGuessed, true);
  const unguessed = applyLensGuess(extracted, null);
  assert.equal(unguessed.lensRequest.material, null);
  assert.equal(unguessed.lensGuessed, false);
});

test("submission defaults come from the selected account and frame workflow", () => {
  const existing = { customer_account: "5000150", customer_name: "Anka Optical Broad Street" };
  const normalized = { frame: { status: "TO_BE_TRACED", mounting: "2" }, lensRequest: { catalogAlias: "0010002800096", coatingSku: "A1HDARC" }, instructions: "Rush" };
  const actor = { username: "employee" };
  const defaults = resolutionDefaults({ frameMounting: "3", addonSkus: ["TINT"], customerNumber: "999", shipName: "Other", labNum: "9", customerSequence: "7" }, { existing, normalized, actor, mappedCustomerNumber: null });
  assert.equal(resolutionDefaults({}, { existing, normalized: { ...normalized, frame: { status: "MEASURED" } }, actor }).frameMounting, "2");
  assert.equal(normalizeOpticalOrder({ frame: { mounting: "3" } }).frame.mounting, "3");
  assert.equal(normalizeOpticalOrder({ frame: { mounting: "9" } }).frame.mounting, null);
  assert.deepEqual(defaults, {
    frameMounting: "2", addonSkus: [], customerNumber: "5000150", shipName: "Anka Optical Broad Street", frameMode: "edged",
    coatingSku: "A1HDARC", lensAlias: "0010002800096", remoteOperator: "employee", instructions: "Rush"
  });
  assert.equal(resolutionDefaults({}, { existing, normalized, actor, mappedCustomerNumber: "7000001" }).customerNumber, "7000001");
  assert.equal(resolutionDefaults({}, { existing, normalized: { ...normalized, frame: { status: "UNCUT" } }, actor }).frameMode, "uncut");
});

test("marks only unresolved extracted fields as needing information", () => {
  const order = emptyNormalizedOrder();
  order.patient.name = "Patient One";
  order.prescription.od.sphere = "+0.00";
  order.prescription.os.sphere = "+0.00";
  order.pd.binocular = "66.0";
  order.missingFields = ["patient.name", "prescription.od.axis"];
  order.uncertainFields = ["prescription.os.sphere"];
  const result = unresolvedFields(order);
  assert.deepEqual(result.missingFields, ["prescription.od.axis"]);
  assert.deepEqual(result.uncertainFields, ["prescription.os.sphere"]);
  assert.equal(result.hasIssues, true);
});

test("single-vision blank ADD, prism, and base cells are optional rather than missing", () => {
  const order = emptyNormalizedOrder();
  order.patient.name = "TEST PATIENT";
  order.prescription.od.sphere = "-1.00";
  order.prescription.os.sphere = "-1.25";
  order.pd.binocular = "62";
  order.lensRequest.lensType = "Single Vision Lenses";
  order.missingFields = [
    "prescription.od.add",
    "prescription.os.add",
    "prescription.od.prism",
    "prescription.od.base",
    "prescription.os.prism",
    "prescription.os.base"
  ];

  const result = unresolvedFields(order);
  assert.deepEqual(result.missingFields, []);
  assert.equal(result.hasIssues, false);
});

test("multifocal prescriptions still require ADD while optional prism and base remain blank", () => {
  const order = emptyNormalizedOrder();
  order.patient.name = "TEST PATIENT";
  order.prescription.od.sphere = "+1.00";
  order.prescription.os.sphere = "+1.00";
  order.pd.binocular = "64";
  order.lensRequest.design = "Progressive multifocal";
  order.missingFields = ["prescription.od.prism", "prescription.os.base"];

  const result = unresolvedFields(order);
  assert.deepEqual(result.missingFields, ["prescription.od.add", "prescription.os.add"]);
});

test("an illegible optional field remains uncertain instead of being silently discarded", () => {
  const order = emptyNormalizedOrder();
  order.patient.name = "TEST PATIENT";
  order.prescription.od.sphere = "-1.00";
  order.prescription.os.sphere = "-1.00";
  order.pd.binocular = "60";
  order.lensRequest.lensType = "Single Vision";
  order.uncertainFields = ["prescription.od.add", "prescription.os.prism", "prescription.os.base"];

  const result = unresolvedFields(order);
  assert.deepEqual(result.uncertainFields, order.uncertainFields);
  assert.equal(result.hasIssues, true);
});

test("frame and lens detail omissions stay optional while frame workflow defaults to tracing", () => {
  const order = normalizeOpticalOrder({
    patient: { name: "TEST PATIENT" },
    prescription: { od: { sphere: "-1.00" }, os: { sphere: "-1.00" } },
    pd: { binocular: 62 },
    missingFields: [
      "frame.supplied", "frame.model", "frame.color", "frame.a", "frame.b",
      "frame.dbl", "frame.ed", "frame.segHeightOd", "frame.segHeightOs",
      "lensRequest.design", "lensRequest.option"
    ]
  });

  assert.equal(order.frame.status, "TO_BE_TRACED");
  assert.equal(order.frame.supplied, true);
  assert.deepEqual(unresolvedFields(order).missingFields, []);
});

test("strict extraction schema requires each normalized section", () => {
  const schema = extractionJsonSchema();
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, Object.keys(schema.properties));
  assert.equal(schema.properties.prescription.additionalProperties, false);
  assert.ok(schema.properties.uncertainFields.items.enum.includes("prescription.od.sphere"));
});

test("OpenAI extraction sends images server-side with strict schema and storage disabled", async () => {
  let request;
  const extracted = emptyNormalizedOrder();
  extracted.patient.name = "HUNTE, RUSSELL";
  const result = await extractPrescriptionFromImages([
    { mimeType: "image/jpeg", buffer: Buffer.from("photo") }
  ], {
    config: { apiKey: "server-only-test-key", baseUrl: "https://api.openai.com/v1", model: "vision-test" },
    fetch: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({ output: [{ content: [{ type: "output_text", text: JSON.stringify(extracted) }] }] })
      };
    }
  });

  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.options.headers.authorization, "Bearer server-only-test-key");
  assert.equal(request.body.store, false);
  assert.equal(request.body.text.format.type, "json_schema");
  assert.equal(request.body.text.format.strict, true);
  assert.match(request.body.input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
  assert.equal(result.patient.name, "HUNTE, RUSSELL");
});

test("OpenAI extraction sends a PDF prescription as a file input", async () => {
  let body;
  await extractPrescriptionFromImages([{ mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7") }], {
    config: { apiKey: "server-only-test-key", baseUrl: "https://api.openai.com/v1", model: "vision-test" },
    fetch: async (url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ output_text: JSON.stringify(emptyNormalizedOrder()) }) };
    }
  });
  assert.equal(body.input[0].content[1].type, "input_file");
  assert.match(body.input[0].content[1].file_data, /^data:application\/pdf;base64,/);
});

test("RX extraction prefers the Credentials Vault key over a stale environment key", () => {
  const config = loadRxAiConfig({
    env: {
      OPENAI_API_KEY: "stale-environment-key",
      OPENAI_BASE_URL: "https://stale.example/v1",
      ASSISTANT_MODEL: "stale-model"
    },
    vault: {
      apiKey: "vault-key",
      baseUrl: "https://api.openai.com/v1/",
      model: "gpt-5.6-luna"
    }
  });

  assert.deepEqual(config, {
    apiKey: "vault-key",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-luna"
  });
});

test("image intake accepts supported image data and rejects HEIC without a converter", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]);
  const parsed = parseImages([{ dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}` }]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].mimeType, "image/jpeg");
  assert.throws(
    () => parseImages([{ dataUrl: `data:image/heic;base64,${Buffer.from("heic").toString("base64")}` }]),
    (error) => error.statusCode === 415
  );
});

test("public order response excludes local source image paths", () => {
  const response = publicOrder({
    capture_order_id: "11111111-1111-4111-8111-111111111111",
    status: "PROCESSING",
    created_by_user_id: "22222222-2222-4222-8222-222222222222",
    created_by_username: "employee",
    created_by_display_name: "Employee One",
    source_image_paths_json: JSON.stringify(["C:\\private\\patient.jpg"]),
    created_at: new Date("2026-09-22T10:00:00Z"),
    last_updated_at: new Date("2026-09-22T10:00:00Z")
  });
  assert.equal(response.id, "11111111-1111-4111-8111-111111111111");
  assert.equal("sourceImagePaths" in response, false);
  assert.doesNotMatch(JSON.stringify(response), /private|patient\.jpg/);
});

test("page and server integration preserve full-screen, authenticated camera capture", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "public", "rx-capture.html"), "utf8");
  const client = fs.readFileSync(path.join(root, "public", "rx-capture.js"), "utf8");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const auth = fs.readFileSync(path.join(root, "lib", "auth.js"), "utf8");
  const service = fs.readFileSync(path.join(root, "lib", "rx-capture", "service.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "styles", "pages", "rx-capture.css"), "utf8");
  const migration = fs.readFileSync(path.join(root, "database", "043-rx-capture.sql"), "utf8");

  assert.match(html, /accept="image\/\*" capture="environment"/);
  assert.match(html, /Lens selection/);
  assert.match(html, /data-lens="option"/);
  assert.match(html, /<script src="\/rx-combobox\.js" defer><\/script>\s*<script src="\/rx-capture\.js" defer>/);
  assert.doesNotMatch(html, /<datalist/);
  assert.match(html, /id="primaryImage" type="file" accept="image\/\*,application\/pdf,\.pdf" data-image-input="primary"/);
  assert.match(html, /id="primaryCamera" type="file" accept="image\/\*" capture="environment"/);
  assert.match(html, /Choose image or PDF/);
  assert.doesNotMatch(html, /imagePasteTarget|contenteditable="true" inputmode="none"/);
  assert.match(html, /paste a copied image or screenshot \(Ctrl\+V\)/);
  assert.doesNotMatch(html, /data-image-slot="secondary"|data-path="pd\.type"/);
  assert.match(html, /id="manualEntryButton"/);
  assert.match(html, /id="ownLensButton"/);
  assert.match(html, /data-path="lensRequest\.lensType"/);
  assert.match(html, /data-path="frame\.status"/);
  assert.match(html, /To be traced/);
  assert.match(html, /id="customerSearch"/);
  assert.match(html, /role="combobox" aria-autocomplete="list"/);
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /class="rx-table"/);
  assert.match(html, /data-path="frame\.segHeightOd"/);
  assert.doesNotMatch(html, /Structured review/);
  assert.match(html, /Employee prescription intake — photograph a prescription/);
  assert.doesNotMatch(html, /id="ordersTitle"/);
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  assert.doesNotMatch(html, /shared\.js/);
  assert.doesNotMatch(client, /createObjectURL/);
  assert.match(client, /The last saved values remain available below for review/);
  assert.match(client, /await persistReview\(\);\s+saved = true;/);
  assert.match(server, /handleRxCaptureRoute/);
  assert.match(server, /"\/rx-capture": \["rx-capture\.read", "rx-capture\.write"\]/);
  assert.match(auth, /code: "rx-capture"/);
  assert.match(service, /WHERE created_by_user_id = @user_id/);
  assert.match(service, /capture_order_id = @capture_order_id AND created_by_user_id = @user_id/);
  assert.match(service, /review_confirmed_at/);
  assert.match(migration, /created_by_user_id uniqueidentifier NOT NULL/);
  assert.match(migration, /rx_capture\.order_events/);
});

test("RX Capture lets the intake owner submit one reviewed draft without a second-person queue", () => {
  const root = path.join(__dirname, "..");
  const routes = fs.readFileSync(path.join(root, "lib", "rx-capture", "routes.js"), "utf8");
  const service = fs.readFileSync(path.join(root, "lib", "rx-capture", "service.js"), "utf8");
  const delivery = fs.readFileSync(path.join(root, "lib", "rx-capture", "file-delivery.js"), "utf8");
  const migration = fs.readFileSync(path.join(root, "database", "044-rx-capture-milestone-2.sql"), "utf8");
  const releaseMigration = fs.readFileSync(path.join(root, "database", "046-rx-capture-milestone-4-release.sql"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "rx-capture.html"), "utf8");
  const client = fs.readFileSync(path.join(root, "public", "rx-capture.js"), "utf8");

  assert.match(routes, /submit/);
  assert.match(routes, /rx-capture\.release/);
  assert.match(routes, /rx-capture\.write/);
  assert.match(service, /submitOrder/);
  assert.match(service, /listCoatings/);
  assert.doesNotMatch(service, /A different authorized employee must approve/);
  assert.match(service, /order_generations/);
  assert.match(delivery, /content integrity check failed/);
  assert.doesNotMatch(service, /rxGenerator\.release/);
  assert.match(service, /RX_RELEASED_TO_INNOVATIONS/);
  assert.match(migration, /UQ_rx_capture_generations_order/);
  assert.match(releaseMigration, /rx-capture\.release/);
  assert.match(client, /\/submit/);
  assert.match(client, /rx-capture\/coatings/);
  assert.match(client, /rx-capture\/catalog/);
  assert.match(routes, /submission-account/);
  assert.match(service, /innovations_account_mappings/);
  assert.match(html, /data-path="lensRequest.materialGroup" value="1"/);
  assert.doesNotMatch(html, /Customer sequence|Remote operator|Exact active lens alias|id="resolutionForm"/);
  assert.match(html, /Rimless \/ grooved/);
  assert.match(html, /data-path="frame.mounting"/);
  assert.doesNotMatch(html, /Add-on SKUs|id="frameMounting"/);
  assert.match(client, /choose a lens material, design and colour option that exist together/);
  assert.match(html, /SUBMIT TO INNOVATIONS/);
  assert.match(html, />SAVE DRAFT</);
  assert.match(html, /Captured details to continue later/);
  assert.doesNotMatch(html, /Review \/ release access/);
});

test("review normalization preserves exact catalogue choices without asking image extraction to invent them", () => {
  const order = normalizeOpticalOrder({ lensRequest: {
    materialGroup: "1", material: "Plastic 1.50", lensType: "Progressive",
    catalogAlias: "0000000100001", coatingSku: "STANDARDAR"
  } });
  assert.equal(order.lensRequest.materialGroup, "1");
  assert.equal(order.lensRequest.catalogAlias, "0000000100001");
  assert.equal(order.lensRequest.coatingSku, "STANDARDAR");
  assert.doesNotMatch(JSON.stringify(extractionJsonSchema().properties.lensRequest.properties), /catalogAlias|coatingSku|materialGroup/);
});

test("recent orders pass a click listener rather than Array.map callback metadata", () => {
  const client = fs.readFileSync(path.join(__dirname, "..", "public", "rx-capture.js"), "utf8");

  assert.match(client, /state\.orders\.map\(\(order\) => orderButton\(order\)\)/);
  assert.doesNotMatch(client, /state\.orders\.map\(orderButton\)/);
});

test("a submitted RX cannot be edited, re-extracted or regenerated", async () => {
  const { createRxCaptureService } = require("../lib/rx-capture/service");
  const actor = { userId: "11111111-1111-1111-1111-111111111111", username: "employee" };
  const orderId = "e5132c2e-a170-4958-b495-94121f7f0e08";
  const writes = [];
  const pool = {
    request() {
      const request = {
        input() { return request; },
        async query(text) {
          if (/^\s*(UPDATE|INSERT)/.test(text)) { writes.push(text); return { recordset: [], rowsAffected: [0] }; }
          return { recordset: [{ capture_order_id: orderId, created_by_user_id: actor.userId, status: "RELEASED" }] };
        }
      };
      return request;
    }
  };
  const service = createRxCaptureService({ getAppPool: async () => pool, schedule: () => { throw new Error("must not reprocess"); } });
  await assert.rejects(service.updateOrder(orderId, { normalizedOrder: {} }, actor), { statusCode: 409, message: /already been submitted/ });
  await assert.rejects(service.reprocessOrder(orderId, actor), { statusCode: 409, message: /already been submitted/ });
  assert.deepEqual(writes, []);

  const client = fs.readFileSync(path.join(__dirname, "..", "public", "rx-capture.js"), "utf8");
  assert.match(client, /\$\("#reprocessButton"\)\.hidden = !editable;/);
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "rx-capture", "service.js"), "utf8");
  assert.match(source, /already submitted to Innovations as \$\{prior\.recordset\[0\]\.generated_filename\}/);
});
