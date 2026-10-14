USE [optilens_local];
GO

-- Inventory Intelligence Cockpit schema.
-- App database only. Nothing here references, and no code path writes to, the live
-- LensItem table or any source system. Written to be re-runnable (every object is
-- guarded), because the migration runner applies batches without a transaction.

IF SCHEMA_ID(N'inventory') IS NULL
    EXEC(N'CREATE SCHEMA inventory AUTHORIZATION dbo');
GO

MERGE core.permissions AS target
USING (
    SELECT m.module_id, v.permission_code, v.permission_name
    FROM (VALUES
        (N'inventory.read', N'Read inventory replenishment recommendations and the cockpit'),
        (N'inventory.write', N'Approve replenishment recommendations, edit proposed values and assign inventory tasks')
    ) AS v(permission_code, permission_name)
    INNER JOIN core.modules m ON m.module_code = N'delivery-export'
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
      AND p.permission_code IN (N'inventory.read', N'inventory.write')
) AS source (role_id, permission_id)
ON target.role_id = source.role_id AND target.permission_id = source.permission_id
WHEN NOT MATCHED THEN
    INSERT (role_id, permission_id) VALUES (source.role_id, source.permission_id);
GO

/* ───────────────────────── 1. scan runs ───────────────────────── */

IF OBJECT_ID(N'inventory.scan_runs', N'U') IS NULL
BEGIN
    CREATE TABLE inventory.scan_runs (
        scan_run_id uniqueidentifier NOT NULL CONSTRAINT PK_inv_scan_runs PRIMARY KEY,
        trigger_type nvarchar(60) NOT NULL,
        status nvarchar(40) NOT NULL CONSTRAINT DF_inv_scan_status DEFAULT N'RUNNING',
        source_watermarks_json nvarchar(max) NULL,
        items_evaluated int NOT NULL CONSTRAINT DF_inv_scan_items DEFAULT 0,
        recommendations_created int NOT NULL CONSTRAINT DF_inv_scan_rec_created DEFAULT 0,
        recommendations_superseded int NOT NULL CONSTRAINT DF_inv_scan_rec_sup DEFAULT 0,
        tasks_created int NOT NULL CONSTRAINT DF_inv_scan_tasks_created DEFAULT 0,
        tasks_updated int NOT NULL CONSTRAINT DF_inv_scan_tasks_updated DEFAULT 0,
        summary_json nvarchar(max) NULL,
        errors_json nvarchar(max) NULL,
        started_at datetime2(0) NOT NULL CONSTRAINT DF_inv_scan_started DEFAULT SYSUTCDATETIME(),
        completed_at datetime2(0) NULL
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_scan_started' AND object_id = OBJECT_ID(N'inventory.scan_runs'))
    CREATE INDEX IX_inv_scan_started ON inventory.scan_runs(started_at DESC) INCLUDE (status);
GO

/* ───────────────────────── 2. approved settings ───────────────────────── */

IF OBJECT_ID(N'inventory.item_replenishment_settings', N'U') IS NULL
BEGIN
    CREATE TABLE inventory.item_replenishment_settings (
        setting_id uniqueidentifier NOT NULL CONSTRAINT DF_inv_set_id DEFAULT NEWID(),
        item_id nvarchar(100) NOT NULL,
        item_kind nvarchar(20) NOT NULL CONSTRAINT DF_inv_set_kind DEFAULT N'lens',
        sku nvarchar(100) NULL,
        item_label nvarchar(400) NULL,
        supplier_id nvarchar(100) NULL,
        supplier_name nvarchar(200) NULL,
        is_active bit NOT NULL CONSTRAINT DF_inv_set_active DEFAULT 1,
        order_point int NOT NULL,
        safety_stock int NOT NULL CONSTRAINT DF_inv_set_safety DEFAULT 0,
        target_cover_days int NOT NULL CONSTRAINT DF_inv_set_cover DEFAULT 30,
        lead_time_days int NOT NULL CONSTRAINT DF_inv_set_lead DEFAULT 14,
        lead_time_override_reason nvarchar(500) NULL,
        reorder_quantity int NOT NULL,
        min_order_qty int NOT NULL CONSTRAINT DF_inv_set_moq DEFAULT 1,
        pack_multiple int NOT NULL CONSTRAINT DF_inv_set_pack DEFAULT 1,
        supplier_preference nvarchar(100) NULL,
        substitution_policy nvarchar(200) NULL,
        approved_recommendation_id uniqueidentifier NULL,
        approved_task_id uniqueidentifier NULL,
        approved_by nvarchar(120) NULL,
        approved_at datetime2(0) NOT NULL CONSTRAINT DF_inv_set_app_at DEFAULT SYSUTCDATETIME(),
        version int NOT NULL CONSTRAINT DF_inv_set_ver DEFAULT 1,
        effective_from datetime2(0) NOT NULL CONSTRAINT DF_inv_set_eff_from DEFAULT SYSUTCDATETIME(),
        effective_to datetime2(0) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_inv_set_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_inventory_replenishment_settings PRIMARY KEY (setting_id),
        CONSTRAINT CK_inv_set_values CHECK (order_point >= 0 AND safety_stock >= 0 AND reorder_quantity >= 0
            AND min_order_qty >= 1 AND pack_multiple >= 1 AND lead_time_days >= 1 AND target_cover_days >= 1)
    );
END;
GO

-- One effective revision per item, and one row per (item, version): a race cannot write two.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_inv_settings_active' AND object_id = OBJECT_ID(N'inventory.item_replenishment_settings'))
    CREATE UNIQUE INDEX UQ_inv_settings_active ON inventory.item_replenishment_settings(item_id) WHERE effective_to IS NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_inv_settings_item_version' AND object_id = OBJECT_ID(N'inventory.item_replenishment_settings'))
    CREATE UNIQUE INDEX UQ_inv_settings_item_version ON inventory.item_replenishment_settings(item_id, version);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_settings_supplier' AND object_id = OBJECT_ID(N'inventory.item_replenishment_settings'))
    CREATE INDEX IX_inv_settings_supplier ON inventory.item_replenishment_settings(supplier_id) WHERE effective_to IS NULL;
GO

/* ───────────────────────── 3. confidence (current + history) ───────────────────────── */

IF OBJECT_ID(N'inventory.confidence', N'U') IS NULL
BEGIN
    CREATE TABLE inventory.confidence (
        confidence_id uniqueidentifier NOT NULL CONSTRAINT DF_inv_conf_id DEFAULT NEWID(),
        item_id nvarchar(100) NOT NULL,
        supplier_id nvarchar(100) NULL,
        confidence_score decimal(5, 2) NOT NULL,
        confidence_level nvarchar(20) NOT NULL,
        stock_freshness_days int NULL,
        last_verified_count_date date NULL,
        usage_sufficiency nvarchar(50) NOT NULL,
        coverage_window_days int NOT NULL CONSTRAINT DF_inv_conf_win DEFAULT 90,
        po_completeness_flag bit NULL,
        po_freshness_days int NULL,
        supplier_mapping_quality nvarchar(50) NOT NULL,
        missing_settings_flags_json nvarchar(max) NULL,
        reasons_json nvarchar(max) NULL,
        calculated_at datetime2(0) NOT NULL CONSTRAINT DF_inv_conf_calc DEFAULT SYSUTCDATETIME(),
        is_current bit NOT NULL CONSTRAINT DF_inv_conf_current DEFAULT 1,
        CONSTRAINT PK_inventory_confidence PRIMARY KEY (confidence_id)
    );
END;
GO

-- Repair a table created by an earlier draft of this migration (one row per item, flag NOT NULL).
IF COL_LENGTH(N'inventory.confidence', N'is_current') IS NULL
    ALTER TABLE inventory.confidence ADD is_current bit NOT NULL CONSTRAINT DF_inv_conf_current DEFAULT 1;
GO

IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'inventory.confidence') AND name = N'po_completeness_flag' AND is_nullable = 0)
    ALTER TABLE inventory.confidence ALTER COLUMN po_completeness_flag bit NULL;
