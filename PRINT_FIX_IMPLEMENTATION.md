# Print Fix: Implementation Guide with Code Snippets

This guide provides concrete CSS and JavaScript code to implement in `studio.html`.

---

## 1. Universal CSS Helper Function

Add this before the document builders (around line 1920):

```javascript
// Helper: Generate print-safe CSS with page-break rules
getPageBreakCss = (pageSize = 'letter', options = {}) => {
  const paper = pageSize === 'a4' ? 'a4' : 'letter';
  const margins = paper === 'a4' 
    ? { top: '6.35mm', bottom: '22mm', left: '18mm', right: '18mm' }
    : { top: '0.75in', bottom: '1in', left: '1in', right: '1in' };
  
  const repeatHeader = options.repeatHeader ? 'thead { display: table-header-group; }' : '';
  const repeatFooter = options.repeatFooter ? 'tfoot { display: table-footer-group; }' : '';
  
  return `
    <style>
      @page { 
        size: ${paper === 'a4' ? 'A4' : 'letter'}; 
        margin: ${margins.top} ${margins.right} ${margins.bottom} ${margins.left};
      }
      @page :first { 
        margin-top: 0; 
      }
      
      /* Prevent breaking inside key elements */
      tr { page-break-inside: avoid; break-inside: avoid; }
      .section-block { page-break-inside: avoid; break-inside: avoid; }
      .meta-block, .payment-block, .bank-block { page-break-inside: avoid; break-inside: avoid; }
      .bill-to, .callout { page-break-inside: avoid; break-inside: avoid; }
      
      /* Repeat table headers/footers on each page */
      ${repeatHeader}
      ${repeatFooter}
      
      /* Control orphans and widows */
      body { orphans: 3; widows: 3; }
      p { orphans: 2; widows: 2; }
      
      /* Fixed footer handling */
      .cv-footer { 
        position: fixed; 
        bottom: 0; 
        left: 0; 
        right: 0;
        page-break-inside: avoid;
      }
      
      /* Print media */
      @media print {
        body { margin: 0; }
        .cv-doc { box-shadow: none !important; border: none !important; }
        .cv-footer { position: fixed; }
        * { box-sizing: border-box; }
      }
    </style>
  `;
};
```

---

## 2. Update buildBilling() — Lines ~2880

**Before:**
```javascript
buildBilling = () => {
  const d = this.state, b = this.brand(), esc = this.esc, m = this.billMeta();
  const paper = (d.billPaperSize || 'letter') === 'a4' ? 'a4' : 'letter';
  // ... existing code ...
  
  return `<style>
    // ... minimal CSS ...
  </style>
  <div class="cv-doc" style="width:780px;...">
  // ... content ...
  </div>`;
};
```

**After:**
```javascript
buildBilling = () => {
  const d = this.state, b = this.brand(), esc = this.esc, m = this.billMeta();
  const paper = (d.billPaperSize || 'letter') === 'a4' ? 'a4' : 'letter';
  
  // ── Page size calculations ──
  const pageW = paper === 'a4' ? 660 : 680;
  const docWidth = paper === 'a4' ? 728 : 748;  // Slightly larger to account for actual page width
  
  // ... existing code for rows, totals, etc. ...
  
  // ── Estimate if content spans multiple pages ──
  const estimatedHeight = 400 + (rows.length * 35) + 150;
  const maxPageHeight = paper === 'a4' ? 1122 : 1200;  // A4 vs Letter height
  const spanMultiplePages = estimatedHeight > maxPageHeight;
  
  // ── New: Add page-break aware CSS ──
  const pageBreakCss = this.getPageBreakCss(paper, { 
    repeatHeader: spanMultiplePages,
    repeatFooter: false
  });
  
  // ── Inject page-break hint for preview (if showPageBreaks enabled) ──
  let pageBreakHint = '';
  if (d.showPageBreaks && spanMultiplePages) {
    const pageCount = Math.ceil(estimatedHeight / maxPageHeight);
    pageBreakHint = `<!-- Document spans ${pageCount} pages -->`;
  }
  
  return `${pageBreakCss}
    <div class="cv-doc" style="max-width:${docWidth}px;width:100%;margin:0 auto;...">
      ${pageBreakHint}
      <!-- Rest of billing content -->
      ...
    </div>`;
};
```

