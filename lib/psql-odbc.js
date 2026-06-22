const { spawn } = require("node:child_process");
const { getConfig } = require("./config");

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
  const script = [
    "$ErrorActionPreference = \"Stop\"",
    "$inputJson = [Console]::In.ReadToEnd()",
    "$payload = $inputJson | ConvertFrom-Json",
    "$conn = [System.Data.Odbc.OdbcConnection]::new($payload.connectionString)",
    "try {",
    "  $conn.Open()",
    "  $shipmentsCmd = $conn.CreateCommand()",
    "  $shipmentsCmd.CommandText = \"SELECT COUNT(*) FROM Shipments\"",
    "  $shipments = $shipmentsCmd.ExecuteScalar()",
    "  $itemsCmd = $conn.CreateCommand()",
    "  $itemsCmd.CommandText = \"SELECT COUNT(*) FROM ShipmentItems\"",
    "  $shipmentItems = $itemsCmd.ExecuteScalar()",
    "  $result = @{ shipments = $shipments; shipmentItems = $shipmentItems }",
    "  [Console]::Out.Write(($result | ConvertTo-Json -Compress))",
    "}",
    "finally {",
    "  if ($conn.State -eq \"Open\") { $conn.Close() }",
    "}"
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("PSQL ODBC health check timed out."));
    }, 10000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(cleanPowerShellError(stderr) || `PSQL ODBC health check failed with exit code ${code}.`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("PSQL ODBC health check returned invalid JSON."));
      }
    });

    child.stdin.end(JSON.stringify({ connectionString }));
  });
}

function cleanPowerShellError(stderr) {
  return String(stderr || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
}

module.exports = {
  checkPsqlConfig,
  checkPsqlDatabase
};
