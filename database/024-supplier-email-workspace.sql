USE [optilens_local];
GO

IF OBJECT_ID(N'ops.MailboxMessages', N'U') IS NULL
BEGIN
    CREATE TABLE ops.MailboxMessages (
        mailbox_message_id uniqueidentifier NOT NULL CONSTRAINT DF_ops_mailbox_message_id DEFAULT NEWID(),
        event_id uniqueidentifier NULL,
        mailbox_code nvarchar(120) NOT NULL,
        uid bigint NOT NULL,
        message_key nvarchar(128) NOT NULL,
        message_id nvarchar(500) NULL,
        supplier_code nvarchar(80) NULL,
        supplier_name nvarchar(200) NULL,
        sender_address nvarchar(260) NULL,
        subject nvarchar(1000) NOT NULL CONSTRAINT DF_ops_mailbox_message_subject DEFAULT N'',
        received_at datetime2(0) NULL,
        is_read bit NOT NULL CONSTRAINT DF_ops_mailbox_message_read DEFAULT 0,
        routing_state nvarchar(60) NOT NULL CONSTRAINT DF_ops_mailbox_message_routing DEFAULT N'CAPTURED',
        processing_state nvarchar(60) NOT NULL CONSTRAINT DF_ops_mailbox_message_processing DEFAULT N'NOT_PROCESSED',
        archive_state nvarchar(40) NOT NULL CONSTRAINT DF_ops_mailbox_message_archive DEFAULT N'IN_INBOX',
        archive_folder nvarchar(260) NULL,
        rule_code nvarchar(120) NULL,
        attachment_count int NOT NULL CONSTRAINT DF_ops_mailbox_message_attachments DEFAULT 0,
        last_error nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_ops_mailbox_message_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_ops_mailbox_message_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_ops_mailbox_messages PRIMARY KEY (mailbox_message_id),
        CONSTRAINT UQ_ops_mailbox_messages_key UNIQUE (message_key),
        CONSTRAINT FK_ops_mailbox_messages_event FOREIGN KEY (event_id) REFERENCES ops.Events(event_id)
    );
END;
GO

IF OBJECT_ID(N'ops.SupplierRecords', N'U') IS NULL
BEGIN
    CREATE TABLE ops.SupplierRecords (
        record_id uniqueidentifier NOT NULL CONSTRAINT DF_ops_supplier_record_id DEFAULT NEWID(),
        mailbox_message_id uniqueidentifier NULL,
        event_id uniqueidentifier NULL,
        attachment_id uniqueidentifier NULL,
        row_number int NOT NULL,
        supplier_code nvarchar(80) NULL,
        rule_code nvarchar(120) NULL,
        supplier_reference nvarchar(300) NOT NULL,
        supplier_status nvarchar(160) NULL,
        normalized_status nvarchar(160) NULL,
        record_kind nvarchar(40) NULL,
        raw_json nvarchar(max) NULL,
        parse_state nvarchar(40) NOT NULL CONSTRAINT DF_ops_supplier_record_parse DEFAULT N'PARSED',
        match_result nvarchar(60) NULL,
        internal_order_id int NULL,
        current_status_id int NULL,
        current_status_description nvarchar(300) NULL,
        patient_id nvarchar(300) NULL,
        customer_id int NULL,
        customer_name nvarchar(220) NULL,
        customer_account nvarchar(120) NULL,
        received_at datetime2(3) NULL,
        target_status_item_id int NULL,
        target_status_description nvarchar(300) NULL,
        action_id uniqueidentifier NULL,
        error_detail nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_ops_supplier_record_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_ops_supplier_record_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_ops_supplier_records PRIMARY KEY (record_id),
        CONSTRAINT UQ_ops_supplier_records_row UNIQUE (event_id, attachment_id, row_number),
        CONSTRAINT FK_ops_supplier_records_message FOREIGN KEY (mailbox_message_id) REFERENCES ops.MailboxMessages(mailbox_message_id),
        CONSTRAINT FK_ops_supplier_records_event FOREIGN KEY (event_id) REFERENCES ops.Events(event_id),
        CONSTRAINT FK_ops_supplier_records_attachment FOREIGN KEY (attachment_id) REFERENCES ops.Attachments(attachment_id),
        CONSTRAINT FK_ops_supplier_records_action FOREIGN KEY (action_id) REFERENCES ops.Actions(action_id)
    );
