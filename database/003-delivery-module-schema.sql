USE [optilens_local];
GO

IF OBJECT_ID(N'delivery.shipment_sessions', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.shipment_sessions (
        shipment_session_id uniqueidentifier NOT NULL CONSTRAINT DF_delivery_shipment_sessions_id DEFAULT NEWID(),
        tenant_id uniqueidentifier NULL,
        source_system nvarchar(80) NOT NULL,
        source_shipment_id nvarchar(120) NULL,
        customer_account nvarchar(120) NULL,
        dispatcher_id nvarchar(120) NULL,
        app_status nvarchar(40) NOT NULL CONSTRAINT DF_delivery_shipment_sessions_status DEFAULT N'prep',
        source_shipped bit NULL,
        started_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_shipment_sessions_started DEFAULT SYSUTCDATETIME(),
        closed_at datetime2(0) NULL,
        reopened_at datetime2(0) NULL,
        last_edited_at datetime2(0) NULL,
        notes nvarchar(max) NULL,
        legacy_delivery_no int NULL,
        CONSTRAINT PK_delivery_shipment_sessions PRIMARY KEY (shipment_session_id)
    );
END;
GO

IF OBJECT_ID(N'delivery.shipment_session_items', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.shipment_session_items (
        shipment_session_item_id uniqueidentifier NOT NULL CONSTRAINT DF_delivery_shipment_session_items_id DEFAULT NEWID(),
        shipment_session_id uniqueidentifier NOT NULL,
        source_system nvarchar(80) NOT NULL,
        source_shipment_item_id nvarchar(120) NULL,
        source_order_id nvarchar(120) NULL,
        invoice_number nvarchar(120) NULL,
        patient_name nvarchar(300) NULL,
        price decimal(18, 2) NULL,
        item_state nvarchar(40) NOT NULL CONSTRAINT DF_delivery_shipment_session_items_state DEFAULT N'prep',
        added_method nvarchar(40) NOT NULL,
        removed_at datetime2(0) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_shipment_session_items_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_delivery_shipment_session_items PRIMARY KEY (shipment_session_item_id),
        CONSTRAINT FK_delivery_shipment_session_items_session FOREIGN KEY (shipment_session_id) REFERENCES delivery.shipment_sessions(shipment_session_id)
    );
END;
GO

IF OBJECT_ID(N'delivery.shipment_events', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.shipment_events (
        shipment_event_id bigint IDENTITY(1,1) NOT NULL,
        shipment_session_id uniqueidentifier NOT NULL,
        event_type nvarchar(120) NOT NULL,
        actor_user_id uniqueidentifier NULL,
        event_data nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_shipment_events_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_delivery_shipment_events PRIMARY KEY (shipment_event_id),
        CONSTRAINT FK_delivery_shipment_events_session FOREIGN KEY (shipment_session_id) REFERENCES delivery.shipment_sessions(shipment_session_id)
    );
END;
GO

IF OBJECT_ID(N'delivery.dispatchers', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.dispatchers (
        dispatcher_id uniqueidentifier NOT NULL CONSTRAINT DF_delivery_dispatchers_id DEFAULT NEWID(),
        legacy_dispatcher_id int NULL,
        dispatcher_name nvarchar(200) NOT NULL,
        is_active bit NOT NULL CONSTRAINT DF_delivery_dispatchers_active DEFAULT 1,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_dispatchers_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_delivery_dispatchers PRIMARY KEY (dispatcher_id)
    );
END;
GO

IF OBJECT_ID(N'delivery.customer_branches', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.customer_branches (
        customer_branch_id uniqueidentifier NOT NULL CONSTRAINT DF_delivery_customer_branches_id DEFAULT NEWID(),
        legacy_branch_id int NULL,
        customer_account nvarchar(120) NULL,
        branch_name nvarchar(300) NULL,
        customer_id nvarchar(120) NULL,
        show_price_in_delivery bit NULL,
        raw_json nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_customer_branches_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_delivery_customer_branches PRIMARY KEY (customer_branch_id)
    );
END;
GO

IF OBJECT_ID(N'delivery.access_import_map', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.access_import_map (
        access_import_map_id bigint IDENTITY(1,1) NOT NULL,
        source_database nvarchar(260) NOT NULL,
        source_table nvarchar(160) NOT NULL,
        source_key nvarchar(160) NOT NULL,
        target_schema nvarchar(80) NOT NULL,
        target_table nvarchar(160) NOT NULL,
        target_key nvarchar(160) NOT NULL,
        import_batch_id uniqueidentifier NOT NULL,
        imported_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_access_import_map_imported DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_delivery_access_import_map PRIMARY KEY (access_import_map_id)
    );
END;
GO

IF OBJECT_ID(N'delivery.commercial_invoices', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.commercial_invoices (
        commercial_invoice_id uniqueidentifier NOT NULL CONSTRAINT DF_delivery_commercial_invoices_id DEFAULT NEWID(),
        shipment_session_id uniqueidentifier NULL,
        legacy_delivery_id int NULL,
        carrier nvarchar(200) NULL,
        airway_bill nvarchar(200) NULL,
        po_numbers nvarchar(max) NULL,
        description_of_goods nvarchar(max) NULL,
        declaration_text nvarchar(max) NULL,
        number_of_boxes int NULL,
        gross_weight decimal(18, 3) NULL,
        cubic_meters decimal(18, 3) NULL,
        packing_cost decimal(18, 2) NULL,
        freight_cost decimal(18, 2) NULL,
        other_cost decimal(18, 2) NULL,
        insurance_cost decimal(18, 2) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_commercial_invoices_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NULL,
        CONSTRAINT PK_delivery_commercial_invoices PRIMARY KEY (commercial_invoice_id),
        CONSTRAINT FK_delivery_commercial_invoices_session FOREIGN KEY (shipment_session_id) REFERENCES delivery.shipment_sessions(shipment_session_id)
    );
END;
GO