GO

IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_inv_confidence_item' AND object_id = OBJECT_ID(N'inventory.confidence'))
    DROP INDEX UQ_inv_confidence_item ON inventory.confidence;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_inv_confidence_current' AND object_id = OBJECT_ID(N'inventory.confidence'))
    CREATE UNIQUE INDEX UQ_inv_confidence_current ON inventory.confidence(item_id) WHERE is_current = 1;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_confidence_history' AND object_id = OBJECT_ID(N'inventory.confidence'))
    CREATE INDEX IX_inv_confidence_history ON inventory.confidence(item_id, calculated_at DESC);
GO

/* ───────────────────────── 4. recommendations ───────────────────────── */

IF OBJECT_ID(N'inventory.replenishment_recommendations', N'U') IS NULL
BEGIN
    CREATE TABLE inventory.replenishment_recommendations (
        recommendation_id uniqueidentifier NOT NULL CONSTRAINT DF_inv_rec_id DEFAULT NEWID(),
        item_id nvarchar(100) NOT NULL,
        item_kind nvarchar(20) NOT NULL CONSTRAINT DF_inv_rec_kind DEFAULT N'lens',
        item_label nvarchar(400) NULL,
        sku nvarchar(100) NULL,
        supplier_id nvarchar(100) NULL,
        supplier_name nvarchar(200) NULL,
        scan_run_id uniqueidentifier NULL,
        idempotency_key nvarchar(200) NOT NULL,
        recommendation_type nvarchar(50) NOT NULL,
        status nvarchar(50) NOT NULL CONSTRAINT DF_inv_rec_status DEFAULT N'OPEN',
        evidence_snapshot_json nvarchar(max) NOT NULL,
        evidence_version int NOT NULL CONSTRAINT DF_inv_rec_ev_ver DEFAULT 1,
        proposed_settings_json nvarchar(max) NOT NULL,
        calculation_version nvarchar(50) NOT NULL,
        policy_version nvarchar(80) NOT NULL,
        confidence_score decimal(5, 2) NOT NULL,
        confidence_level nvarchar(20) NOT NULL,
        previous_recommendation_id uniqueidentifier NULL,
        revision_number int NOT NULL CONSTRAINT DF_inv_rec_rev DEFAULT 1,
        before_settings_snapshot_json nvarchar(max) NULL,
        approved_settings_snapshot_json nvarchar(max) NULL,
        decision_reason nvarchar(500) NULL,
        decision_actor nvarchar(120) NULL,
        decision_at datetime2(0) NULL,
        superseded_at datetime2(0) NULL,
        superseded_by_id uniqueidentifier NULL,
        linked_task_id uniqueidentifier NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_inv_rec_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_inv_rec_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_inventory_recommendations PRIMARY KEY (recommendation_id),
        CONSTRAINT CK_inv_rec_type CHECK (recommendation_type IN (N'ORDER_MORE', N'ORDER_LESS', N'WRITE_OFF_REVIEW', N'SHELF_CHECK', N'ALREADY_COVERED_BY_PO', N'DATA_REVIEW')),
        CONSTRAINT CK_inv_rec_status CHECK (status IN (N'OPEN', N'PENDING_APPROVAL', N'APPROVED', N'REJECTED', N'SUPERSEDED', N'APPLIED', N'CANCELLED'))
    );
