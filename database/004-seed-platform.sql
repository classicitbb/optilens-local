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

IF NOT EXISTS (SELECT 1 FROM core.modules WHERE module_code = N'pricing-automation')
BEGIN
    INSERT INTO core.modules (module_code, module_name, route_path, status)
    VALUES (N'pricing-automation', N'Pricing Automation', N'/modules/pricing-automation', N'first-build');
END;
GO

IF NOT EXISTS (SELECT 1 FROM core.users WHERE username = N'local-dashboard')
BEGIN
    INSERT INTO core.users (tenant_id, username, display_name)
    SELECT tenant_id, N'local-dashboard', N'Local Dashboard'
    FROM core.tenants
    WHERE tenant_code = N'default';
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

MERGE core.dashboard_tiles AS target
USING (VALUES
    (N'open-source-shipments', N'Open source shipments', N'Source shipments still open for export prep.', N'delivery-export', N'kpi', N'normal', 10, 1),
    (N'shipment-prep-sessions', N'Shipment prep sessions', N'App-owned delivery/export prep sessions.', N'delivery-export', N'kpi', N'normal', 20, 1),
    (N'app-owned-closures', N'App-owned closures', N'Closed shipment state stored in the private app database.', N'delivery-export', N'kpi', N'normal', 30, 1),
    (N'reopened-shipments', N'Reopened shipments', N'Reopened shipment sessions tracked by the app.', N'delivery-export', N'kpi', N'normal', 40, 1),
    (N'source-mssql-health', N'Source MSSQL health', N'Read-only Innovations source connection status.', NULL, N'health', N'normal', 50, 1),
    (N'private-app-db-health', N'Private app DB health', N'Private optilens_local database status.', NULL, N'health', N'normal', 60, 1),
    (N'access-archive-import-status', N'Access archive/import status', N'Historic CV_Accounts_be import and archive readiness.', N'delivery-export', N'kpi', N'normal', 70, 1),
    (N'write-back-status', N'Write-back status', N'Source write-back remains disabled until explicitly approved.', NULL, N'kpi', N'normal', 80, 1),
    (N'integration-readiness', N'Integration readiness', N'Integration module setup and connector readiness.', N'integrations', N'kpi', N'normal', 90, 1),
    (N'automation-readiness', N'Automation readiness', N'Local LLM and automation readiness.', N'automation', N'kpi', N'normal', 100, 1),
    (N'pricing-rule-count', N'Pricing rules', N'Active pricing automation rules in the private app database.', N'pricing-automation', N'kpi', N'normal', 110, 1),
    (N'pricing-calculation-count', N'Pricing calculations', N'App-owned pricing calculation history.', N'pricing-automation', N'kpi', N'normal', 120, 1)
) AS source (tile_key, title, description, module_code, tile_type, default_size, default_sort, is_default_visible)
ON target.tile_key = source.tile_key
WHEN MATCHED THEN
    UPDATE SET
        title = source.title,
        description = source.description,
        module_code = source.module_code,
        tile_type = source.tile_type,
        default_size = source.default_size,
        default_sort = source.default_sort,
        is_default_visible = source.is_default_visible,
        is_active = 1
WHEN NOT MATCHED THEN
    INSERT (tile_key, title, description, module_code, tile_type, default_size, default_sort, is_default_visible)
    VALUES (source.tile_key, source.title, source.description, source.module_code, source.tile_type, source.default_size, source.default_sort, source.is_default_visible);
GO
