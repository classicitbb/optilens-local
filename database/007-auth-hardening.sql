USE [optilens_local];
GO

IF COL_LENGTH(N'core.users', N'updated_at') IS NULL
BEGIN
    ALTER TABLE core.users
    ADD updated_at datetime2(0) NULL;
END;
GO

IF OBJECT_ID(N'core.user_credentials', N'U') IS NULL
BEGIN
    CREATE TABLE core.user_credentials (
        user_id uniqueidentifier NOT NULL,
        password_hash nvarchar(512) NOT NULL,
        must_change_password bit NOT NULL CONSTRAINT DF_core_user_credentials_must_change DEFAULT 0,
        failed_login_count int NOT NULL CONSTRAINT DF_core_user_credentials_failed DEFAULT 0,
        locked_until datetime2(0) NULL,
        password_changed_at datetime2(0) NOT NULL CONSTRAINT DF_core_user_credentials_changed DEFAULT SYSUTCDATETIME(),
        last_login_at datetime2(0) NULL,
        CONSTRAINT PK_core_user_credentials PRIMARY KEY (user_id),
        CONSTRAINT FK_core_user_credentials_user FOREIGN KEY (user_id) REFERENCES core.users(user_id)
    );
END;
GO

MERGE core.roles AS target
USING (VALUES
    (N'admin', N'Administrator'),
    (N'dispatcher', N'Dispatcher'),
    (N'export_shipping', N'Export and Shipping'),
    (N'pricing_manager', N'Pricing Manager'),
    (N'viewer', N'Viewer')
) AS source (role_code, role_name)
ON target.role_code = source.role_code
WHEN MATCHED THEN
    UPDATE SET role_name = source.role_name
WHEN NOT MATCHED THEN
    INSERT (role_code, role_name)
    VALUES (source.role_code, source.role_name);
GO

