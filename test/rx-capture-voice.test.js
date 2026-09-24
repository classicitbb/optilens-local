const assert = require("node:assert/strict");
const test = require("node:test");

const RxVoice = require("../public/rx-capture-voice");
const { applyVoiceRules, customerMismatch, normalizeForMatch } = require("../lib/rx-capture/voice-rules");
const { normalizeOpticalOrder } = require("../lib/rx-capture/normalized-order");
const { extractPrescriptionFromText } = require("../lib/rx-capture/openai-extractor");
const { buildTranscriptionPrompt, parseAudio, transcribeAudio } = require("../lib/rx-capture/openai-transcriber");
const { createRxCaptureService, parseTranscript, rankFrequentCustomers } = require("../lib/rx-capture/service");
const regression = require("./fixtures/rx-voice-regression.json");

const keys = (pieces) => pieces.map((piece) => piece.key);

test("splitter labels a clean dictation by section without changing the words", () => {
  const text = "Right eye -2.50 -0.50 axis 180. Left eye -2.25 -0.75 axis 175. Add 2.00, PD 63. Lens 1.67 Varilux Comfort, Crizal. Frame to follow. Patient Jones ref 4471. Rush please.";
  const pieces = RxVoice.splitTranscript(text);
  assert.deepEqual(keys(pieces), ["right", "left", "measure", "lens", "frame", "patient", "instructions"]);
  assert.equal(pieces.map((piece) => piece.text).join(" "), text);
});

test("right and left only open an eye when an eye value follows", () => {
  const pieces = RxVoice.splitTranscript("That is right, left eye -1.00 sphere. I left the frame at the desk.");
  assert.equal(pieces[0].key, "unassigned");
  assert.equal(pieces[0].text, "That is right,");
  assert.equal(pieces[1].key, "left");
  assert.ok(!keys(pieces).includes("right"));
});

test("single-letter eyes only count at the start of a phrase", () => {
  assert.deepEqual(keys(RxVoice.splitTranscript("R -1.00 sphere. L -1.25 sphere")), ["right", "left"]);
  assert.deepEqual(keys(RxVoice.splitTranscript("model R 2 in brown")), ["frame"]);
});

test("prism and per-eye PD stay with the eye they follow", () => {
  const pieces = RxVoice.splitTranscript("right PD 32 left PD 31.5 right -1.50 prism 2 base in");
  assert.deepEqual(keys(pieces), ["right", "left", "right"]);
  assert.match(pieces[2].text, /prism 2 base in/);
});

test("a quarter-step index number inside an eye is a power, not a lens", () => {
  assert.deepEqual(keys(RxVoice.splitTranscript("OS -1.50 1.50 axis 90")), ["left"]);
  assert.deepEqual(keys(RxVoice.splitTranscript("OS -1.50 axis 90. 1.67 poly")), ["left", "lens"]);
});

test("text before the first trigger is unassigned and a new clip never continues an eye", () => {
  const first = RxVoice.mergeIntoSegments({}, RxVoice.splitTranscript("OD -1.00 sphere"));
  const second = RxVoice.mergeIntoSegments(first, RxVoice.splitTranscript("-2.00 sphere"));
  assert.equal(second.right, "OD -1.00 sphere");
  assert.equal(second.unassigned, "-2.00 sphere");
});

test("correction words are reported so the employee tidies the text", () => {
  assert.deepEqual(RxVoice.correctionWords("minus 2.50 no, scratch that -2.75"), ["scratch that", "no"]);
  assert.deepEqual(RxVoice.correctionWords("-2.50 axis 180"), []);
});

test("segments are sent to the extractor as labelled text in a fixed order", () => {
  const text = RxVoice.segmentsToText({ lens: "poly", right: "OD -1.00", unassigned: "uh" });
  assert.equal(text, "[Right eye (OD)]\nOD -1.00\n\n[Lens]\npoly\n\n[Unassigned]\nuh");
});

test("evidence matching ignores formatting differences", () => {
  assert.equal(normalizeForMatch("Minus 2.50"), normalizeForMatch("-2.5"));
  assert.equal(normalizeForMatch("−2.00"), "-2");
  assert.equal(normalizeForMatch("axis 180."), "axis 180");
});

function order(values) {
  return normalizeOpticalOrder(values);
}

