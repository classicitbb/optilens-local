const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { validatedSignature } = require("../lib/delivery-documents");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const transparentPngHeader = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,0,0,0,0]);

test("authorisation accepts alpha-capable PNGs and rejects opaque/non-PNG payloads", () => {
  const value = transparentPngHeader.toString("base64");
  assert.deepEqual(validatedSignature({ imageBase64: value }), transparentPngHeader);
  assert.throws(() => validatedSignature({ imageBase64: Buffer.from("not a PNG").toString("base64") }), /transparent PNG/);
  const opaque = Buffer.from(transparentPngHeader); opaque[25] = 2;
  assert.throws(() => validatedSignature({ imageBase64: opaque.toString("base64") }), /transparent PNG/);
});

test("archive, authorisation and immutable explicit save wiring are present", () => {
  const server = read("server.js"); const client = read("public/delivery-export.js");
  assert.match(read("lib/delivery-documents.js"), /delivery\.document_archive_entries/);
  assert.match(server, /delivery\.write/);
  assert.match(client, /archiveDocument: !options\.silent/);
  assert.match(client, /authorisationDropZone/);
  assert.match(read("database/040-delivery-document-archive-and-authorisation.sql"), /rendered_html/);
});
