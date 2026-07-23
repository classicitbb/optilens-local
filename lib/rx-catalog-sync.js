const fs = require("node:fs");
const path = require("node:path");
const { connectZen } = require("./zen-source");

const ROOT = path.join(__dirname, "..");
const PRICING_ROWS_FILE = path.join(ROOT, "data", "pricelist", "catalog-rows.generated.json");
const RX_DIR = path.join(ROOT, "data", "rx");
const CATALOG_FILE = path.join(RX_DIR, "catalog.generated.json");
const ADDONS_FILE = path.join(RX_DIR, "addons.generated.json");
const COATINGS_FILE = path.join(RX_DIR, "coatings.generated.json");
const METADATA_FILE = path.join(RX_DIR, "catalog-source.json");

const normalise = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
const key = (...parts) => parts.map(normalise).join("\u0001");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  fs.renameSync(temporary, file);
}

function pricingKeys() {
  const rows = readJson(PRICING_ROWS_FILE, []);
  if (!Array.isArray(rows) || !rows.length) throw new Error("Pricing Automation catalogue rows are unavailable. Refresh the pricing catalogue first.");
  const values = new Map();
  for (const row of rows) {
    if (row?.active === false || !row?.material || !row?.mftype || !row?.lenstype) continue;
    values.set(key(row.material, row.mftype, row.lenstype), {
      material: String(row.material).trim(), mfType: String(row.mftype).trim(), lensType: String(row.lenstype).trim()
    });
  }
  return values;
}

async function syncRxCatalog() {
  const pricing = pricingKeys();
  const connection = await connectZen();
  try {
    // Resolve dimensions in the same query as the alias. The dimension tables contain
    // historical duplicate keys, so independent maps can overwrite a valid description.
    const aliases = await connection.query(`SELECT DISTINCT
      a."Alias" AS alias,
      m."Name" AS material,
      mf."Name" AS mf_type,
      lt."Name" AS lens_type,
      lo."Name" AS option_name
      FROM "LensAlias" a
      JOIN "Materials" m ON m."MtrlNum" = a."MtrlNum" AND m."GroupNum" = a."GroupNum"
      JOIN "MFTypes" mf ON mf."MFNum" = a."MFNum" AND mf."MtrlNum" = a."MtrlNum" AND mf."GroupNum" = a."GroupNum"
      JOIN "LensType" lt ON lt."Lnum" = a."LNum" AND lt."MFnum" = a."MFNum" AND lt."Matlnum" = a."MtrlNum" AND lt."Groupnum" = a."GroupNum"
      JOIN "LensOptions" lo ON lo."Num" = a."OptNum" AND lo."Lnum" = a."LNum" AND lo."MFnum" = a."MFNum" AND lo."Matlnum" = a."MtrlNum" AND lo."Groupnum" = a."GroupNum"`);
    const [miscRows, miscGroups] = await Promise.all([
      connection.query('SELECT "MiscItemID" AS item_id, "MiscItemGroupID" AS group_id, "Alias" AS alias, "SKU" AS sku, "Desc1" AS description, "DefaultRxQuantity" AS default_quantity FROM "MiscItems"'),
      connection.query('SELECT "MiscItemGroupID" AS group_id, "MiscItemGroupPID" AS parent_group_id, "MiscItemGroupName" AS name FROM "MiscItemGroups"')
    ]);

    const seen = new Set();
    const records = [];

    for (const row of aliases) {
      const alias = String(row.alias || "").trim();
      if (!/^\d{13}$/.test(alias) || seen.has(alias)) continue;
      const material = String(row.material || "").trim();
      const mfType = String(row.mf_type || "").trim();
      const lensType = String(row.lens_type || "").trim();
      const lensOption = String(row.option_name || "").trim();
      const priceRow = pricing.get(key(material, mfType, lensType));
      if (!priceRow || !lensOption) continue;
      seen.add(alias);
      records.push({
        alias,
        materialCode: alias.slice(0, 3),
        materialDescription: material,
        styleCode: alias.slice(3, 8),
        styleDescription: lensType,
        colorCode: alias.slice(8, 13),
        colorDescription: lensOption,
        mfType,
        category: mfType,
        pricingKey: `${priceRow.material} | ${priceRow.mfType} | ${priceRow.lensType}`,
        source: "Innovations LensAlias"
      });
    }

    records.sort((left, right) => left.alias.localeCompare(right.alias));
    const matchedPricingKeys = new Set(records.map((row) => key(row.materialDescription, row.mfType, row.styleDescription)));
    const unmatchedPricing = [...pricing.values()].filter((row) => !matchedPricingKeys.has(key(row.material, row.mfType, row.lensType)));
    const groupsByParent = new Map();
    const groupNames = new Map(miscGroups.map((group) => [Number(group.group_id), String(group.name || "").trim()]));
    for (const group of miscGroups) {
      const parent = Number(group.parent_group_id);
      if (!Number.isInteger(parent)) continue;
      const children = groupsByParent.get(parent) || [];
      children.push(Number(group.group_id));
      groupsByParent.set(parent, children);
    }
    const coatingGroupIds = new Set([3]);
    for (const id of coatingGroupIds) for (const child of groupsByParent.get(id) || []) coatingGroupIds.add(child);
    const misc = miscRows
      .map((row) => ({
        sku: String(row.sku || row.alias || "").trim(),
        source: "MISC",
        description: String(row.description || "").trim(),
        quantity: Math.max(1, Number(row.default_quantity || 1)),
        side: "NONE",
        partRx: "Y",
        active: true,
        sourceItemId: Number(row.item_id),
        sourceAlias: String(row.alias || "").trim(),
        groupId: Number(row.group_id),
        groupName: groupNames.get(Number(row.group_id)) || "Miscellaneous"
      }))
      .filter((row) => row.sku && row.description)
      .sort((left, right) => left.description.localeCompare(right.description));

    const edgeItem = misc.find((item) => normalise(item.description) === "edge to fit") || null;
    const coatings = misc.filter((item) => coatingGroupIds.has(item.groupId)).map((item) => ({ ...item, kind: "coating" }));
    const metadata = {
      generatedAt: new Date().toISOString(),
      source: "Innovations PSQL LensAlias / MiscItems",
      pricingSource: "data/pricelist/catalog-rows.generated.json",
      aliasesRead: aliases.length,
      validPricingAliases: records.length,
      coatingGroup: { id: 3, name: groupNames.get(3) || "Coatings", descendantGroupIds: [...coatingGroupIds].sort((a, b) => a - b) },
      coatingItems: coatings.length,
      pricingKeys: pricing.size,
      matchedPricingKeys: matchedPricingKeys.size,
      unmatchedPricingKeys: unmatchedPricing.map((row) => `${row.material} | ${row.mfType} | ${row.lensType}`),
      edgeItem
    };

    if (!records.length) throw new Error("No source aliases matched the active Pricing Automation catalogue; RX generation remains disabled.");
    writeJson(CATALOG_FILE, records);
    writeJson(ADDONS_FILE, edgeItem ? [edgeItem] : []);
    writeJson(COATINGS_FILE, coatings);
    writeJson(METADATA_FILE, metadata);
    return metadata;
  } finally {
    try { await connection.close(); } catch {}
  }
}

