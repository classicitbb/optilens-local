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
const { parseImages, publicOrder } = require("../lib/rx-capture/service");
const { resolveLensAlias } = require("../lib/rx-capture/alias-resolver");

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
  assert.match(html, /Lens information/);
  assert.match(html, /data-path="lensRequest\.lensType"/);
  assert.match(html, /data-path="frame\.status"/);
  assert.match(html, /To be traced/);
  assert.match(html, /id="customerSearch"/);
  assert.match(html, /class="rx-table"/);
  assert.match(html, /data-path="frame\.segHeightOd"/);
  assert.doesNotMatch(html, /Structured review/);
  assert.match(html, /Employee prescription intake — photograph a prescription/);
  assert.doesNotMatch(html, /id="ordersTitle"/);
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  assert.doesNotMatch(html, /shared\.js/);
  assert.doesNotMatch(client, /createObjectURL/);
  assert.match(client, /The last saved values remain available below for review/);
  assert.match(client, /reviewConfirmedAt/);
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
  assert.match(html, /Material group/);
  assert.match(html, /Rimless \/ grooved/);
  assert.match(html, /Edged \/ enclosed/);
  assert.match(client, /Save draft & continue to open the lens and coating choices/);
  assert.match(html, /SUBMIT TO INNOVATIONS/);
  assert.match(html, /SAVE DRAFT &amp; CONTINUE/);
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
