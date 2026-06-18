USE [optilens_local];
GO

IF SCHEMA_ID(N'pricing') IS NULL
BEGIN
    EXEC(N'CREATE SCHEMA pricing');
END;
GO

IF OBJECT_ID(N'pricing.price_rules', N'U') IS NULL
BEGIN
    CREATE TABLE pricing.price_rules (
        pricing_rule_id uniqueidentifier NOT NULL CONSTRAINT DF_pricing_price_rules_id DEFAULT NEWID(),
        tenant_id uniqueidentifier NULL,
        rule_code nvarchar(120) NOT NULL,
        rule_name nvarchar(200) NOT NULL,
        customer_account nvarchar(120) NULL,
        product_code nvarchar(120) NULL,
        base_price decimal(18, 2) NULL,
        markup_percent decimal(9, 4) NOT NULL CONSTRAINT DF_pricing_price_rules_markup DEFAULT 0,
        fixed_adjustment decimal(18, 2) NOT NULL CONSTRAINT DF_pricing_price_rules_adjustment DEFAULT 0,
        min_price decimal(18, 2) NULL,
        max_price decimal(18, 2) NULL,
        rounding_increment decimal(18, 2) NOT NULL CONSTRAINT DF_pricing_price_rules_rounding DEFAULT .01,
        priority int NOT NULL CONSTRAINT DF_pricing_price_rules_priority DEFAULT 100,
        is_active bit NOT NULL CONSTRAINT DF_pricing_price_rules_active DEFAULT 1,
        effective_from datetime2(0) NULL,
        effective_to datetime2(0) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_pricing_price_rules_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NULL,
        CONSTRAINT PK_pricing_price_rules PRIMARY KEY (pricing_rule_id),
        CONSTRAINT UQ_pricing_price_rules_code UNIQUE (rule_code),
        CONSTRAINT FK_pricing_price_rules_tenant FOREIGN KEY (tenant_id) REFERENCES core.tenants(tenant_id)
    );
END;
GO

IF OBJECT_ID(N'pricing.price_calculations', N'U') IS NULL
BEGIN
    CREATE TABLE pricing.price_calculations (
        price_calculation_id bigint IDENTITY(1,1) NOT NULL,
        pricing_rule_id uniqueidentifier NULL,
        tenant_id uniqueidentifier NULL,
        customer_account nvarchar(120) NULL,
        product_code nvarchar(120) NULL,
        source_reference nvarchar(200) NULL,
        input_price decimal(18, 2) NOT NULL,
        calculated_price decimal(18, 2) NOT NULL,
        explanation_json nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_pricing_price_calculations_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_pricing_price_calculations PRIMARY KEY (price_calculation_id),
        CONSTRAINT FK_pricing_price_calculations_rule FOREIGN KEY (pricing_rule_id) REFERENCES pricing.price_rules(pricing_rule_id),
        CONSTRAINT FK_pricing_price_calculations_tenant FOREIGN KEY (tenant_id) REFERENCES core.tenants(tenant_id)
    );
END;
GO

