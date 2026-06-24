# Supplies & Lenses → Billing Integration Strategy

## Overview
Integrate real-time supplies and lenses inventory/pricing from Classic Website, Supabase Catalog, and Lab Management into the Quote Builder for fast, accurate proposals.

---

## 1. Data Architecture

### Data Sources
```
Classic Website API (x-api-key)
  ├─ Supplies: frames, coatings, materials, accessories
  ├─ Lenses: prescriptions, materials, tints
  └─ Pricing: list prices, bulk discounts, regional markup

Supabase Catalog (optilens database)
  ├─ Product master: SKU, description, attributes
  ├─ Inventory levels: real-time stock
  └─ Variant mappings: size, color, material

Lab Management System (ODBC)
  ├─ Lab costs: per-unit processing, turnaround
  ├─ Capacity: max daily throughput
  └─ Availability: current utilization %
```

### Unified Cache Layer
**Location:** `data/pricelist/supplies-lenses-cache.json`

```json
{
  "supplies": {
    "FRAME-ACE-001": {
      "sku": "FRAME-ACE-001",
      "name": "Acetate Frame Classic",
      "category": "frames",
      "cost": 8.50,
      "msrp": 24.99,
      "inventory": {
        "warehouse": 245,
        "lab": 18
      },
      "attributes": {
        "material": "acetate",
        "size": "medium",
        "colors": ["black", "tortoise", "clear"]
      },
      "lastSync": "2026-06-24T14:32:00Z"
    }
  },
  "lenses": {
    "LENS-PROG-003": {
      "sku": "LENS-PROG-003",
      "name": "Progressive High-Index",
      "category": "lenses",
      "cost": 22.00,
      "msrp": 89.99,
      "turnaround": "3 days",
      "lab_capacity_used": 42,
      "attributes": {
        "index": "1.67",
        "material": "polycarbonate",
        "coating": "optional"
      },
      "lastSync": "2026-06-24T14:32:00Z"
    }
  },
  "pricingRules": {
    "bulk_discount_5": 0.05,
    "bulk_discount_10": 0.10,
    "volume_frame_20": 0.15
  }
}
```

---

## 2. Integration Points

### A. Sync Service (Backend)
**Endpoint:** `POST /api/inventory/sync` (requires `credentials.manage`)

**Flow:**
1. Every 60 minutes, trigger sync from all three sources
2. Merge & deduplicate by SKU
3. Resolve conflicts (Lab capacity > Warehouse stock takes precedence for fulfillment)
4. Update local cache
5. Broadcast cache version to connected browsers via WebSocket

**Conflict Resolution Rules:**
- **Pricing:** Classic Website (primary) → Supabase (fallback) → Manual override
- **Inventory:** Lab count (real-time) > Warehouse (daily refresh)
- **Availability:** If lab capacity >80%, flag for lead time increase

### B. Quote Builder (Frontend)
**Module:** `modules/quote-builder/` (new tab in OptiLens Local)

**Features:**
1. **Product Search & Filter**
   - Search supplies/lenses by name, SKU, category
   - Filter: material, size, coating type, turnaround
   - Real-time inventory badges

2. **Add to Quote**
   - Click or drag-drop items
   - Auto-populate cost + MSRP
   - Show availability: "In stock (245)" or "Lab custom (5 days)"

3. **Quantity & Pricing**
   - Unit cost auto-calculated based on:
     - Base MSRP
     - Customer type (direct/distributor)
     - Volume discount thresholds
     - Lab labor if customization needed

4. **Dynamic Total**
   - Line-item breakdown
   - Subtotal → Tax (if applicable) → Grand Total
   - Margin indicator (cost vs. quote price)

### C. Proposal Export
**Route:** `GET /api/quotes/:id/export?format=pdf|invoice|template`

**Outputs:**
- **PDF Proposal**: Branded header, itemized list, payment terms
- **Commercial Invoice**: Full compliance fields (HS codes, certificate of origin)
- **CoO Certificate**: Auto-populated with supplies origin + lab location
- **Email Template**: One-click send to lead with file attachments

---

## 3. Database Schema (additions to existing)

