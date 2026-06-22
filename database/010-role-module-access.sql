USE [optilens_local];
GO

IF OBJECT_ID(N'core.role_module_access', N'U') IS NULL
BEGIN
    CREATE TABLE core.role_module_access (
        role_id uniqueidentifier NOT NULL,
        module_id uniqueidentifier NOT NULL,
        access_level nvarchar(20) NOT NULL,
        assigned_at datetime2(0) NOT NULL CONSTRAINT DF_core_role_module_access_assigned DEFAULT SYSUTCDATETIME(),
        assigned_by_user_id uniqueidentifier NULL,
        CONSTRAINT PK_core_role_module_access PRIMARY KEY (role_id, module_id),
        CONSTRAINT CK_core_role_module_access_level CHECK (access_level IN (N'read', N'full')),
        CONSTRAINT FK_core_role_module_access_role FOREIGN KEY (role_id) REFERENCES core.roles(role_id),
        CONSTRAINT FK_core_role_module_access_module FOREIGN KEY (module_id) REFERENCES core.modules(module_id),
        CONSTRAINT FK_core_role_module_access_assigned_by FOREIGN KEY (assigned_by_user_id) REFERENCES core.users(user_id)
    );
END;
GO

MERGE core.permissions AS target
USING (
    SELECT m.module_id, v.permission_code, v.permission_name
    FROM (VALUES
        (N'automation', N'automation.read', N'Read automation workspace'),
        (N'automation', N'automation.manage', N'Manage automation workspace')
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
