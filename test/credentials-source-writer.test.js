const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { sourceMssqlWriteProfile } = require("../lib/config");
const { innovationsIncomingFolderFromVault } = require("../lib/credential-vault");

test("source writer vault profile never falls back to the source read identity", () => {
  const sourceReadProfile = {
    server: "source-server",
    database: "Innovations",
    user: "source-reader",
    password: "reader-password",
    encrypt: true,
    trustServerCertificate: true
  };

  assert.equal(sourceMssqlWriteProfile(sourceReadProfile, null, (profile) => profile), null);

  const writer = sourceMssqlWriteProfile(sourceReadProfile, null, (profile) => ({
    ...profile,
    user: "source-writer",
    password: "writer-password"
  }));
  assert.equal(writer.user, "source-writer");
  assert.equal(writer.database, "Innovations");
});

test("Credentials Vault provides a dedicated source writer entry", () => {
  const page = fs.readFileSync(path.join(__dirname, "..", "public", "credentials.html"), "utf8");
  assert.match(page, /id="addSourceWriterEntryBtn"/);
  assert.match(page, /Source MSSQL Writer \(Innovations\)/);
  assert.match(page, /label: "Password", val: "", secret: true/);
});

test("Credentials Vault provides a non-secret Innovations incoming-folder override", () => {
  const page = fs.readFileSync(path.join(__dirname, "..", "public", "credentials.html"), "utf8");
  assert.match(page, /id="addInnovationsIncomingFolderBtn"/);
  assert.match(page, /Innovations Incoming Folder/);
  assert.match(page, /label: "Incoming folder", val: "", secret: false/);
});

test("Innovations incoming-folder override is optional and uses the saved non-secret field", () => {
  assert.equal(innovationsIncomingFolderFromVault(() => null), null);
  assert.equal(innovationsIncomingFolderFromVault(() => ({
    fields: [{ label: "Incoming folder", val: "\\\\server\\share\\incoming", secret: false }]
  })), "\\\\server\\share\\incoming");
});