END;
GO

IF COL_LENGTH(N'inventory.replenishment_recommendations', N'approved_settings_snapshot_json') IS NULL
    ALTER TABLE inventory.replenishment_recommendations ADD approved_settings_snapshot_json nvarchar(max) NULL;
GO

IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'inventory.replenishment_recommendations') AND name = N'policy_version' AND max_length < 160)
    ALTER TABLE inventory.replenishment_recommendations ALTER COLUMN policy_version nvarchar(80) NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_inv_rec_idempotency' AND object_id = OBJECT_ID(N'inventory.replenishment_recommendations'))
    CREATE UNIQUE INDEX UQ_inv_rec_idempotency ON inventory.replenishment_recommendations(idempotency_key);
GO

-- One revision number per item, and at most one undecided recommendation per item.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_inv_rec_item_revision' AND object_id = OBJECT_ID(N'inventory.replenishment_recommendations'))
    CREATE UNIQUE INDEX UQ_inv_rec_item_revision ON inventory.replenishment_recommendations(item_id, revision_number);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_inv_rec_one_undecided' AND object_id = OBJECT_ID(N'inventory.replenishment_recommendations'))
    CREATE UNIQUE INDEX UQ_inv_rec_one_undecided ON inventory.replenishment_recommendations(item_id)
        WHERE status IN (N'OPEN', N'PENDING_APPROVAL');
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_rec_type_status' AND object_id = OBJECT_ID(N'inventory.replenishment_recommendations'))
    CREATE INDEX IX_inv_rec_type_status ON inventory.replenishment_recommendations(recommendation_type, status)
        INCLUDE (item_id, confidence_level, created_at);
