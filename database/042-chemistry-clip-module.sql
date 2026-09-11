USE [optilens_local];
GO

-- Chemistrie clip inventory + order recording module.
--
-- Source-of-truth split, same pattern as metrics.inventory_overrides /
-- inventory_snapshots (029): the clip parts catalog (lenses, bridges,
-- magnets, bushings, spacers, cases, cloths) already exists in Innovations
-- as dbo.MiscItems, identified by its SKU column -- that IS the barcode
-- printed on the drawer labels. This module never writes back to
-- Innovations (source-system writeback is disabled by default, see
-- AGENTS.md); it keeps its own app-owned usage ledger layered on top of a
-- periodically-synced read-only cache of that catalog. "Available qty" is
-- computed as cache.on_hand minus usage recorded since last_synced_at, not
-- a live Innovations value.
--
-- Access to this module's page/API is gated by its own PIN session (see
-- lib/chemistry-pin-session.js), not the core.users/core.modules permission
-- system every other module uses -- deliberate, per the shop-floor-tablet
-- requirement discussed for this module. It is therefore NOT registered in
-- core.modules.
IF SCHEMA_ID(N'chemistry') IS NULL EXEC(N'CREATE SCHEMA chemistry');
GO

-- ── Local cache of the Innovations MiscItems catalog ───────────────────────
-- Refreshed on a sync cadence (extends the existing `supplies` sync entity
-- in lib/innovations-sync.js). Lets barcode/voice lookup resolve a SKU
-- without a live Innovations round trip per scan.
IF OBJECT_ID(N'chemistry.item_catalog_cache', N'U') IS NULL
BEGIN
    CREATE TABLE chemistry.item_catalog_cache (
        innovations_misc_item_id int NOT NULL,
        sku nvarchar(40) NOT NULL,
        name nvarchar(300) NOT NULL,
        category nvarchar(120) NULL,
        on_hand decimal(10, 2) NULL,
        last_synced_at datetime2(0) NOT NULL CONSTRAINT DF_chemistry_catalog_synced DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_chemistry_item_catalog_cache PRIMARY KEY (innovations_misc_item_id)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'UQ_chemistry_catalog_sku'
                 AND object_id = OBJECT_ID(N'chemistry.item_catalog_cache'))
BEGIN
    CREATE UNIQUE INDEX UQ_chemistry_catalog_sku
        ON chemistry.item_catalog_cache(sku);
END;
GO

-- ── Default bundle items (case + cloth) ─────────────────────────────────────
-- Auto-added to every new order; removable per order. Editable later without
-- a schema change -- exactly one active row per item_role is the expected
-- shape, enforced by the app, not the schema (a brief transitional state
-- with zero or two active rows while an admin re-picks a default is fine).
IF OBJECT_ID(N'chemistry.default_bundle_items', N'U') IS NULL
BEGIN
    CREATE TABLE chemistry.default_bundle_items (
        default_bundle_item_id uniqueidentifier NOT NULL CONSTRAINT DF_chemistry_bundle_id DEFAULT NEWID(),
        item_role nvarchar(30) NOT NULL,
        sku nvarchar(40) NOT NULL,
        is_active bit NOT NULL CONSTRAINT DF_chemistry_bundle_active DEFAULT 1,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_chemistry_bundle_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_chemistry_default_bundle_items PRIMARY KEY (default_bundle_item_id),
        CONSTRAINT CK_chemistry_bundle_role CHECK (item_role IN (N'case', N'cloth'))
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM chemistry.default_bundle_items WHERE item_role = N'case' AND sku = N'0260030242')
BEGIN
    INSERT INTO chemistry.default_bundle_items (item_role, sku) VALUES (N'case', N'0260030242'); -- Black Magnetic Thin Case
END;
GO

IF NOT EXISTS (SELECT 1 FROM chemistry.default_bundle_items WHERE item_role = N'cloth' AND sku = N'0260030226')
BEGIN
    INSERT INTO chemistry.default_bundle_items (item_role, sku) VALUES (N'cloth', N'0260030226'); -- Pouch, Card, Cloth - Chemistrie
