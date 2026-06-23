USE [optilens_local];
GO

IF SCHEMA_ID(N'docstudio') IS NULL
BEGIN
    EXEC(N'CREATE SCHEMA docstudio');
END;
GO

IF NOT EXISTS (SELECT 1 FROM core.modules WHERE module_code = N'doc-studio')
BEGIN
    INSERT INTO core.modules (module_code, module_name, route_path, status)
    VALUES (N'doc-studio', N'Doc Studio', N'/modules/doc-studio', N'active');
END;
GO

MERGE core.permissions AS target
USING (
    SELECT m.module_id, v.permission_code, v.permission_name
    FROM (VALUES
        (N'doc-studio', N'docstudio.read', N'Read Doc Studio documents'),
        (N'doc-studio', N'docstudio.write', N'Create and edit Doc Studio documents')
    ) AS v(module_code, permission_code, permission_name)
    INNER JOIN core.modules m
      ON m.module_code = v.module_code
) AS source (module_id, permission_code, permission_name)
ON target.permission_code = source.permission_code
WHEN MATCHED THEN
    UPDATE SET module_id = source.module_id,
               permission_name = source.permission_name
WHEN NOT MATCHED THEN
    INSERT (module_id, permission_code, permission_name)
    VALUES (source.module_id, source.permission_code, source.permission_name);
GO

MERGE core.role_permissions AS target
USING (
    SELECT r.role_id, p.permission_id
    FROM core.roles r
    CROSS JOIN core.permissions p
    WHERE r.role_code = N'admin'
      AND p.permission_code IN (N'docstudio.read', N'docstudio.write')
) AS source (role_id, permission_id)
ON target.role_id = source.role_id
AND target.permission_id = source.permission_id
WHEN NOT MATCHED THEN
    INSERT (role_id, permission_id)
    VALUES (source.role_id, source.permission_id);
GO

IF OBJECT_ID(N'docstudio.billing_documents', N'U') IS NULL
BEGIN
    CREATE TABLE docstudio.billing_documents (
        document_id uniqueidentifier NOT NULL CONSTRAINT DF_docstudio_billing_documents_id DEFAULT NEWID(),
        owner_user_id uniqueidentifier NOT NULL,
        document_type nvarchar(24) NOT NULL,
        document_name nvarchar(220) NOT NULL,
        billing_number nvarchar(80) NULL,
        customer_name nvarchar(220) NULL,
        customer_company nvarchar(220) NULL,
        customer_account nvarchar(120) NULL,
        paper_size nvarchar(12) NOT NULL CONSTRAINT DF_docstudio_billing_documents_paper DEFAULT N'letter',
        status nvarchar(24) NOT NULL CONSTRAINT DF_docstudio_billing_documents_status DEFAULT N'saved',
        content_json nvarchar(max) NOT NULL,
        rendered_html nvarchar(max) NULL,
        totals_json nvarchar(max) NULL,
        latest_autosave_content_json nvarchar(max) NULL,
        latest_autosave_rendered_html nvarchar(max) NULL,
        latest_autosave_totals_json nvarchar(max) NULL,
        latest_autosave_at datetime2(0) NULL,
        created_by_user_id uniqueidentifier NOT NULL,
        updated_by_user_id uniqueidentifier NOT NULL,
        deleted_by_user_id uniqueidentifier NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_docstudio_billing_documents_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_docstudio_billing_documents_updated DEFAULT SYSUTCDATETIME(),
        deleted_at datetime2(0) NULL,
        file_version rowversion NOT NULL,
        CONSTRAINT PK_docstudio_billing_documents PRIMARY KEY (document_id),
        CONSTRAINT CK_docstudio_billing_documents_type CHECK (document_type IN (N'invoice', N'quote', N'proforma', N'receipt')),
        CONSTRAINT CK_docstudio_billing_documents_paper CHECK (paper_size IN (N'letter', N'a4')),
        CONSTRAINT CK_docstudio_billing_documents_status CHECK (status IN (N'draft', N'saved'))
    );
END;
GO

