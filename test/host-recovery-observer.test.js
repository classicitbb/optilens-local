"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createHostRecoveryObserver } = require("../lib/host-recovery-observer");

test("host recovery observer classifies active port collisions without proposing source edits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-recovery-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(root, "server.err.log"), "OptiLens recovery observer boot 2026-08-24T14:00:00.000Z\nError: listen EADDRINUSE: address already in use 0.0.0.0:8080\n");
  const report = createHostRecoveryObserver({ projectRoot: root, dataDir }).inspect();
  assert.equal(report.healthy, false);
  assert.equal(report.findings[0].code, "port-in-use");
  assert.deepEqual(report.proposal.sourceEdits, []);
});