```sql
-- Supplies catalog (synced)
CREATE TABLE supplies (
  id UUID PRIMARY KEY,
  sku VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(50), -- frames, coatings, accessories
  cost_usd DECIMAL(10,2),
  msrp_usd DECIMAL(10,2),
  warehouse_qty INT,
  lab_qty INT,
  attributes JSONB, -- {material, color, size, ...}
  source VARCHAR(20), -- 'classic_api', 'supabase', 'lab'
  last_synced TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Lenses catalog (synced)
CREATE TABLE lenses (
  id UUID PRIMARY KEY,
  sku VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  cost_usd DECIMAL(10,2),
  msrp_usd DECIMAL(10,2),
  turnaround_days INT,
  lab_capacity_used INT,
  attributes JSONB, -- {index, material, coating, ...}
  source VARCHAR(20),
  last_synced TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Quotes (new)
CREATE TABLE quotes (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL,
  quote_number VARCHAR(20) UNIQUE,
  status VARCHAR(20) DEFAULT 'draft', -- draft, sent, accepted, invoiced
  items JSONB, -- [{sku, qty, unit_price, discount, ...}]
  subtotal_usd DECIMAL(12,2),
  tax_usd DECIMAL(12,2),
  total_usd DECIMAL(12,2),
  notes TEXT,
  expiry_date DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  exported_at TIMESTAMP
);

-- Pricing rules (rules engine)
CREATE TABLE pricing_rules (
  id UUID PRIMARY KEY,
  rule_name VARCHAR(100),
  condition JSONB, -- {min_qty, customer_type, ...}
  discount_percent DECIMAL(5,2),
  effective_date DATE,
  expiry_date DATE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 4. API Endpoints

### Catalog Access
```
GET  /api/supplies?search=frame&category=frames&inStock=true
GET  /api/lenses?index=1.67&turnaround=3-5days
GET  /api/supplies/:sku
GET  /api/lenses/:sku
```

### Quote Management
```
POST   /api/quotes                    -- Create draft quote
GET    /api/quotes/:id               -- Fetch quote details
PUT    /api/quotes/:id               -- Update quote (add/remove items)
DELETE /api/quotes/:id               -- Delete draft
POST   /api/quotes/:id/finalize      -- Lock & send to customer
GET    /api/quotes/:id/export        -- Download PDF/invoice
POST   /api/quotes/:id/template-save -- Save as recurring template
```

### Admin/Sync
```
POST  /api/inventory/sync             -- Trigger manual sync
GET   /api/inventory/status           -- Last sync time, cache version
POST  /api/pricing-rules              -- Create/update pricing rules
```

---

## 5. UI Workflow

### Step 1: Start Quote
- Select customer (auto-fill from CRM if connected)
- Quote expires in: 30 days (default, configurable)

### Step 2: Add Supplies & Lenses
- Browse/search catalog (left panel)
- Click item → add to quote
- Set quantity → price auto-calculates
- See real-time availability: ✓ In stock | ⏱ Custom (5 days) | ✗ Discontinued

### Step 3: Review & Adjust
- Line-item breakdown
- Apply coupon/manual discount (if permitted)
- Add notes: "Rush processing fee +15%", "Bulk discount applied"
- Margin indicator: Show cost vs. quote price (for internal eyes)

### Step 4: Export & Send
- **Download PDF**: Branded proposal, ready to email
- **Email Direct**: Auto-populate lead, attach PDF, include payment button link
- **Save Template**: Reuse for future similar quotes

### Step 5: Track
- Quote status dashboard: Draft → Sent → Accepted → Invoiced
- Reminder: Auto-email if quote expires in 3 days

---

## 6. Implementation Phases

### Phase 1 (Week 1-2): Foundation
- [ ] Set up cache schema & sync service
- [ ] Connect Classic API + Supabase connectors
- [ ] Build supplies/lenses tables in DB
- [ ] Create `/api/supplies` & `/api/lenses` GET endpoints

### Phase 2 (Week 3-4): Quote Builder UI
- [ ] Build quote-builder module (HTML/JS)
- [ ] Implement product search & add-to-quote
- [ ] Real-time pricing calculation
- [ ] Draft quote save/load

### Phase 3 (Week 5-6): Export & Distribution
- [ ] PDF export (use existing PDF skill)
- [ ] Commercial invoice generator
- [ ] Email integration (direct send to lead)
- [ ] Template save/manage

### Phase 4 (Week 7-8): Polish & Scaling
- [ ] Pricing rules engine
- [ ] Bulk operations (quote multiple customers)
- [ ] Analytics: most-quoted items, margin trends
- [ ] Performance: cache invalidation, async sync

---

## 7. Key Decisions

### Caching Strategy
- **TTL:** 60 min (hourly sync for supplies/lenses, real-time for lab capacity)
- **Fallback:** Serve stale cache if sync fails; alert user
- **Broadcast:** WebSocket push to browsers on significant changes (stock <5 units, new item added)

### Pricing Calculation
- **Default:** MSRP (to customer) - Cost (to company) = Margin
- **Rules:** Apply tiered discounts (5 units = 5%, 10+ = 10%)
- **Custom:** Manual override for specific accounts (distributor pricing, loyalty)

### Inventory Management
- **Warehouse:** Use for planning/forecasting
- **Lab:** Real inventory for fulfillment; prioritize if both available
- **Low-Stock Alert:** Flag if <10 units in all warehouses combined

### Document Branding
- **PDF Templates:** Stored in `data/templates/` with CSS variables for brand colors
- **Dynamic Sections:** Customer info, itemized quote, terms, payment instructions
- **Compliance:** Auto-include HS codes, CoO fields, tax ID on exports

---

## 8. Example User Flow

1. **Sales team member opens Quote Builder**
   - Sees "New Quote" button
   - Selects customer: "Acme Vision Center"
   
2. **Searches for supplies**
   - Types "titanium frame" → shows 12 matches
   - Clicks "Titanium Frame Pro" ($28 MSRP, 156 in stock)
   
3. **Adds to quote**
   - Quantity: 50 units
   - System applies 10% volume discount → $25.20/unit
   - Line total: $1,260
   
4. **Adds lenses**
   - Selects "Progressive High-Index 1.67"
   - Quantity: 50
   - Turnaround: 5 days (lab at 78% capacity)
   - Unit price: $72 (includes lab processing)
   - Line total: $3,600
   
5. **Finalizes quote**
   - Subtotal: $4,860
   - Tax (if applicable): $389
   - **Total: $5,249**
   
6. **Exports & sends**
   - Clicks "Email to Lead"
   - Auto-generates PDF, embeds in email
   - Sends to customer with 30-day expiry
   
7. **Tracks**
   - Dashboard shows quote as "Sent"
   - Auto-reminder in 27 days if not accepted
   - When customer accepts → auto-create invoice + CoO

---

## 9. Success Metrics

- **Quote time:** Reduce from 15 min (manual lookup) → 2 min (system)
- **Accuracy:** Zero pricing mismatches between quote & invoice
- **Margin:** Visibility into cost vs. price at quote time
- **Compliance:** All exports include required CoO/HS code data
- **Volume:** Track most-quoted products → inform inventory planning

