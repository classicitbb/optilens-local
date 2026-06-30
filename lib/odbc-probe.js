const odbc = require("odbc");

function readRowValue(row, key) {
  if (!row || typeof row !== "object") return undefined;
  const target = String(key || "").toLowerCase();
  const match = Object.entries(row).find(([name]) => String(name).toLowerCase() === target);
  return match ? match[1] : undefined;
}

function readRowNumber(row, key) {
  const value = Number(readRowValue(row, key));
  return Number.isFinite(value) ? value : 0;
}

async function runOdbcProbe(connectionString, { timeoutMs = 10000, queries = [] } = {}) {
  let connection = null;

  const work = (async () => {
    connection = await odbc.connect(connectionString);
    const results = [];

    for (const query of queries) {
      results.push(await connection.query(query));
    }

    return results;
  })();

  try {
    return await withTimeout(work, timeoutMs, "ODBC probe");
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch {
        // Best-effort cleanup; the probe result already captured the failure state.
      }
    }
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  readRowNumber,
  readRowValue,
  runOdbcProbe
};
