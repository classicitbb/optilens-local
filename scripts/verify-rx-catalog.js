const fs = require("node:fs");
const path = require("node:path");
const { getSourcePool } = require("../lib/db");

const ROOT = path.join(__dirname, "..");
const RX_DIR = path.join(ROOT, "data", "rx");

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(RX_DIR, name), "utf8"));
}

async function verify() {
  const catalog = readJson("catalog.generated.json");
  const addons = readJson("addons.generated.json");
  const coatings = readJson("coatings.generated.json");
  const pool = await getSourcePool();
  {
    const aliases = (await pool.request().query('SELECT Alias AS alias FROM dbo.LensAlias')).recordset;
    const misc = (await pool.request().query('SELECT SKU AS sku, Alias AS alias FROM dbo.MiscItems')).recordset;
    const sourceAliases = new Set(aliases.map((row) => String(row.alias || "").trim()));
    const sourceMisc = new Set(misc.flatMap((row) => [row.sku, row.alias].map((value) => String(value || "").trim())).filter(Boolean));
    const invalidAliases = catalog.map((row) => row.alias).filter((alias) => !sourceAliases.has(alias));
    const miscItems = [...addons, ...coatings];
    const invalidMisc = miscItems.map((row) => row.sku).filter((sku) => !sourceMisc.has(sku));
    const result = { aliasesChecked: catalog.length, invalidAliases, coatingItemsChecked: coatings.length, automaticItemsChecked: addons.length, invalidMisc };
    console.log(JSON.stringify(result, null, 2));
    if (invalidAliases.length || invalidMisc.length) process.exitCode = 1;
  }
}

verify().catch((error) => {
  console.error(`RX catalogue verification failed: ${error.message}`);
  process.exit(1);
});
