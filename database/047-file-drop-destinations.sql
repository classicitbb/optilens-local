USE [optilens_local];
GO

IF OBJECT_ID(N'integration.file_drop_destinations', N'U') IS NULL
BEGIN
    CREATE TABLE integration.file_drop_destinations (
        destination_id uniqueidentifier NOT NULL CONSTRAINT DF_integration_file_drop_destinations_id DEFAULT NEWID(),
        destination_name nvarchar(120) NOT NULL,
        purpose_code nvarchar(60) NOT NULL,
        customer_account nvarchar(80) NULL,
        folder_path nvarchar(1000) NOT NULL,
        is_active bit NOT NULL CONSTRAINT DF_integration_file_drop_destinations_active DEFAULT 1,
        created_by_user_id uniqueidentifier NULL,
        updated_by_user_id uniqueidentifier NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_integration_file_drop_destinations_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_integration_file_drop_destinations_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_integration_file_drop_destinations PRIMARY KEY (destination_id),
        CONSTRAINT FK_integration_file_drop_destinations_created_by FOREIGN KEY (created_by_user_id) REFERENCES core.users(user_id),
        CONSTRAINT FK_integration_file_drop_destinations_updated_by FOREIGN KEY (updated_by_user_id) REFERENCES core.users(user_id)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_integration_file_drop_destinations_route' AND object_id = OBJECT_ID(N'integration.file_drop_destinations'))
    CREATE INDEX IX_integration_file_drop_destinations_route ON integration.file_drop_destinations (purpose_code, customer_account, is_active, updated_at DESC);
GO