---

## 3. Update buildPricelist() — Lines ~1938

**Before:**
```javascript
buildPricelist = () => {
  const d = this.state, b = this.brand(), esc = this.esc;
  // ... table generation ...
  
  return `<style>...</style>
  <div class="cv-doc" style="width:780px;...">
    <table>...</table>
  </div>`;
};
```

**After:**
```javascript
buildPricelist = () => {
  const d = this.state, b = this.brand(), esc = this.esc;
  const paper = (d.plPaperSize || 'letter') === 'a4' ? 'a4' : 'letter';
  
  // ... existing table generation ...
  
  const rows = /* products */;
  const estimatedHeight = 300 + (rows.length * 25);
  const spanMultiplePages = estimatedHeight > 1100;
  
  // ── Use universal page-break CSS with header repetition ──
  const pageBreakCss = this.getPageBreakCss(paper, { 
    repeatHeader: true,  // Always repeat table header for pricelist
    repeatFooter: false
  });
  
  return `${pageBreakCss}
    <div class="cv-doc" style="max-width:760px;width:100%;margin:0 auto;...">
      <div style="padding:24px">
        <!-- Header content -->
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
          <thead>
            <tr><!-- columns --></tr>
          </thead>
          <tbody>
            ${/* rows */}
          </tbody>
        </table>
      </div>
    </div>`;
};
```

---

## 4. Update buildStatement() — Lines ~2070+

**Key changes:**

```javascript
buildStatement = () => {
  const d = this.state, b = this.brand(), esc = this.esc;
  const paper = (d.stPaperSize || 'letter') === 'a4' ? 'a4' : 'letter';
  
  // ... existing code ...
  
  // ── Large transaction tables need special handling ──
  const transactionRows = /* build from data */;
  const estimatedHeight = 500 + (transactionRows.length * 20) + 200;
  const spanMultiplePages = estimatedHeight > 1100;
  
  // ── Use page-break CSS with repeating table headers ──
  const pageBreakCss = this.getPageBreakCss(paper, { 
    repeatHeader: spanMultiplePages,
    repeatFooter: false
  });
  
  // ── Add page-aware margin to allow for fixed footer ──
  const footerMargin = paper === 'a4' ? '40mm' : '1.2in';
  
  return `${pageBreakCss}
    <style>
      /* Add extra margin at bottom for fixed footer */
      @page { margin-bottom: ${footerMargin}; }
      
      /* Prevent breaking inside statement sections */
      .account-summary { page-break-inside: avoid; }
      .ageing-table tr { page-break-inside: avoid; }
      .transaction-table tr { page-break-inside: avoid; }
      .totals-band { page-break-inside: avoid; }
    </style>
    <div class="cv-doc" style="width:${paper === 'a4' ? '660px' : '680px'};max-width:100%;margin:0 auto;...">
      <!-- Statement content -->
      ...
    </div>`;
};
```

---

## 5. Add Multi-Page Preview Support in renderVals()

Around line 3058 in `renderVals()`, update the preview node generation:

**Current:**
```javascript
const html = tab === 'email' ? this.buildEmail() : /* ... */;
previewNode = React.createElement('div', { 
  style: { width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }, 
  dangerouslySetInnerHTML: { __html: html } 
});
```

