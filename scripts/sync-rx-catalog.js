const { syncRxCatalog } = require("../lib/rx-catalog-sync");
const fs = require("node:fs");
const path = require("node:path");
const logFile = path.join(__dirname, "..", "data", "logs", "rx-catalog-sync.jsonl");
function log(event, details = {}) { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`); }

syncRxCatalog()
  .then((result) => { log("sync.finished", { ok: true, aliases: result.validPricingAliases }); console.log(JSON.stringify(result, null, 2)); })
  .catch((error) => {
    log("sync.failed", { ok: false, error: error.message });
    console.error(`RX catalogue sync failed: ${error.message}`);
    process.exit(1);
  });
