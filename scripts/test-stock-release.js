/**
 * Manual, one-shot connectivity test for the .stockhashref file-drop.
 * Stock orders only — unrelated to the .rx/RXI patient-prescription
 * pipeline (lib/rx-generator.js).
 *
 * Stages a clearly-marked TEST order and releases it into the REAL Incoming
 * share (data/rx/config.json -> folders.incoming). Must be run on a machine
 * that actually has \\INNOVA-SVR\Innovations\Incoming on its network (e.g.
 * INO-3FRC3Q3) — it will NOT work from an unrelated dev box or a Linux
 * sandbox, since UNC path resolution requires Windows.
 *
 * Usage:  node scripts/test-stock-release.js
 *
 * After running, check \\INNOVA-SVR\Innovations\Incoming for the filename
 * printed below, and watch how Innova's system handles it (it's marked
 * TEST / DO NOT PROCESS throughout, but nothing stops their intake from
 * picking it up like a real order).
 */
const fs = require("node:fs");
const path = require("node:path");
const gen = require("../lib/stock-order-generator");

const CONFIG_FILE = path.join(__dirname, "..", "data", "rx", "config.json");
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);

const payload = {
  customer: { custNum: config.defaults.custNum, shipName: config.defaults.shipName },
  poNum: `CLAUDE-TEST-${stamp}`,
  patientName: `CLAUDE TEST DO NOT PROCESS ${stamp}`,
  instructions: `TEST ORDER - stock order pipeline connectivity check - please ignore / do not fulfill - ${new Date().toISOString()}`,
  items: [
    { sku: "0011751138", source: "FLENS", description: "TEST DO NOT PROCESS - pipeline connectivity check", quantity: 1, comment: "TEST" },
  ],
};

console.log(`Incoming target: ${config.folders.incoming}`);
const staged = gen.generate(payload, { username: "connectivity-test" });
console.log(`Staged: ${staged.filename}`);

const released = gen.release({ filenames: [staged.filename] }, { username: "connectivity-test" });
console.log(`Released: ${JSON.stringify(released)}`);
console.log("Now check the Incoming share (and Innova's own order log) for that filename.");
