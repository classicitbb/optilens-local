const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const { searchTariffs, validateCustom } = require("../public/tariff-codes");
const { validateTariffInput, normalizeInvoiceTariffs } = require("../lib/tariff-codes");

// The seed lives in the migration; parse it so the tests exercise the real data.
function seededLibrary() {
  const sql = read("database/057-commercial-invoice-tariff-library.sql");
  const rows = [...sql.matchAll(/\(N'([^']+)', N'([^']+)', N'([^']+)', (\d+)\)/g)];
  return rows.map(([, tariffCode, description, searchAliases, order], index) => ({
    id: `id-${index}`, tariffCode, description, searchAliases, displayOrder: Number(order), isActive: true, verificationStatus: "unverified"
  }));
}

test("migration seeds the eleven requested codes as unverified strings, only when missing", () => {
  const sql = read("database/057-commercial-invoice-tariff-library.sql");
  const library = seededLibrary();
  assert.equal(library.length, 11);
  assert.deepEqual(library.map((t) => t.tariffCode), [
    "9001.50.00.000", "9004.90.00.000", "9004.50.00.000", "3405.90", "3402.90.10", "3919.90.50.60",
    "6804.21.00.000", "6804.22.00.000", "6307.10.00.000", "8466.93.00.000", "9608.10.00.00"
  ]);
  assert.match(sql, /tariff_code nvarchar\(40\)/);
  assert.match(sql, /WHERE NOT EXISTS \(SELECT 1 FROM delivery\.tariff_codes t WHERE t\.tariff_code = s\.tariff_code\)/);
  assert.match(sql, /N'unverified', s\.display_order/);
  assert.doesNotMatch(sql, /UPDATE delivery\.tariff_codes/);
  assert.match(read("lib/migrations.js"), /057-commercial-invoice-tariff-library\.sql", module: "delivery-export"/);
});

test("invoice tariffs are snapshots with no foreign key to the library", () => {
  const sql = read("database/057-commercial-invoice-tariff-library.sql");
  const table = sql.slice(sql.indexOf("commercial_invoice_tariffs (") );
  assert.match(table, /tariff_code nvarchar\(40\) NOT NULL/);
  assert.match(table, /description nvarchar\(500\) NOT NULL/);
  assert.doesNotMatch(table, /REFERENCES delivery\.tariff_codes/);
});

test("slash search matches code, partial code, description and keywords", () => {
  const library = seededLibrary();
  const codes = (query) => searchTariffs(library, query).map((t) => t.tariffCode);
  assert.deepEqual(codes("/lens").slice(0, 1), ["9001.50.00.000"]);
  assert.ok(codes("/lens").includes("6307.10.00.000"));
  assert.equal(codes("/9001")[0], "9001.50.00.000");
  assert.equal(codes("/900150")[0], "9001.50.00.000");
  assert.deepEqual(codes("/cloth"), ["6307.10.00.000"]);
  assert.deepEqual(codes("/polish").sort(), ["3405.90", "6804.21.00.000", "6804.22.00.000"].sort());
  assert.deepEqual(codes("/chuck"), ["8466.93.00.000"]);
  assert.deepEqual(codes("/EDGER"), ["8466.93.00.000"]);
  assert.equal(codes("/").length, 11);
  assert.deepEqual(codes("zzzz"), []);
});

test("custom tariff validation keeps punctuation and rejects junk", () => {
  assert.deepEqual(validateCustom(" 1234.56.78 ", "Widgets"), { tariffCode: "1234.56.78", description: "Widgets" });
  assert.ok(validateCustom("", "x").error);
  assert.ok(validateCustom("abc", "x").error);
  assert.ok(validateCustom("1234", "").error);
  const server = validateTariffInput({ tariffCode: "3405.90", description: "  Polish ", searchAliases: "a,  b", verificationStatus: "verified" });
  assert.deepEqual(server, { tariffCode: "3405.90", description: "Polish", searchAliases: "a, b", verificationStatus: "verified" });
  assert.equal(validateTariffInput({ tariffCode: "1234", description: "x" }).verificationStatus, "unverified");
  assert.throws(() => validateTariffInput({ tariffCode: "12;DROP", description: "x" }), /may only contain/);
});

test("invoice selection keeps order, drops duplicates and bounds size", () => {
  const rows = normalizeInvoiceTariffs([
    { tariffCode: "9001.50.00.000", description: "Lenses", tariffId: "5C7A0B3E-1111-4222-8333-944455556666" },
    { tariffCode: "6307.10.00.000", description: "Cloths", tariffId: "not-a-guid" },
    { tariffCode: "9001.50.00.000", description: "Lenses again" }
  ]);
  assert.deepEqual(rows.map((r) => r.tariffCode), ["9001.50.00.000", "6307.10.00.000"]);
  assert.equal(rows[1].tariffId, null);
  assert.throws(() => normalizeInvoiceTariffs([{ tariffCode: "", description: "x" }]), /needs a code/);
  assert.throws(() => normalizeInvoiceTariffs([{ tariffCode: "1234", description: "" }]), /needs a description/);
  assert.throws(() => normalizeInvoiceTariffs(Array.from({ length: 41 }, (_, i) => ({ tariffCode: `${1000 + i}`, description: "x" }))), /at most/);
});

test("library changes need platform.admin while invoice users only read and select", () => {
  const server = read("server.js");
  const block = server.slice(server.indexOf('"/api/delivery/tariff-codes" && req.method === "GET"'), server.indexOf("const commercialInvoiceHeaderMatch"));
  assert.match(block, /requirePermission\(req, "delivery\.read"\)/);
  assert.equal((block.match(/requirePermission\(req, "platform\.admin"\)/g) || []).length, 3);
  assert.match(block, /includeInactive = url\.searchParams\.get\("all"\) === "1" && canManage/);
  assert.match(block, /commercial-invoice\\\/tariffs\$[\s\S]*requirePermission\(req, "delivery\.write"\)/);
  const lib = read("lib/tariff-codes.js");
  assert.match(lib, /usageCount > 0/);
  assert.match(lib, /cannot be deleted. Deactivate it instead/);
});

test("print output lists every tariff as plain wrapped text", () => {
  const server = read("server.js");
  const start = server.indexOf("function renderCommercialInvoiceHtml");
  const end = server.indexOf("function escapeHtmlServer");
  const escapeStart = end;
  const escapeEnd = server.indexOf("\n}\n", escapeStart) + 3;
  const render = new Function(`${server.slice(escapeStart, escapeEnd)}\n${server.slice(start, end)}\nreturn renderCommercialInvoiceHtml;`)();
  const basePreview = {
    invoiceNo: "1", invoiceDate: "2026-10-29", customerOrderNo: "", poNumbers: "", seller: { name: "CV", addressLines: [], phone: "" },
    consignee: {}, transport: {}, totals: {}, items: [], declarationOverride: "RX LENSES"
  };
  const html = render({
    ...basePreview,
    tariffSelections: [
      { tariffCode: "9001.50.00.000", description: "Rx Spectacle Lenses – Uncut, Plastic and Other Materials" },
      { tariffCode: "6307.10.00.000", description: "Lens <Cleaning> Cloths" }
    ]
  });
  assert.match(html, /<h2>Customs Tariff Classifications<\/h2>/);
  assert.match(html, /<p>9001\.50\.00\.000 – Rx Spectacle Lenses – Uncut, Plastic and Other Materials<\/p>/);
  assert.match(html, /<p>6307\.10\.00\.000 – Lens &lt;Cleaning&gt; Cloths<\/p>/);
  assert.match(html, /\.tariffs p \{[^}]*overflow-wrap: anywhere/);
  assert.doesNotMatch(html, /Remove|<button|<select/);
  assert.doesNotMatch(render({ ...basePreview, tariffSelections: [] }), /Customs Tariff Classifications<\/h2>/);
  assert.match(html, /RX LENSES/);
});

test("settings tab and invoice selector are wired into the delivery page", () => {
  const html = read("public/delivery-export.html");
  assert.match(html, /data-settings-tab="tariffCodes"/);
  assert.match(html, /id="tariffCodes"/);
  assert.match(html, /<script src="\/tariff-codes\.js"><\/script>/);
  const client = read("public/delivery-export.js");
  assert.match(client, /TariffUi\.selectorHtml\(preview\)/);
  const ui = read("public/tariff-codes.js");
  assert.match(ui, /Tariff Codes \/ Customs Classification/);
  assert.match(ui, /Type \/ to select a tariff, search, or add your own\.\.\./);
  assert.match(ui, /role="combobox"/);
  assert.match(ui, /Save to Tariff Library/);
});

test("invoice HTML keeps currency beside the amount and forces backgrounds to print", () => {
  const server = read("server.js");
  assert.match(server, /\* \{ -webkit-print-color-adjust: exact; print-color-adjust: exact; \}/);
  assert.match(server, /\.total-row \{ display: grid; grid-template-columns: 1fr auto;/);
  assert.match(server, /\.total-row span:last-child \{ text-align: right; white-space: nowrap; \}/);
  assert.match(read("public/delivery-export.js"), /pdfUrl: `\/api\/delivery\/shipments\/.*commercial-invoice\/download\.pdf`/);
  assert.match(read("public/document-preview.js"), /pdfUrl \? await fetchPdf/);
});

const { findBrowser, renderProtectedPdf } = require("../lib/pdf-render");
let hasBrowser = true;
try { findBrowser(); } catch { hasBrowser = false; }

test("server-rendered PDF is a real, print-only, password-protected vector document", { skip: !hasBrowser, timeout: 60000 }, async () => {
  const { PDFParse } = require("pdf-parse");
  process.env.OPTILENS_INVOICE_PDF_PASSWORD = "unit-test-password";
  try {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>T</title><style>@page{size:Letter;margin:.35in}</style></head><body><h1>Commercial Invoice 11999</h1><p>BBD $8,104.12 – Rx Spectacle Lenses</p></body></html>`;
    const pdf = await renderProtectedPdf(html, { title: "Commercial Invoice 11999", subject: "Test" });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.match(pdf.toString("latin1"), /\/Encrypt \d+ 0 R/);
    assert.doesNotMatch(pdf.toString("latin1"), /Commercial Invoice 11999/); // strings are encrypted
    const open = new PDFParse({ data: new Uint8Array(pdf), password: "unit-test-password" });
    const text = await open.getText();
    assert.equal(text.total, 1);
    assert.match(text.text, /BBD \$8,104\.12 – Rx Spectacle Lenses/);
    const info = (await open.getInfo()).info;
    assert.equal(info.Title, "Commercial Invoice 11999");
    assert.equal(info.Author, "Classic Visions");
    assert.equal(info.Producer, "OptiLens Local");
    await assert.rejects(() => new PDFParse({ data: new Uint8Array(pdf) }).getText(), /Password/);
    await assert.rejects(() => new PDFParse({ data: new Uint8Array(pdf), password: "wrong" }).getText(), /Password/);
  } finally {
    delete process.env.OPTILENS_INVOICE_PDF_PASSWORD;
  }
});
