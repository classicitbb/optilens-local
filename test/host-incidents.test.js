const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createHostIncidentReporter } = require("../lib/host-incidents");

test("persists incidents and suppresses duplicate delivery during the cooldown", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-host-incidents-"));
  const requests = [];
  try {
    const reporter = createHostIncidentReporter({
      dataDir: root,
      now: () => 1_000,
      fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 202 }; },
    });
    const first = await reporter.report({ fingerprint: "source-db", title: "Source offline", message: "offline" });
    const second = await reporter.report({ fingerprint: "source-db", title: "Source offline", message: "offline" });
    assert.equal(first.suppressed, false);
    assert.equal(second.suppressed, true);
    assert.equal(requests.length, 0);
    assert.equal(fs.readFileSync(path.join(root, "host-incidents.jsonl"), "utf8").trim().split("\n").length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
