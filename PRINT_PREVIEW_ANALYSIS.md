# Print/Preview Mismatch Analysis & Recommendations
**Doc Studio Print & Pagination Strategy**

---

## Executive Summary

Your print output doesn't match the preview because:
1. **Preview is a static single page** — shows one continuous document without representing actual page breaks
2. **Print CSS is minimal** — doesn't actively reflow or break content across pages intelligently
3. **Fixed-width documents** — wrapped in fixed-width divs (780px, 660px, 680px) that assume a single rendering
4. **No page-break strategy** — missing CSS directives that tell the print engine where breaks should occur and how to avoid orphans/widows

The gap manifests most in documents with variable content (statements, pricelist, billing with many line items) where the preview shows it all on one page, but the print engine chunks it across multiple pages differently.

---

## Root Cause Analysis

### 1. Preview vs. Print Rendering Differences

**Current Preview Architecture (lines 911–912 in studio.html):**
```html
<div class="cv-scroll" style="{{ previewAreaStyle }}">
  {{ previewNode }}
</div>
```
- Shows a padded, scrollable container with a single fixed-width document div
- No visual indication of where page breaks will occur
- Centered on screen with shadow/border to suggest a physical page, but it's actually a mock-up, not a rendered page

**Current Print Function (lines 1928–1934):**
```javascript
printDoc = (html, title, pageSize) => {
  const w = window.open('', '_blank', 'width=860,height=1100');
  if (!w) { this.toast('Allow pop-ups to print'); return; }
  const paper = String(pageSize || 'letter').toLowerCase() === 'a4' ? 'A4' : 'letter';
  // ... write HTML to window ...
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch(e){} }, 500);
};
```
- Opens a new window with fixed dimensions (860×1100)
- Applies `@page` and `@media print` CSS
- But the HTML content inside isn't pre-validated to fit the page — it just flows as the print engine decides

### 2. The @page / @media print CSS (lines 2128–2141 in buildStatement)

```css
@page           { size: A4; margin: 6.35mm 18mm 22mm; }
@page :first    { margin-top: 0; margin-bottom: 6.35mm; }
@media print {
  body { margin: 0; }
  .cv-doc { box-shadow: none !important; border: none !important; }
  .cv-footer { position: fixed; bottom: 0; left: 0; right: 0; }
}
```

**Problems:**
- No `page-break-inside: avoid` on critical sections (table rows, billTo address, payment block)
- No `page-break-after` rules to force breaks at logical boundaries
- No `widows` / `orphans` control
- Fixed footer but no header repetition on subsequent pages
- No `break-inside: avoid` on inline elements that shouldn't split

### 3. Fixed-Width Documents Don't Adapt

**buildBilling (lines 2880–2886):**
```javascript
const pageW = paper === 'a4' ? 660 : 680;
const pagePad = paper === 'a4' ? 34 : 38;
// ...
return `<style>...</style>
  <div class="cv-doc" style="width:780px;max-width:780px;margin:0 auto;...">
