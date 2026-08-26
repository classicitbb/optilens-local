const sql = require("mssql");
const { getConfig } = require("./config");

let appPoolPromise;
let sourcePoolPromise;
let livePoolPromise;
let sourceWritePoolPromise;
const recoveredPools = new WeakSet();

function hasSqlCredentials(dbConfig) {
  return Boolean(dbConfig.user && dbConfig.password);
}

function buildAppPool(profileConfig) {
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
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000
    },
    connectionTimeout: 8000,
    requestTimeout: 10000
  }).connect();
}

async function requireConnectedPool(poolPromise, clearPool) {
  const pool = await poolPromise;
  if (pool?.connected) return pool;

  clearPool();
  await pool?.close().catch(() => {});
  return null;
}

async function getAppPool() {
  const config = getConfig();

  if (!hasSqlCredentials(config.appDb)) {
    throw new Error("App database credentials are not configured.");
  }

  if (!appPoolPromise) {
    appPoolPromise = buildAppPool(config.appDb);
  }

  const poolPromise = appPoolPromise;
  try {
    const pool = await requireConnectedPool(poolPromise, () => {
      if (appPoolPromise === poolPromise) appPoolPromise = null;
    });
    if (!pool) return getAppPool();
    attachPoolRecovery(pool, () => { appPoolPromise = null; });
    return pool;
  } catch (error) {
    // A failed connection promise must not become a permanent outage. Clear it
    // so the next request can create a fresh pool after the network or SQL
    // service has recovered.
    if (appPoolPromise === poolPromise) appPoolPromise = null;
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
  const profileConfig = getConfig().sourceMssql;

  if (!hasSqlCredentials(profileConfig)) {
    throw new Error("Source MSSQL credentials are not configured.");
  }

  if (!sourcePoolPromise) sourcePoolPromise = buildSourcePool(profileConfig);

  const poolPromise = sourcePoolPromise;
  try {
    const pool = await requireConnectedPool(poolPromise, () => {
      if (sourcePoolPromise === poolPromise) {
        sourcePoolPromise = null;
      }
    });
    if (!pool) return getSourcePool();
    attachPoolRecovery(pool, () => {
      sourcePoolPromise = null;
    });
    return pool;
  } catch (error) {
    if (sourcePoolPromise === poolPromise) {
      sourcePoolPromise = null;
    }
    throw error;
  }
}

// Explicit source operations use the same direct Innovations MSSQL pool.
async function getLiveSourcePool() {
  const profileConfig = getConfig().sourceMssql;

  if (!hasSqlCredentials(profileConfig)) {
    throw new Error("Live source MSSQL credentials are not configured.");
  }

  if (!livePoolPromise) {
    livePoolPromise = buildSourcePool(profileConfig);
  }

  const poolPromise = livePoolPromise;
  try {
    const pool = await requireConnectedPool(poolPromise, () => {
      if (livePoolPromise === poolPromise) livePoolPromise = null;
    });
    if (!pool) return getLiveSourcePool();
    attachPoolRecovery(pool, () => { livePoolPromise = null; });
    return pool;
  } catch (error) {
    if (livePoolPromise === poolPromise) livePoolPromise = null;
    throw error;
  }
}

async function getSourceWritePool() {
  const profileConfig = getConfig().privilegedDataAccess.sources["source-mssql"].write;

  if (!profileConfig || !hasSqlCredentials(profileConfig)) {
    throw new Error("Dedicated source write credentials are not configured.");
  }

  if (!sourceWritePoolPromise) {
    sourceWritePoolPromise = buildSourcePool(profileConfig);
  }

  const poolPromise = sourceWritePoolPromise;
  try {
    const pool = await requireConnectedPool(poolPromise, () => {
      if (sourceWritePoolPromise === poolPromise) sourceWritePoolPromise = null;
    });
    if (!pool) return getSourceWritePool();
    attachPoolRecovery(pool, () => { sourceWritePoolPromise = null; });
    return pool;
  } catch (error) {
    if (sourceWritePoolPromise === poolPromise) sourceWritePoolPromise = null;
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

async function checkSourceDatabase() {
  const config = getConfig().sourceMssql;

  if (!hasSqlCredentials(config)) {
    return {
      name: "Source MSSQL Innovations",
      state: "credentials-needed",
      detail: `Set source MSSQL credentials for ${config.server}/${config.database}.`
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
      detail: `${row.database_name}, ${row.export_customer_count} export customers`
    };
  } catch (error) {
    sourcePoolPromise = null;
    return {
      name: "Source MSSQL Innovations",
      state: "error",
      detail: error.message
    };
  }
}

module.exports = {
  checkAppDatabase,
  checkSourceDatabase,
  getAppPool,
  getLiveSourcePool,
  getSourceWritePool,
  getSourcePool,
};
