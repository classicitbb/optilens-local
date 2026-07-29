# Business Metrics — Overview tab redesign plan

**Scope:** tab 1 (`#overview`) of `public/business-metrics.html`. Drill-down and refresh
are built as reusable primitives so tabs 2–6 can adopt them later.

**Status:** built. Phases 0–4 complete; phase 5 (folder move, applying the drawer to
tabs 2–6) remains.

**What shipped:**

| | |
|---|---|
| `lib/metrics/summary.js` | Overview summary — journal-basis sales + comparators, trend, aging, WIP, exceptions, data quality. Innovations MSSQL only. |
| `lib/metrics/drill.js` | Eight drill handlers behind one generic envelope. |
| `server.js` | `GET /api/business-metrics/summary`, `GET /api/business-metrics/drill/:kind`, plus `handleCachedApi` (20 s cache + ETag/304). |
| `public/business-metrics-overview.js` | The whole tab: command bar, refresh manager, rail, tiles, trend, aging, customers, drill drawer, CSV. |
| `public/styles/pages/business-metrics.css` | Overview + drawer styles. |
| `public/business-metrics.html` | Overview panel replaced; monolith fetch made lazy; Actian pill dropped. |

Measured: summary payload **8.6 KB / ~140 ms warm** against the old **201 KB / 540 ms**;
conditional poll returns **304 with 0 bytes**; drills 9–55 ms. The monolith is no longer
fetched at all unless a user opens one of tabs 2–6. All 67 existing tests pass.

**Scope decisions taken after review:**

- **Actian / PSQL is out.** No Overview metric ever read from it; it appeared only as a
  status pill. Tab 1 is now sourced entirely from the Innovations MSSQL source, and shows
  a single source indicator for it.
- **The Access archive band is out** (§4.6 below is dropped). Tab 1 shows live operating
  data only. The `archive.access_*` tables still back the Sales and Deliveries tabs — those
  are untouched.
- Consequence: the Overview summary endpoint reads **only** the Innovations source, so it
  no longer depends on the app database at all.

**Evidence base:** live payload pulled from the host instance (`http://ino-3frc3q3`,
signed in as `admin`) on 2026-07-29, plus direct schema/feasibility queries against the
Innovations MSSQL source. Every number quoted below is real, not illustrative.

---

## 1. What exists today

### Code

| Piece | File | Notes |
|---|---|---|
| Markup + all rendering JS | `public/business-metrics.html` | 488 lines, one inline IIFE, 6 tabs |
| Aggregation | `lib/business-metrics.js` | 698 lines, one function per data plane |
| Route | `server.js:1406` | `GET /api/business-metrics`, `delivery.read` |
| Styles | `public/styles/pages/business-metrics.css` | 13 lines |

One endpoint returns **201 KB in ~540 ms**, building 3 temp tables and 14 result sets.
The Overview tab consumes about **10 of those numbers**.

### The Overview tab as rendered

Two flat bands of tiles and two paragraphs of prose:

```
[ source banner — 2 lines of prose + 3 status pills ]
[ ~340px of dead vertical space                     ]
[ tabs ]
Live KPIs — Innovations (MSSQL)
  Sales YTD | Sales MTD | WIP value | Receivables | Stock turn
  as-of line + stock-turn caveat
Export archive context
  Archived deliveries | Archived revenue | Open export sessions
  | Commercial invoices | Active pricing rules
  archive window line
```

---

## 2. Findings

### 2.1 Nothing is refreshable

`loadMetrics()` runs once on load. There is no refresh control anywhere — the only
`Retry` button is injected *inside the error handler*, so it exists only when the
page has already failed. A dashboard left open on a monitor shows figures that are
silently hours stale, with an "As of" line that is equally stale and therefore
actively misleading.

The load path also blanks the screen: it resets the badge to `Loading…`, hides the
banner, and re-renders every section from scratch. Any refresh built on this would
flash the whole tab.

### 2.2 Nothing is drillable

