USE [optilens_local];
GO

IF OBJECT_ID(N'archive.access_import_batches', N'U') IS NULL
BEGIN
    CREATE TABLE archive.access_import_batches (
        import_batch_id uniqueidentifier NOT NULL CONSTRAINT DF_archive_access_import_batches_id DEFAULT NEWID(),
        source_path nvarchar(600) NOT NULL,
        cutoff_date date NOT NULL,
        history_months int NOT NULL,
        started_at datetime2(0) NOT NULL CONSTRAINT DF_archive_access_import_batches_started DEFAULT SYSUTCDATETIME(),
        completed_at datetime2(0) NULL,
        status nvarchar(40) NOT NULL CONSTRAINT DF_archive_access_import_batches_status DEFAULT N'running',
        summary_json nvarchar(max) NULL,
        CONSTRAINT PK_archive_access_import_batches PRIMARY KEY (import_batch_id)
    );
END;
GO

IF OBJECT_ID(N'archive.access_deliveries', N'U') IS NULL
BEGIN
    CREATE TABLE archive.access_deliveries (
        legacy_delivery_no int NOT NULL,
        delivery_date datetime2(0) NULL,
        dispatcher_legacy_id int NULL,
        courier_legacy_id int NULL,
        import_batch_id uniqueidentifier NOT NULL,
        imported_at datetime2(0) NOT NULL CONSTRAINT DF_archive_access_deliveries_imported DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_archive_access_deliveries PRIMARY KEY (legacy_delivery_no)
    );
END;
GO

IF OBJECT_ID(N'archive.access_delivery_items', N'U') IS NULL
BEGIN
    CREATE TABLE archive.access_delivery_items (
        legacy_item_id int NOT NULL,
        legacy_delivery_no int NULL,
        rx_invoice_no nvarchar(120) NULL,
        comments nvarchar(max) NULL,
        customer_branch_legacy_id int NULL,
        patient nvarchar(300) NULL,
        total decimal(18, 2) NULL,
        customer_id int NULL,
        description nvarchar(500) NULL,
        customer_po nvarchar(200) NULL,
        rx_number nvarchar(120) NULL,
        import_batch_id uniqueidentifier NOT NULL,
        imported_at datetime2(0) NOT NULL CONSTRAINT DF_archive_access_delivery_items_imported DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_archive_access_delivery_items PRIMARY KEY (legacy_item_id)
    );
END;
GO

IF OBJECT_ID(N'archive.access_delivery_extras', N'U') IS NULL
BEGIN
    CREATE TABLE archive.access_delivery_extras (
        legacy_extra_id int NOT NULL,
        legacy_delivery_no int NULL,
        customer_branch_legacy_id int NULL,
        collect_cheque bit NULL,
        comments nvarchar(max) NULL,
        customer_id int NULL,
        import_batch_id uniqueidentifier NOT NULL,
        imported_at datetime2(0) NOT NULL CONSTRAINT DF_archive_access_delivery_extras_imported DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_archive_access_delivery_extras PRIMARY KEY (legacy_extra_id)
    );
END;
GO

IF OBJECT_ID(N'archive.access_commercial_invoices', N'U') IS NULL
BEGIN
    CREATE TABLE archive.access_commercial_invoices (
        legacy_invoice_id int NOT NULL,
        legacy_delivery_no int NULL,
        carrier nvarchar(200) NULL,
        airway_bill nvarchar(200) NULL,
        number_of_boxes nvarchar(80) NULL,
        gross_weight nvarchar(80) NULL,
        cubic_meters nvarchar(80) NULL,
        declaration_text nvarchar(max) NULL,
        description_of_goods nvarchar(max) NULL,
        packing_cost decimal(18, 2) NULL,
        freight_cost decimal(18, 2) NULL,
        other_cost decimal(18, 2) NULL,
        insurance_cost decimal(18, 2) NULL,
        po_numbers nvarchar(max) NULL,
        import_batch_id uniqueidentifier NOT NULL,
        imported_at datetime2(0) NOT NULL CONSTRAINT DF_archive_access_commercial_invoices_imported DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_archive_access_commercial_invoices PRIMARY KEY (legacy_invoice_id)
    );
END;
GO

