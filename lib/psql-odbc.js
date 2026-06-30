const { getConfig } = require("./config");
const { readRowNumber, runOdbcProbe } = require("./odbc-probe");

function hasPsqlCredentials(config) {
  return Boolean(config.user && config.password);
}

function connectionStrings(config) {
  const auth = [
    ["UID", config.user],
    ["PWD", config.password]
  ];

  const strings = [];

  if (config.dsn) {
    strings.push([
      ["DSN", config.dsn],
      ...auth
    ].map(([key, value]) => `${key}=${odbcValue(value)}`).join(";"));
  }

  if (config.driver && config.host && config.port && config.database) {
    strings.push([
      ["Driver", config.driver],
      ["ServerName", `${config.host}.${config.port}`],
      ["DBQ", config.database],
      ...auth
    ].map(([key, value]) => `${key}=${odbcValue(value)}`).join(";"));
  }

  return [...new Set(strings)];
}

function odbcValue(value) {
  const text = String(value ?? "");
  if (!/[;{}]/.test(text)) return text;
  return `{${text.replaceAll("}", "}}")}}`;
}

async function checkPsqlConfig(config) {
  if (!hasPsqlCredentials(config)) {
    return {
      name: "PSQL Innovations",
      state: "credentials-needed",
      detail: `Set PSQL credentials in the shared vault for ${config.dsn || `${config.host}/${config.database}`}.`
    };
  }

  try {
    const result = await runFirstSuccessfulProbe(connectionStrings(config));
    return {
      name: "PSQL Innovations",
      state: "online",
      detail: `Shipments ${Number(result.shipments).toLocaleString()}, ShipmentItems ${Number(result.shipmentItems).toLocaleString()}`
    };
  } catch (error) {
    return {
      name: "PSQL Innovations",
      state: "error",
      detail: error.message
    };
  }
}

async function checkPsqlDatabase() {
  return checkPsqlConfig(getConfig().sourcePsql);
}

async function runFirstSuccessfulProbe(strings) {
  let lastError;
  for (const item of strings) {
    try {
      return await runHealthProbe(item);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("No PSQL ODBC connection string is configured.");
}

function runHealthProbe(connectionString) {
  return runOdbcProbe(connectionString, {
    timeoutMs: 10000,
    queries: [
      "SELECT COUNT(*) AS shipments FROM Shipments",
      "SELECT COUNT(*) AS shipmentItems FROM ShipmentItems"
    ]
  }).then(([shipmentsRows, shipmentItemsRows]) => ({
    shipments: readRowNumber(shipmentsRows?.[0], "shipments"),
    shipmentItems: readRowNumber(shipmentItemsRows?.[0], "shipmentItems")
  }));
}

module.exports = {
  checkPsqlConfig,
  checkPsqlDatabase
};
