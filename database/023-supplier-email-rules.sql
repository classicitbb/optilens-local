USE [optilens_local];
GO

IF OBJECT_ID(N'ops.MailboxConfigurations', N'U') IS NULL
BEGIN
    CREATE TABLE ops.MailboxConfigurations (
        mailbox_configuration_id uniqueidentifier NOT NULL CONSTRAINT DF_ops_mailbox_id DEFAULT NEWID(),
        configuration_code nvarchar(120) NOT NULL,
        configuration_name nvarchar(200) NOT NULL,
        protocol nvarchar(20) NOT NULL CONSTRAINT DF_ops_mailbox_protocol DEFAULT N'IMAP',
        server_hostname nvarchar(260) NULL,
        port int NULL CONSTRAINT DF_ops_mailbox_port DEFAULT 993,
        ssl_enabled bit NOT NULL CONSTRAINT DF_ops_mailbox_ssl DEFAULT 1,
        mailbox_username nvarchar(260) NULL,
        credential_reference nvarchar(300) NULL,
        folder_name nvarchar(260) NOT NULL CONSTRAINT DF_ops_mailbox_folder DEFAULT N'Inbox',
        scan_previous_days int NOT NULL CONSTRAINT DF_ops_mailbox_days DEFAULT 7,
        max_messages_per_run int NOT NULL CONSTRAINT DF_ops_mailbox_max DEFAULT 200,
        unread_only bit NOT NULL CONSTRAINT DF_ops_mailbox_unread DEFAULT 0,
        mark_processed_read bit NOT NULL CONSTRAINT DF_ops_mailbox_mark_read DEFAULT 0,
        move_processed_messages bit NOT NULL CONSTRAINT DF_ops_mailbox_move DEFAULT 0,
        processed_folder_name nvarchar(260) NULL,
        error_folder_name nvarchar(260) NULL,
        is_enabled bit NOT NULL CONSTRAINT DF_ops_mailbox_enabled DEFAULT 0,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_ops_mailbox_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_ops_mailbox_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_ops_mailbox PRIMARY KEY (mailbox_configuration_id),
        CONSTRAINT UQ_ops_mailbox_code UNIQUE (configuration_code),
        CONSTRAINT CK_ops_mailbox_protocol CHECK (protocol IN (N'IMAP', N'POP3'))
    );
END;
GO

IF OBJECT_ID(N'ops.SupplierRules', N'U') IS NULL
BEGIN
    CREATE TABLE ops.SupplierRules (
        supplier_rule_id uniqueidentifier NOT NULL CONSTRAINT DF_ops_supplier_rules_id DEFAULT NEWID(),
        rule_code nvarchar(120) NOT NULL,
        supplier_code nvarchar(80) NOT NULL,
        supplier_name nvarchar(200) NOT NULL,
        sender_address nvarchar(260) NULL,
        sender_domain nvarchar(260) NULL,
        subject_match_type nvarchar(30) NOT NULL CONSTRAINT DF_ops_supplier_rules_subject_type DEFAULT N'CONTAINS',
        subject_pattern nvarchar(500) NOT NULL,
        report_code nvarchar(120) NOT NULL,
        parser_code nvarchar(120) NOT NULL,
        matching_field nvarchar(80) NULL,
        attachment_required bit NOT NULL CONSTRAINT DF_ops_supplier_rules_attachment DEFAULT 1,
        allowed_extensions nvarchar(200) NOT NULL,
        future_target_status_id int NULL,
        future_target_status_description nvarchar(200) NULL,
        mapping_state nvarchar(40) NOT NULL CONSTRAINT DF_ops_supplier_rules_mapping DEFAULT N'PENDING_CONFIRMATION',
        is_enabled bit NOT NULL CONSTRAINT DF_ops_supplier_rules_enabled DEFAULT 0,
        priority int NOT NULL CONSTRAINT DF_ops_supplier_rules_priority DEFAULT 100,
        notes nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_ops_supplier_rules_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_ops_supplier_rules_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_ops_supplier_rules PRIMARY KEY (supplier_rule_id),
        CONSTRAINT UQ_ops_supplier_rules_code UNIQUE (rule_code),
        CONSTRAINT CK_ops_supplier_rules_subject_type CHECK (subject_match_type IN (N'EXACT', N'CONTAINS', N'STARTS_WITH', N'REGEX')),
        CONSTRAINT CK_ops_supplier_rules_mapping CHECK (mapping_state IN (N'PENDING_CONFIRMATION', N'CONFIRMED', N'DISABLED'))
    );
END;
GO

MERGE ops.MailboxConfigurations AS target
USING (VALUES
    (N'classic-visions-orders', N'Classic Visions Orders', N'IMAP', N'orders@classicvisions.net', N'EmailMailboxCredential', 0)
) AS source (configuration_code, configuration_name, protocol, mailbox_username, credential_reference, is_enabled)
ON target.configuration_code = source.configuration_code
WHEN MATCHED THEN UPDATE SET configuration_name = source.configuration_name, protocol = source.protocol, mailbox_username = source.mailbox_username, credential_reference = source.credential_reference, is_enabled = source.is_enabled, updated_at = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT (configuration_code, configuration_name, protocol, mailbox_username, credential_reference, is_enabled)
VALUES (source.configuration_code, source.configuration_name, source.protocol, source.mailbox_username, source.credential_reference, source.is_enabled);
GO

MERGE ops.SupplierRules AS target
USING (VALUES
    (N'tog-wip', N'TOG', N'Thai Optical Group', N'noreply-system@thaiopticalgroup.com', NULL, N'CONTAINS', N'WIP Report Classic', N'TOG_WIP', N'TOGXlsxParser', N'job_id', N'.xlsx', N'TOG sample references matched dbo.Orders.JobID; enable after operational review.'),
    (N'tog-dispatch', N'TOG', N'Thai Optical Group', N'noreply-system@thaiopticalgroup.com', NULL, N'CONTAINS', N'Report Dispatch Classic', N'TOG_DISPATCH', N'TOGXlsxParser', N'job_id', N'.xlsx', N'TOG sample references matched dbo.Orders.JobID; enable after operational review.'),
    (N'skylab-shipped', N'SKYLAB', N'SkyLab Optical', N'ymartinez@skylab-optical.net', NULL, N'CONTAINS', N'SHIPPING DOCUMENTS', N'SKYLAB_SHIPPED', N'SkyLabShippedPdfParser', N'order_id', N'.pdf', N'SkyLab reference is matched directly to dbo.Orders.OrderID; confirm status mapping before enabling.' )
) AS source (rule_code, supplier_code, supplier_name, sender_address, sender_domain, subject_match_type, subject_pattern, report_code, parser_code, matching_field, allowed_extensions, notes)
ON target.rule_code = source.rule_code
WHEN MATCHED THEN UPDATE SET supplier_code = source.supplier_code, supplier_name = source.supplier_name, sender_address = source.sender_address, subject_match_type = source.subject_match_type, subject_pattern = source.subject_pattern, report_code = source.report_code, parser_code = source.parser_code, matching_field = source.matching_field, allowed_extensions = source.allowed_extensions, notes = source.notes, mapping_state = N'PENDING_CONFIRMATION', is_enabled = 0, updated_at = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT (rule_code, supplier_code, supplier_name, sender_address, subject_match_type, subject_pattern, report_code, parser_code, matching_field, allowed_extensions, notes)
VALUES (source.rule_code, source.supplier_code, source.supplier_name, source.sender_address, source.subject_match_type, source.subject_pattern, source.report_code, source.parser_code, source.matching_field, source.allowed_extensions, source.notes);
GO