Every value is a dead-end string. `Receivables BBD 230,637` cannot be opened to see
who owes it, even though the aging breakdown is already in the same payload and
rendered on a different tab. There is no drawer, modal, or expandable-row component
anywhere in the module.

### 2.3 No comparators — the numbers have no meaning

`Sales MTD BBD 153,650` is presented with no prior month, no same-month-last-year, no
run rate, no target. A KPI without a comparator cannot support a decision; it is
trivia. There is not a single delta, sparkline, or trend indicator on tab 1.

### 2.4 The business-critical items are on other tabs

The Overview is a totals page. The things that actually need action are hidden two
clicks away, and right now several are off-target:

| Signal | Current value | Where it lives |
|---|---|---|
| Zero-cost invoices (target **0**) | **48 invoices**, BBD 11,741 exposed, 75 lines (7d) | tab 4 |
| Receivables > 120 days | 45 items, BBD 2,999.74, oldest invoice **2024-12-03** | tab 2 |
| WIP orders aging | 166 open orders, **49 sitting > 7 days** | nowhere |
| Lowest-margin lines | 100 rows shipped in payload | tab 4 |

A user opening Business Metrics today sees five green-looking totals and no
indication that the zero-cost KPI is 48 over target.

### 2.5 Stock turn is broken data at headline weight

`Stock turn 157.3×` sits in the same tile band, at the same visual weight, as
Sales YTD. It is `cogsYTD / inventoryValue`, and the denominator is meaningless:

```
StockLots WHERE Active = 1
  lots            1573
  with OnHand > 0   46      ← 3% of rows
  total OnHand     158 units
  value          BBD 2,863.60
  OnHandCalcTime  NULL on every row   ← on-hand has never been calculated
  ReceivedDate    2026-07-27 17:59:46 on every row  ← bulk-sync artefact
```

The caveat text is correct but it is 3 lines of small grey prose under a bold number.
Presenting a known-unusable figure at headline weight discredits the four tiles beside
it that are sound.

### 2.6 Two data planes at equal weight

Half the tab is "Export archive context" — the imported Access archive, window
`2025-12-22 → 2026-06-19`, last imported `2026-06-21`. That is historical reference
material, over a month stale by design, and it occupies the same tile treatment as
live receivables.

### 2.7 Layout waste

The source banner is a paragraph of prose where a status strip would do, and there is
roughly 340 px of empty space between it and the tab row before any content appears.

---

## 3. What the data can actually support

All verified by direct query against the live source. No new tables, no schema change.

### 3.1 Drill-down is fully available

`dbo.FinAROpenItems` (677 rows) carries everything needed for a three-level
receivables drill:

```
CustomerID, InvoiceID, OrderID, RxNumber, Patient, PoNumber,
InvoiceTime, ShipTime, AmountDue, SubTotal, TaxAmount, Total,
PaymentAmount, NumPayments, LastPaymentDate, FinARStatus,
FinARAgingPeriodNum, InvoiceType, OrderType
```

→ aging bucket → customers in that bucket → their individual open invoices.

`dbo.CustomerBalances` gives the same for sales and WIP, per customer:
`SalesValueYTD/PTD`, `SalesCostYTD/PTD`, `CurrentWIPValue`, `CurrentBalance`,
`CreditLimit`, `LastPaymentDate/Amount`.

### 3.2 Trend and year-on-year are available and fast

`Orders ⋈ Invoices ⋈ OrderTypes` yields **115 monthly buckets, 2017-03 → 2026-07**.
A 25-month aggregate returns in **176 ms**. Recent actuals:

```
2025-12  235,052 | 2026-01  244,355 | 2026-02  230,138 | 2026-03  268,619
2026-04  235,116 | 2026-05  209,701 | 2026-06  206,161 | 2026-07  211,699 (partial)
```

Caveat: the raw grouping contains two junk buckets (a `NULL` month and `1899-12`)
that must be filtered.

Note this is a *live* trend. The chart on the Sales tab today plots the **archive**
(7 months, ends June), not this.