test("an unsigned sphere or cylinder is uncertain, plano and ADD are not", () => {
  const source = "[Right eye (OD)]\nright 2.25 -0.50 axis 90\n\n[Left eye (OS)]\nleft plano\n\n[Add / PD / heights]\nadd 2.00";
  const proposal = order({ prescription: { od: { sphere: "2.25", cylinder: "-0.50", axis: 90, add: "2.00" }, os: { sphere: "PL", add: "2.00" } } });
  const evidence = [
    { field: "prescription.od.sphere", text: "2.25" },
    { field: "prescription.od.cylinder", text: "-0.50" },
    { field: "prescription.od.axis", text: "axis 90" },
    { field: "prescription.od.add", text: "add 2.00" },
    { field: "prescription.os.sphere", text: "plano" },
    { field: "prescription.os.add", text: "add 2.00" }
  ];
  const { uncertainFields, flags } = applyVoiceRules(proposal, evidence, source);
  assert.deepEqual(uncertainFields, ["prescription.od.sphere"]);
  assert.equal(flags["prescription.od.sphere"].reason, "No plus or minus was spoken");
});

test("a sign the model added without one being spoken is still uncertain", () => {
  const source = "right 2.25 axis 90";
  const proposal = order({ prescription: { od: { sphere: "-2.25" } } });
  const { uncertainFields } = applyVoiceRules(proposal, [{ field: "prescription.od.sphere", text: "2.25" }], source);
  assert.deepEqual(uncertainFields, ["prescription.od.sphere"]);
});

test("values without evidence, or with evidence not in the transcript, are uncertain", () => {
  const source = "right -1.00 sphere";
  const proposal = order({ prescription: { od: { sphere: "-1.00", cylinder: "-0.75" } }, patient: { name: "Jones" } });
  const { flags } = applyVoiceRules(proposal, [
    { field: "prescription.od.sphere", text: "-1.00" },
    { field: "prescription.od.cylinder", text: "-0.75" }
  ], source);
  assert.equal(flags["prescription.od.sphere"], undefined);
  assert.equal(flags["prescription.od.cylinder"].reason, "The quoted words are not in the transcript");
  assert.equal(flags["patient.name"].reason, "No spoken words support this value");
});

test("two different spoken values for one field are uncertain", () => {
  const source = "right -2.50 no scratch that -2.75";
  const proposal = order({ prescription: { od: { sphere: "-2.75" } } });
  const { flags } = applyVoiceRules(proposal, [
    { field: "prescription.od.sphere", text: "-2.50" },
    { field: "prescription.od.sphere", text: "-2.75" }
  ], source);
  assert.equal(flags["prescription.od.sphere"].reason, "Two different values were spoken");
});

test("a customer named in the dictation that is not the selected one produces a note", () => {
  const selected = { name: "Harbour Optical Ltd", account: "5000150" };
  assert.equal(customerMismatch("Harbour Optical", selected), null);
  assert.equal(customerMismatch("account 5000150", selected), null);
  assert.equal(customerMismatch(null, selected), null);
  assert.match(customerMismatch("Bayside Eye Care", selected), /mentions "Bayside Eye Care", but this order is for Harbour Optical Ltd/);
});

test("the regression dictations raise only the expected flags", () => {
  for (const item of regression.cases) {
    const segments = RxVoice.mergeIntoSegments({}, RxVoice.splitTranscript(item.transcript));
    assert.deepEqual(Object.keys(segments).filter((key) => segments[key]), item.segments, `${item.name}: segments`);
    const source = RxVoice.segmentsToText(segments);
    const { uncertainFields } = applyVoiceRules(order(item.proposal), item.evidence, source);
    assert.deepEqual(uncertainFields.sort(), [...item.expectedUncertain].sort(), `${item.name}: flags`);
  }
});

test("text extraction asks for evidence, never stores, and returns the proposal", async () => {
  let request;
  const fetch = async (url, init) => {
    request = { url, body: JSON.parse(init.body) };
    return {
      ok: true,
      json: async () => ({ output_text: JSON.stringify({
        patient: { name: null, reference: null },
        prescription: { od: { sphere: "-1.00", cylinder: null, axis: null, add: null, prism: null, base: null }, os: { sphere: null, cylinder: null, axis: null, add: null, prism: null, base: null } },
        pd: { type: null, binocular: null, od: null, os: null, nearOd: null, nearOs: null },
        frame: { supplied: null, status: null, model: null, color: null, a: null, b: null, dbl: null, ed: null, segHeightOd: null, segHeightOs: null },
        lensRequest: { lensType: null, design: null, material: null, option: null, coating: null },
        instructions: null, uncertainFields: [], missingFields: [],
        evidence: [{ field: "prescription.od.sphere", text: "-1.00" }], spokenCustomer: null
      }) })
    };
  };
  const result = await extractPrescriptionFromText("[Right eye (OD)]\nOD -1.00", { fetch, config: { apiKey: "test", baseUrl: "https://example.test/v1", model: "m" } });
  assert.equal(request.url, "https://example.test/v1/responses");
  assert.equal(request.body.store, false);
  assert.match(request.body.instructions, /labels come from a keyword splitter and are hints only/);
  assert.ok(request.body.text.format.schema.required.includes("evidence"));
  assert.equal(result.order.prescription.od.sphere, "-1.00");
  assert.deepEqual(result.evidence, [{ field: "prescription.od.sphere", text: "-1.00" }]);
});

