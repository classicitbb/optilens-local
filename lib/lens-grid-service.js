const sql = require('mssql');
const { getConfig } = require('./config');

/** Helper to get a connected pool for the reporting DB */
async function getReportingPool() {
  const cfg = getConfig();
  if (!cfg.reportingDb) throw new Error('Reporting DB configuration missing');
  const pool = new sql.ConnectionPool({
    server: cfg.reportingDb.server,
    database: cfg.reportingDb.database,
    user: cfg.reportingDb.user,
    password: cfg.reportingDb.password,
    options: {
      encrypt: cfg.reportingDb.encrypt,
      trustServerCertificate: cfg.reportingDb.trustServerCertificate
    },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 8000,
    requestTimeout: 12000
  });
  await pool.connect();
  return pool;
}

/** Retrieve a list of distinct lens names with on‑hand quantity */
async function getLensSummary() {
  const pool = await getReportingPool();
  try {
    const result = await pool.request()
      .query('SELECT DISTINCT LensName AS name FROM LensesOnHand WHERE Quantity > 0 ORDER BY LensName');
    return result.recordset;
  } finally {
    await pool.close();
  }
}

/** Retrieve detailed on‑hand quantities for a specific lens */
async function getLensDetails(lensName) {
  if (!lensName) throw new Error('lensName is required');
  const pool = await getReportingPool();
  try {
    const result = await pool.request()
      .input('lensName', sql.NVarChar, lensName)
      .query(`SELECT Base, Sphere, Add, Cyl, Quantity FROM LensesOnHand WHERE LensName = @lensName AND Quantity > 0 ORDER BY Base, Sphere, Add, Cyl`);
    return result.recordset;
  } finally {
    await pool.close();
  }
}

/** Stream CSV for summary or detail */
async function streamLensCsv(res, lensName = null) {
  const pool = await getReportingPool();
  try {
    const request = pool.request();
    let query;
    if (lensName) {
      request.input('lensName', sql.NVarChar, lensName);
      query = `SELECT Base, Sphere, Add, Cyl, Quantity FROM LensesOnHand WHERE LensName = @lensName AND Quantity > 0 ORDER BY Base, Sphere, Add, Cyl`;
    } else {
      query = `SELECT LensName, SUM(Quantity) AS totalQty FROM LensesOnHand GROUP BY LensName ORDER BY LensName`;
    }
    const result = await request.query(query);
    const header = lensName ? 'Base,Sphere,Add,Cyl,Quantity\n' : 'LensName,TotalQuantity\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="lens-${lensName || 'summary'}.csv"`);
    res.write(header);
    for (const r of result.recordset) {
      if (lensName) {
        res.write(`${r.Base},${r.Sphere},${r.Add},${r.Cyl},${r.Quantity}\n`);
      } else {
        res.write(`${r.LensName},${r.totalQty}\n`);
      }
    }
    res.end();
  } finally {
    await pool.close();
  }
}

module.exports = { getLensSummary, getLensDetails, streamLensCsv };