### 3.2a The sales basis — RESOLVED

Initially the LMS roll-up and a recompute disagreed by 24.6%, which would have made every
comparator quote a different population than the value above it. Resolved:

**`CustomerBalances.SalesValueYTD` = `SUM(FinARSalesJournal.SubTotal)` over the calendar
year** — tax-exclusive, keyed on `InvoiceTime`.

```
                       LMS roll-up      FinARSalesJournal.SubTotal     gap
Sales YTD               1,288,240              1,289,297             0.08%
```

Per-customer it ties exactly for most accounts (Insight Optical, Enhance Vision, PSMT,
Warrens Eye Care all match to the cent); two accounts differ by <0.5%, consistent with
posting timing.

The earlier 24.6% gap came from recomputing with tax-inclusive `Invoices.Total` keyed on
`Orders.ShippedTime` — the wrong column and the wrong date on both counts.

`FinARSalesJournal` spans **2019-01 → 2026-07, 64,778 rows**, and a 26-month aggregate
returns in **70 ms**. So value, comparator, sparkline and trend all share one basis.

Comparators on that basis: **YTD −13.2%** vs last year, **MTD −12.2%** vs Jul 2025.

One nuance: `SalesValuePTD` is the LMS *accounting period*, not the calendar month
(journal calendar MTD is 158,401 vs PTD 153,650, ~3%). Tab 1 uses the journal calendar
month throughout so the MTD tile, its comparator and the trend agree with each other.

### 3.3 WIP aging is available

```
Open orders (not shipped, not cancelled, last 6 months)
  count           166
  avg age        11.4 days
  older than 7d   49
```

Pairs with the existing `wipValue` 49,251 to make WIP actionable rather than a number.

### 3.4 Detail rows are already in the payload — level-2 drill is free

`sourceKpis` already ships: 81 under-199 invoices, 80 over-180, 75 zero-cost lines,
100 low-margin lines, 20 customers, 11 product groups, 10 top customers, 5 aging
buckets. Opening a drawer on any of these needs **no new fetch**.

### 3.5 Credit limits are NOT a usable signal — do not add the card

Checked, because it looked like an obvious addition:

```
customers 89 | with a limit set 11 | breaches 0 | within 10% of limit 0
```

78 of 89 customers have no credit limit configured. A "credit-limit breaches" card
would read `0` forever and imply everyone is inside their limit, which is false —
most have no limit to be inside. This belongs in a data-quality note, not on the
dashboard.

---

## 4. Proposed Overview

Principle: **exceptions first, totals second, context last.** The first screen should
answer "is anything wrong?" before "how are we doing?".

```
┌─ COMMAND BAR ───────────────────────────────────────────────────────────────┐
│ [MTD|QTD|YTD|12M]   Updated 14s ago · next in 46s   [↻] [auto ▾] ●●● [CSV]  │
└─────────────────────────────────────────────────────────────────────────────┘

┌─ NEEDS ATTENTION ───────────────────────────────────────────── 3 open ──────┐
│ ▌Zero-cost invoices  48 →   ▌AR over 120d   45 →   ▌WIP over 7d   49 →      │
│  target 0 · 11,741 exposed   2,999 · since Dec'24   of 166 open orders      │
└─────────────────────────────────────────────────────────────────────────────┘

┌─ HEADLINE ──────────────────────────────────────────────────────────────────┐
│ Sales YTD        Sales MTD         WIP value        Receivables             │
│ 1,288,240        153,650           49,251           230,637                 │
│ ▲ x% vs LY       ▼ x% vs Jul'25    166 orders       98.7% current           │
│ ▁▂▃▅▄▃▅▆▅▄▃▅     run-rate 198k     avg age 11.4d    ▓▓▓▓▓▓▓▓▓░ 1.3% >120d   │
│         →                 →                →                 →              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─ REVENUE TREND (live, 24 months) ──────┬─ RECEIVABLES AGING ────────────────┐
│  ▁▂▃▅▄▃▅▆▅▄▃▅▆▅▄▃▅▆▅▄▃▅▆▅              │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░               │
│  ── this year   ┄┄ last year           │ Current  228,823  685 items  →     │
│  click a month to drill                │ >120d      2,999   45 items  →     │
└────────────────────────────────────────┴────────────────────────────────────┘

┌─ TOP CUSTOMERS (live, YTD) ─────────────────────────────────────────────────┐
│ 1 H A Optical           HAO  149,736 ▓▓▓▓▓▓▓▓ 11.6%   bal 24,555   →        │
│ 2 Insight Optical       INO  128,192 ▓▓▓▓▓▓▓   9.9%   bal  7,395   →        │
│ ...                                                                         │
└─────────────────────────────────────────────────────────────────────────────┘

▸ Export archive context (collapsed — reuses the existing .analytics-band)
```