GO

/* ───────────────────────── 5. operational tasks ───────────────────────── */

IF OBJECT_ID(N'inventory.operational_tasks', N'U') IS NULL
BEGIN
    CREATE TABLE inventory.operational_tasks (
        task_id uniqueidentifier NOT NULL CONSTRAINT DF_inv_task_id DEFAULT NEWID(),
        recommendation_id uniqueidentifier NULL,
        item_id nvarchar(100) NOT NULL,
        supplier_id nvarchar(100) NULL,
        idempotency_key nvarchar(200) NOT NULL,
        task_type nvarchar(60) NOT NULL,
        status nvarchar(40) NOT NULL CONSTRAINT DF_inv_task_status DEFAULT N'OPEN',
        assignee nvarchar(120) NULL,
        priority nvarchar(20) NOT NULL CONSTRAINT DF_inv_task_prio DEFAULT N'MEDIUM',
        due_date date NULL,
        source_run_id uniqueidentifier NULL,
        task_payload_json nvarchar(max) NULL,
        resolution_note nvarchar(1000) NULL,
        audit_correlation_id nvarchar(120) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_inv_task_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_inv_task_updated DEFAULT SYSUTCDATETIME(),
        completed_at datetime2(0) NULL,
        cancelled_at datetime2(0) NULL,
        escalated_at datetime2(0) NULL,
        CONSTRAINT PK_inventory_operational_tasks PRIMARY KEY (task_id),
        CONSTRAINT CK_inv_task_type CHECK (task_type IN (N'APPROVE_REPLENISHMENT_CHANGE', N'REVIEW_SUGGESTED_PO', N'COUNT_SHELF', N'REVIEW_WRITE_OFF', N'REVIEW_OVERSTOCK', N'RESOLVE_SUPPLIER_MAPPING', N'CORRECT_ITEM_DATA')),
        CONSTRAINT CK_inv_task_status CHECK (status IN (N'OPEN', N'ASSIGNED', N'IN_PROGRESS', N'PENDING_APPROVAL', N'APPROVED', N'REJECTED', N'COMPLETED', N'CANCELLED', N'BLOCKED'))
    );
END;
GO

-- An earlier draft made idempotency_key unconditionally unique, which would have stopped a new
-- task being created for the same item and purpose after the first was completed.
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_inv_task_idempotency' AND object_id = OBJECT_ID(N'inventory.operational_tasks'))
    DROP INDEX UQ_inv_task_idempotency ON inventory.operational_tasks;
GO

-- At most one UNRESOLVED task per item and purpose; resolved ones keep their key and history.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_inv_task_active' AND object_id = OBJECT_ID(N'inventory.operational_tasks'))
    CREATE UNIQUE INDEX UQ_inv_task_active ON inventory.operational_tasks(idempotency_key)
        WHERE status IN (N'OPEN', N'ASSIGNED', N'IN_PROGRESS', N'PENDING_APPROVAL', N'BLOCKED');
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_task_status_type' AND object_id = OBJECT_ID(N'inventory.operational_tasks'))
    CREATE INDEX IX_inv_task_status_type ON inventory.operational_tasks(status, task_type)
        INCLUDE (assignee, priority, due_date);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_task_item' AND object_id = OBJECT_ID(N'inventory.operational_tasks'))
    CREATE INDEX IX_inv_task_item ON inventory.operational_tasks(item_id, status);
GO

/* ───────────────────────── 6. task history (append-only) ───────────────────────── */

