USE [optilens_local];
GO

IF OBJECT_ID(N'core.user_module_access', N'U') IS NULL
BEGIN
    CREATE TABLE core.user_module_access (
        user_id uniqueidentifier NOT NULL,
        module_id uniqueidentifier NOT NULL,
        access_level nvarchar(20) NOT NULL,
        assigned_at datetime2(0) NOT NULL CONSTRAINT DF_core_user_module_access_assigned DEFAULT SYSUTCDATETIME(),
        assigned_by_user_id uniqueidentifier NULL,
        CONSTRAINT PK_core_user_module_access PRIMARY KEY (user_id, module_id),
        CONSTRAINT CK_core_user_module_access_level CHECK (access_level IN (N'read', N'full')),
        CONSTRAINT FK_core_user_module_access_user FOREIGN KEY (user_id) REFERENCES core.users(user_id),
        CONSTRAINT FK_core_user_module_access_module FOREIGN KEY (module_id) REFERENCES core.modules(module_id),
        CONSTRAINT FK_core_user_module_access_assigned_by FOREIGN KEY (assigned_by_user_id) REFERENCES core.users(user_id)
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

MERGE core.role_permissions AS target
USING (
    SELECT r.role_id, p.permission_id
    FROM core.roles r
    CROSS JOIN core.permissions p
    WHERE r.role_code = N'admin'
) AS source (role_id, permission_id)
ON target.role_id = source.role_id
AND target.permission_id = source.permission_id
WHEN NOT MATCHED THEN
    INSERT (role_id, permission_id)
    VALUES (source.role_id, source.permission_id);
GO
