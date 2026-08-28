IF OBJECT_ID(N'delivery.document_authorisations', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.document_authorisations (
        document_authorisation_id uniqueidentifier NOT NULL CONSTRAINT DF_delivery_document_authorisations_id DEFAULT NEWID(),
        authorisation_key nvarchar(80) NOT NULL,
        mime_type nvarchar(80) NOT NULL,
        image_bytes varbinary(max) NOT NULL,
        content_hash char(64) NOT NULL,
        uploaded_by_user_id uniqueidentifier NULL,
        uploaded_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_document_authorisations_uploaded DEFAULT SYSUTCDATETIME(),
        removed_by_user_id uniqueidentifier NULL,
        removed_at datetime2(0) NULL,
        CONSTRAINT PK_delivery_document_authorisations PRIMARY KEY (document_authorisation_id),
        CONSTRAINT UQ_delivery_document_authorisations_key UNIQUE (authorisation_key)
    );
END;
GO

IF OBJECT_ID(N'delivery.document_archive_entries', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.document_archive_entries (
        document_archive_entry_id uniqueidentifier NOT NULL CONSTRAINT DF_delivery_document_archive_entries_id DEFAULT NEWID(),
        document_type nvarchar(80) NOT NULL,
        document_status nvarchar(80) NOT NULL,
        shipment_session_id uniqueidentifier NULL,
        source_shipment_id nvarchar(120) NULL,
        invoice_numbers nvarchar(500) NULL,
        reference_numbers nvarchar(1000) NULL,
        customer_account nvarchar(120) NULL,
        customer_name nvarchar(300) NULL,
        source_system nvarchar(80) NOT NULL CONSTRAINT DF_delivery_document_archive_entries_source DEFAULT N'optilens-local',
        source_audit_key nvarchar(200) NULL,
        import_batch_id uniqueidentifier NULL,
        rendered_html nvarchar(max) NULL,
        snapshot_json nvarchar(max) NULL,
        content_hash char(64) NULL,
        created_by_user_id uniqueidentifier NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_document_archive_entries_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_delivery_document_archive_entries PRIMARY KEY (document_archive_entry_id),
        CONSTRAINT FK_delivery_document_archive_entries_session FOREIGN KEY (shipment_session_id) REFERENCES delivery.shipment_sessions(shipment_session_id)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_delivery_document_archive_entries_search' AND object_id = OBJECT_ID(N'delivery.document_archive_entries'))
    CREATE INDEX IX_delivery_document_archive_entries_search ON delivery.document_archive_entries (document_type, created_at DESC, source_shipment_id, customer_account);
GO

INSERT INTO delivery.document_archive_entries (
    document_type, document_status, source_shipment_id, invoice_numbers, customer_account, customer_name,
    source_system, source_audit_key, import_batch_id, snapshot_json, created_at
)
SELECT
    N'commercial_invoice', N'imported', CONVERT(nvarchar(120), ci.legacy_delivery_no), CONVERT(nvarchar(120), ci.legacy_invoice_id),
    branch.account_number, branch.branch_name, N'access-import', CONCAT(N'access-commercial-invoice:', ci.legacy_invoice_id), ci.import_batch_id,
    (SELECT ci.legacy_invoice_id AS legacyInvoiceId, ci.legacy_delivery_no AS legacyDeliveryNo, ci.carrier, ci.airway_bill, ci.po_numbers FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
    ci.imported_at
FROM archive.access_commercial_invoices ci
OUTER APPLY (
    SELECT TOP (1) b.account_number, b.branch_name
    FROM archive.access_delivery_items di
    INNER JOIN archive.access_customer_branches b ON b.legacy_branch_id = di.customer_branch_legacy_id
    WHERE di.legacy_delivery_no = ci.legacy_delivery_no
) branch
WHERE NOT EXISTS (
    SELECT 1 FROM delivery.document_archive_entries archive_entry
    WHERE archive_entry.source_audit_key = CONCAT(N'access-commercial-invoice:', ci.legacy_invoice_id)
);
GO
