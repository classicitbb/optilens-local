USE [optilens_local];
GO

-- Standards catalog: controlled vocabulary for export paperwork (commercial
-- invoice + CARICOM CO) and the BeSwift fill. option_value = canonical/printed
-- value; beswift_value = exact BeSwift dropdown string (nullable = same as
-- option_value); applies_to_modes = comma list ('air','sea') or NULL for any.
IF OBJECT_ID(N'delivery.standards_catalog', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.standards_catalog (
        standards_catalog_id uniqueidentifier NOT NULL CONSTRAINT DF_delivery_stdcat_id DEFAULT NEWID(),
        field_key nvarchar(60) NOT NULL,
        option_value nvarchar(300) NOT NULL,
        beswift_value nvarchar(300) NULL,
        display_label nvarchar(300) NULL,
        applies_to_modes nvarchar(60) NULL,
        is_default bit NOT NULL CONSTRAINT DF_delivery_stdcat_default DEFAULT 0,
        is_active bit NOT NULL CONSTRAINT DF_delivery_stdcat_active DEFAULT 1,
        sort_order int NOT NULL CONSTRAINT DF_delivery_stdcat_sort DEFAULT 100,
        notes nvarchar(400) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_stdcat_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NULL,
        updated_by_user_id uniqueidentifier NULL,
        CONSTRAINT PK_delivery_standards_catalog PRIMARY KEY (standards_catalog_id)
    );
END;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UQ_delivery_stdcat_field_value'
      AND object_id = OBJECT_ID(N'delivery.standards_catalog')
)
BEGIN
    CREATE UNIQUE INDEX UQ_delivery_stdcat_field_value
        ON delivery.standards_catalog(field_key, option_value);
END;
GO

-- Idempotent seed: insert each option only if that (field_key, option_value)
-- pair is not already present, so re-running the migration never duplicates
-- and never clobbers operator edits to existing rows.
MERGE delivery.standards_catalog AS target
USING (VALUES
    -- Delivery terms (Incoterms 2020). FCA is the default for air; FOB retained
    -- for sea. seaOnly terms flagged via applies_to_modes = 'sea'.
    (N'deliveryTerms', N'FCA — Free Carrier',                    N'Free Carrier',                 N'FCA — Free Carrier',                    NULL,   1, 10),
    (N'deliveryTerms', N'FOB — Free on Board',                   N'Free on Board',                N'FOB — Free on Board',                   N'sea', 0, 20),
    (N'deliveryTerms', N'CPT — Carriage Paid To',                N'Carriage Paid To',             N'CPT — Carriage Paid To',                NULL,   0, 30),
    (N'deliveryTerms', N'CIP — Carriage and Insurance Paid To',  N'Carriage and Insurance Paid To', N'CIP — Carriage and Insurance Paid To', NULL,   0, 40),
    (N'deliveryTerms', N'CFR — Cost and Freight',                N'Cost and Freight',             N'CFR — Cost and Freight',                N'sea', 0, 50),
    (N'deliveryTerms', N'CIF — Cost, Insurance and Freight',     N'Cost, Insurance and Freight',  N'CIF — Cost, Insurance and Freight',     N'sea', 0, 60),
    (N'deliveryTerms', N'EXW — Ex Works',                        N'Ex Works',                     N'EXW — Ex Works',                        NULL,   0, 70),
    (N'deliveryTerms', N'DAP — Delivered at Place',              N'Delivered at Place',           N'DAP — Delivered at Place',              NULL,   0, 80),
    (N'deliveryTerms', N'DPU — Delivered at Place Unloaded',     N'Delivered at Place Unloaded',  N'DPU — Delivered at Place Unloaded',     NULL,   0, 90),
    (N'deliveryTerms', N'DDP — Delivered Duty Paid',             N'Delivered Duty Paid',          N'DDP — Delivered Duty Paid',             NULL,   0, 100),
    (N'deliveryTerms', N'FAS — Free Alongside Ship',             N'Free Alongside Ship',          N'FAS — Free Alongside Ship',             N'sea', 0, 110),
    -- Currency
    (N'currency', N'BARBADOS DOLLAR',       NULL, N'Barbados Dollar (BBD)',        NULL, 1, 10),
    (N'currency', N'UNITED STATES DOLLAR',  NULL, N'United States Dollar (USD)',   NULL, 0, 20),
    -- Presenting bank (our bank is always the first option)
    (N'presentingBank', N'Bank of Nova Scotia', NULL, N'Bank of Nova Scotia (Scotiabank)', NULL, 1, 10),
    -- Package type
    (N'packageType', N'Box, fibreboard', NULL, N'Box, fibreboard', NULL, 1, 10),
    (N'packageType', N'Carton',          NULL, N'Carton',          NULL, 0, 20),
    (N'packageType', N'Case',            NULL, N'Case',            NULL, 0, 30),
    -- Country of origin
    (N'countryOfOrigin', N'Barbados', NULL, N'Barbados', NULL, 1, 10),
    -- Mode of transport
    (N'modeOfTransport', N'Air', NULL, N'Air', N'air', 1, 10),
    (N'modeOfTransport', N'Sea', NULL, N'Sea', N'sea', 0, 20),
    -- Port of loading
    (N'portOfLoading', N'GRANTLEY ADAMS INTL. AIRPORT', NULL, N'Grantley Adams Intl. Airport (air)', N'air', 1, 10),
    (N'portOfLoading', N'BRIDGETOWN PORT',              NULL, N'Bridgetown Port (sea)',              N'sea', 0, 20),
    -- Unit of measure
    (N'unitOfMeasure', N'Number of Units', NULL, N'Number of Units', NULL, 1, 10),
    -- Rule of origin / origin criterion
    (N'ruleOfOrigin',    N'Percentage Value', NULL, N'Percentage Value', NULL, 1, 10),
    (N'originCriterion', N'L',                NULL, N'L — wholly produced / qualifying', NULL, 1, 10)
) AS src (field_key, option_value, beswift_value, display_label, applies_to_modes, is_default, sort_order)
ON target.field_key = src.field_key AND target.option_value = src.option_value
WHEN NOT MATCHED THEN
    INSERT (field_key, option_value, beswift_value, display_label, applies_to_modes, is_default, sort_order)
    VALUES (src.field_key, src.option_value, src.beswift_value, src.display_label, src.applies_to_modes, src.is_default, src.sort_order);
GO