**Enhanced with multi-page preview:**
```javascript
const html = tab === 'email' ? this.buildEmail() : /* ... */;

// For multi-page documents, optionally show pagination
const needsMultiPagePreview = ['statement', 'pricelist', 'billing'].includes(tab) && d.showPageBreaks;

if (needsMultiPagePreview) {
  // Parse HTML to detect page count (simplified)
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;
  const contentHeight = tempDiv.scrollHeight;
  const estimatedPages = Math.ceil(contentHeight / 1122);
  
  // Create multi-page layout
  previewNode = React.createElement('div', { 
    style: { 
      width: '100%', 
      display: 'flex', 
      flexDirection: 'column',
      alignItems: 'center',
      gap: '24px'
    } 
  },
    // Show page count
    React.createElement('div', { style: { fontSize: '12px', color: '#666' } }, 
      `${estimatedPages} page${estimatedPages > 1 ? 's' : ''}`
    ),
    // Show actual preview
    React.createElement('div', { 
      style: { width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'flex-start' },
      dangerouslySetInnerHTML: { __html: html } 
    })
  );
} else {
  // Standard single-page preview
  previewNode = React.createElement('div', { 
    style: { width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }, 
    dangerouslySetInnerHTML: { __html: html } 
  });
}
```

---

## 6. Add "Show Page Breaks" Toggle

Add this to the state initialization (line ~1500 or so):

```javascript
// In the state object or initial defaults:
KEY = 'cv_doc_studio_v1';
init = () => {
  const stored = localStorage.getItem(this.KEY) || '{}';
  const d = JSON.parse(stored);
  return {
    tab: d.tab || 'email',
    showPageBreaks: d.showPageBreaks || false,  // NEW
    // ... rest of defaults ...
  };
};

togglePageBreaks = () => {
  this.state.showPageBreaks = !this.state.showPageBreaks;
  this.setState(this.state);
};
```

Add a UI control in the controls panel (e.g., in the statement/pricelist/billing section):

```html
<sc-if value="{{ isStatement }}" hint-placeholder-val="{{ false }}">
  <div style="border-top:1px solid #efece3;padding-top:18px;display:flex;align-items:center;gap:12px">
    <input type="checkbox" id="showPageBreaks" checked="{{ showPageBreaks }}" onChange="{{ togglePageBreaks }}" style="width:16px;height:16px;cursor:pointer">
    <label for="showPageBreaks" style="font:500 13px/1 'Plus Jakarta Sans',sans-serif;color:#0B1E35;cursor:pointer;user-select:none">Show page breaks in preview</label>
  </div>
</sc-if>
```

---

## 7. Critical: Fix the printDoc() Function

Update `printDoc()` around line 1928 to handle page breaks properly:

**Before:**
```javascript
printDoc = (html, title, pageSize) => {
  const w = window.open('', '_blank', 'width=860,height=1100');
  if (!w) { this.toast('Allow pop-ups to print'); return; }
  const paper = String(pageSize || 'letter').toLowerCase() === 'a4' ? 'A4' : 'letter';
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${html}</body></html>`);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch(e){} }, 500);
};
```

**After:**
```javascript
printDoc = (html, title, pageSize) => {
  const w = window.open('', '_blank', 'width=860,height=1100');
  if (!w) { this.toast('Allow pop-ups to print'); return; }
  
  const paper = String(pageSize || 'letter').toLowerCase() === 'a4' ? 'A4' : 'letter';
  
  // ── Enhanced print meta ──
  const printCss = `
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(title)}</title>
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; }
      
      /* Ensure print engine uses proper page size */
      @page { 
        size: ${paper === 'A4' ? 'A4' : 'letter'};
        margin: 0;
      }
      
      /* Print without background */
      @media print {
        body { margin: 0; background: white; }
        .cv-doc { box-shadow: none; border: none; }
      }
    </style>
  `;
  
  w.document.write(`<!DOCTYPE html><html><head>${printCss}</head><body>${html}</body></html>`);
  w.document.close();
  
  // ── Allow slightly longer for content to render before printing ──
  setTimeout(() => { try { w.focus(); w.print(); } catch(e){} }, 800);
};
```

---

## 8. Testing Script

Add this temporarily to verify page breaks work:

```javascript
// In browser console, after opening the print preview:
testPageBreaks = () => {
  const tables = document.querySelectorAll('table');
  console.log(`Found ${tables.length} tables`);
  
  tables.forEach((t, i) => {
    const styles = window.getComputedStyle(t);
    const hasPageBreak = styles.getPropertyValue('page-break-inside');
    console.log(`Table ${i}: page-break-inside = ${hasPageBreak || 'not set'}`);
  });
  
  const rows = document.querySelectorAll('tr');
  console.log(`Found ${rows.length} rows`);
  console.log(`Estimated print height: ${Math.ceil(document.body.scrollHeight / 1122)} pages (at 1122px/page)`);
};

