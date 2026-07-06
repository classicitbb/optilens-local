USE [optilens_local];
GO

-- Operator-supplied error + resolution capture for the BeSwift CO fill.
-- Written by the Beta extension when a supervisor fixes a stuck field on the
-- page (or in the popup) and records what was wrong and how they fixed it.
-- Aggregated across every job so an AI coder can mine recurring failure
-- modes (field/section) and propose selector/logic refinements. Nullable
-- automation_job_id / co_application_id (no hard FK) so a note can still be
-- captured even for a test/expired job without blocking the insert.
IF OBJECT_ID(N'delivery.co_fill_resolutions', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.co_fill_resolutions (
        co_fill_resolution_id bigint IDENTITY(1,1) NOT NULL,
        automation_job_id uniqueidentifier NULL,
        co_application_id uniqueidentifier NULL,
        field nvarchar(200) NULL,
        section nvarchar(200) NULL,
        expected_value nvarchar(max) NULL,
        actual_value nvarchar(max) NULL,
        fix_action nvarchar(max) NULL,
        root_cause nvarchar(max) NULL,
        note nvarchar(max) NULL,
        source nvarchar(40) NOT NULL CONSTRAINT DF_delivery_co_fill_resolutions_source DEFAULT N'beta',
        resolved bit NOT NULL CONSTRAINT DF_delivery_co_fill_resolutions_resolved DEFAULT 0,
        created_by_user_id uniqueidentifier NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_co_fill_resolutions_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_delivery_co_fill_resolutions PRIMARY KEY (co_fill_resolution_id)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_delivery_co_fill_resolutions_field' AND object_id = OBJECT_ID(N'delivery.co_fill_resolutions'))
    CREATE INDEX IX_delivery_co_fill_resolutions_field ON delivery.co_fill_resolutions (field, created_at DESC);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_delivery_co_fill_resolutions_job' AND object_id = OBJECT_ID(N'delivery.co_fill_resolutions'))
    CREATE INDEX IX_delivery_co_fill_resolutions_job ON delivery.co_fill_resolutions (automation_job_id, created_at DESC);
GO
