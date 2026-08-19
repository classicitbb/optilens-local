-- QBO invoice synchronization ledger and deterministic external mappings.
-- Innovations remains read-only; QBO IDs live only in the private app database.

IF SCHEMA_ID(N'qbo') IS NULL EXEC(N'CREATE SCHEMA qbo');

IF OBJECT_ID(N'qbo.invoice_sync_ledger', N'U') IS NULL
BEGIN
    CREATE TABLE qbo.invoice_sync_ledger (
        sync_ledger_id uniqueidentifier NOT NULL CONSTRAINT DF_qbo_invoice_sync_ledger_id DEFAULT NEWID(),
        source_system nvarchar(80) NOT NULL,
        source_invoice_id nvarchar(120) NOT NULL,
        source_invoice_type nvarchar(40) NOT NULL,
        qbo_realm_id nvarchar(80) NOT NULL,
        qbo_transaction_type nvarchar(40) NULL,
        qbo_transaction_id nvarchar(120) NULL,
        qbo_doc_number nvarchar(120) NULL,
        source_customer_account nvarchar(120) NULL,
        source_customer_name nvarchar(300) NULL,
        source_total decimal(18,2) NULL,
        source_invoice_time datetime2(3) NULL,
        payload_hash nvarchar(64) NULL,
        status nvarchar(40) NOT NULL CONSTRAINT DF_qbo_invoice_sync_ledger_status DEFAULT N'discovered',
        attempt_count int NOT NULL CONSTRAINT DF_qbo_invoice_sync_ledger_attempts DEFAULT 0,
        last_error nvarchar(max) NULL,
        last_result_json nvarchar(max) NULL,
        first_seen_at datetime2(3) NOT NULL CONSTRAINT DF_qbo_invoice_sync_ledger_first_seen DEFAULT SYSUTCDATETIME(),
        last_attempt_at datetime2(3) NULL,
        synced_at datetime2(3) NULL,
        updated_at datetime2(3) NOT NULL CONSTRAINT DF_qbo_invoice_sync_ledger_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_qbo_invoice_sync_ledger PRIMARY KEY (sync_ledger_id),
        CONSTRAINT UQ_qbo_invoice_sync_ledger_source UNIQUE (source_system, source_invoice_id, qbo_realm_id)
    );
END;

IF OBJECT_ID(N'qbo.customer_mappings', N'U') IS NULL
BEGIN
    CREATE TABLE qbo.customer_mappings (
        mapping_id uniqueidentifier NOT NULL CONSTRAINT DF_qbo_customer_mappings_id DEFAULT NEWID(),
        qbo_realm_id nvarchar(80) NOT NULL,
        source_account nvarchar(120) NOT NULL,
        source_name nvarchar(300) NULL,
        qbo_customer_id nvarchar(120) NOT NULL,
        qbo_display_name nvarchar(500) NULL,
        mapping_state nvarchar(30) NOT NULL CONSTRAINT DF_qbo_customer_mappings_state DEFAULT N'confirmed',
        created_at datetime2(3) NOT NULL CONSTRAINT DF_qbo_customer_mappings_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(3) NOT NULL CONSTRAINT DF_qbo_customer_mappings_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_qbo_customer_mappings PRIMARY KEY (mapping_id),
        CONSTRAINT UQ_qbo_customer_mappings_source UNIQUE (qbo_realm_id, source_account)
    );
END;

IF OBJECT_ID(N'qbo.item_mappings', N'U') IS NULL
BEGIN
    CREATE TABLE qbo.item_mappings (
        mapping_id uniqueidentifier NOT NULL CONSTRAINT DF_qbo_item_mappings_id DEFAULT NEWID(),
        qbo_realm_id nvarchar(80) NOT NULL,
        source_item_name nvarchar(300) NOT NULL,
        qbo_item_id nvarchar(120) NOT NULL,
        qbo_item_name nvarchar(500) NULL,
        mapping_state nvarchar(30) NOT NULL CONSTRAINT DF_qbo_item_mappings_state DEFAULT N'confirmed',
        created_at datetime2(3) NOT NULL CONSTRAINT DF_qbo_item_mappings_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(3) NOT NULL CONSTRAINT DF_qbo_item_mappings_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_qbo_item_mappings PRIMARY KEY (mapping_id),
        CONSTRAINT UQ_qbo_item_mappings_source UNIQUE (qbo_realm_id, source_item_name)
    );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_qbo_invoice_sync_ledger_status' AND object_id = OBJECT_ID(N'qbo.invoice_sync_ledger'))
    CREATE INDEX IX_qbo_invoice_sync_ledger_status ON qbo.invoice_sync_ledger(status, updated_at DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_qbo_invoice_sync_ledger_source_time' AND object_id = OBJECT_ID(N'qbo.invoice_sync_ledger'))
    CREATE INDEX IX_qbo_invoice_sync_ledger_source_time ON qbo.invoice_sync_ledger(source_invoice_time DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_qbo_invoice_sync_ledger_qbo' AND object_id = OBJECT_ID(N'qbo.invoice_sync_ledger'))
    CREATE INDEX IX_qbo_invoice_sync_ledger_qbo ON qbo.invoice_sync_ledger(qbo_realm_id, qbo_transaction_type, qbo_transaction_id);
GO
