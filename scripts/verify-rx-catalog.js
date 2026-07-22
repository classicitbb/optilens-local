const fs = require("node:fs");
const path = require("node:path");
const { connectZen } = require("../lib/zen-source");

const ROOT = path.join(__dirname, "..");
const RX_DIR = path.join(ROOT, "data", "rx");

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(RX_DIR, name), "utf8"));
}

async function verify() {
  const catalog = readJson("catalog.generated.json");
  const addons = readJson("addons.generated.json");
  const connection = await connectZen();
  try {
    const aliases = await connection.query('SELECT "Alias" AS alias FROM "LensAlias"');
    const misc = await connection.query('SELECT "SKU" AS sku, "Alias" AS alias FROM "MiscItems"');
    const sourceAliases = new Set(aliases.map((row) => String(row.alias || "").trim()));
    const sourceMisc = new Set(misc.flatMap((row) => [row.sku, row.alias].map((value) => String(value || "").trim())).filter(Boolean));
    const invalidAliases = catalog.map((row) => row.alias).filter((alias) => !sourceAliases.has(alias));
    const invalidMisc = addons.map((row) => row.sku).filter((sku) => !sourceMisc.has(sku));
    const result = { aliasesChecked: catalog.length, invalidAliases, miscChecked: addons.length, invalidMisc };
    console.log(JSON.stringify(result, null, 2));
    if (invalidAliases.length || invalidMisc.length) process.exitCode = 1;
  } finally {
    await connection.close();
  }
}

verify().catch((error) => {
  console.error(`RX catalogue verification failed: ${error.message}`);
  process.exit(1);
});
