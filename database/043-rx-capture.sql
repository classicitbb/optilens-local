USE [optilens_local];
GO

IF NOT EXISTS (SELECT 1 FROM core.modules WHERE module_code = N'rx-capture')
BEGIN
    INSERT INTO core.modules (module_code, module_name, route_path, status)
    VALUES (N'rx-capture', N'RX Capture', N'/rx-capture', N'first-build');
END;
GO

MERGE core.permissions AS target
USING (
    SELECT m.module_id, v.permission_code, v.permission_name
    FROM (VALUES
        (N'rx-capture.read', N'Read own RX Capture orders'),
        (N'rx-capture.write', N'Create and update own RX Capture orders')
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
      AND p.permission_code IN (N'rx-capture.read', N'rx-capture.write')
) AS source (role_id, permission_id)
ON target.role_id = source.role_id AND target.permission_id = source.permission_id
WHEN NOT MATCHED THEN
    INSERT (role_id, permission_id) VALUES (source.role_id, source.permission_id);
GO

IF SCHEMA_ID(N'rx_capture') IS NULL
    EXEC(N'CREATE SCHEMA rx_capture AUTHORIZATION dbo');
GO

IF OBJECT_ID(N'rx_capture.orders', N'U') IS NULL
BEGIN
    CREATE TABLE rx_capture.orders (
        capture_order_id uniqueidentifier NOT NULL,
        status nvarchar(40) NOT NULL,
        created_by_user_id uniqueidentifier NOT NULL,
        created_by_username nvarchar(160) NOT NULL,
        created_by_display_name nvarchar(200) NOT NULL,
        patient_name nvarchar(200) NULL,
        source_image_paths_json nvarchar(max) NULL,
        source_image_deleted_at datetime2(0) NULL,
        extracted_json nvarchar(max) NULL,
        validated_json nvarchar(max) NULL,
        lens_alias nvarchar(13) NULL,
        instructions nvarchar(max) NULL,
        generated_filename nvarchar(260) NULL,
        staging_path nvarchar(1000) NULL,
        approved_by uniqueidentifier NULL,
        approved_at datetime2(0) NULL,
        released_by uniqueidentifier NULL,
        released_at datetime2(0) NULL,
        error_message nvarchar(500) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_rx_capture_orders_created DEFAULT SYSUTCDATETIME(),
        last_updated_at datetime2(0) NOT NULL CONSTRAINT DF_rx_capture_orders_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_rx_capture_orders PRIMARY KEY (capture_order_id),
        CONSTRAINT FK_rx_capture_orders_created_by FOREIGN KEY (created_by_user_id) REFERENCES core.users(user_id),
        CONSTRAINT FK_rx_capture_orders_approved_by FOREIGN KEY (approved_by) REFERENCES core.users(user_id),
        CONSTRAINT FK_rx_capture_orders_released_by FOREIGN KEY (released_by) REFERENCES core.users(user_id),
        CONSTRAINT CK_rx_capture_orders_status CHECK (status IN (
            N'NEW', N'PROCESSING', N'NEEDS_INFO', N'READY_FOR_REVIEW', N'APPROVED',
            N'RX_GENERATED', N'STAGED', N'RELEASED', N'FAILED', N'CANCELLED'
        ))
    );
    CREATE INDEX IX_rx_capture_orders_owner_created
        ON rx_capture.orders (created_by_user_id, created_at DESC);
END;
GO

IF OBJECT_ID(N'rx_capture.order_events', N'U') IS NULL
BEGIN
    CREATE TABLE rx_capture.order_events (
        order_event_id bigint IDENTITY(1,1) NOT NULL,
        capture_order_id uniqueidentifier NOT NULL,
        event_at datetime2(0) NOT NULL CONSTRAINT DF_rx_capture_events_at DEFAULT SYSUTCDATETIME(),
        actor_user_id uniqueidentifier NULL,
        actor_username nvarchar(160) NOT NULL,
        event_code nvarchar(60) NOT NULL,
        details_json nvarchar(max) NULL,
        CONSTRAINT PK_rx_capture_order_events PRIMARY KEY (order_event_id),
        CONSTRAINT FK_rx_capture_events_order FOREIGN KEY (capture_order_id) REFERENCES rx_capture.orders(capture_order_id),
        CONSTRAINT FK_rx_capture_events_user FOREIGN KEY (actor_user_id) REFERENCES core.users(user_id)
    );
    CREATE INDEX IX_rx_capture_events_order_at
        ON rx_capture.order_events (capture_order_id, event_at, order_event_id);
END;
GO
