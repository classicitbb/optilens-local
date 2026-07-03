USE [optilens_local];
GO

IF OBJECT_ID(N'delivery.co_applications', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.co_applications (
        co_application_id uniqueidentifier NOT NULL CONSTRAINT DF_delivery_co_applications_id DEFAULT NEWID(),
        shipment_session_id uniqueidentifier NOT NULL,
        portal_environment nvarchar(40) NOT NULL CONSTRAINT DF_delivery_co_applications_environment DEFAULT N'training',
        app_status nvarchar(40) NOT NULL CONSTRAINT DF_delivery_co_applications_status DEFAULT N'draft',
        payload_json nvarchar(max) NOT NULL,
        editable_json nvarchar(max) NOT NULL,
        warnings_json nvarchar(max) NULL,
        created_by_user_id uniqueidentifier NULL,
        updated_by_user_id uniqueidentifier NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_co_applications_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NULL,
        queued_at datetime2(0) NULL,
        filled_at datetime2(0) NULL,
        CONSTRAINT PK_delivery_co_applications PRIMARY KEY (co_application_id),
        CONSTRAINT FK_delivery_co_applications_session FOREIGN KEY (shipment_session_id) REFERENCES delivery.shipment_sessions(shipment_session_id)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_delivery_co_applications_session' AND object_id = OBJECT_ID(N'delivery.co_applications'))
    CREATE INDEX IX_delivery_co_applications_session ON delivery.co_applications (shipment_session_id, updated_at DESC, created_at DESC);
GO

IF OBJECT_ID(N'delivery.co_automation_jobs', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.co_automation_jobs (
        automation_job_id uniqueidentifier NOT NULL CONSTRAINT DF_delivery_co_automation_jobs_id DEFAULT NEWID(),
        co_application_id uniqueidentifier NOT NULL,
        claim_code nvarchar(80) NOT NULL,
        portal_environment nvarchar(40) NOT NULL CONSTRAINT DF_delivery_co_automation_jobs_environment DEFAULT N'training',
        job_status nvarchar(40) NOT NULL CONSTRAINT DF_delivery_co_automation_jobs_status DEFAULT N'queued',
        payload_snapshot_json nvarchar(max) NOT NULL,
        log_json nvarchar(max) NULL,
        error_message nvarchar(max) NULL,
        created_by_user_id uniqueidentifier NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_co_automation_jobs_created DEFAULT SYSUTCDATETIME(),
        expires_at datetime2(0) NOT NULL,
        claimed_at datetime2(0) NULL,
        completed_at datetime2(0) NULL,
        CONSTRAINT PK_delivery_co_automation_jobs PRIMARY KEY (automation_job_id),
        CONSTRAINT UQ_delivery_co_automation_jobs_claim_code UNIQUE (claim_code),
        CONSTRAINT FK_delivery_co_automation_jobs_application FOREIGN KEY (co_application_id) REFERENCES delivery.co_applications(co_application_id)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_delivery_co_automation_jobs_application' AND object_id = OBJECT_ID(N'delivery.co_automation_jobs'))
    CREATE INDEX IX_delivery_co_automation_jobs_application ON delivery.co_automation_jobs (co_application_id, created_at DESC);
GO

IF OBJECT_ID(N'delivery.co_weight_log', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.co_weight_log (
        co_weight_log_id bigint IDENTITY(1,1) NOT NULL,
        shipment_session_id uniqueidentifier NULL,
        source_shipment_id nvarchar(120) NULL,
        customer_account nvarchar(120) NULL,
        job_count int NULL,
        box_code nvarchar(80) NULL,
        actual_gross_kg decimal(18, 3) NOT NULL,
        created_by_user_id uniqueidentifier NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_co_weight_log_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_delivery_co_weight_log PRIMARY KEY (co_weight_log_id),
        CONSTRAINT FK_delivery_co_weight_log_session FOREIGN KEY (shipment_session_id) REFERENCES delivery.shipment_sessions(shipment_session_id)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_delivery_co_weight_log_account' AND object_id = OBJECT_ID(N'delivery.co_weight_log'))
    CREATE INDEX IX_delivery_co_weight_log_account ON delivery.co_weight_log (customer_account, created_at DESC);
GO