IF OBJECT_ID(N'archive.access_customer_branches', N'U') IS NULL
BEGIN
    CREATE TABLE archive.access_customer_branches (
        legacy_branch_id int NOT NULL,
        customer_id int NULL,
        account_number nvarchar(120) NULL,
        credit_limit decimal(18, 2) NULL,
        opening_balance decimal(18, 2) NULL,
        location nvarchar(300) NULL,
        contact_name nvarchar(300) NULL,
        branch_name nvarchar(max) NULL,
        branch_tel nvarchar(120) NULL,
        branch_fax nvarchar(120) NULL,
        category nvarchar(120) NULL,
        show_in_phone_list bit NULL,
        show_price_in_delivery bit NULL,
        show_in_delivery_summary bit NULL,
        mobile_no nvarchar(120) NULL,
        overseas bit NULL,
        terms_of_payment nvarchar(200) NULL,
        country nvarchar(120) NULL,
        not_in_delivery_list bit NULL,
        alias int NULL,
        customer_category nvarchar(120) NULL,
        import_batch_id uniqueidentifier NOT NULL,
        imported_at datetime2(0) NOT NULL CONSTRAINT DF_archive_access_customer_branches_imported DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_archive_access_customer_branches PRIMARY KEY (legacy_branch_id)
    );
END;
GO

IF OBJECT_ID(N'archive.access_couriers', N'U') IS NULL
BEGIN
    CREATE TABLE archive.access_couriers (
        legacy_courier_id int NOT NULL,
        courier_name nvarchar(200) NULL,
        overseas_courier bit NULL,
        import_batch_id uniqueidentifier NOT NULL,
        imported_at datetime2(0) NOT NULL CONSTRAINT DF_archive_access_couriers_imported DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_archive_access_couriers PRIMARY KEY (legacy_courier_id)
    );
END;
GO

IF OBJECT_ID(N'archive.access_ci_declarations', N'U') IS NULL
BEGIN
    CREATE TABLE archive.access_ci_declarations (
        legacy_declaration_id int NOT NULL,
        declaration_text nvarchar(max) NULL,
        import_batch_id uniqueidentifier NOT NULL,
        imported_at datetime2(0) NOT NULL CONSTRAINT DF_archive_access_ci_declarations_imported DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_archive_access_ci_declarations PRIMARY KEY (legacy_declaration_id)
    );
END;
GO

IF OBJECT_ID(N'archive.access_ci_goods', N'U') IS NULL
BEGIN
    CREATE TABLE archive.access_ci_goods (
        legacy_goods_id int NOT NULL,
        description_of_goods nvarchar(max) NULL,
        import_batch_id uniqueidentifier NOT NULL,
        imported_at datetime2(0) NOT NULL CONSTRAINT DF_archive_access_ci_goods_imported DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_archive_access_ci_goods PRIMARY KEY (legacy_goods_id)
    );
END;
GO

IF OBJECT_ID(N'archive.access_dispatchers', N'U') IS NULL
BEGIN
    CREATE TABLE archive.access_dispatchers (
        legacy_dispatcher_id int NOT NULL,
        dispatcher_name nvarchar(200) NULL,
        import_batch_id uniqueidentifier NOT NULL,
        imported_at datetime2(0) NOT NULL CONSTRAINT DF_archive_access_dispatchers_imported DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_archive_access_dispatchers PRIMARY KEY (legacy_dispatcher_id)
    );
END;
GO

IF OBJECT_ID(N'archive.access_company', N'U') IS NULL
BEGIN
    CREATE TABLE archive.access_company (
        legacy_company_id int NOT NULL,
        company_name nvarchar(300) NULL,
        no_charge_amount decimal(18, 2) NULL,
        import_batch_id uniqueidentifier NOT NULL,
        imported_at datetime2(0) NOT NULL CONSTRAINT DF_archive_access_company_imported DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_archive_access_company PRIMARY KEY (legacy_company_id)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_archive_access_deliveries_delivery_date' AND object_id = OBJECT_ID(N'archive.access_deliveries'))
    CREATE INDEX IX_archive_access_deliveries_delivery_date ON archive.access_deliveries (delivery_date);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_archive_access_delivery_items_delivery_no' AND object_id = OBJECT_ID(N'archive.access_delivery_items'))
    CREATE INDEX IX_archive_access_delivery_items_delivery_no ON archive.access_delivery_items (legacy_delivery_no);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_archive_access_commercial_invoices_delivery_no' AND object_id = OBJECT_ID(N'archive.access_commercial_invoices'))
    CREATE INDEX IX_archive_access_commercial_invoices_delivery_no ON archive.access_commercial_invoices (legacy_delivery_no);
GO
