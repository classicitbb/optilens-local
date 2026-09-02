const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { PDFParse } = require("pdf-parse");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("delivery checklist eligibility and packing slip access use shipment classification", () => {
  const client = read("public/delivery-export.js");
  assert.match(client, /function updateDeliveryChecklistAvailability/);
  assert.match(client, /Delivery checklist is not used for local shipments/);
  assert.match(client, /#packingSlipBtn/);
  assert.match(read("public/delivery-export.html"), /id="packingSlipBtn"/);
});

test("shared document preview saves native PDF bytes with the sanitized PDF filename", () => {
  const preview = read("public/document-preview.js");
  assert.match(preview, /function sanitizeFilename/);
  assert.match(preview, /printPreview\(frame, safeFilename\)/);
  assert.match(preview, /type: "application\/pdf"/);
  assert.match(preview, /%PDF-1\.4/);
  assert.match(preview, /link\.download = `\$\{safeFilename\}\.pdf`/);
  assert.doesNotMatch(preview, /link\.download = `\$\{safeFilename\}\.html`/);
  assert.match(preview, /Opens your browser print dialog/);
  assert.match(preview, /Close document preview/);
  assert.match(preview, /event\.target === dialog/);
  assert.match(read("public/delivery-export.html"), /document-preview\.js/);
});

test("shared print uses the sanitized filename as the iframe title and restores it afterward", () => {
  const source = read("public/document-preview.js");
  const start = source.indexOf("  function printPreview(frame, filename) {");
  const end = source.indexOf("\n\n  async function renderFrameAsPdf", start);
  assert.ok(start >= 0 && end > start, "printPreview should remain a reusable client-side helper");
  const printPreview = new Function(`${source.slice(start, end)}; return printPreview;`)();
  const previewDocument = { title: "Document preview" };
  const calls = [];
  printPreview({
    contentDocument: previewDocument,
    contentWindow: {
      focus() { calls.push(["focus", previewDocument.title]); },
      print() { calls.push(["print", previewDocument.title]); }
    }
  }, "Classic Packing Slip - A B");
  assert.deepEqual(calls, [["focus", "Classic Packing Slip - A B"], ["print", "Classic Packing Slip - A B"]]);
  assert.equal(previewDocument.title, "Document preview");
  const sanitizeStart = source.indexOf("  function sanitizeFilename(value) {");
  const sanitizeEnd = source.indexOf("\n\n  function open", sanitizeStart);
  assert.ok(sanitizeStart >= 0 && sanitizeEnd > sanitizeStart, "sanitizeFilename should remain shared");
  const sanitizeFilename = new Function(`${source.slice(sanitizeStart, sanitizeEnd)}\nreturn sanitizeFilename;`)();
  assert.equal(
    sanitizeFilename("Classic / Invoice:* Customer"),
    "Classic Invoice Customer"
  );
});

test("PDF builder emits a real Letter-page PDF byte stream", async () => {
  const source = read("public/document-preview.js");
  const start = source.indexOf("  function buildPdf(pages) {");
  const end = source.indexOf("\n\n  window.OptiLensDocumentPreview", start);
  assert.ok(start >= 0 && end > start, "buildPdf should remain a reusable client-side helper");
  const buildPdf = new Function(`${source.slice(start, end)}; return buildPdf;`)();
  const blob = buildPdf([{ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), width: 1632, height: 2112 }]);
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(blob.type, "application/pdf");
  assert.ok(bytes.subarray(0, 8).toString("ascii").startsWith("%PDF-1.4"));
  assert.match(bytes.toString("latin1"), /\/MediaBox \[0 0 612 792\]/);
  assert.match(bytes.toString("latin1"), /\/Filter \/DCTDecode/);
  const parser = new PDFParse({ data: bytes });
  const info = await parser.getInfo({ parsePageInfo: true });
  await parser.destroy();
  assert.equal(info.total, 1);
  assert.deepEqual(info.pages.map((page) => [page.width, page.height]), [[612, 792]]);
});

test("packing slip maps shipment data and stock-only shipments to one attached-documents row", () => {
  const client = read("public/delivery-export.js");
  assert.match(client, /function renderPackingSlipHtml/);
  for (const label of ["Packing List", "Invoice #", "Received By", "Signature", "Dispatcher", "Thank you for choosing Classic Visions"]) assert.match(client, new RegExp(label));
  assert.match(client, /STOCK ORDER - SEE ATTACHED DOCUMENTS\./);
});

test("commercial invoice uses the shared preview, branded filename, and stock invoice rows", () => {
  const client = read("public/delivery-export.js");
  const server = read("server.js");
  assert.match(client, /Classic Commercial Invoice -/);
  assert.match(client, /OptiLensDocumentPreview\?\.open/);
  assert.match(read("public/delivery-export.html"), /id="saveCoDraftBottomBtn"/);
  assert.match(server, /signatureDataUrl/);
  assert.match(server, /const money = \(value\) => `BBD \$\$\{Number\(value \|\| 0\)/);
  assert.match(server, /Currency of Sale<\/span><span class="strong">Barbados Dollars \(BBD\)<\/span>/);
  assert.doesNotMatch(server.slice(server.indexOf("function renderCommercialInvoiceHtml"), server.indexOf("function escapeHtmlServer")), /<span>\$<\/span>|>\$\$\{money\(/);
  assert.doesNotMatch(server, /STOCK ORDER - SEE ATTACHED DOCUMENTS\./);
  assert.doesNotMatch(client.slice(0, client.indexOf("function renderPackingSlipHtml")), /STOCK ORDER - SEE ATTACHED DOCUMENTS\./);
});

test("commercial invoice signature sits above a transparent signing line", () => {
  const server = read("server.js");
  assert.match(server, /\.sig img \{ display: block;[\s\S]*background: transparent;[\s\S]*mix-blend-mode: multiply;[\s\S]*clip-path: inset\(2px\);/);
  assert.match(server, /<img src="\$\{escapeHtmlServer\(signatureDataUrl\)\}" alt="Authorised Classic Visions signature">[\s\S]*<div class="sig-line"><\/div><div class="sig-signer">Classic Visions/);
});

test("stock detection prefers source order type and item defaults use the normalised label", () => {
  const source = read("lib/beswift-co.js");
  const client = read("public/delivery-export.js");
  assert.match(source, /orderTypeName\s*\?\s*\/stock\|fulfil/);
  assert.match(source, /orderLines\.some\(isStockOrFulfillmentOrder\)/);
  assert.match(client, /function itemDefaultDisplayLabel/);
  assert.match(client, /item\.catalogName \|\| item\.specification/);
});
