-- Production QBO runs reconcile first. External creates and updates require a
-- durable OptiLens approval and retain the QBO snapshot used for that decision.

IF COL_LENGTH(N'qbo.invoice_sync_ledger', N'approval_state') IS NULL
BEGIN
    ALTER TABLE qbo.invoice_sync_ledger ADD
        approval_state nvarchar(30) NOT NULL CONSTRAINT DF_qbo_invoice_sync_ledger_approval_state DEFAULT N'not_required',
        approval_requested_at datetime2(3) NULL,
        approval_requested_by_user_id uniqueidentifier NULL,
        approved_at datetime2(3) NULL,
        approved_by_user_id uniqueidentifier NULL,
        qbo_snapshot_hash nvarchar(64) NULL,
        reconciliation_json nvarchar(max) NULL;
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_qbo_invoice_sync_ledger_approval' AND object_id = OBJECT_ID(N'qbo.invoice_sync_ledger'))
    CREATE INDEX IX_qbo_invoice_sync_ledger_approval ON qbo.invoice_sync_ledger(approval_state, updated_at DESC);
GO
