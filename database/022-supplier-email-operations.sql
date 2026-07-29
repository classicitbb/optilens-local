USE [optilens_local];
GO

IF SCHEMA_ID(N'ops') IS NULL EXEC(N'CREATE SCHEMA ops');
GO

IF OBJECT_ID(N'ops.Events', N'U') IS NULL
BEGIN
    CREATE TABLE ops.Events (
        event_id uniqueidentifier NOT NULL CONSTRAINT DF_ops_events_id DEFAULT NEWID(),
        event_type nvarchar(160) NOT NULL,
        schema_version int NOT NULL CONSTRAINT DF_ops_events_schema_version DEFAULT 1,
        source_system nvarchar(120) NOT NULL,
        external_reference nvarchar(300) NULL,
        correlation_id uniqueidentifier NOT NULL,
        causation_id uniqueidentifier NULL,
        idempotency_key nvarchar(500) NOT NULL,
        payload_json nvarchar(max) NOT NULL,
        status nvarchar(40) NOT NULL CONSTRAINT DF_ops_events_status DEFAULT N'RECEIVED',
        attempt_count int NOT NULL CONSTRAINT DF_ops_events_attempts DEFAULT 0,
        available_at datetime2(0) NOT NULL CONSTRAINT DF_ops_events_available DEFAULT SYSUTCDATETIME(),
        locked_by nvarchar(160) NULL,
        lock_expires_at datetime2(0) NULL,
        last_error nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_ops_events_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_ops_events_updated DEFAULT SYSUTCDATETIME(),
        completed_at datetime2(0) NULL,
        CONSTRAINT PK_ops_events PRIMARY KEY (event_id),
        CONSTRAINT UQ_ops_events_idempotency UNIQUE (idempotency_key),
        CONSTRAINT CK_ops_events_status CHECK (status IN (N'RECEIVED', N'PROCESSING', N'WAITING_RETRY', N'COMPLETED', N'FAILED', N'DEAD_LETTER'))
    );
END;
GO

IF OBJECT_ID(N'ops.Attachments', N'U') IS NULL
BEGIN
    CREATE TABLE ops.Attachments (
        attachment_id uniqueidentifier NOT NULL CONSTRAINT DF_ops_attachments_id DEFAULT NEWID(),
        event_id uniqueidentifier NULL,
        original_filename nvarchar(260) NOT NULL,
        stored_filename nvarchar(260) NOT NULL,
        content_type nvarchar(160) NULL,
        file_size bigint NOT NULL,
        sha256 nvarchar(64) NOT NULL,
        storage_path nvarchar(1000) NOT NULL,
        parser_code nvarchar(120) NULL,
        processing_status nvarchar(40) NOT NULL CONSTRAINT DF_ops_attachments_status DEFAULT N'RECEIVED',
        error_detail nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_ops_attachments_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_ops_attachments PRIMARY KEY (attachment_id),
        CONSTRAINT UQ_ops_attachments_hash UNIQUE (sha256),
        CONSTRAINT FK_ops_attachments_event FOREIGN KEY (event_id) REFERENCES ops.Events(event_id)
    );
END;
GO

IF OBJECT_ID(N'ops.Actions', N'U') IS NULL
BEGIN
    CREATE TABLE ops.Actions (
        action_id uniqueidentifier NOT NULL CONSTRAINT DF_ops_actions_id DEFAULT NEWID(),
        event_id uniqueidentifier NULL,
        action_type nvarchar(160) NOT NULL,
        target_type nvarchar(120) NOT NULL,
        target_reference nvarchar(300) NOT NULL,
        idempotency_key nvarchar(500) NOT NULL,
        risk_level nvarchar(40) NOT NULL CONSTRAINT DF_ops_actions_risk DEFAULT N'MEDIUM',
        status nvarchar(40) NOT NULL CONSTRAINT DF_ops_actions_status DEFAULT N'WAITING_APPROVAL',
        before_json nvarchar(max) NULL,
        proposed_json nvarchar(max) NOT NULL,
        applied_json nvarchar(max) NULL,
        requested_by uniqueidentifier NULL,
        decided_by uniqueidentifier NULL,
        decision_note nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_ops_actions_created DEFAULT SYSUTCDATETIME(),
        decided_at datetime2(0) NULL,
        CONSTRAINT PK_ops_actions PRIMARY KEY (action_id),
        CONSTRAINT UQ_ops_actions_idempotency UNIQUE (idempotency_key),
        CONSTRAINT CK_ops_actions_status CHECK (status IN (N'WAITING_APPROVAL', N'APPROVED', N'REJECTED', N'APPLIED', N'FAILED')),
        CONSTRAINT FK_ops_actions_event FOREIGN KEY (event_id) REFERENCES ops.Events(event_id)
    );
END;
GO