END;
GO

-- ── Orders ───────────────────────────────────────────────────────────────
-- One row per clip build, linked to the Innovations job/invoice. Columns
-- mirror the existing paper log binder 1:1 so the page can replace it
-- without retraining staff on new field names.
IF OBJECT_ID(N'chemistry.orders', N'U') IS NULL
BEGIN
    CREATE TABLE chemistry.orders (
        order_id uniqueidentifier NOT NULL CONSTRAINT DF_chemistry_orders_id DEFAULT NEWID(),
        job_number nvarchar(40) NULL,
        tray_number nvarchar(40) NULL,
        patient_name nvarchar(300) NOT NULL,
        optician nvarchar(80) NULL,
        order_date date NOT NULL CONSTRAINT DF_chemistry_orders_date DEFAULT CAST(SYSUTCDATETIME() AS date),

        base_curve nvarchar(10) NULL,
        lens_color nvarchar(60) NULL,
        lens_material nvarchar(60) NULL,
        bridge_color nvarchar(30) NULL,
        bridge_size_mm decimal(5, 2) NULL,
        magnet_color nvarchar(30) NULL,
        magnet_separation_mm decimal(5, 2) NULL,
        upsize_amount decimal(5, 2) NULL,
        edge_work nvarchar(20) NULL,
        clip_only bit NOT NULL CONSTRAINT DF_chemistry_orders_clip_only DEFAULT 0,
        redrill_only bit NOT NULL CONSTRAINT DF_chemistry_orders_redrill_only DEFAULT 0,
        permanent_crystal bit NOT NULL CONSTRAINT DF_chemistry_orders_perm_crystal DEFAULT 0,
        magnetic_crystal bit NOT NULL CONSTRAINT DF_chemistry_orders_mag_crystal DEFAULT 0,
        round_square nvarchar(10) NULL,
        comments nvarchar(max) NULL,

        fit_checked bit NOT NULL CONSTRAINT DF_chemistry_orders_fit_checked DEFAULT 0,
        fit_notes nvarchar(max) NULL,

        status nvarchar(20) NOT NULL CONSTRAINT DF_chemistry_orders_status DEFAULT N'draft',
        locked_at datetime2(0) NULL,
        locked_by nvarchar(100) NULL,
        created_by nvarchar(100) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_chemistry_orders_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NULL,
        CONSTRAINT PK_chemistry_orders PRIMARY KEY (order_id),
        CONSTRAINT CK_chemistry_orders_status CHECK (status IN (N'draft', N'locked'))
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_chemistry_orders_patient'
                 AND object_id = OBJECT_ID(N'chemistry.orders'))
BEGIN
    CREATE INDEX IX_chemistry_orders_patient ON chemistry.orders(patient_name);
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_chemistry_orders_job'
                 AND object_id = OBJECT_ID(N'chemistry.orders'))
BEGIN
    CREATE INDEX IX_chemistry_orders_job ON chemistry.orders(job_number);
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_chemistry_orders_tray'
                 AND object_id = OBJECT_ID(N'chemistry.orders'))
BEGIN
    CREATE INDEX IX_chemistry_orders_tray ON chemistry.orders(tray_number);
END;
GO

-- ── Order items (inventory usage ledger) ────────────────────────────────────
IF OBJECT_ID(N'chemistry.order_items', N'U') IS NULL
BEGIN
    CREATE TABLE chemistry.order_items (
        order_item_id uniqueidentifier NOT NULL CONSTRAINT DF_chemistry_order_items_id DEFAULT NEWID(),
        order_id uniqueidentifier NOT NULL,
        innovations_misc_item_id int NOT NULL,
        sku nvarchar(40) NOT NULL,
        item_name nvarchar(300) NOT NULL,
        item_role nvarchar(30) NOT NULL,
        quantity decimal(9, 2) NOT NULL CONSTRAINT DF_chemistry_order_items_qty DEFAULT 1,
        entry_method nvarchar(20) NOT NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_chemistry_order_items_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_chemistry_order_items PRIMARY KEY (order_item_id),
        CONSTRAINT FK_chemistry_order_items_order FOREIGN KEY (order_id) REFERENCES chemistry.orders(order_id),
        CONSTRAINT CK_chemistry_order_items_role CHECK (item_role IN (
            N'lens', N'bridge', N'magnet', N'bushing', N'spacer', N'case', N'cloth', N'other'
        )),
        CONSTRAINT CK_chemistry_order_items_method CHECK (entry_method IN (N'barcode', N'voice', N'manual'))
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_chemistry_order_items_order'
                 AND object_id = OBJECT_ID(N'chemistry.order_items'))