IF OBJECT_ID(N'docstudio.billing_document_shares', N'U') IS NULL
BEGIN
    CREATE TABLE docstudio.billing_document_shares (
        document_share_id uniqueidentifier NOT NULL CONSTRAINT DF_docstudio_billing_document_shares_id DEFAULT NEWID(),
        document_id uniqueidentifier NOT NULL,
        shared_user_id uniqueidentifier NOT NULL,
        access_level nvarchar(12) NOT NULL,
        created_by_user_id uniqueidentifier NOT NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_docstudio_billing_document_shares_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_docstudio_billing_document_shares PRIMARY KEY (document_share_id),
        CONSTRAINT UQ_docstudio_billing_document_shares_user UNIQUE (document_id, shared_user_id),
        CONSTRAINT CK_docstudio_billing_document_shares_access CHECK (access_level IN (N'view', N'edit')),
        CONSTRAINT FK_docstudio_billing_document_shares_document FOREIGN KEY (document_id) REFERENCES docstudio.billing_documents(document_id)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_docstudio_billing_documents_owner' AND object_id = OBJECT_ID(N'docstudio.billing_documents'))
    CREATE INDEX IX_docstudio_billing_documents_owner ON docstudio.billing_documents (owner_user_id, deleted_at, updated_at DESC);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_docstudio_billing_documents_customer' AND object_id = OBJECT_ID(N'docstudio.billing_documents'))
    CREATE INDEX IX_docstudio_billing_documents_customer ON docstudio.billing_documents (customer_company, customer_name, billing_number);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_docstudio_billing_document_shares_user' AND object_id = OBJECT_ID(N'docstudio.billing_document_shares'))
    CREATE INDEX IX_docstudio_billing_document_shares_user ON docstudio.billing_document_shares (shared_user_id, access_level);
GO

IF OBJECT_ID(N'docstudio.files', N'U') IS NULL
BEGIN
    CREATE TABLE docstudio.files (
        file_id uniqueidentifier NOT NULL CONSTRAINT DF_docstudio_files_id DEFAULT NEWID(),
        owner_user_id uniqueidentifier NOT NULL,
        file_type nvarchar(24) NOT NULL,
        file_name nvarchar(220) NOT NULL,
        customer_name nvarchar(220) NULL,
        customer_account nvarchar(120) NULL,
        metadata_json nvarchar(max) NULL,
        content_json nvarchar(max) NOT NULL,
        rendered_html nvarchar(max) NULL,
        latest_autosave_content_json nvarchar(max) NULL,
        latest_autosave_rendered_html nvarchar(max) NULL,
        latest_autosave_at datetime2(0) NULL,
        created_by_user_id uniqueidentifier NOT NULL,
        updated_by_user_id uniqueidentifier NOT NULL,
        deleted_by_user_id uniqueidentifier NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_docstudio_files_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_docstudio_files_updated DEFAULT SYSUTCDATETIME(),
        deleted_at datetime2(0) NULL,
        file_version rowversion NOT NULL,
        CONSTRAINT PK_docstudio_files PRIMARY KEY (file_id),
        CONSTRAINT CK_docstudio_files_type CHECK (file_type IN (N'email', N'letter', N'signature', N'social', N'pricelist', N'shiplabel', N'statement'))
    );
END;
GO

IF OBJECT_ID(N'docstudio.file_shares', N'U') IS NULL
BEGIN
    CREATE TABLE docstudio.file_shares (
        file_share_id uniqueidentifier NOT NULL CONSTRAINT DF_docstudio_file_shares_id DEFAULT NEWID(),
        file_id uniqueidentifier NOT NULL,
        shared_user_id uniqueidentifier NOT NULL,
        access_level nvarchar(12) NOT NULL,
        created_by_user_id uniqueidentifier NOT NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_docstudio_file_shares_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_docstudio_file_shares PRIMARY KEY (file_share_id),
        CONSTRAINT UQ_docstudio_file_shares_user UNIQUE (file_id, shared_user_id),
        CONSTRAINT CK_docstudio_file_shares_access CHECK (access_level IN (N'view', N'edit')),
        CONSTRAINT FK_docstudio_file_shares_file FOREIGN KEY (file_id) REFERENCES docstudio.files(file_id)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_docstudio_files_owner' AND object_id = OBJECT_ID(N'docstudio.files'))
    CREATE INDEX IX_docstudio_files_owner ON docstudio.files (owner_user_id, deleted_at, updated_at DESC);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_docstudio_files_type' AND object_id = OBJECT_ID(N'docstudio.files'))
    CREATE INDEX IX_docstudio_files_type ON docstudio.files (file_type, deleted_at, updated_at DESC);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_docstudio_file_shares_user' AND object_id = OBJECT_ID(N'docstudio.file_shares'))
    CREATE INDEX IX_docstudio_file_shares_user ON docstudio.file_shares (shared_user_id, access_level);
GO