### 4.1 Command bar (replaces the prose banner)

- **Period selector** — MTD / QTD / YTD / rolling 12. Drives every comparator on the tab.
- **Freshness** — relative time from `generatedAt`, ticking every second; a `stale` badge
  past 5 minutes. Live and archive planes carry separate timestamps, so show both
  (archive on its own band, not in the global bar).
- **Refresh** `↻` — manual, always present, not just on error.
- **Auto-refresh** — off by default; 60 s / 5 min options; **paused on
  `document.hidden`** so a forgotten wall monitor stops hammering MSSQL.
- **Source dots** — three dots for app / MSSQL / PSQL, detail on hover. Replaces two
  lines of prose. Only expands to a full banner when something is actually down.
- **Export CSV** of the current view.

### 4.2 Needs-attention rail

Cards appear **only when off-target**. Each: severity colour, count, value, one line of
context, and a chevron into the drill drawer.

| Card | Rule | Source | Now |
|---|---|---|---|
| Zero-cost invoices | `> 0` vs target 0 | already in payload | **48**, red |
| AR over 120 days | bucket 4 `amountDue > 0` | already in payload | **45 / 2,999**, amber |
| WIP over 7 days | open orders older than 7d | new, verified feasible | **49**, amber |
| Margin below floor | lines under a configurable % | already in payload | tune floor first |
| Data quality | stock not costed; customers without credit limits | derived | info, grey |

When nothing is off-target the rail collapses to a single "All clear" strip. It must be
able to be empty, or it stops meaning anything.

### 4.3 Headline band — four tiles, not five

Each tile gains a comparator, a sparkline, and a drill target.

| Tile | Value | Comparator | Drill |
|---|---|---|---|
| Sales YTD | 1,288,240 | vs same point last year | monthly breakdown → month → invoices |
| Sales MTD | 153,650 | vs same month last year + run-rate | daily breakdown → invoices |
| WIP value | 49,251 | order count + average age | WIP by customer → orders |
| Receivables | 230,637 | current vs overdue split bar | aging → customers → invoices |

**Stock turn is removed from the headline.** Keep the field in the API for
compatibility but mark it `confidence: "unusable"` and surface it as a data-quality
note until `OnHand` / `OnHandCalcTime` are actually populated. Reinstate it as a fifth
tile the day the stock lots are costed.

### 4.4 Trend and aging

- **Trend** — 24 months from the *live* source, this year vs last year, with the current
  partial month marked as partial. Click a month → drawer of that month's invoices.
- **Aging** — horizontal stacked bar plus per-bucket rows. Click a bucket → customers →
  invoices. Zero-value buckets render as thin ticks, not full tiles (three of the five
  buckets are currently 0 and each takes a full tile today).

### 4.5 Top customers

Ten rows with YTD, share-of-revenue bar, balance, and row → customer drawer.

### 4.6 Archive context — dropped

Removed from tab 1 per the scope decision above. Tab 1 carries live operating data only.

---

## 5. Drill-down model

One reusable **drill drawer** — right-side sheet, ~640 px, closes on Esc/backdrop,
breadcrumb for levels 2–3, deep-linkable via hash (`#drill=aging:4`) so a drill state
can be shared or reloaded.

