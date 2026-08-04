#!/usr/bin/env node
const { runLensStatusSync } = require("../lib/actian-lens-status-sync");

runLensStatusSync({ dryRun: process.argv.includes("--dry-run"), trigger: "scheduled" })
  .then((result) => { console.log(JSON.stringify(result, null, 2)); process.exit(0); })
  .catch((error) => { console.error(`Actian lens status sync failed: ${error.message}`); process.exit(1); });
