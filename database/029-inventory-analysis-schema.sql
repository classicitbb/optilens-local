USE [optilens_local];
GO

-- Inventory analysis (Business Metrics → Inventory tab).
--
-- Three app-owned tables. None of this lives in Innovations: that source is
-- configured read-only and is owned by the vendor, so every judgement we layer
-- on top of it (this item's zero cost is deliberate, I've decided not to write
-- this off, this is what stock looked like last Tuesday) is recorded here.
--
-- Lens identity is the six-part compound key
--   (MaterialGroup, Material, MFType, LensType, Option, Num)
-- because LensItem.Num alone is NOT unique — joining on it fans out roughly 2x.
-- Misc items key on MiscItemID. item_kind says which of the two applies.
IF SCHEMA_ID(N'metrics') IS NULL EXEC(N'CREATE SCHEMA metrics');
GO

-- ── Overrides ───────────────────────────────────────────────────────────────
-- Suppresses an exception alert for one item. The motivating case: written-off
-- stock deliberately held at zero cost with a quantity still on the shelf, so
-- the lab knows it exists. Those must stay at zero cost AND stop alerting.
--
-- Suppressed items are never hidden — the tab shows them in a "suppressed" view
-- with the reason — so an override is an annotation, not a deletion.
IF OBJECT_ID(N'metrics.inventory_overrides', N'U') IS NULL
BEGIN
    CREATE TABLE metrics.inventory_overrides (
        inventory_override_id uniqueidentifier NOT NULL
            CONSTRAINT DF_metrics_invovr_id DEFAULT NEWID(),
        item_kind nvarchar(10) NOT NULL,          -- 'lens' | 'misc'
        -- Lens six-part compound key (NULL for misc items).
        material_group int NULL,
        material int NULL,
        mf_type int NULL,
        lens_type int NULL,
        lens_option int NULL,
        item_num int NULL,
        -- Misc item key (NULL for lenses).
        misc_item_id int NULL,
        -- Which alert this override silences. 'zero_cost' | 'negative_qty' |
        -- 'slow_mover' | 'non_mover' | 'all'.
        alert_kind nvarchar(30) NOT NULL,
        is_suppressed bit NOT NULL CONSTRAINT DF_metrics_invovr_supp DEFAULT 1,
        reason nvarchar(500) NOT NULL,
        item_label nvarchar(400) NULL,            -- human-readable name at time of override
        created_at datetime2(0) NOT NULL CONSTRAINT DF_metrics_invovr_created DEFAULT SYSUTCDATETIME(),
        created_by_user_id uniqueidentifier NULL,
        created_by nvarchar(100) NULL,
        updated_at datetime2(0) NULL,
        updated_by nvarchar(100) NULL,
        CONSTRAINT PK_metrics_inventory_overrides PRIMARY KEY (inventory_override_id),
        CONSTRAINT CK_metrics_invovr_kind CHECK (item_kind IN (N'lens', N'misc')),
        -- Exactly one identity must be supplied, matching item_kind.
        CONSTRAINT CK_metrics_invovr_identity CHECK (
            (item_kind = N'lens' AND misc_item_id IS NULL
                AND material_group IS NOT NULL AND material IS NOT NULL
                AND mf_type IS NOT NULL AND lens_type IS NOT NULL
                AND lens_option IS NOT NULL AND item_num IS NOT NULL)
            OR
            (item_kind = N'misc' AND misc_item_id IS NOT NULL
                AND material_group IS NULL AND material IS NULL
                AND mf_type IS NULL AND lens_type IS NULL
                AND lens_option IS NULL AND item_num IS NULL)
        )
    );
END;
GO

-- One override per (item, alert_kind). Filtered-unique on each identity shape so
-- the NULL columns of the other shape never collide.
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'UQ_metrics_invovr_lens'
                 AND object_id = OBJECT_ID(N'metrics.inventory_overrides'))
BEGIN
    CREATE UNIQUE INDEX UQ_metrics_invovr_lens
        ON metrics.inventory_overrides(material_group, material, mf_type, lens_type, lens_option, item_num, alert_kind)
        WHERE item_kind = N'lens';
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'UQ_metrics_invovr_misc'
                 AND object_id = OBJECT_ID(N'metrics.inventory_overrides'))
BEGIN
    CREATE UNIQUE INDEX UQ_metrics_invovr_misc
        ON metrics.inventory_overrides(misc_item_id, alert_kind)
        WHERE item_kind = N'misc';
END;
GO

