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

test("an advisory full-suite test failure is reported as a warning and does not mark the host unhealthy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-recovery-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, "update-status.json"), JSON.stringify({
    state: "succeeded",
    testSuite: { ran: true, passed: false, summary: "not ok 1 - flaky\n# fail 1" }
  }));
  const report = createHostRecoveryObserver({ projectRoot: root, dataDir }).inspect();
  assert.equal(report.healthy, true);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].code, "advisory-test-failures");
  assert.equal(report.findings[0].severity, "warning");
});

test("raw TAP failure text in the update log no longer blocks recovery now that tests are advisory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-recovery-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  const stamp = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, "local-update.log"), `${stamp} [application tests] FAILED (advisory; not blocking this update) in 12.3s.\nnot ok 4 - some flaky test\n# fail 1\n${stamp} Update completed.\n`);
  const report = createHostRecoveryObserver({ projectRoot: root, dataDir }).inspect();
  assert.equal(report.healthy, true);
  assert.deepEqual(report.findings, []);
});

test("a genuine unclassified update failure is still reported as an error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-recovery-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  const stamp = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, "local-update.log"), `${stamp} Update failed: git fast-forward merge failed with exit code 1.\n`);
  const report = createHostRecoveryObserver({ projectRoot: root, dataDir }).inspect();
  assert.equal(report.healthy, false);
  assert.equal(report.findings[0].code, "unclassified-host-failure");
});