MERGE core.permissions AS target
USING (
    SELECT m.module_id, v.permission_code, v.permission_name
    FROM (VALUES
        (NULL, N'platform.admin', N'Platform administration'),
        (NULL, N'users.manage', N'Manage platform users'),
        (NULL, N'dashboard.write', N'Change command-center dashboard layout'),
        (NULL, N'credentials.manage', N'Manage credential vault and connector secrets'),
        (N'delivery-export', N'delivery.read', N'Read delivery and export data'),
        (N'delivery-export', N'delivery.write', N'Create and update delivery/export sessions'),
        (N'pricing-automation', N'pricing.read', N'Read pricing automation data'),
        (N'pricing-automation', N'pricing.write', N'Create and update pricing automation data'),
        (N'integrations', N'integrations.read', N'Read integration configuration'),
        (N'integrations', N'integrations.manage', N'Manage integration connections')
    ) AS v(module_code, permission_code, permission_name)
    LEFT JOIN core.modules m
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

INSERT INTO core.permissions (module_id, permission_code, permission_name)
SELECT NULL, v.permission_code, v.permission_name
FROM (VALUES
    (N'platform.admin', N'Platform administration'),
    (N'users.manage', N'Manage platform users'),
    (N'dashboard.write', N'Change command-center dashboard layout'),
    (N'credentials.manage', N'Manage credential vault and connector secrets')
) AS v(permission_code, permission_name)
WHERE NOT EXISTS (
    SELECT 1
    FROM core.permissions p
    WHERE p.permission_code = v.permission_code
);
GO

MERGE core.role_permissions AS target
USING (
    SELECT r.role_id, p.permission_id
    FROM core.roles r
    CROSS JOIN core.permissions p
    WHERE r.role_code = N'admin'

    UNION ALL

    SELECT r.role_id, p.permission_id
    FROM core.roles r
    INNER JOIN core.permissions p
      ON p.permission_code IN (N'dashboard.write', N'delivery.read', N'delivery.write')
    WHERE r.role_code IN (N'dispatcher', N'export_shipping')

    UNION ALL

    SELECT r.role_id, p.permission_id
    FROM core.roles r
    INNER JOIN core.permissions p
      ON p.permission_code IN (N'dashboard.write', N'pricing.read', N'pricing.write')
    WHERE r.role_code = N'pricing_manager'

    UNION ALL

    SELECT r.role_id, p.permission_id
    FROM core.roles r
    INNER JOIN core.permissions p
      ON p.permission_code IN (N'delivery.read', N'pricing.read', N'integrations.read')
    WHERE r.role_code = N'viewer'
) AS source (role_id, permission_id)
ON target.role_id = source.role_id
AND target.permission_id = source.permission_id
WHEN NOT MATCHED THEN
    INSERT (role_id, permission_id)
    VALUES (source.role_id, source.permission_id);
GO

IF EXISTS (SELECT 1 FROM core.users WHERE username = N'local-dashboard')
AND EXISTS (SELECT 1 FROM core.roles WHERE role_code = N'viewer')
AND NOT EXISTS (
    SELECT 1
    FROM core.user_roles ur
    INNER JOIN core.users u
      ON u.user_id = ur.user_id
    INNER JOIN core.roles r
      ON r.role_id = ur.role_id
    WHERE u.username = N'local-dashboard'
      AND r.role_code = N'viewer'
)
BEGIN
    INSERT INTO core.user_roles (user_id, role_id)
    SELECT u.user_id, r.role_id
    FROM core.users u
    CROSS JOIN core.roles r
    WHERE u.username = N'local-dashboard'
      AND r.role_code = N'viewer';
END;
GO

DECLARE @default_tenant_id uniqueidentifier;
DECLARE @default_user_id uniqueidentifier;
DECLARE @default_admin_role_id uniqueidentifier;

SELECT @default_tenant_id = tenant_id
FROM core.tenants
WHERE tenant_code = N'default';

IF @default_tenant_id IS NULL
BEGIN
    INSERT INTO core.tenants (tenant_code, tenant_name)
    VALUES (N'default', N'OptiLens Local');

    SELECT @default_tenant_id = tenant_id
    FROM core.tenants
    WHERE tenant_code = N'default';
END;

SELECT @default_user_id = user_id
FROM core.users
WHERE username = N'optilens';

IF @default_user_id IS NULL
BEGIN
    INSERT INTO core.users (tenant_id, username, display_name, email, is_active)
    VALUES (@default_tenant_id, N'optilens', N'OptiLens Admin', NULL, 1);

    SELECT @default_user_id = user_id
    FROM core.users
    WHERE username = N'optilens';
END
ELSE
BEGIN
    UPDATE core.users
    SET display_name = N'OptiLens Admin',
        is_active = 1,
        updated_at = SYSUTCDATETIME()
    WHERE user_id = @default_user_id;
END;

IF EXISTS (SELECT 1 FROM core.user_credentials WHERE user_id = @default_user_id)
BEGIN
    UPDATE core.user_credentials
    SET password_hash = N'pbkdf2-sha256$210000$b3B0aWxlbnMtZGVmYXVsdC1hZG1pbi12MQ==$X2227xO74edMFG3IyX3l1HgNEVR++RWsSbLKdJFUvCE=',
        must_change_password = 0,
        failed_login_count = 0,
        locked_until = NULL,
        password_changed_at = SYSUTCDATETIME()
    WHERE user_id = @default_user_id;
END
ELSE
BEGIN
    INSERT INTO core.user_credentials (
        user_id,
        password_hash,
        must_change_password
    )
    VALUES (
        @default_user_id,
        N'pbkdf2-sha256$210000$b3B0aWxlbnMtZGVmYXVsdC1hZG1pbi12MQ==$X2227xO74edMFG3IyX3l1HgNEVR++RWsSbLKdJFUvCE=',
        0
    );
END;

SELECT @default_admin_role_id = role_id
FROM core.roles
WHERE role_code = N'admin';

IF @default_admin_role_id IS NOT NULL
AND NOT EXISTS (
    SELECT 1
    FROM core.user_roles
    WHERE user_id = @default_user_id
      AND role_id = @default_admin_role_id
)
BEGIN
    INSERT INTO core.user_roles (user_id, role_id)
    VALUES (@default_user_id, @default_admin_role_id);
END;
GO