test("audio uploads are type and length checked before transcription", () => {
  const webm = `data:audio/webm;codecs=opus;base64,${Buffer.from("abc").toString("base64")}`;
  assert.equal(parseAudio(webm, 4000).mimeType, "audio/webm");
  assert.throws(() => parseAudio(webm, 400), /Nothing heard/);
  assert.throws(() => parseAudio(`data:text/plain;base64,${Buffer.from("abc").toString("base64")}`, 4000), (error) => error.statusCode === 415);
  assert.throws(() => parseAudio(webm, 4 * 60 * 1000), (error) => error.statusCode === 413);
});

test("the transcription prompt forbids adding signs and stays within its cap", () => {
  const prompt = buildTranscriptionPrompt(Array.from({ length: 400 }, (_, index) => `Design ${index}`));
  assert.match(prompt, /Never add a sign that was not spoken/);
  assert.match(prompt, /Lens names: Design 0/);
  assert.ok(prompt.length <= 1800);
});

test("transcription posts the audio with the vocabulary prompt", async () => {
  let sent;
  const fetch = async (url, init) => {
    sent = { url, form: init.body };
    return { ok: true, json: async () => ({ text: "Right eye -2.50" }) };
  };
  const audio = parseAudio(`data:audio/mp4;base64,${Buffer.from("abc").toString("base64")}`, 3000);
  const text = await transcribeAudio(audio, { fetch, vocabulary: ["Physio"], config: { apiKey: "k", baseUrl: "https://example.test/v1", model: "gpt-4o-transcribe" } });
  assert.equal(text, "Right eye -2.50");
  assert.equal(sent.url, "https://example.test/v1/audio/transcriptions");
  assert.equal(sent.form.get("model"), "gpt-4o-transcribe");
  assert.match(sent.form.get("prompt"), /Physio/);
});

test("frequent customers rank own history first, recent over old, topped up by the team", () => {
  const now = new Date("2026-09-24T12:00:00Z");
  const day = (n) => new Date(now.getTime() - n * 86400000);
  const rows = [
    { customer_id: 1, customer_account: "A", customer_name: "Old Regular", own_count: 6, own_last_at: day(80), team_count: 6, team_last_at: day(80) },
    { customer_id: 2, customer_account: "B", customer_name: "This Week", own_count: 6, own_last_at: day(1), team_count: 6, team_last_at: day(1) },
    { customer_id: 3, customer_account: "C", customer_name: "Team Only", own_count: 0, own_last_at: null, team_count: 30, team_last_at: day(2) }
  ];
  assert.deepEqual(rankFrequentCustomers(rows, now).map((customer) => customer.id), [2, 1, 3]);
  assert.equal(rankFrequentCustomers(rows, now, 2).length, 2);
});

test("a transcript payload must contain text and is capped", () => {
  assert.throws(() => parseTranscript({ segments: { right: "  " } }), /empty/);
  assert.equal(parseTranscript({ segments: { right: "OD -1.00" }, clipCount: 2 }).clipCount, 2);
  assert.equal(parseTranscript({ segments: { right: "OD -1.00" }, clipCount: "x" }).clipCount, 0);
});

function fakePool() {
  const rows = new Map();
  const events = [];
  const pool = {
    rows,
    events,
    request() {
      const params = {};
      const request = {
        input(name, _type, value) { params[name] = value === undefined ? _type : value; return request; },
        async query(text) {
          if (/INSERT INTO rx_capture\.orders/.test(text)) {
            rows.set(params.capture_order_id, { ...params, last_updated_at: params.created_at });
            return { recordset: [], rowsAffected: [1] };
          }
          if (/order_events/.test(text)) { events.push({ ...params }); return { recordset: [] }; }
          if (/^\s*UPDATE rx_capture\.orders/.test(text)) {
            const row = rows.get(params.capture_order_id);
            if (row) {
              for (const key of ["status", "patient_name", "extracted_json", "validated_json", "error_message"]) if (key in params) row[key] = params[key];
              if (/status = N'FAILED'/.test(text)) row.status = "FAILED";
              if (/status = N'PROCESSING'/.test(text)) row.status = "PROCESSING";
            }
            return { recordset: [], rowsAffected: [row ? 1 : 0] };
          }
          return { recordset: [...rows.values()].filter((row) => row.capture_order_id === params.capture_order_id) };
        }
      };
      return request;
    }
  };
  return pool;
}

