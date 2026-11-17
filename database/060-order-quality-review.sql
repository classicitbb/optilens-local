USE [optilens_local];
GO

-- Review decisions for the Business Metrics "Order quality" tab.
-- The findings themselves are live read-only queries against Innovations and are never stored.
-- This table only records what a person decided about a finding, so it stops shouting
-- once handled and can be reopened if it comes back after being marked fixed.
IF SCHEMA_ID(N'metrics') IS NULL EXEC (N'CREATE SCHEMA metrics');
GO

IF OBJECT_ID(N'metrics.order_quality_decisions', N'U') IS NULL
BEGIN
    CREATE TABLE metrics.order_quality_decisions (
        decision_id uniqueidentifier NOT NULL CONSTRAINT DF_metrics_oqd_id DEFAULT NEWID(),
        finding_key nvarchar(300) NOT NULL,
        check_code nvarchar(40) NOT NULL,
        decision nvarchar(20) NOT NULL,              -- 'accepted' | 'fixed' | 'dismissed'
        reason nvarchar(500) NOT NULL,
        context_json nvarchar(max) NULL,             -- what the numbers were when decided
        created_at datetime2(0) NOT NULL CONSTRAINT DF_metrics_oqd_created DEFAULT SYSUTCDATETIME(),
        created_by_user_id uniqueidentifier NULL,
        created_by nvarchar(100) NULL,
        CONSTRAINT PK_metrics_order_quality_decisions PRIMARY KEY (decision_id),
        CONSTRAINT CK_metrics_oqd_decision CHECK (decision IN (N'accepted', N'fixed', N'dismissed'))
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_metrics_oqd_key' AND object_id = OBJECT_ID(N'metrics.order_quality_decisions'))
    CREATE INDEX IX_metrics_oqd_key ON metrics.order_quality_decisions (finding_key, created_at DESC);
GO
