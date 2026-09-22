USE [optilens_local];
GO

MERGE core.permissions AS target
USING (
    SELECT m.module_id, v.permission_code, v.permission_name
    FROM (VALUES
        (N'rx-capture.approve', N'Approve reviewed RX Capture orders'),
        (N'rx-capture.stage', N'Stage approved RX Capture files')
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
      AND p.permission_code IN (N'rx-capture.approve', N'rx-capture.stage')
) AS source (role_id, permission_id)
ON target.role_id = source.role_id AND target.permission_id = source.permission_id
WHEN NOT MATCHED THEN
    INSERT (role_id, permission_id) VALUES (source.role_id, source.permission_id);
GO

IF COL_LENGTH(N'rx_capture.orders', N'resolution_json') IS NULL
    ALTER TABLE rx_capture.orders ADD resolution_json nvarchar(max) NULL;
GO

IF COL_LENGTH(N'rx_capture.orders', N'approved_snapshot_json') IS NULL
    ALTER TABLE rx_capture.orders ADD approved_snapshot_json nvarchar(max) NULL;
GO

IF OBJECT_ID(N'rx_capture.order_generations', N'U') IS NULL
BEGIN
    CREATE TABLE rx_capture.order_generations (
        order_generation_id bigint IDENTITY(1,1) NOT NULL,
        capture_order_id uniqueidentifier NOT NULL,
        generated_filename nvarchar(260) NOT NULL,
        content_sha256 char(64) NOT NULL,
        rx_content nvarchar(max) NOT NULL,
        snapshot_json nvarchar(max) NOT NULL,
        generated_by_user_id uniqueidentifier NOT NULL,
        generated_at datetime2(0) NOT NULL CONSTRAINT DF_rx_capture_generations_at DEFAULT SYSUTCDATETIME(),
        staged_at datetime2(0) NULL,
        CONSTRAINT PK_rx_capture_order_generations PRIMARY KEY (order_generation_id),
        CONSTRAINT UQ_rx_capture_generations_order UNIQUE (capture_order_id),
        CONSTRAINT FK_rx_capture_generations_order FOREIGN KEY (capture_order_id) REFERENCES rx_capture.orders(capture_order_id),
        CONSTRAINT FK_rx_capture_generations_user FOREIGN KEY (generated_by_user_id) REFERENCES core.users(user_id)
    );
END;
GO
