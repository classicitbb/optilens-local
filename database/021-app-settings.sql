-- 021-app-settings.sql — generic key/value application settings.
-- First consumer: the Innovations source-backend switch (live vs mirror).
-- Rerunnable.

IF OBJECT_ID(N'core.app_settings', N'U') IS NULL
BEGIN
    CREATE TABLE core.app_settings (
        setting_key nvarchar(100) NOT NULL CONSTRAINT PK_core_app_settings PRIMARY KEY,
        setting_value nvarchar(max) NULL,
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_core_app_settings_updated DEFAULT SYSUTCDATETIME(),
        updated_by nvarchar(100) NULL
    );
END;
GO