IF OBJECT_ID(N'inventory.task_history', N'U') IS NULL
BEGIN
    CREATE TABLE inventory.task_history (
        task_history_id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_inv_task_history PRIMARY KEY,
        task_id uniqueidentifier NOT NULL,
        event_type nvarchar(60) NOT NULL,
        from_status nvarchar(40) NULL,
        to_status nvarchar(40) NULL,
        actor nvarchar(120) NULL,
        note nvarchar(1000) NULL,
        details_json nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_inv_th_created DEFAULT SYSUTCDATETIME()
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_th_task' AND object_id = OBJECT_ID(N'inventory.task_history'))
    CREATE INDEX IX_inv_th_task ON inventory.task_history(task_id, task_history_id);
GO

/* ───────────────────────── 7. audit events (append-only) ───────────────────────── */

IF OBJECT_ID(N'inventory.audit_events', N'U') IS NULL
BEGIN
    CREATE TABLE inventory.audit_events (
        audit_id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_inv_audit_events PRIMARY KEY,
        scan_run_id uniqueidentifier NULL,
        recommendation_id uniqueidentifier NULL,
        task_id uniqueidentifier NULL,
        setting_id uniqueidentifier NULL,
        actor nvarchar(120) NOT NULL,
        action nvarchar(100) NOT NULL,
        entity_type nvarchar(100) NOT NULL,
        entity_id nvarchar(100) NOT NULL,
        before_state_json nvarchar(max) NULL,
        after_state_json nvarchar(max) NULL,
        reason nvarchar(500) NULL,
        correlation_id nvarchar(120) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_inv_audit_created DEFAULT SYSUTCDATETIME()
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_audit_entity' AND object_id = OBJECT_ID(N'inventory.audit_events'))
    CREATE INDEX IX_inv_audit_entity ON inventory.audit_events(entity_type, entity_id, audit_id DESC);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_audit_recommendation' AND object_id = OBJECT_ID(N'inventory.audit_events'))
    CREATE INDEX IX_inv_audit_recommendation ON inventory.audit_events(recommendation_id, audit_id DESC) WHERE recommendation_id IS NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_audit_scan' AND object_id = OBJECT_ID(N'inventory.audit_events'))
    CREATE INDEX IX_inv_audit_scan ON inventory.audit_events(scan_run_id, audit_id DESC) WHERE scan_run_id IS NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_audit_correlation' AND object_id = OBJECT_ID(N'inventory.audit_events'))
    CREATE INDEX IX_inv_audit_correlation ON inventory.audit_events(correlation_id) WHERE correlation_id IS NOT NULL;
GO

-- Append-only is enforced by the database, not just by convention: nobody, including the app
-- login, can update or delete these rows without first dropping the trigger (itself a visible act).
IF OBJECT_ID(N'inventory.trg_audit_events_append_only', N'TR') IS NULL
EXEC(N'CREATE TRIGGER inventory.trg_audit_events_append_only ON inventory.audit_events
INSTEAD OF UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    THROW 51000, N''inventory.audit_events is append-only: rows cannot be changed or removed.'', 1;
END');
GO

IF OBJECT_ID(N'inventory.trg_task_history_append_only', N'TR') IS NULL
EXEC(N'CREATE TRIGGER inventory.trg_task_history_append_only ON inventory.task_history
INSTEAD OF UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    THROW 51000, N''inventory.task_history is append-only: rows cannot be changed or removed.'', 1;
END');
GO

/* ───────────────────────── 8. recalculation requests (durable queue) ───────────────────────── */

IF OBJECT_ID(N'inventory.recalculation_requests', N'U') IS NULL
BEGIN
    CREATE TABLE inventory.recalculation_requests (
        request_id uniqueidentifier NOT NULL CONSTRAINT PK_inv_recalc_requests PRIMARY KEY,
        event_type nvarchar(40) NOT NULL,
        item_id nvarchar(100) NULL,
        dedupe_key nvarchar(200) NOT NULL,
        payload_json nvarchar(max) NULL,
        status nvarchar(20) NOT NULL CONSTRAINT DF_inv_recalc_status DEFAULT N'PENDING',
        requested_by nvarchar(120) NULL,
        requested_at datetime2(0) NOT NULL CONSTRAINT DF_inv_recalc_requested DEFAULT SYSUTCDATETIME(),
        claimed_at datetime2(0) NULL,
        processed_at datetime2(0) NULL,
        scan_run_id uniqueidentifier NULL,
        attempts int NOT NULL CONSTRAINT DF_inv_recalc_attempts DEFAULT 0,
        last_error nvarchar(500) NULL,
        CONSTRAINT CK_inv_recalc_event CHECK (event_type IN (N'SCHEDULED_FULL', N'MANUAL_FULL', N'EVENT_USAGE', N'EVENT_STOCK_ADJUSTMENT', N'EVENT_PO', N'EVENT_SETTINGS')),
        CONSTRAINT CK_inv_recalc_status CHECK (status IN (N'PENDING', N'RUNNING', N'PROCESSED', N'FAILED'))
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_inv_recalc_dedupe' AND object_id = OBJECT_ID(N'inventory.recalculation_requests'))
    CREATE UNIQUE INDEX UQ_inv_recalc_dedupe ON inventory.recalculation_requests(dedupe_key);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_recalc_pending' AND object_id = OBJECT_ID(N'inventory.recalculation_requests'))
    CREATE INDEX IX_inv_recalc_pending ON inventory.recalculation_requests(status, requested_at) INCLUDE (event_type, item_id);
GO

/* ───────────────────────── 9. shelf count results ───────────────────────── */

IF OBJECT_ID(N'inventory.stock_count_results', N'U') IS NULL
BEGIN
    CREATE TABLE inventory.stock_count_results (
        count_id uniqueidentifier NOT NULL CONSTRAINT PK_inv_stock_counts PRIMARY KEY,
        item_id nvarchar(100) NOT NULL,
        counted_quantity int NOT NULL,
        system_quantity int NULL,
        counted_by nvarchar(120) NOT NULL,
        counted_at datetime2(0) NOT NULL CONSTRAINT DF_inv_count_at DEFAULT SYSUTCDATETIME(),
        task_id uniqueidentifier NULL,
        note nvarchar(500) NULL,
        CONSTRAINT CK_inv_count_qty CHECK (counted_quantity >= 0)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_counts_item' AND object_id = OBJECT_ID(N'inventory.stock_count_results'))
    CREATE INDEX IX_inv_counts_item ON inventory.stock_count_results(item_id, counted_at DESC);
GO

IF OBJECT_ID(N'inventory.trg_stock_counts_append_only', N'TR') IS NULL
EXEC(N'CREATE TRIGGER inventory.trg_stock_counts_append_only ON inventory.stock_count_results
INSTEAD OF UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    THROW 51000, N''inventory.stock_count_results is append-only: a wrong count is corrected by recording a new one.'', 1;
END');
GO

/* ───────────────────────── 10. API idempotency keys ───────────────────────── */

IF OBJECT_ID(N'inventory.idempotency_keys', N'U') IS NULL
BEGIN
    CREATE TABLE inventory.idempotency_keys (
        idempotency_key nvarchar(120) NOT NULL CONSTRAINT PK_inv_idempotency PRIMARY KEY,
        operation nvarchar(120) NOT NULL,
        actor nvarchar(120) NOT NULL,
        state nvarchar(20) NOT NULL,
        response_json nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_inv_idem_created DEFAULT SYSUTCDATETIME()
    );
END;
GO

/* ───────────────────────── 11. policy settings ───────────────────────── */

MERGE core.app_settings AS target
USING (VALUES
    (N'inventory_weight_30', N'0.70'),
    (N'inventory_weight_90', N'0.30'),
    (N'inventory_target_cover_days', N'30'),
    (N'inventory_default_lead_time_days', N'14'),
    (N'inventory_default_safety_stock', N'5'),
    (N'inventory_write_off_days', N'365'),
    (N'inventory_overstock_cover_ratio', N'2.0'),
    (N'inventory_order_less_tolerance', N'0.25'),
    (N'inventory_confidence_threshold', N'50')
) AS source (setting_key, setting_value)
    ON target.setting_key = source.setting_key
WHEN NOT MATCHED BY TARGET THEN
    INSERT (setting_key, setting_value, updated_by)
    VALUES (source.setting_key, source.setting_value, N'053-inventory-intelligence');
GO