BEGIN
    CREATE INDEX IX_chemistry_order_items_order ON chemistry.order_items(order_id);
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_chemistry_order_items_sku'
                 AND object_id = OBJECT_ID(N'chemistry.order_items'))
BEGIN
    CREATE INDEX IX_chemistry_order_items_sku ON chemistry.order_items(sku);
END;
GO

-- ── Order photos ─────────────────────────────────────────────────────────
IF OBJECT_ID(N'chemistry.order_photos', N'U') IS NULL
BEGIN
    CREATE TABLE chemistry.order_photos (
        order_photo_id uniqueidentifier NOT NULL CONSTRAINT DF_chemistry_order_photos_id DEFAULT NEWID(),
        order_id uniqueidentifier NOT NULL,
        file_path nvarchar(400) NOT NULL,
        taken_at datetime2(0) NOT NULL CONSTRAINT DF_chemistry_order_photos_taken DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_chemistry_order_photos PRIMARY KEY (order_photo_id),
        CONSTRAINT FK_chemistry_order_photos_order FOREIGN KEY (order_id) REFERENCES chemistry.orders(order_id)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_chemistry_order_photos_order'
                 AND object_id = OBJECT_ID(N'chemistry.order_photos'))
BEGIN
    CREATE INDEX IX_chemistry_order_photos_order ON chemistry.order_photos(order_id);
END;
GO

-- ── Order events (audit trail) ──────────────────────────────────────────────
IF OBJECT_ID(N'chemistry.order_events', N'U') IS NULL
BEGIN
    CREATE TABLE chemistry.order_events (
        order_event_id bigint IDENTITY(1, 1) NOT NULL,
        order_id uniqueidentifier NOT NULL,
        event_type nvarchar(40) NOT NULL,
        event_data nvarchar(max) NULL,
        actor nvarchar(100) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_chemistry_order_events_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_chemistry_order_events PRIMARY KEY (order_event_id),
        CONSTRAINT FK_chemistry_order_events_order FOREIGN KEY (order_id) REFERENCES chemistry.orders(order_id)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_chemistry_order_events_order'
                 AND object_id = OBJECT_ID(N'chemistry.order_events'))
BEGIN
    CREATE INDEX IX_chemistry_order_events_order ON chemistry.order_events(order_id, created_at);
END;
GO

-- ── Available quantity view ─────────────────────────────────────────────────
-- cache.on_hand minus usage recorded since the cache row was last synced.
-- Not a live Innovations value -- see the module header note above.
IF OBJECT_ID(N'chemistry.item_available_qty', N'V') IS NOT NULL
    DROP VIEW chemistry.item_available_qty;
GO

CREATE VIEW chemistry.item_available_qty AS
SELECT
    c.innovations_misc_item_id,
    c.sku,
    c.name,
    c.category,
    c.on_hand,
    c.last_synced_at,
    ISNULL(u.used_since_sync, 0) AS used_since_sync,
    c.on_hand - ISNULL(u.used_since_sync, 0) AS available_qty
FROM chemistry.item_catalog_cache c
LEFT JOIN (
    SELECT oi.sku, SUM(oi.quantity) AS used_since_sync
    FROM chemistry.order_items oi
    INNER JOIN chemistry.item_catalog_cache cc ON cc.sku = oi.sku
    WHERE oi.created_at >= cc.last_synced_at
    GROUP BY oi.sku
) u ON u.sku = c.sku;
GO
