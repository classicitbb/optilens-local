const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { periodRange, PERIODS } = require("../lib/metrics/summary");
const { DRILL_KINDS } = require("../lib/metrics/drill");
const { DETAIL_SECTIONS } = require("../lib/metrics/detail");
const {
  buildConformanceQuery, buildGapsQuery, buildFarmoutLabsQuery,
  TEMPLATE_PRICE_LIST_ID, SUPPLIER_COST_GROUP, COST_LIST_CHECKS
} = require("../lib/metrics/cost-lists");

const PUBLIC = path.join(__dirname, "..", "public");
const readPublic = (f) => fs.readFileSync(path.join(PUBLIC, f), "utf8");

const iso = (d) => d.toISOString().slice(0, 10);

test("period windows start where the period starts and end tomorrow", () => {
  // 2026-07-29 — mid-month, in Q3.
  const now = new Date(2026, 6, 29, 14, 30);

  assert.strictEqual(iso(periodRange("mtd", now).start), "2026-07-01");
  assert.strictEqual(iso(periodRange("qtd", now).start), "2026-07-01", "Q3 starts in July");
  assert.strictEqual(iso(periodRange("ytd", now).start), "2026-01-01");
  assert.strictEqual(iso(periodRange("r12", now).start), "2025-08-01", "rolling 12 covers 12 whole months");

  // End is exclusive and one day past today, so today's rows are included.
  for (const key of Object.keys(PERIODS)) {
    assert.strictEqual(iso(periodRange(key, now).end), "2026-07-30", `${key} end`);
  }
});

test("prior windows are the same span a year earlier, so comparators are like-for-like", () => {
  const now = new Date(2026, 6, 29);

  const ytd = periodRange("ytd", now);
  assert.strictEqual(iso(ytd.priorStart), "2025-01-01");
  assert.strictEqual(iso(ytd.priorEnd), "2025-07-30");

  const mtd = periodRange("mtd", now);
  assert.strictEqual(iso(mtd.priorStart), "2025-07-01");
  assert.strictEqual(iso(mtd.priorEnd), "2025-07-30");

  // Rolling 12 compares against the 12 months immediately before it, not last year.
  const r12 = periodRange("r12", now);
  assert.strictEqual(iso(r12.priorStart), "2024-08-01");
  assert.strictEqual(iso(r12.priorEnd), iso(r12.start));
});

test("quarter boundaries land on the right month", () => {
  const q = (month) => iso(periodRange("qtd", new Date(2026, month, 15)).start);
  assert.strictEqual(q(0), "2026-01-01");   // Jan → Q1
  assert.strictEqual(q(4), "2026-04-01");   // May → Q2
  assert.strictEqual(q(8), "2026-07-01");   // Sep → Q3
  assert.strictEqual(q(11), "2026-10-01");  // Dec → Q4
});

test("period windows survive a January rollover", () => {
  const jan1 = new Date(2026, 0, 1, 9, 0);
  const r = periodRange("mtd", jan1);
  assert.strictEqual(iso(r.start), "2026-01-01");
  assert.strictEqual(iso(r.end), "2026-01-02");
  assert.strictEqual(iso(r.priorStart), "2025-01-01");

  assert.strictEqual(iso(periodRange("r12", jan1).start), "2025-02-01");
});

test("an unknown period falls back to year to date rather than throwing", () => {
  const now = new Date(2026, 6, 29);
  assert.deepStrictEqual(periodRange("nonsense", now), periodRange("ytd", now));
});

