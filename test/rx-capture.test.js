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
  const migration = fs.readFileSync(path.join(root, "database", "043-rx-capture.sql"), "utf8");

  assert.match(html, /accept="image\/\*" capture="environment"/);
  assert.doesNotMatch(html, /shared\.js/);
  assert.doesNotMatch(client, /createObjectURL/);
  assert.match(server, /handleRxCaptureRoute/);
  assert.match(server, /"\/rx-capture": \["rx-capture\.read", "rx-capture\.write"\]/);
  assert.match(auth, /code: "rx-capture"/);
  assert.match(service, /WHERE created_by_user_id = @user_id/);
  assert.match(service, /capture_order_id = @capture_order_id AND created_by_user_id = @user_id/);
  assert.match(migration, /created_by_user_id uniqueidentifier NOT NULL/);
  assert.match(migration, /rx_capture\.order_events/);
});
