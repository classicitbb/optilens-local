
const { getCoForShipment, prepareCoDraft, saveCoDraft, createAutomationJob, claimAutomationJob, updateAutomationJobStatus } = require("./lib/beswift-co");
// access the private function indirectly is not possible; instead require credential-vault directly
const { findVaultEntry, fieldMap } = require("./lib/credential-vault");
(async () => {
  const entry = findVaultEntry("Web Portals", ["beswift training", "beswift"]);
  const fields = fieldMap(entry || {});
  console.log("url:", fields.url || fields.portalurl || fields.baseurl || "(none, would use fallback)");
  console.log("has username:", !!(fields.username || fields.user || fields.login));
  console.log("has password:", !!(fields.password || fields.pwd));
  console.log("all field keys:", Object.keys(fields));
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
