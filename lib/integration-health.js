const { checkAppDatabase, checkSourceDatabase } = require("./db");
const { getInnovationsSyncStatus } = require("./innovations-sync-status");
const { getRxCatalogSyncStatus } = require("./rx-catalog-sync-status");

const CACHE_TTL_MS = 15000;

let cache = null;
let inFlight = null;

async function getIntegrationHealthSnapshot({ force = false } = {}) {
  const cached = !force ? readCache() : null;
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = loadSnapshot().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

function readCache() {
  if (!cache) return null;
  if (Date.now() - cache.generatedAt > CACHE_TTL_MS) return null;
  return cache.snapshot;
}

async function loadSnapshot() {
  const [appDbHealth, sourceDbHealth, syncHealth] = await Promise.all([
    checkAppDatabase(),
    checkSourceDatabase(),
    Promise.resolve(getInnovationsSyncStatus())
  ]);

  const snapshot = {
    ok: appDbHealth.state === "online" && sourceDbHealth.state === "online",
    service: "optilens-local",
    checkedAt: new Date().toISOString(),
    appDatabase: appDbHealth,
    sourceDatabase: sourceDbHealth,
    innovationsSync: syncHealth,
    rxAliasSync: getRxCatalogSyncStatus()
  };

  cache = {
    generatedAt: Date.now(),
    snapshot
  };

  return snapshot;
}

module.exports = {
  getIntegrationHealthSnapshot
};
