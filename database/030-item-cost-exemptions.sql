-- Item cost defect exemptions.
--
-- The item-level cost defect register (lib/metrics/data-quality.js) is a live query over
-- the Innovations source: fix an item's cost there and it drops off the report on the
-- next refresh. No app-owned status tracking is wanted.
--
-- The one thing the source cannot tell us is which zero-cost items are zero-cost ON
-- PURPOSE. Innovations has a "Processes" misc item group (MiscItemGroupID = 77) holding
-- workflow triggers such as EDGINVTRIG "Edged Invoice Trigger" and UNCINVTRIG, which
-- legitimately carry no cost. But that group also holds job trays and a professional fee
-- that arguably SHOULD be costed, so the group cannot simply be excluded wholesale.
--
-- Hence this table: an operator-curated exemption list, pre-seeded from group 77 so the
-- report starts clean, with every decision attributed and reversible.
--
-- Keyed on the SKU string because dbo.InvoiceLines carries no item foreign key — the same
-- reason delivery.co_item_catalog keys on item name.

USE [optilens_local];
GO

IF SCHEMA_ID(N'pricing') IS NULL
    EXEC(N'CREATE SCHEMA pricing');
GO

IF OBJECT_ID(N'pricing.item_cost_exemptions', N'U') IS NULL
BEGIN
    CREATE TABLE pricing.item_cost_exemptions (
        exemption_id uniqueidentifier NOT NULL CONSTRAINT DF_pricing_ice_id DEFAULT NEWID(),
        item_key nvarchar(120) NOT NULL,
        item_description nvarchar(400) NULL,
        check_code nvarchar(40) NOT NULL CONSTRAINT DF_pricing_ice_check DEFAULT N'zero-cost',
        exemption_state nvarchar(40) NOT NULL CONSTRAINT DF_pricing_ice_state DEFAULT N'ACTIVE',
        reason nvarchar(max) NULL,
        source nvarchar(40) NOT NULL CONSTRAINT DF_pricing_ice_source DEFAULT N'OPERATOR',
        exempted_by uniqueidentifier NULL,
        exempted_at datetime2(0) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_pricing_ice_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_pricing_ice_updated DEFAULT SYSUTCDATETIME(),
        updated_by_user_id uniqueidentifier NULL,
        CONSTRAINT PK_pricing_item_cost_exemptions PRIMARY KEY (exemption_id),
        -- One row per item per check, so the same SKU can be exempt from zero-cost while
        -- still being reported for zero-price.
        CONSTRAINT UQ_pricing_item_cost_exemptions_key UNIQUE (item_key, check_code),
        CONSTRAINT CK_pricing_item_cost_exemptions_state
            CHECK (exemption_state IN (N'ACTIVE', N'REVOKED')),
        CONSTRAINT CK_pricing_item_cost_exemptions_source
            CHECK (source IN (N'OPERATOR', N'SEED'))
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'IX_pricing_ice_active'
                 AND object_id = OBJECT_ID(N'pricing.item_cost_exemptions'))
BEGIN
    -- The register filters on this every refresh.
    CREATE INDEX IX_pricing_ice_active
        ON pricing.item_cost_exemptions (check_code, exemption_state) INCLUDE (item_key);
END;
GO

-- Seed the known workflow triggers. MERGE rather than INSERT so re-running migrations
-- never clobbers an operator's edits or resurrects something they revoked.
MERGE pricing.item_cost_exemptions AS target
USING (VALUES
    (N'EDGINVTRIG', N'Edged Invoice Trigger'),
    (N'UNCINVTRIG', N'Uncut Invoice Trigger')
) AS seed (item_key, item_description)
    ON target.item_key = seed.item_key AND target.check_code = N'zero-cost'
WHEN NOT MATCHED THEN
    INSERT (item_key, item_description, check_code, exemption_state, reason, source, exempted_at)
    VALUES (seed.item_key, seed.item_description, N'zero-cost', N'ACTIVE',
            N'Workflow trigger in the Innovations "Processes" group (MiscItemGroupID 77) — exists to drive lab routing, not to be costed.',
            N'SEED', SYSUTCDATETIME());
GO