async function syncRxCoatings() {
  const connection = await connectZen();
  try {
    const [miscRows, miscGroups] = await Promise.all([
      connection.query('SELECT "MiscItemID" AS item_id, "MiscItemGroupID" AS group_id, "Alias" AS alias, "SKU" AS sku, "Desc1" AS description, "DefaultRxQuantity" AS default_quantity FROM "MiscItems"'),
      connection.query('SELECT "MiscItemGroupID" AS group_id, "MiscItemGroupPID" AS parent_group_id, "MiscItemGroupName" AS name FROM "MiscItemGroups"')
    ]);
    const groupsByParent = new Map();
    const groupNames = new Map(miscGroups.map((group) => [Number(group.group_id), String(group.name || "").trim()]));
    for (const group of miscGroups) {
      const parent = Number(group.parent_group_id);
      if (!Number.isInteger(parent)) continue;
      const children = groupsByParent.get(parent) || [];
      children.push(Number(group.group_id));
      groupsByParent.set(parent, children);
    }
    const coatingGroupIds = new Set([3]);
    for (const id of coatingGroupIds) for (const child of groupsByParent.get(id) || []) coatingGroupIds.add(child);
    const items = miscRows.map((row) => ({
      sku: String(row.sku || row.alias || "").trim(), source: "MISC", description: String(row.description || "").trim(),
      quantity: Math.max(1, Number(row.default_quantity || 1)), side: "NONE", partRx: "Y", active: true,
      sourceItemId: Number(row.item_id), sourceAlias: String(row.alias || "").trim(), groupId: Number(row.group_id),
      groupName: groupNames.get(Number(row.group_id)) || "Miscellaneous"
    })).filter((row) => row.sku && row.description);
    const coatings = items.filter((item) => coatingGroupIds.has(item.groupId)).map((item) => ({ ...item, kind: "coating" }));
    const edgeItem = items.find((item) => normalise(item.description) === "edge to fit") || null;
    if (!coatings.length) throw new Error("No live coating options were found in the Innovations Coatings group.");
    writeJson(ADDONS_FILE, edgeItem ? [edgeItem] : []);
    writeJson(COATINGS_FILE, coatings);
    const metadata = readJson(METADATA_FILE, {});
    writeJson(METADATA_FILE, { ...metadata, generatedAt: new Date().toISOString(), coatingItems: coatings.length, edgeItem });
    return { coatingItems: coatings.length, edgeItem };
  } finally {
    try { await connection.close(); } catch {}
  }
}

module.exports = { syncRxCatalog, syncRxCoatings, CATALOG_FILE, ADDONS_FILE, COATINGS_FILE, METADATA_FILE };