-- ── Recommendation decisions ────────────────────────────────────────────────
-- "Write this off / promote it / order more" prompts are advisory only; nothing
-- acts automatically. This records what a human decided so the same item stops
-- shouting, and so there is an audit trail of why.
IF OBJECT_ID(N'metrics.inventory_recommendation_actions', N'U') IS NULL
BEGIN
    CREATE TABLE metrics.inventory_recommendation_actions (
        recommendation_action_id uniqueidentifier NOT NULL
            CONSTRAINT DF_metrics_invrec_id DEFAULT NEWID(),
        item_kind nvarchar(10) NOT NULL,
        material_group int NULL,
        material int NULL,
        mf_type int NULL,
        lens_type int NULL,
        lens_option int NULL,
        item_num int NULL,
        misc_item_id int NULL,
        recommendation_kind nvarchar(40) NOT NULL,   -- 'write_off' | 'promote' | 'discount' | 'reorder' | 'trending_up'
        decision nvarchar(20) NOT NULL,              -- 'dismissed' | 'snoozed' | 'actioned'
        reason nvarchar(500) NULL,
        snooze_until datetime2(0) NULL,
        -- What the numbers were when the decision was taken, so a later reader can
        -- tell whether the situation has since changed.
        context_json nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_metrics_invrec_created DEFAULT SYSUTCDATETIME(),
        created_by_user_id uniqueidentifier NULL,
        created_by nvarchar(100) NULL,
        CONSTRAINT PK_metrics_inventory_recommendation_actions PRIMARY KEY (recommendation_action_id),
        CONSTRAINT CK_metrics_invrec_kind CHECK (item_kind IN (N'lens', N'misc')),
        CONSTRAINT CK_metrics_invrec_decision CHECK (decision IN (N'dismissed', N'snoozed', N'actioned'))
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_metrics_invrec_lookup'
                 AND object_id = OBJECT_ID(N'metrics.inventory_recommendation_actions'))
BEGIN
    CREATE INDEX IX_metrics_invrec_lookup
        ON metrics.inventory_recommendation_actions(recommendation_kind, created_at DESC)
        INCLUDE (item_kind, misc_item_id, snooze_until);
END;
GO

-- ── Point-in-time snapshots ─────────────────────────────────────────────────
-- The only part of this build that cannot be backfilled.
--
-- LensItem.OnHand_* and MiscItems.OnHand are CURRENT values with no history.
-- Walking StockTransactions backwards reconstructs on-hand only approximately:
-- measured against the 3,497 stocked lens rows, the ledger net matched exactly
-- for 2,489 (71%) and to within +/-2 units for 3,105 (89%), with a 6.5% gap in
-- aggregate (23,785 on hand vs 25,329 ledger net) — and there is no way to tell
-- which items fall in the wrong 11%.
--
-- So cover-over-time ("this item's months of supply is trending down") is only
-- trustworthy from the day we start recording it. ~3,762 lens rows + ~340 misc
-- per weekly run.
IF OBJECT_ID(N'metrics.inventory_snapshots', N'U') IS NULL
BEGIN
    CREATE TABLE metrics.inventory_snapshots (
        inventory_snapshot_id bigint IDENTITY(1,1) NOT NULL,
        snapshot_date date NOT NULL,
        item_kind nvarchar(10) NOT NULL,
        material_group int NULL,
        material int NULL,
        mf_type int NULL,
        lens_type int NULL,
        lens_option int NULL,
        item_num int NULL,
        misc_item_id int NULL,
        item_label nvarchar(400) NULL,
        on_hand int NOT NULL,
        unit_cost decimal(18, 4) NULL,
        stock_value decimal(18, 4) NULL,
        -- Demand and classification as computed on the snapshot date, so a later
        -- reader reproduces that day's verdict without re-deriving it.
        units_moved_window int NULL,
        window_months int NULL,
        speed_class nvarchar(20) NULL,            -- 'non_mover' | 'slow' | 'regular' | 'fast'
        months_of_cover decimal(10, 2) NULL,      -- NULL = no demand, cover is undefined not infinite
        treatment nvarchar(60) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_metrics_invsnap_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_metrics_inventory_snapshots PRIMARY KEY (inventory_snapshot_id)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_metrics_invsnap_date'
                 AND object_id = OBJECT_ID(N'metrics.inventory_snapshots'))
BEGIN
    CREATE INDEX IX_metrics_invsnap_date
        ON metrics.inventory_snapshots(snapshot_date DESC)
        INCLUDE (item_kind, on_hand, stock_value, speed_class);
END;
GO

-- One row per item per snapshot date; a re-run on the same day overwrites rather
-- than duplicating.
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'UQ_metrics_invsnap_lens'
                 AND object_id = OBJECT_ID(N'metrics.inventory_snapshots'))
BEGIN
    CREATE UNIQUE INDEX UQ_metrics_invsnap_lens
        ON metrics.inventory_snapshots(snapshot_date, material_group, material, mf_type, lens_type, lens_option, item_num)
        WHERE item_kind = N'lens';
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'UQ_metrics_invsnap_misc'
                 AND object_id = OBJECT_ID(N'metrics.inventory_snapshots'))
BEGIN
    CREATE UNIQUE INDEX UQ_metrics_invsnap_misc
        ON metrics.inventory_snapshots(snapshot_date, misc_item_id)
        WHERE item_kind = N'misc';
END;
GO

-- ── Default thresholds ──────────────────────────────────────────────────────
-- Seeded only if absent, so re-running the migration never clobbers a retune.
-- Cut points follow the natural breaks in 24 months of measured demand; every
-- metric and CSV records the thresholds that produced it.
MERGE core.app_settings AS target
USING (VALUES
    (N'inventory_window_months',   N'24'),
    (N'inventory_slow_max_units',  N'5'),
    (N'inventory_regular_max_units', N'30'),
    (N'inventory_cover_warn_months', N'12'),
    (N'inventory_cover_critical_months', N'24')
) AS source (setting_key, setting_value)
    ON target.setting_key = source.setting_key
WHEN NOT MATCHED BY TARGET THEN
    INSERT (setting_key, setting_value, updated_by)
    VALUES (source.setting_key, source.setting_value, N'029-inventory-analysis-schema');
GO