```
level 1  tile / bar segment / rail card   →  breakdown        (from payload, instant)
level 2  row (customer, month, bucket)    →  their records    (lazy fetch)
level 3  invoice row                      →  line detail      (lazy fetch)
```

Every drawer carries its own **refresh**, its own **as-of**, a **CSV export**, and a
link through to the full tab where one exists. Level 1 must never fetch — the payload
already has the rows, and instant expansion is what makes the drill feel worth using.

---

## 6. Refresh model

Three tiers, all built on one refresh manager:

1. **Manual** — command bar, per-band icon, per-drawer button.
2. **Auto** — opt-in interval, paused when the tab is hidden.
3. **Freshness** — per-section `generatedAt`, ticking relative time, stale badge.

**Optimistic rendering:** during a refresh, keep the current values on screen dimmed
with a shimmer and swap on arrival. Never blank the tab, never re-show `Loading…` for a
background refresh. The current `loadMetrics()` does the opposite and must be reworked
before auto-refresh is switched on.

---

## 7. API changes

The monolith is the reason refresh is expensive. Split it:

| Endpoint | Purpose | Target |
|---|---|---|
| `GET /api/business-metrics/summary?period=` | everything tab 1 needs | < 400 ms |
| `GET /api/business-metrics/detail/:section` | tabs 2–6, lazy | as today |
| `GET /api/business-metrics/drill/:kind?...` | aging bucket, customer items, month invoices, WIP by customer | < 300 ms |
| `GET /api/business-metrics` | unchanged, composes the above | back-compat |

Plus:
- **ETag / If-None-Match** — an auto-refresh with no change becomes a 304.
- **Short server-side cache** (20–30 s, keyed by period) — five people on the dashboard
  become one query against MSSQL.
- Split `lib/business-metrics.js` into `lib/metrics/summary.js`, `lib/metrics/drill.js`,
  `lib/metrics/detail.js`. The single 698-line module with a 260-line inline SQL batch
  is already hard to change safely.

---

## 8. Phasing

| Phase | Work | Independently shippable |
|---|---|---|
| 0 | ~~Reconcile the two sales bases (§3.2a)~~ — **done**, basis is `FinARSalesJournal.SubTotal` | complete |
| 1 | `summary` endpoint: comparators, trend, exception rules, WIP aging, ETag, cache | yes — old UI keeps working |
| 2 | Command bar, refresh manager, freshness ticker, optimistic re-render, skeletons | yes |
| 3 | Overview layout: rail, 4 tiles + sparklines, trend, aging bar, top customers | yes |
| 4 | Drill drawer + the six drill routes; wire every number on the tab | yes |
| 5 | Move to `public/tools/business-metrics/` with scoped CSS per `UI_AUDIT_AND_PLAN.md`; apply drawer + refresh to tabs 2–6 | follow-up |

---

## 9. Risks and open questions

- **MSSQL load** from auto-refresh — mitigated by cache + ETag + hidden-tab pause, but
  the interval default should stay *off* until measured on the host.
- **Junk month buckets** (`NULL`, `1899-12`) must be filtered from every trend query.
- **Removing stock turn** changes what people expect to see. Proposal is to keep the API
  field and hide the tile, with a data-quality note explaining why.
- **The rail will show red on day one** — the zero-cost KPI is genuinely 48 over target.
  That is the point of the change, but it should be a deliberate decision, not a surprise.
- **Margin floor** for the "below floor" card needs a threshold from the business; it is
  the one rail rule I cannot derive from the data.
- ~~Sales basis mismatch~~ — resolved, see §3.2a. All sales figures now come from
  `FinARSalesJournal.SubTotal`, which is also what the LMS roll-up is built from.
- **`SalesValuePTD` is a period, not a month** — the MTD tile deliberately uses the journal
  calendar month instead, so it will sit ~3% off the LMS's own PTD figure. Worth stating on
  the tile footnote.