END;
GO

IF OBJECT_ID(N'ops.SupplierStatusMappings', N'U') IS NULL
BEGIN
    CREATE TABLE ops.SupplierStatusMappings (
        mapping_id uniqueidentifier NOT NULL CONSTRAINT DF_ops_status_mapping_id DEFAULT NEWID(),
        rule_code nvarchar(120) NOT NULL,
        supplier_code nvarchar(80) NOT NULL,
        supplier_status_key nvarchar(160) NOT NULL,
        supplier_status_label nvarchar(160) NOT NULL,
        target_status_item_id int NULL,
        target_status_description nvarchar(300) NULL,
        mapping_state nvarchar(40) NOT NULL CONSTRAINT DF_ops_status_mapping_state DEFAULT N'PENDING_CONFIRMATION',
        confirmed_by uniqueidentifier NULL,
        confirmed_at datetime2(0) NULL,
        notes nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_ops_status_mapping_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_ops_status_mapping_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_ops_supplier_status_mappings PRIMARY KEY (mapping_id),
        CONSTRAINT UQ_ops_supplier_status_mappings_key UNIQUE (rule_code, supplier_status_key),
        CONSTRAINT CK_ops_supplier_status_mappings_state CHECK (mapping_state IN (N'PENDING_CONFIRMATION', N'CONFIRMED', N'DISABLED'))
    );
END;
GO

IF OBJECT_ID(N'ops.SourceStatusWritebacks', N'U') IS NULL
BEGIN
    CREATE TABLE ops.SourceStatusWritebacks (
        writeback_id uniqueidentifier NOT NULL CONSTRAINT DF_ops_source_writeback_id DEFAULT NEWID(),
        action_id uniqueidentifier NULL,
        record_id uniqueidentifier NULL,
        order_id int NOT NULL,
        before_status_id int NULL,
        target_status_id int NOT NULL,
        verified_status_id int NULL,
        result nvarchar(30) NOT NULL CONSTRAINT DF_ops_source_writeback_result DEFAULT N'PENDING',
        error_detail nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_ops_source_writeback_created DEFAULT SYSUTCDATETIME(),
        completed_at datetime2(0) NULL,
        CONSTRAINT PK_ops_source_status_writebacks PRIMARY KEY (writeback_id),
        CONSTRAINT UQ_ops_source_status_writebacks_action UNIQUE (action_id),
        CONSTRAINT FK_ops_source_status_writebacks_action FOREIGN KEY (action_id) REFERENCES ops.Actions(action_id),
        CONSTRAINT FK_ops_source_status_writebacks_record FOREIGN KEY (record_id) REFERENCES ops.SupplierRecords(record_id),
        CONSTRAINT CK_ops_source_status_writebacks_result CHECK (result IN (N'PENDING', N'APPLIED', N'FAILED'))
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ops_mailbox_messages_supplier_date')
    CREATE INDEX IX_ops_mailbox_messages_supplier_date ON ops.MailboxMessages(supplier_code, received_at DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ops_mailbox_messages_processing')
    CREATE INDEX IX_ops_mailbox_messages_processing ON ops.MailboxMessages(processing_state, archive_state);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ops_supplier_records_message')
    CREATE INDEX IX_ops_supplier_records_message ON ops.SupplierRecords(mailbox_message_id, created_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ops_supplier_records_match')
    CREATE INDEX IX_ops_supplier_records_match ON ops.SupplierRecords(match_result, internal_order_id);
GO

UPDATE ops.MailboxConfigurations
SET processed_folder_name = COALESCE(NULLIF(processed_folder_name, N''), N'Supplier Processed'),
    updated_at = SYSUTCDATETIME()
WHERE configuration_code = N'classic-visions-orders';
GO
