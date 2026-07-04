USE [optilens_local];
GO

IF OBJECT_ID(N'delivery.co_item_catalog', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.co_item_catalog (
        co_item_catalog_id uniqueidentifier NOT NULL CONSTRAINT DF_delivery_coic_id DEFAULT NEWID(),
        item_name nvarchar(400) NOT NULL,
        item_category nvarchar(40) NULL,
        hs_code nvarchar(20) NULL,
        hs_description nvarchar(300) NULL,
        commercial_description nvarchar(500) NULL,
        unit_of_measure nvarchar(60) NULL,
        weight_kg decimal(10, 4) NULL,
        country_of_origin nvarchar(120) NULL,
        times_seen int NOT NULL CONSTRAINT DF_delivery_coic_times_seen DEFAULT 0,
        first_seen_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_coic_first_seen DEFAULT SYSUTCDATETIME(),
        last_seen_at datetime2(0) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_coic_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NULL,
        updated_by_user_id uniqueidentifier NULL,
        CONSTRAINT PK_delivery_co_item_catalog PRIMARY KEY (co_item_catalog_id)
    );
END;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UQ_delivery_coic_item_name'
      AND object_id = OBJECT_ID(N'delivery.co_item_catalog')
)
BEGIN
    CREATE UNIQUE INDEX UQ_delivery_coic_item_name
        ON delivery.co_item_catalog(item_name);
END;
GO
