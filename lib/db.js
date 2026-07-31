const sql = require("mssql");
const { getConfig } = require("./config");

let appPoolPromise;
let sourcePoolPromise;
let sourcePoolProfile = null;
let mirrorPoolPromise;
let livePoolPromise;
let activeProfilePromise = null;
const recoveredPools = new WeakSet();

const SOURCE_BACKEND_SETTING = "source_backend";
const SOURCE_PROFILES = ["live", "mirror"];

function hasSqlCredentials(dbConfig) {
  return Boolean(dbConfig.user && dbConfig.password);
}

async function getAppPool() {
  const config = getConfig();

  if (!hasSqlCredentials(config.appDb)) {
    throw new Error("App database credentials are not configured.");
  }

  if (!appPoolPromise) {
    appPoolPromise = sql.connect({
      server: config.appDb.server,
      database: config.appDb.database,
      user: config.appDb.user,
      password: config.appDb.password,
      options: {
        encrypt: config.appDb.encrypt,
        trustServerCertificate: config.appDb.trustServerCertificate
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
      },
      connectionTimeout: 8000,
      requestTimeout: 10000
    });
  }

  try {
    const pool = await appPoolPromise;
    attachPoolRecovery(pool, () => { appPoolPromise = null; });
    return pool;
  } catch (error) {
    // A failed connection promise must not become a permanent outage. Clear it
    // so the next request can create a fresh pool after the network or SQL
    // service has recovered.
    appPoolPromise = null;
    throw error;
  }
}

async function checkAppDatabase() {
  const config = getConfig();

  if (!hasSqlCredentials(config.appDb)) {
    return {
      name: "Private app MSSQL",
      state: "credentials-needed",
      detail: `Set OPTILENS_DB_USER and OPTILENS_DB_PASSWORD for ${config.appDb.server}/${config.appDb.database}.`
    };
  }

  try {
    const pool = await getAppPool();
    const result = await pool.request().query(`
      SELECT
        DB_NAME() AS database_name,
        (SELECT COUNT(*) FROM core.modules) AS module_count
    `);
    const row = result.recordset[0];

    return {
      name: "Private app MSSQL",
      state: "online",
      detail: `${row.database_name}, ${row.module_count} registered modules`
    };
  } catch (error) {
    appPoolPromise = null;
    return {
      name: "Private app MSSQL",
      state: "error",
      detail: error.message
    };
  }
}

// ── Innovations source profiles ─────────────────────────────────────────────
// "live" is the vendor Innovations MSSQL; "mirror" is innovations_mirror on the
// app SQL Server, fed from Actian Zen by lib/zen-mirror-sync.js. The active
// profile is persisted in core.app_settings so the integrations-page switch
// survives restarts. All consumers go through getSourcePool() and never know
// which backend serves them.

function sourceProfileConfig(profile) {
  const config = getConfig();
  return profile === "mirror" ? config.sourceMirror : config.sourceMssql;
}

async function readSourceBackendSetting() {
  try {
    const pool = await getAppPool();
    const result = await pool.request()
      .input("key", SOURCE_BACKEND_SETTING)
      .query("SELECT setting_value FROM core.app_settings WHERE setting_key = @key");
    const value = result.recordset[0] ? result.recordset[0].setting_value : null;
    return value === "mirror" ? "mirror" : "live";
  } catch {
    // Table missing (pre-migration) or app DB briefly unavailable: behave
    // exactly as before the switch existed.
    return "live";
  }
}

async function getActiveSourceProfile() {
  if (!activeProfilePromise) {
    activeProfilePromise = readSourceBackendSetting();
  }
  return activeProfilePromise;
}

function buildSourcePool(profileConfig) {
  return new sql.ConnectionPool({
    server: profileConfig.server,
    database: profileConfig.database,
    user: profileConfig.user,
    password: profileConfig.password,
    options: {
      encrypt: profileConfig.encrypt,
      trustServerCertificate: profileConfig.trustServerCertificate
    },
    pool: {
      max: 8,
      min: 0,
      idleTimeoutMillis: 30000
    },
    connectionTimeout: 8000,
    requestTimeout: 15000
  }).connect();
}

async function getSourcePool() {
  const profile = await getActiveSourceProfile();
  const profileConfig = sourceProfileConfig(profile);

  if (!hasSqlCredentials(profileConfig)) {
    throw new Error(`Source MSSQL credentials are not configured for the "${profile}" profile.`);
  }

  if (!sourcePoolPromise || sourcePoolProfile !== profile) {
    closePoolQuietly(sourcePoolPromise);
    sourcePoolProfile = profile;
    sourcePoolPromise = buildSourcePool(profileConfig);
  }

  try {
    const pool = await sourcePoolPromise;
    attachPoolRecovery(pool, () => {
      sourcePoolPromise = null;
      sourcePoolProfile = null;
    });
    return pool;
  } catch (error) {
    sourcePoolPromise = null;
    sourcePoolProfile = null;
    throw error;
  }
}