```

- Document is hard-coded to 780px or 680px width
- Padding is absolute (34–38px), not responsive to actual page width
- Tables, text, images all assume this fixed width
- If print engine applies different margins or uses a different DPI, content might overflow or reflow unexpectedly

---

## The Gap: Why Preview ≠ Print

### Scenario: A statement with 40 transactions

**In Preview:**
1. You see one long scrollable document
2. All 40 rows visible if you scroll
3. Looks like it fits on "a page" visually
4. No indication that it will span 3–4 actual pages

**In Print:**
1. First page: header, summary, table header, ~15 rows → fills page
2. Second page: ~15 rows → fills page
3. Third page: ~10 rows + footer → fits
4. **But the table header doesn't repeat** → second page has orphaned rows with no context
5. **And "Notes & Terms" might split awkwardly** → text runs from page 2 to page 3

Result: **Printed document looks incomplete or broken**.

---

## Solution Strategy: Multi-Layered Approach

### Layer 1: Multi-Page Preview (UX)

**Goal:** Show the user how content will actually paginate before they print.

**Implementation:**
1. **Detect page breaks programmatically**
   - Render the HTML to a hidden container
   - Measure each block's height against remaining page space
   - Inject visual "page break" indicators
   - Show page count

2. **Update `previewNode` rendering**
   - For documents that might span multiple pages (statement, pricelist, billing with many rows):
     - Wrap content in a multi-page layout preview
     - Each simulated page has the correct margin/padding matching print CSS
     - Show page number at bottom of each preview "page"
     - Users see exactly what will print

3. **Add a page-break indicator toggle**
   - Checkbox: "Show page breaks in preview"
   - When enabled, renders with visual page break lines (dotted line + page number)

**Pseudo-code:**
```javascript
// In renderVals(), detect if content is multi-page:
const estimatedPages = Math.ceil(contentHeight / printPageHeight);
const showPageBreaks = d.showPageBreaks && estimatedPages > 1;

// In buildBilling() or buildStatement():
if (showPageBreaks) {
  // Inject page-break lines and repeat headers
}

// Render preview with pagination:
previewNode = renderMultiPagePreview(html, { 
  pageHeight: 1122, // 8.5" @ 96 DPI
  marginTop, marginBottom, 
  repeatHeaders: true 
});
```

### Layer 2: CSS Print Page-Break Rules (Content Flow)

**Goal:** Tell the print engine exactly where to break and what to keep together.

**Key CSS additions:**

```css
/* Don't break inside table rows */
tr { page-break-inside: avoid; break-inside: avoid; }

/* Don't break inside address/contact blocks */
.bill-to, .bank-block, .callout { page-break-inside: avoid; break-inside: avoid; }

/* Repeat table header on each page */
thead { display: table-header-group; }
tfoot { display: table-footer-group; }

/* Force breaks before sections */
.statement-section, .page-section { page-break-before: avoid; }

/* Control orphans/widows */
body { orphans: 3; widows: 3; }

/* Keep short blocks together */
.meta-row, .total-row { page-break-inside: avoid; }

