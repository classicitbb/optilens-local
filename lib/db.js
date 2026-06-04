const sql = require("mssql");
const { getConfig } = require("./config");

let appPoolPromise;
let sourcePoolPromise;

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

  return appPoolPromise;
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

async function getSourcePool() {
  const config = getConfig();

  if (!hasSqlCredentials(config.sourceMssql)) {
    throw new Error("Source MSSQL credentials are not configured.");
  }

  if (!sourcePoolPromise) {
    sourcePoolPromise = new sql.ConnectionPool({
      server: config.sourceMssql.server,
      database: config.sourceMssql.database,
      user: config.sourceMssql.user,
      password: config.sourceMssql.password,
      options: {
        encrypt: config.sourceMssql.encrypt,
        trustServerCertificate: config.sourceMssql.trustServerCertificate
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

  return sourcePoolPromise;
}

async function checkSourceDatabase() {
  const config = getConfig();

  if (!hasSqlCredentials(config.sourceMssql)) {
    return {
      name: "Source MSSQL Innovations",
      state: "credentials-needed",
      detail: `Set source MSSQL credentials for ${config.sourceMssql.server}/${config.sourceMssql.database}.`
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
  getSourcePool
};
