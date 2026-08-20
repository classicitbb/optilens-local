USE [optilens_local];
GO

IF OBJECT_ID(N'core.admin_dashboard_metrics', N'U') IS NULL
BEGIN
    CREATE TABLE core.admin_dashboard_metrics (
        metric_id uniqueidentifier NOT NULL CONSTRAINT DF_admin_dashboard_metrics_id DEFAULT NEWID(),
        tile_key nvarchar(120) NOT NULL,
        title nvarchar(200) NOT NULL,
        description nvarchar(500) NULL,
        source_name nvarchar(120) NOT NULL,
        value_text nvarchar(200) NULL,
        state nvarchar(40) NOT NULL CONSTRAINT DF_admin_dashboard_metrics_state DEFAULT N'online',
        created_by uniqueidentifier NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_admin_dashboard_metrics_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_admin_dashboard_metrics_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_admin_dashboard_metrics PRIMARY KEY (metric_id),
        CONSTRAINT UQ_admin_dashboard_metrics_tile_key UNIQUE (tile_key),
        CONSTRAINT FK_admin_dashboard_metrics_user FOREIGN KEY (created_by) REFERENCES core.users(user_id)
    );
END;
GO
