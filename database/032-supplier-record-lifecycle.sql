USE [optilens_local];
GO

IF COL_LENGTH(N'ops.SupplierRecords', N'lifecycle_state') IS NULL
BEGIN
    ALTER TABLE ops.SupplierRecords ADD
        lifecycle_state nvarchar(20) NOT NULL CONSTRAINT DF_ops_supplier_records_lifecycle DEFAULT N'ACTIVE',
        first_observed_at datetime2(0) NULL,
        last_observed_at datetime2(0) NULL,
        terminated_at datetime2(0) NULL;
END;
GO

IF COL_LENGTH(N'ops.SupplierRecords', N'lifecycle_archive_reason') IS NULL
    ALTER TABLE ops.SupplierRecords ADD lifecycle_archive_reason nvarchar(40) NULL;
GO

UPDATE ops.SupplierRecords
SET first_observed_at = COALESCE(first_observed_at, created_at),
    last_observed_at = COALESCE(last_observed_at, updated_at, created_at)
WHERE first_observed_at IS NULL OR last_observed_at IS NULL;
GO

IF OBJECT_ID(N'ops.SupplierRecordOccurrences', N'U') IS NULL
BEGIN
    CREATE TABLE ops.SupplierRecordOccurrences (
        occurrence_id uniqueidentifier NOT NULL CONSTRAINT DF_ops_supplier_record_occurrence_id DEFAULT NEWID(),
        record_id uniqueidentifier NOT NULL,
        mailbox_message_id uniqueidentifier NOT NULL,
        event_id uniqueidentifier NOT NULL,
        attachment_id uniqueidentifier NOT NULL,
        row_number int NOT NULL,
        observed_at datetime2(0) NOT NULL CONSTRAINT DF_ops_supplier_record_occurrence_observed DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_ops_supplier_record_occurrences PRIMARY KEY (occurrence_id),
        CONSTRAINT UQ_ops_supplier_record_occurrence_source UNIQUE (event_id, attachment_id, row_number),
        CONSTRAINT FK_ops_supplier_record_occurrence_record FOREIGN KEY (record_id) REFERENCES ops.SupplierRecords(record_id),
        CONSTRAINT FK_ops_supplier_record_occurrence_message FOREIGN KEY (mailbox_message_id) REFERENCES ops.MailboxMessages(mailbox_message_id),
        CONSTRAINT FK_ops_supplier_record_occurrence_event FOREIGN KEY (event_id) REFERENCES ops.Events(event_id),
        CONSTRAINT FK_ops_supplier_record_occurrence_attachment FOREIGN KEY (attachment_id) REFERENCES ops.Attachments(attachment_id)
    );
END;
GO

INSERT INTO ops.SupplierRecordOccurrences
    (record_id, mailbox_message_id, event_id, attachment_id, row_number, observed_at)
SELECT r.record_id, r.mailbox_message_id, r.event_id, r.attachment_id, r.row_number,
       COALESCE(r.updated_at, r.created_at)
FROM ops.SupplierRecords r
WHERE r.mailbox_message_id IS NOT NULL
  AND r.event_id IS NOT NULL
  AND r.attachment_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM ops.SupplierRecordOccurrences o
      WHERE o.event_id = r.event_id AND o.attachment_id = r.attachment_id AND o.row_number = r.row_number
  );
GO

;WITH ranked AS (
    SELECT record_id, internal_order_id,
           FIRST_VALUE(record_id) OVER (
             PARTITION BY internal_order_id
             ORDER BY last_observed_at DESC, updated_at DESC, created_at DESC, record_id DESC
           ) AS keeper_id,
           ROW_NUMBER() OVER (
             PARTITION BY internal_order_id
             ORDER BY last_observed_at DESC, updated_at DESC, created_at DESC, record_id DESC
           ) AS lifecycle_rank
    FROM ops.SupplierRecords
    WHERE internal_order_id IS NOT NULL AND lifecycle_state = N'ACTIVE'
)
UPDATE o
SET record_id = r.keeper_id
FROM ops.SupplierRecordOccurrences o
INNER JOIN ranked r ON r.record_id = o.record_id
WHERE r.lifecycle_rank > 1;
GO

;WITH ranked AS (
    SELECT record_id,
           ROW_NUMBER() OVER (
             PARTITION BY internal_order_id
             ORDER BY last_observed_at DESC, updated_at DESC, created_at DESC, record_id DESC
           ) AS lifecycle_rank
    FROM ops.SupplierRecords
    WHERE internal_order_id IS NOT NULL AND lifecycle_state = N'ACTIVE'
)
UPDATE r
SET lifecycle_state = N'ARCHIVED', lifecycle_archive_reason = N'SUPERSEDED',
    terminated_at = COALESCE(terminated_at, last_observed_at, updated_at)
FROM ops.SupplierRecords r
INNER JOIN ranked d ON d.record_id = r.record_id
WHERE d.lifecycle_rank > 1;
GO

UPDATE a
SET status = N'FAILED',
    decision_note = N'Superseded while canonical supplier-record lifecycles were established.',
    decided_at = SYSUTCDATETIME()
FROM ops.Actions a
INNER JOIN ops.SupplierRecords r ON r.action_id = a.action_id
WHERE r.lifecycle_archive_reason = N'SUPERSEDED' AND a.status = N'WAITING_APPROVAL';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_ops_supplier_records_active_order')
    CREATE UNIQUE INDEX UX_ops_supplier_records_active_order
      ON ops.SupplierRecords(internal_order_id)
      WHERE internal_order_id IS NOT NULL AND lifecycle_state = N'ACTIVE';
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ops_supplier_record_occurrences_message')
    CREATE INDEX IX_ops_supplier_record_occurrences_message
      ON ops.SupplierRecordOccurrences(mailbox_message_id, record_id);
GO
