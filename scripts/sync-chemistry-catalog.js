const { syncChemistryCatalog } = require("../lib/chemistry-catalog-sync");
const fs = require("node:fs");
const path = require("node:path");
const logFile = path.join(__dirname, "..", "data", "logs", "chemistry-catalog-sync.jsonl");
function log(event, details = {}) { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`); }

syncChemistryCatalog()
  .then((result) => { log("sync.finished", { ok: true, ...result }); console.log(JSON.stringify(result, null, 2)); })
  .catch((error) => {
    log("sync.failed", { ok: false, error: error.message });
    console.error(`Chemistry catalog sync failed: ${error.message}`);
    process.exit(1);
  });
