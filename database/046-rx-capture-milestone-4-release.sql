USE [optilens_local];
GO

MERGE core.permissions AS target
USING (
    SELECT m.module_id, v.permission_code, v.permission_name
    FROM (VALUES
        (N'rx-capture.release', N'Release staged RX Capture files to Innovations')
    ) AS v(permission_code, permission_name)
    INNER JOIN core.modules m ON m.module_code = N'rx-capture'
) AS source (module_id, permission_code, permission_name)
ON target.permission_code = source.permission_code
WHEN MATCHED THEN
    UPDATE SET module_id = source.module_id, permission_name = source.permission_name
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
      AND p.permission_code = N'rx-capture.release'
) AS source (role_id, permission_id)
ON target.role_id = source.role_id AND target.permission_id = source.permission_id
WHEN NOT MATCHED THEN
    INSERT (role_id, permission_id) VALUES (source.role_id, source.permission_id);
GO
