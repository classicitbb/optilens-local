/**
 * Shared helpers for the Inventory Intelligence tests.
 *
 * The services run against their in-memory model (explicit test mode). The
 * Innovations source is faked at the pool: every statement sent to it is
 * recorded so tests can prove the source is only ever read.
 */

const { mock } = require("node:test");
const db = require("../lib/db");
const store = require("../lib/inventory/store");
const { setAutoDrain } = require("../lib/inventory/scan-runner");

function setup() {
  store.setTestMode(true);
  setAutoDrain(false); // tests drain the queue explicitly
  store.resetMemory();
  mock.restoreAll();
}

/** A raw row as the evidence query returns it. */
function liveRow(overrides = {}) {
  return {
    mg: 1, mt: 1, mf: 1, lt: 1, op: 1, it: 100,
    itemName: "Lens 100", unitCost: 10, skuR: "SKU-100", skuL: null,
    onHand: 0, onOrder: 0,
    manufacturerNum: 5, supplierNum: 5, supplierName: "Supplier Five",
    usage30: 0, usage90: 0, lastMoved: null,
    ...overrides
  };
}

function itemIdOf(row) {
  return `${row.mg}:${row.mt}:${row.mf}:${row.lt}:${row.op}:${row.it}`;
}

/**
 * Replaces the live source pool with a fake. `rows` is an array or a function
 * returning one, so a test can change the source between scans. Returns the
 * list of statements the source received.
 */
function fakeSource(rows) {
  const statements = [];
  const pool = {
    request() {
      const inputs = {};
      const req = {
        input(name, _type, value) { inputs[name] = value; return req; },
        async query(text) {
          statements.push({ text, inputs: { ...inputs } });
          let result = typeof rows === "function" ? rows() : rows;
          if (inputs.mg0 !== undefined) {
            const keys = [];
            for (let i = 0; inputs[`mg${i}`] !== undefined; i += 1) {
              keys.push([inputs[`mg${i}`], inputs[`mt${i}`], inputs[`mf${i}`], inputs[`lt${i}`], inputs[`op${i}`], inputs[`it${i}`]].join(":"));
            }
            result = result.filter((r) => keys.includes(itemIdOf(r)));
          }
          if (inputs.rowLimit) result = result.slice(0, inputs.rowLimit);
          return { recordset: result };
        }
      };
      return req;
    }
  };
  mock.method(db, "getLiveSourcePool", async () => pool);
  return statements;
}

function brokenSource(message = "Login failed for user 'svc_secret' (password: hunter2)") {
  mock.method(db, "getLiveSourcePool", async () => { throw new Error(message); });
}

module.exports = { setup, liveRow, itemIdOf, fakeSource, brokenSource };