/* Allow breaks in long text but prefer to avoid splitting mid-sentence */
p { widows: 2; orphans: 2; }
```

**Why it matters:**
- `page-break-inside: avoid` on `<tr>` prevents table rows from splitting across pages
- `display: table-header-group` ensures the table header repeats on every page
- `orphans: 3; widows: 3` prevents isolated lines at page breaks
- These rules tell **both the preview engine AND the print engine** how to behave

### Layer 3: Responsive Content Width & Scaling (Fit-to-Page)

**Goal:** Let content intelligently shrink to fit a page if needed, rather than overflowing or being cut off.

**Current issue:**
- Document is fixed at 660–780px
- If margins are tighter in print, content still assumes the same width
- Tables might have text that doesn't wrap, forcing overflow

**Solution:**
1. **Use CSS `max-width` instead of fixed `width`**
   ```css
   .cv-doc { 
     max-width: 780px;  /* Max, not fixed */
     width: 100%;       /* Fill available space */
     margin: 0 auto;
   }
   ```

2. **Add `box-sizing: border-box` globally**
   ```css
   * { box-sizing: border-box; }
   ```

3. **Font size scaling in print**
   ```css
   @media print {
     body { font-size: 11pt; }  /* Ensure readable in print */
     table { font-size: 10pt; } /* Smaller for tables */
   }
   ```

4. **Table column widths that compress gracefully**
   ```css
   table { width: 100%; }
   td { padding: 6px 8px; }  /* Reduce padding in print */
   ```

### Layer 4: Document-Specific Improvements

#### A. Billing Documents (Invoice / Quotation / Pro Forma)

**Current structure** (buildBilling, line 2880+):
- Header, logo, supplier info
- Bill-to + callout (side-by-side)
- Line items table (variable rows)
- Totals
- Payment block (optional)
- Bank details block (optional)
- Footer (fixed position)

**Improvements needed:**
```javascript
buildBilling = () => {
  // ... existing code ...
  
  // NEW: Calculate if content spans multiple pages
  const estimatedHeight = 400 + (rows.length * 35) + 150; // rough estimate
  const maxPageHeight = 1122; // letter height minus margins
  const estimatedPages = Math.ceil(estimatedHeight / maxPageHeight);
  
  // NEW: Page break strategy
  const cssPageBreaks = `
    tr { page-break-inside: avoid; break-inside: avoid; }
    thead { display: table-header-group; }
    .payment-block, .bank-block { page-break-inside: avoid; }
    .line-items-section { page-break-inside: avoid; }
  `;
  
  // NEW: Add page-break marker for preview
  let pageBreakMarkers = '';
  if (estimatedPages > 1) {
    // Inject markers showing where breaks will occur
    pageBreakMarkers = `<!-- Page 1 of ${estimatedPages} -->`;
  }
  
  return `<style>${cssPageBreaks}</style>...`;
};
```

**For multi-page bills:**
- Repeat the header (company logo + address) on page 2+
- Repeat table header on page 2+
- Move bank details to final page (not on every page)
- Use fixed footer with page numbers

#### B. Pricelist

**Current structure** (buildPricelist, line 1938+):
- Header with logo, date
- Table of products/prices (variable rows)
- Footer

**Issues:**
- Table might be very long (50–100+ rows)
- Currently doesn't handle multi-page
- Header should repeat on each page

**Improvements:**
```javascript
buildPricelist = () => {
  // ... existing code ...
  
  const cssPageBreaks = `
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; break-inside: avoid; }
    @page :first { margin-top: 0; }
    @page { margin-top: 0.5in; }  /* Room for repeated header */
  `;
  
  return `<style>${cssPageBreaks}</style>...`;
};
```

#### C. Statements

**Current structure** (buildStatement, line ~2200):
- Header
- Metadata + account summary (side-by-side)
- Ageing table
- Transaction detail table (often 50–200+ rows)
- Totals band
- Notes
- Bank details
- Footer (fixed)

**Critical issue:**
- Transaction table is often very long
- No header repetition → pages 2–3 are orphaned rows
- Footer should be on every page
- Notes might get cut off

**Improvements:**
```javascript
buildStatement = () => {
  // ... existing code ...
  
  const cssPageBreaks = `
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; break-inside: avoid; }
    .statement-section { page-break-before: avoid; page-break-inside: avoid; }
    .cv-footer { position: fixed; bottom: 10mm; left: 0; right: 0; font-size: 8pt; }
    @page { margin-bottom: 30mm; }  /* Extra space for fixed footer */
    @media print {
      .cv-footer { position: fixed; }  /* Ensure it stays fixed in print */
    }
  `;
  
  return `<style>${cssPageBreaks}</style>...`;
};
```

---

## Implementation Roadmap

### Phase 1: Quick Wins (2–3 hours)
1. **Add CSS page-break rules** to all document builders
   - Apply `page-break-inside: avoid` to critical blocks
   - Add `display: table-header-group` for tables
   - Update `@page` CSS to match actual print expectations

2. **Fix fixed footer positioning** in print media
   - Ensure `.cv-footer` respects page margins on all pages

3. **Test with real content** (print to PDF and compare to preview)

### Phase 2: Multi-Page Preview (4–6 hours)
1. **Build a preview renderer** that simulates page breaks
   - Measure content height
   - Inject visual page indicators
   - Show accurate page count

2. **Update preview pane** to show pagination
   - Replace single scrollable div with multi-page layout
   - Add "page X of Y" indicator
   - Add toggle: "Show page breaks"

3. **Test with statements, pricelists, and long billing docs**

### Phase 3: Advanced Improvements (8–10 hours)
1. **Responsive content width**
   - Switch from fixed to `max-width` layout
   - Test with different paper sizes (A4 vs. letter)

2. **Column width optimization**
   - Adjust table columns to scale gracefully
   - Ensure no text overflow

3. **Header/footer repetition**
   - Add repeating headers for tables
   - Add page numbers to headers/footers

---

## CSS Changes by Document Type

### Universal (all documents)

```css
/* In the <style> tag injected into print HTML: */
* { box-sizing: border-box; }

