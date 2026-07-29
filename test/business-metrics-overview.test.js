const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { periodRange, PERIODS } = require("../lib/metrics/summary");
const { DRILL_KINDS } = require("../lib/metrics/drill");
const { DETAIL_SECTIONS } = require("../lib/metrics/detail");

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

  const referenced = new Set();
  for (const m of sources.matchAll(/data-drill="([a-z-]+)/g)) referenced.add(m[1]);
  for (const m of sources.matchAll(/openRow\("([a-z-]+)/g)) referenced.add(m[1]);
  for (const m of sources.matchAll(/data-open="([a-z-]+)/g)) referenced.add(m[1]);

  // Tables built from data already in the page rather than fetched.
  const localOnly = new Set(["sales-months", "profit-customers", "profit-groups",
    "archive-customers", "archive-months"]);

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

test("every tab panel maps to a detail section", () => {
  const html = readPublic("business-metrics.html");
  const inMarkup = [...html.matchAll(/data-section="([a-z]+)"/g)].map((m) => m[1]);

  assert.deepStrictEqual(inMarkup.slice().sort(), DETAIL_SECTIONS.slice().sort());
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