// The front-end addresses drills and sections by name in data-drill / data-open /
// data-section attributes. A rename on either side would break silently in the browser,
// so assert the two sides still agree.
test("every drill the front-end references exists on the server", () => {
  const sources = [
    readPublic("business-metrics-overview.js"),
    readPublic("business-metrics-tabs.js")
  ].join("\n");

  // Keys may be "kind", "kind:arg" or "kind?query". Capture the kind only.
  const referenced = new Set();
  for (const m of sources.matchAll(/data-drill="([a-z-]+)/g)) referenced.add(m[1]);
  for (const m of sources.matchAll(/openRow\("([a-z-]+)/g)) referenced.add(m[1]);
  for (const m of sources.matchAll(/data-open="([a-z-]+)/g)) referenced.add(m[1]);

  // Tables built from data already in the page rather than fetched. Derived from the
  // source rather than hand-listed, so adding a local table cannot break this guard.
  const localOnly = new Set();
  for (const m of readPublic("business-metrics-tabs.js").matchAll(/^\s*"([a-z-]+(?::[a-z-]+)?)":\s*function/gm)) {
    localOnly.add(m[1].split(":")[0]);
  }
  for (const m of sources.matchAll(/registerLocalDrill\("([a-z-]+)"/g)) localOnly.add(m[1]);

  assert.ok(referenced.size > 0, "expected to find drill references in the front-end");

  for (const kind of referenced) {
    if (localOnly.has(kind)) continue;
    assert.ok(DRILL_KINDS.includes(kind),
      `front-end opens drill "${kind}" but lib/metrics/drill.js has no handler for it`);
  }
});

test("every local drill table the front-end builds is actually registered", () => {
  const tabs = readPublic("business-metrics-tabs.js");
  const overview = readPublic("business-metrics-overview.js");

  for (const key of ["profit-customers", "profit-groups", "archive-customers", "archive-months"]) {
    assert.ok(tabs.includes(`"${key}"`), `LOCAL_TABLES is missing ${key}`);
  }
  assert.ok(overview.includes('registerLocalDrill("sales-months"'),
    "overview must register sales-months locally so it costs no round trip");
});

// Asserted one-way on purpose. A panel naming a section that does not exist 404s at
// runtime, so that must never happen. A section with no panel yet is just backend built
// ahead of its UI, which is normal while a tab is being developed.
test("every tab panel maps to a detail section", () => {
  const html = readPublic("business-metrics.html");
  const inMarkup = [...html.matchAll(/data-section="([a-z-]+)"/g)].map((m) => m[1]);

  assert.ok(inMarkup.length > 0, "expected the page to declare tab panels");

  for (const section of inMarkup) {
    assert.ok(DETAIL_SECTIONS.includes(section),
      `business-metrics.html has a panel for "${section}" but lib/metrics/detail.js has no such section`);
  }
});

test("cost list queries are parameterised and target supplier cost lists only", () => {
  const conformance = buildConformanceQuery();

  assert.match(conformance, /@templateId/, "template list must be a parameter, not inlined");
  assert.match(conformance, /PricelistGroup\s*=\s*@costGroup/,
    "must filter to the supplier cost group rather than all pricelists");
  assert.doesNotMatch(conformance, /PriceListID\s*=\s*125/,
    "the template id must not be hard-coded into the SQL");

  // 125 is pinned by id because the list was renamed from CODEX TEST ACTIAN 20260720.
  assert.strictEqual(TEMPLATE_PRICE_LIST_ID, 125);
  assert.strictEqual(SUPPLIER_COST_GROUP, 1);
});

test("cost list attribute joins use the full composite key, not a single num", () => {
  const gaps = buildGapsQuery();

  // Materials, MFTypes, LensType and LensOptions are all composite-keyed. Joining on
  // one column silently fans out and produces wrong names.
  assert.match(gaps, /dbo\.Materials\s+m[\s\S]*?m\.MtrlNum[\s\S]*?m\.GroupNum/);
  assert.match(gaps, /dbo\.LensType\s+lt[\s\S]*?lt\.Lnum[\s\S]*?lt\.MFnum[\s\S]*?lt\.Matlnum[\s\S]*?lt\.Groupnum/);
  assert.match(gaps, /dbo\.LensOptions\s+lo[\s\S]*?lo\.Num[\s\S]*?lo\.Lnum[\s\S]*?lo\.MFnum[\s\S]*?lo\.Matlnum[\s\S]*?lo\.Groupnum/);
  assert.match(gaps, /@priceListId/);
  assert.match(gaps, /@rowLimit/);
});

test("farmout labs join Labs.num, not Labs.LabID", () => {
  // Farmouts.LabID references Labs.num. Joining Labs.LabID silently returns the wrong lab.
  assert.match(buildFarmoutLabsQuery(), /dbo\.Labs\s+l\s+ON\s+l\.num\s*=\s*f\.LabID/);
});

test("the cost list report never writes to Innovations", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "metrics", "cost-lists.js"), "utf8");
  const code = source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  for (const verb of ["INSERT ", "UPDATE ", "DELETE ", "MERGE ", "DROP ", "ALTER "]) {
    assert.ok(!new RegExp(verb, "i").test(code),
      `cost-lists.js contains "${verb.trim()}" — this report must be strictly read-only`);
  }
});

test("cost list checks are registered so the front-end cannot drift", () => {
  assert.deepStrictEqual(
    COST_LIST_CHECKS.slice().sort(),
    ["duplicate-name", "no-costs", "no-sheets", "stale", "unlisted-lab"]
  );
  assert.ok(DRILL_KINDS.includes("cost-list-gaps"));
  assert.ok(DETAIL_SECTIONS.includes("cost-lists"));
});

test("the optional supplier crosswalk is valid and pins lists by id when configured", () => {
  const file = path.join(__dirname, "..", "data", "pricelist", "supplier-costlist-crosswalk.json");
  // The crosswalk is site-owned operational data and is deliberately ignored by
  // Git. Cost-list reporting degrades safely without it, so a clean checkout
  // must not fail its update gate merely because the local mapping has not yet
  // been supplied.
  if (!fs.existsSync(file)) return;
test("the supplier crosswalk is valid and pins lists by id", () => {
  const file = path.join(__dirname, "..", "lib", "metrics", "supplier-costlist-crosswalk.json");

  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));

  // Must not live under data/ — .gitignore excludes data/*, so it would never deploy.
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "data", "pricelist", "supplier-costlist-crosswalk.json")),
    "the crosswalk must not live under data/, which is gitignored and never reaches the host");

  assert.ok(Array.isArray(parsed.lists) && parsed.lists.length > 0);

  const ids = new Set();
  for (const row of parsed.lists) {
    assert.strictEqual(typeof row.priceListId, "number", `${row.priceListName} needs a numeric priceListId`);
    assert.ok(!ids.has(row.priceListId), `duplicate priceListId ${row.priceListId} in the crosswalk`);
    ids.add(row.priceListId);
    assert.ok("catalogueSupplier" in row,
      `${row.priceListName} must state catalogueSupplier, even if null, so gaps are explicit`);
  }

  const template = parsed.lists.find((r) => r.isTemplate);
  assert.ok(template, "the crosswalk must identify the template list");
  assert.strictEqual(template.priceListId, TEMPLATE_PRICE_LIST_ID);
});

// lib/migrations.js is a hand-maintained ordered list, not a directory scan.
// 020-standards-catalog-option-index.sql was never added to it and has to be run by hand
// to this day (see docs/beswift-downstream-todo.md). This catches the next one.
test("every migration file is registered in lib/migrations.js", () => {
  const dir = path.join(__dirname, "..", "database");
  const registry = fs.readFileSync(path.join(__dirname, "..", "lib", "migrations.js"), "utf8");

  // Deliberately not in the runner:
  //   001 creates the database itself, so it cannot run against that database
  //   005 is a destructive test-data utility, run by hand only
  //   020 is the known gap — documented in docs/beswift-downstream-todo.md and still
  //       applied manually. Pinned here so it stays visible rather than forgotten.
  const KNOWN_UNREGISTERED = [
    "001-create-database.sql",
    "005-utility-clean-test-data.sql",
    "020-standards-catalog-option-index.sql"
  ];

  const onDisk = fs.readdirSync(dir)
    .filter((f) => /^\d{3}-.*\.sql$/.test(f) && !f.includes(".rollback."));

  const missing = onDisk
    .filter((f) => !registry.includes(`"${f}"`))
    .filter((f) => !KNOWN_UNREGISTERED.includes(f));

  assert.deepStrictEqual(missing, [],
    `these migrations exist on disk but are not listed in lib/migrations.js, so they will never run: ${missing.join(", ")}`);
});

test("the overview never reaches for the monolith or the Actian source", () => {
  const overview = readPublic("business-metrics-overview.js");
  const summary = fs.readFileSync(path.join(__dirname, "..", "lib", "metrics", "summary.js"), "utf8");

  assert.ok(!/["']\/api\/business-metrics["']/.test(overview),
    "overview must use the slim summary endpoint, not /api/business-metrics");

  // Match identifiers, not the word "psql" — the comments legitimately mention it.
  const code = summary.replace(/\/\/[^\n]*/g, "");
  assert.ok(!/checkPsqlDatabase|psql-odbc|psqlDatabase/.test(code),
    "the overview summary must not read the Actian/PSQL source");
  assert.ok(!/getAppPool/.test(code), "the overview summary must not read the app database");
  assert.ok(!/getIntegrationHealthSnapshot/.test(code),
    "the overview summary must check only its own source, not the full integration snapshot");
});

// CategoryType 16 is Package, which carries zero cost by design because its components
// are costed on their own lines. Classing it as a lens inflated the zero-cost KPI by 29%
// (31 -> 22 invoices when corrected). Guard every place that classification is made.
test("packages are never treated as lenses or counted as zero-cost defects", () => {
  const files = {
    "lib/metrics/summary.js": fs.readFileSync(path.join(__dirname, "..", "lib", "metrics", "summary.js"), "utf8"),
    "lib/metrics/drill.js": fs.readFileSync(path.join(__dirname, "..", "lib", "metrics", "drill.js"), "utf8"),
    "lib/metrics/detail.js": fs.readFileSync(path.join(__dirname, "..", "lib", "metrics", "detail.js"), "utf8"),
    "lib/business-metrics.js": fs.readFileSync(path.join(__dirname, "..", "lib", "business-metrics.js"), "utf8")
  };

  for (const [name, source] of Object.entries(files)) {
    const code = source.replace(/--[^\n]*/g, "").replace(/\/\/[^\n]*/g, "");
    assert.ok(!/CategoryType\s+IN\s*\(\s*1\s*,\s*16/.test(code),
      `${name} still classifies CategoryType 16 (Package) alongside 1 (Lens)`);
    assert.ok(!/CategoryType\s+IN\s*\([^)]*\b16\b[^)]*\)\s*[\s\S]{0,120}CostPrice[^\n]*=\s*0/.test(code),
      `${name} still includes Package in a zero-cost filter`);
  }
});

test("the overview summary avoids columns the mirror schema lacks", () => {
  const summary = fs.readFileSync(path.join(__dirname, "..", "lib", "metrics", "summary.js"), "utf8");
  const code = summary.replace(/--[^\n]*/g, "").replace(/\/\/[^\n]*/g, "");

  // innovations_mirror has no StockLots.OnHandCalcTime; referencing it fails to compile
  // on the mirror profile and takes the whole Overview tab offline.
  assert.ok(!/OnHandCalcTime/.test(code),
    "summary.js references StockLots.OnHandCalcTime, which does not exist in the mirror schema");
});

test("sales figures come from the journal, never from tax-inclusive invoice totals", () => {
  const summary = fs.readFileSync(path.join(__dirname, "..", "lib", "metrics", "summary.js"), "utf8");

  // CustomerBalances.SalesValueYTD is SUM(FinARSalesJournal.SubTotal) keyed on
  // InvoiceTime. Recomputing from Invoices.Total over ShippedTime lands ~25% high and
  // would make every comparator quote a different population than the headline value.
  assert.ok(/FinARSalesJournal/.test(summary), "sales must be sourced from FinARSalesJournal");
  assert.ok(/SubTotal/.test(summary), "sales must use SubTotal, which is tax-exclusive");

  const salesQuery = summary.slice(summary.indexOf("-- 0:"), summary.indexOf("-- 2:"));
  assert.ok(!/ShippedTime/.test(salesQuery),
    "sales and trend must key on InvoiceTime, not Orders.ShippedTime");
});