@page {
  size: letter;  /* or A4 */
  margin: 0.75in 1in;  /* Adjust based on actual needs */
}

@page :first {
  margin-top: 0;  /* No extra top margin on first page */
}

/* Page breaks */
tr, .section-block { page-break-inside: avoid; break-inside: avoid; }
thead, tfoot { display: table-header-group; }

/* Orphans/widows */
body { orphans: 3; widows: 3; }

/* Footer */
.cv-footer { 
  position: fixed; 
  bottom: 0; 
  left: 0; 
  right: 0;
  page-break-inside: avoid;
}

@media print {
  body { margin: 0; }
  .cv-doc { box-shadow: none !important; border: none !important; }
  .cv-footer { position: fixed; }
}
```

### Billing-Specific

```css
.payment-block, .bank-block { page-break-inside: avoid; break-inside: avoid; }
.line-items-table { page-break-inside: avoid; }
.bill-to { page-break-inside: avoid; }
```

### Statement-Specific

```css
.account-summary { page-break-inside: avoid; }
.ageing-table tr { page-break-inside: avoid; }
.transaction-table tr { page-break-inside: avoid; }
.totals-band { page-break-inside: avoid; }
```

---

## Testing & Validation Checklist

- [ ] Print statement with 100+ transactions → verify page breaks occur at logical boundaries
- [ ] Print billing doc with 50+ line items → verify table header repeats on page 2
- [ ] Print pricelist with 200 products → verify no orphaned rows
- [ ] Print to PDF → compare visual output to preview
- [ ] Test both Letter and A4 sizes
- [ ] Verify footer appears on all pages
- [ ] Check that page numbers are accurate (if added)
- [ ] Ensure no text is cut off at page boundaries
- [ ] Validate that headers/metadata don't repeat unexpectedly

---

## Key Files to Modify

1. **`C:\DEV\optilens-local\public\ds\studio.html`**
   - Lines 1928–1934: `printDoc()` function — may need to pass page-break info
   - Lines 2128–2141: Statement CSS — add page-break rules
   - Lines 2880–3000+: `buildBilling()` — add page-break CSS
   - Lines 1938–2000+: `buildPricelist()` — add page-break CSS
   - `renderVals()` → add multi-page preview logic

2. **New file (optional): `public/ds/_print-css.js`**
   - Centralize print CSS generation
   - Reusable page-break rules
   - Paper size handling

3. **New file (optional): `public/ds/_pagination-preview.js`**
   - Multi-page preview renderer
   - Page break detection
   - Visual indicators

---

## Additional Notes

- **Chrome/Chromium** handles page breaks better than Firefox for complex layouts; test in both
- **`@supports` queries** can detect print support and fallback to simpler layouts
- **Print stylesheets should be comprehensive** — don't rely on inherited styles from screen CSS
- **Test with actual printers** or PDF engines (print to PDF) before relying solely on browser print preview
- **Margin and padding assumptions** — verify that your 7–10 mm border assumption holds across all paper sizes and print drivers

---

## Success Metrics

✅ Preview shows exactly what will print  
✅ Multi-page documents display page breaks visually before printing  
✅ Table headers repeat on every page  
✅ No orphaned rows or cut-off content  
✅ Footer appears on all pages  
✅ Printed PDF matches preview within ±2%  
✅ Letter and A4 sizes produce identical logical layouts (just different physical dimensions)
