USE [optilens_local];
GO

IF NOT EXISTS (SELECT 1 FROM core.tenants WHERE tenant_code = N'default')
BEGIN
    INSERT INTO core.tenants (tenant_code, tenant_name)
    VALUES (N'default', N'OptiLens Local');
END;
GO

IF NOT EXISTS (SELECT 1 FROM core.modules WHERE module_code = N'delivery-export')
BEGIN
    INSERT INTO core.modules (module_code, module_name, route_path, status)
    VALUES (N'delivery-export', N'Delivery and Export', N'/modules/delivery-export', N'first-build');
END;
GO

IF NOT EXISTS (SELECT 1 FROM core.modules WHERE module_code = N'integrations')
BEGIN
    INSERT INTO core.modules (module_code, module_name, route_path, status)
    VALUES (N'integrations', N'Integrations', N'/modules/integrations', N'planned');
END;
GO

IF NOT EXISTS (SELECT 1 FROM core.modules WHERE module_code = N'automation')
BEGIN
    INSERT INTO core.modules (module_code, module_name, route_path, status)
    VALUES (N'automation', N'Automation', N'/modules/automation', N'planned');
END;
GO

IF NOT EXISTS (SELECT 1 FROM core.roles WHERE role_code = N'admin')
BEGIN
    INSERT INTO core.roles (role_code, role_name)
    VALUES (N'admin', N'Administrator');
END;
GO

IF NOT EXISTS (SELECT 1 FROM core.roles WHERE role_code = N'dispatcher')
BEGIN
    INSERT INTO core.roles (role_code, role_name)
    VALUES (N'dispatcher', N'Dispatcher');
END;
GO

IF NOT EXISTS (SELECT 1 FROM core.roles WHERE role_code = N'export_shipping')
BEGIN
    INSERT INTO core.roles (role_code, role_name)
    VALUES (N'export_shipping', N'Export and Shipping');
END;
GO

IF NOT EXISTS (SELECT 1 FROM integration.connections WHERE connection_code = N'source-mssql-innovations')
BEGIN
    INSERT INTO integration.connections (connection_code, connection_name, connection_type, safe_config_json, secret_reference, mode)
    VALUES (
        N'source-mssql-innovations',
        N'Source MSSQL Innovations',
        N'mssql',
        N'{"server":"MSSQL-SVR","database":"Innovations","encrypt":true,"trustServerCertificate":true}',
        N'Windows Credential Manager or environment variables',
        N'read-only'
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM integration.connections WHERE connection_code = N'source-access-cv-accounts')
BEGIN
    INSERT INTO integration.connections (connection_code, connection_name, connection_type, safe_config_json, secret_reference, mode)
    VALUES (
        N'source-access-cv-accounts',
        N'CV Accounts Access Backend',
        N'access',
        N'{"source":"CV_Accounts_be.accdb","retention":"last 12 months active plus archive"}',
        NULL,
        N'read-only'
    );
END;
GO