IF OBJECT_ID(N'ops.Approvals', N'U') IS NULL
BEGIN
    CREATE TABLE ops.Approvals (
        approval_id uniqueidentifier NOT NULL CONSTRAINT DF_ops_approvals_id DEFAULT NEWID(),
        action_id uniqueidentifier NOT NULL,
        decision nvarchar(30) NOT NULL,
        note nvarchar(max) NULL,
        decided_by uniqueidentifier NULL,
        decided_at datetime2(0) NOT NULL CONSTRAINT DF_ops_approvals_decided DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_ops_approvals PRIMARY KEY (approval_id),
        CONSTRAINT CK_ops_approvals_decision CHECK (decision IN (N'APPROVED', N'REJECTED')),
        CONSTRAINT FK_ops_approvals_action FOREIGN KEY (action_id) REFERENCES ops.Actions(action_id)
    );
END;
GO

IF OBJECT_ID(N'ops.Exceptions', N'U') IS NULL
BEGIN
    CREATE TABLE ops.Exceptions (
        exception_id uniqueidentifier NOT NULL CONSTRAINT DF_ops_exceptions_id DEFAULT NEWID(),
        event_id uniqueidentifier NULL,
        exception_type nvarchar(120) NOT NULL,
        severity nvarchar(30) NOT NULL CONSTRAINT DF_ops_exceptions_severity DEFAULT N'WARNING',
        status nvarchar(30) NOT NULL CONSTRAINT DF_ops_exceptions_status DEFAULT N'OPEN',
        subject_reference nvarchar(300) NULL,
        message nvarchar(1000) NOT NULL,
        technical_detail nvarchar(max) NULL,
        assigned_to uniqueidentifier NULL,
        resolution_note nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_ops_exceptions_created DEFAULT SYSUTCDATETIME(),
        resolved_at datetime2(0) NULL,
        CONSTRAINT PK_ops_exceptions PRIMARY KEY (exception_id),
        CONSTRAINT CK_ops_exceptions_status CHECK (status IN (N'OPEN', N'REVIEWING', N'RESOLVED', N'DISMISSED')),
        CONSTRAINT FK_ops_exceptions_event FOREIGN KEY (event_id) REFERENCES ops.Events(event_id)
    );
END;
GO

IF OBJECT_ID(N'ops.StatusProjection', N'U') IS NULL
BEGIN
    CREATE TABLE ops.StatusProjection (
        projection_id uniqueidentifier NOT NULL CONSTRAINT DF_ops_projection_id DEFAULT NEWID(),
        target_reference nvarchar(300) NOT NULL,
        supplier_code nvarchar(80) NOT NULL,
        supplier_status nvarchar(160) NOT NULL,
        projected_status nvarchar(160) NOT NULL,
        source_event_id uniqueidentifier NULL,
        created_by uniqueidentifier NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_ops_projection_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_ops_projection PRIMARY KEY (projection_id),
        CONSTRAINT UQ_ops_projection_event_target UNIQUE (source_event_id, target_reference),
        CONSTRAINT FK_ops_projection_event FOREIGN KEY (source_event_id) REFERENCES ops.Events(event_id)
    );
END;
GO

IF OBJECT_ID(N'ops.NotificationOutbox', N'U') IS NULL
BEGIN
    CREATE TABLE ops.NotificationOutbox (
        notification_id uniqueidentifier NOT NULL CONSTRAINT DF_ops_outbox_id DEFAULT NEWID(),
        action_id uniqueidentifier NULL,
        notification_type nvarchar(120) NOT NULL,
        recipient_reference nvarchar(300) NULL,
        payload_json nvarchar(max) NOT NULL,
        idempotency_key nvarchar(500) NOT NULL,
        status nvarchar(30) NOT NULL CONSTRAINT DF_ops_outbox_status DEFAULT N'PENDING',
        attempts int NOT NULL CONSTRAINT DF_ops_outbox_attempts DEFAULT 0,
        last_error nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_ops_outbox_created DEFAULT SYSUTCDATETIME(),
        sent_at datetime2(0) NULL,
        CONSTRAINT PK_ops_outbox PRIMARY KEY (notification_id),
        CONSTRAINT UQ_ops_outbox_idempotency UNIQUE (idempotency_key),
        CONSTRAINT CK_ops_outbox_status CHECK (status IN (N'PENDING', N'SENT', N'FAILED')),
        CONSTRAINT FK_ops_outbox_action FOREIGN KEY (action_id) REFERENCES ops.Actions(action_id)
    );
END;
GO

IF OBJECT_ID(N'ops.ActivityLog', N'U') IS NULL
BEGIN
    CREATE TABLE ops.ActivityLog (
        activity_id bigint IDENTITY(1,1) NOT NULL,
        event_id uniqueidentifier NULL,
        action_id uniqueidentifier NULL,
        exception_id uniqueidentifier NULL,
        activity_type nvarchar(120) NOT NULL,
        actor_user_id uniqueidentifier NULL,
        detail_json nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_ops_activity_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_ops_activity PRIMARY KEY (activity_id)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ops_events_status_available')
    CREATE INDEX IX_ops_events_status_available ON ops.Events(status, available_at, created_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ops_events_external_reference')
    CREATE INDEX IX_ops_events_external_reference ON ops.Events(source_system, external_reference);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ops_actions_status')
    CREATE INDEX IX_ops_actions_status ON ops.Actions(status, created_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ops_exceptions_status')
    CREATE INDEX IX_ops_exceptions_status ON ops.Exceptions(status, severity, created_at);
GO