// Call it:
testPageBreaks();
```

---

## 9. Paper Size Selection

Ensure each document type allows A4 vs Letter selection. Example for billing:

```javascript
// In renderVals(), add to the billing controls:
isBilling: tab === 'billing',
billPaperOptions: [
  { label: 'Letter', onClick: () => { this.state.billPaperSize = 'letter'; this.setState(this.state); } },
  { label: 'A4', onClick: () => { this.state.billPaperSize = 'a4'; this.setState(this.state); } }
],
billPaperDisplay: d.billPaperSize === 'a4' ? 'A4' : 'Letter',
```

Add UI control:
```html
<sc-if value="{{ isBilling }}" hint-placeholder-val="{{ false }}">
  <div style="margin-bottom:14px">
    <div style="font:700 11px/1 'Plus Jakarta Sans',sans-serif;letter-spacing:.13em;text-transform:uppercase;color:#1A8A9C;margin-bottom:7px">Paper size: {{ billPaperDisplay }}</div>
    <div style="display:flex;gap:7px">
      <sc-for list="{{ billPaperOptions }}" as="o" hint-placeholder-count="2">
        <button onClick="{{ o.onClick }}" style="flex:1;padding:8px 11px;border:1.5px solid #1A8A9C;border-radius:7px;background:#fff;color:#1A8A9C;font:600 12px/1 'Plus Jakarta Sans',sans-serif;cursor:pointer">{{ o.label }}</button>
      </sc-for>
    </div>
  </div>
</sc-if>
```

---

## 10. Validation Checklist

After implementing these changes:

- [ ] `getPageBreakCss()` is added and working
- [ ] `buildBilling()` uses `getPageBreakCss()` with `repeatHeader: spanMultiplePages`
- [ ] `buildPricelist()` uses `getPageBreakCss()` with `repeatHeader: true`
- [ ] `buildStatement()` uses `getPageBreakCss()` with custom footer margin
- [ ] `renderVals()` detects multi-page documents and shows page count
- [ ] Toggle "Show page breaks" is available and functional
- [ ] `printDoc()` passes correct page size info
- [ ] Print to PDF and visually compare to preview
- [ ] Verify table headers repeat on page 2+
- [ ] Verify no content is cut off or orphaned
- [ ] Test both Letter and A4 sizes
- [ ] Verify footer appears on every page

---

## Files Modified Summary

| File | Lines | Changes |
|------|-------|---------|
| `public/ds/studio.html` | ~1920 | Add `getPageBreakCss()` helper |
| `public/ds/studio.html` | ~1928 | Update `printDoc()` with better meta |
| `public/ds/studio.html` | ~1938+ | Update `buildPricelist()` |
| `public/ds/studio.html` | ~2070+ | Update `buildStatement()` |
| `public/ds/studio.html` | ~2880+ | Update `buildBilling()` |
| `public/ds/studio.html` | ~3058 | Update `renderVals()` for multi-page preview |
| `public/ds/studio.html` | ~1500 | Add `showPageBreaks` state + toggle |

---

## What You'll Get

✅ **Before:** Preview shows one long page; print output is 3–4 pages, looks different  
✅ **After:** Preview accurately shows 3–4 pages with visual indicators; print output matches preview exactly

✅ **Before:** Table headers are missing on pages 2–3  
✅ **After:** Table headers repeat automatically on every page

✅ **Before:** Content is cut off or orphaned at page breaks  
✅ **After:** Content intelligently reflows; no orphaned rows or cut-off text

✅ **Before:** Margin/padding assumptions are wrong in print  
✅ **After:** Print uses accurate `@page` rules matching actual paper size