test("a dictated order stores the checked text, never logs it, and extracts from it", async () => {
  const pool = fakePool();
  const tasks = [];
  let extractedFrom = null;
  const service = createRxCaptureService({
    getAppPool: async () => pool,
    schedule: (task) => tasks.push(task),
    getCatalog: () => [],
    extractPrescriptionFromImages: async () => { throw new Error("must not read images"); },
    extractPrescriptionFromText: async (text) => {
      extractedFrom = text;
      return {
        order: normalizeOpticalOrder({ patient: { name: "Jones" }, prescription: { od: { sphere: "2.25" }, os: { sphere: "-1.00" } }, pd: { binocular: 63 } }),
        evidence: [
          { field: "patient.name", text: "Patient Jones" },
          { field: "prescription.od.sphere", text: "2.25" },
          { field: "prescription.os.sphere", text: "-1.00" },
          { field: "pd.binocular", text: "PD 63" }
        ],
        spokenCustomer: "Bayside Eye Care"
      };
    }
  });
  const actor = { userId: "11111111-1111-1111-1111-111111111111", username: "employee" };
  const segments = { right: "Right eye 2.25", left: "Left eye -1.00", measure: "PD 63", patient: "Patient Jones" };
  const created = await service.createOrder({ customer: { id: 7, account: "5000150", name: "Harbour Optical" }, transcript: { segments, raw: "Right eye 2.25 Left eye -1.00 PD 63 Patient Jones", clipCount: 1 } }, actor);
  assert.equal(created.status, "PROCESSING");
  assert.equal(created.inputMode, "voice");
  assert.equal(created.transcript.right, "Right eye 2.25");

  const row = [...pool.rows.values()][0];
  assert.equal(row.input_mode, "voice");
  assert.equal(JSON.parse(row.transcript_raw_json).clipCount, 1);

  await tasks[0]();
  assert.match(extractedFrom, /\[Right eye \(OD\)\]\nRight eye 2\.25/);
  const extracted = JSON.parse(row.extracted_json);
  assert.ok(extracted.uncertainFields.includes("prescription.od.sphere"));
  assert.equal(extracted.voiceFlags["prescription.od.sphere"].reason, "No plus or minus was spoken");
  assert.equal(extracted.voiceFlags["prescription.os.sphere"], undefined);
  assert.match(extracted.voiceNotes[0], /Bayside Eye Care/);
  assert.equal(row.status, "NEEDS_INFO");

  // Transcript words must never reach the event log.
  const logged = JSON.stringify(pool.events.map((event) => event.details_json));
  for (const phrase of ["2.25", "Jones", "Right eye", "PD 63", "Bayside"]) assert.ok(!logged.includes(phrase), `event log contains "${phrase}"`);
});

test("typed-only intake is recorded as text, and photos plus dictation are refused", async () => {
  const pool = fakePool();
  const service = createRxCaptureService({ getAppPool: async () => pool, schedule: () => {} });
  const actor = { userId: "11111111-1111-1111-1111-111111111111", username: "employee" };
  const customer = { id: 7, account: "5000150", name: "Harbour Optical" };
  const created = await service.createOrder({ customer, transcript: { segments: { right: "OD -1.00" } } }, actor);
  assert.equal(created.inputMode, "text");
  await assert.rejects(service.createOrder({ customer, images: [], transcript: { segments: { right: "OD -1.00" } } }, actor), /either prescription photos or a dictation/);
});

test("try again on a dictated order re-extracts from the stored transcript", async () => {
  const pool = fakePool();
  const tasks = [];
  const service = createRxCaptureService({ getAppPool: async () => pool, schedule: (task) => tasks.push(task) });
  const actor = { userId: "11111111-1111-1111-1111-111111111111", username: "employee" };
  const created = await service.createOrder({ customer: { id: 7, account: "5000150", name: "Harbour Optical" }, transcript: { segments: { right: "OD -1.00" }, clipCount: 1 } }, actor);
  pool.rows.get(created.id).status = "FAILED";
  const retried = await service.reprocessOrder(created.id, actor);
  assert.equal(retried.status, "PROCESSING");
  assert.equal(tasks.length, 2);
});

test("voice is reported unavailable without the AI key", () => {
  const off = createRxCaptureService({ loadRxAiConfig: () => ({ apiKey: "" }) }).voiceStatus();
  assert.equal(off.available, false);
  assert.match(off.reason, /not configured/);
  assert.equal(createRxCaptureService({ loadRxAiConfig: () => ({ apiKey: "k" }) }).voiceStatus().available, true);
});
