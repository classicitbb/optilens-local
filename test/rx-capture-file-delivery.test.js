const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { releaseApprovedRx, sha256, stageApprovedRx } = require("../lib/rx-capture/file-delivery");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-rx-capture-"));
  const content = Buffer.from("start_order\r\nend_order\r\n", "utf8");
  return {
    root,
    content,
    config: { folders: { staging: "staging", archive: "archive", incoming: "incoming" }, output: { extension: ".rx" } },
    filename: "80000001_DOE_JANE.rx",
    expectedHash: sha256(content)
  };
}

test("stages an approved RX atomically without overwriting a different file", () => {
  const item = fixture();
  try {
    assert.deepEqual(stageApprovedRx(item), { filename: item.filename, sha256: item.expectedHash, stagingPath: path.join(item.root, "staging", item.filename) });
    assert.equal(fs.readFileSync(path.join(item.root, "staging", item.filename), "utf8"), item.content.toString("utf8"));
    assert.deepEqual(stageApprovedRx(item), { filename: item.filename, sha256: item.expectedHash, stagingPath: path.join(item.root, "staging", item.filename) });
    fs.writeFileSync(path.join(item.root, "staging", item.filename), "different");
    assert.throws(() => stageApprovedRx(item), /different staged file/);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("releases only the hash-verified staged RX after archiving a matching copy", () => {
  const item = fixture();
  try {
    stageApprovedRx(item);
    assert.deepEqual(releaseApprovedRx(item), { filename: item.filename, sha256: item.expectedHash });
    for (const folder of ["archive", "incoming"]) {
      assert.equal(fs.readFileSync(path.join(item.root, folder, item.filename), "utf8"), item.content.toString("utf8"));
    }
    assert.deepEqual(releaseApprovedRx(item), { filename: item.filename, sha256: item.expectedHash });
    fs.writeFileSync(path.join(item.root, "incoming", item.filename), "different");
    assert.throws(() => releaseApprovedRx(item), /different Innovations incoming file/);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test("refuses release when staging content no longer matches the approved hash", () => {
  const item = fixture();
  try {
    stageApprovedRx(item);
    fs.writeFileSync(path.join(item.root, "staging", item.filename), "changed");
    assert.throws(() => releaseApprovedRx(item), /staged RX content integrity check failed/);
    assert.equal(fs.existsSync(path.join(item.root, "incoming", item.filename)), false);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});