// The mirror pool is independent of the active profile: zen-mirror-sync always
// writes to the mirror even while consumers read from "live".
async function getMirrorPool() {
  const config = getConfig().sourceMirror;

  if (!hasSqlCredentials(config)) {
    throw new Error("Mirror database credentials are not configured.");
  }

  if (!mirrorPoolPromise) {
    mirrorPoolPromise = new sql.ConnectionPool({
      server: config.server,
      database: config.database,
      user: config.user,
      password: config.password,
      options: {
        encrypt: config.encrypt,
        trustServerCertificate: config.trustServerCertificate
      },
      pool: {
        max: 4,
        min: 0,
        idleTimeoutMillis: 30000
      },
      connectionTimeout: 8000,
      requestTimeout: 120000
    }).connect();
  }

  try {
    const pool = await mirrorPoolPromise;
    attachPoolRecovery(pool, () => { mirrorPoolPromise = null; });
    return pool;
  } catch (error) {
    mirrorPoolPromise = null;
    throw error;
  }
}

// Approved source writes must never follow the active read profile. The active
// profile may be the Zen-fed mirror, while a write must target live Innovations
// MSSQL explicitly. Inventory analytics read through here too: the mirror carries
// none of the stock tables (LensItem, StockTransactions, MiscItems, POItems), so
// those queries only ever have one valid home.
//
// Cached like the mirror pool. It used to build a fresh pool per call, which
// leaked one pool per invocation — tolerable at write-back frequency, not at
// dashboard-refresh frequency.
async function getLiveSourcePool() {
  const profileConfig = sourceProfileConfig("live");

  if (!hasSqlCredentials(profileConfig)) {
    throw new Error("Live source MSSQL credentials are not configured.");
  }

  if (!livePoolPromise) {
    livePoolPromise = buildSourcePool(profileConfig);
  }

  try {
    const pool = await livePoolPromise;
    attachPoolRecovery(pool, () => { livePoolPromise = null; });
    return pool;
  } catch (error) {
    livePoolPromise = null;
    throw error;
  }
}

function attachPoolRecovery(pool, clearPool) {
  if (!pool || recoveredPools.has(pool)) return;
  recoveredPools.add(pool);
  pool.on("error", () => {
    clearPool();
    pool.close().catch(() => {});
  });
}

function closePoolQuietly(poolPromise) {
  if (!poolPromise) return;
  poolPromise.then((pool) => pool.close()).catch(() => {});
}

// Called after the source_backend setting changes so the next getSourcePool()
// re-resolves the profile and builds a pool against the new backend.
function resetSourcePool() {
  activeProfilePromise = null;
  closePoolQuietly(sourcePoolPromise);
  sourcePoolPromise = null;
  sourcePoolProfile = null;
}

async function checkSourceProfile(profile) {
  const profileConfig = sourceProfileConfig(profile);
  const label = profile === "mirror"
    ? `Innovations mirror (${profileConfig.server}/${profileConfig.database})`
    : `Vendor Innovations MSSQL (${profileConfig.server}/${profileConfig.database})`;

  if (!hasSqlCredentials(profileConfig)) {
    return { profile, name: label, state: "credentials-needed", detail: "Credentials are not configured." };
  }

  let pool;
  try {
    pool = await buildSourcePool(profileConfig);
    const result = await pool.request().query(`
      SELECT
        DB_NAME() AS database_name,
        (SELECT COUNT(*) FROM dbo.Customers) AS customer_count,
        (SELECT COUNT(*) FROM dbo.Shipments) AS shipment_count,
        (SELECT COUNT(*) FROM dbo.Orders) AS order_count
    `);
    const row = result.recordset[0];
    return {
      profile,
      name: label,
      state: "online",
      detail: `${row.database_name}: ${Number(row.customer_count).toLocaleString()} customers, ${Number(row.shipment_count).toLocaleString()} shipments, ${Number(row.order_count).toLocaleString()} orders`,
      counts: {
        customers: Number(row.customer_count),
        shipments: Number(row.shipment_count),
        orders: Number(row.order_count)
      }
    };
  } catch (error) {
    return { profile, name: label, state: "error", detail: error.message };
  } finally {
    if (pool) closePoolQuietly(Promise.resolve(pool));
  }
}

async function checkSourceDatabase() {
  const profile = await getActiveSourceProfile();
  const config = sourceProfileConfig(profile);

  if (!hasSqlCredentials(config)) {
    return {
      name: "Source MSSQL Innovations",
      state: "credentials-needed",
      detail: `Set source MSSQL credentials for ${config.server}/${config.database} (${profile} profile).`
    };
  }

  try {
    const pool = await getSourcePool();
    const result = await pool.request().query(`
      SELECT
        DB_NAME() AS database_name,
        (SELECT COUNT(*) FROM dbo.Customers WHERE ShippingMethodID = 16) AS export_customer_count
    `);
    const row = result.recordset[0];

    return {
      name: "Source MSSQL Innovations",
      state: "online",
      detail: `${row.database_name} (${profile} profile), ${row.export_customer_count} export customers`,
      activeProfile: profile
    };
  } catch (error) {
    sourcePoolPromise = null;
    sourcePoolProfile = null;
    return {
      name: "Source MSSQL Innovations",
      state: "error",
      detail: error.message,
      activeProfile: profile
    };
  }
}

module.exports = {
  SOURCE_BACKEND_SETTING,
  SOURCE_PROFILES,
  checkAppDatabase,
  checkSourceDatabase,
  checkSourceProfile,
  getActiveSourceProfile,
  getAppPool,
  getLiveSourcePool,
  getMirrorPool,
  getSourcePool,
  resetSourcePool
};
