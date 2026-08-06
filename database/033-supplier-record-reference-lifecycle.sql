USE [optilens_local];
GO

-- Every unresolved WIP/dispatch line was creating a brand-new
-- ops.SupplierRecords row each time its report resent the same still-pending
-- reference, because the only reuse keys were internal_order_id (NULL until
-- matched) and the exact event/attachment/row of one specific email. That
-- left every "Not Found" line orphaned forever, even after the order later
-- appeared in Innovations, since the newly matched row was a separate insert
-- and the stale exception rows were never reconciled or retried.
--
-- Collapse any existing duplicates for the same (rule_code, supplier_reference)
-- placeholder down to the most recently observed row, then enforce the
-- invariant going forward with a unique index alongside the existing
-- UX_ops_supplier_records_active_order index for matched rows.

;WITH ranked AS (
    SELECT record_id, rule_code, supplier_reference,
           FIRST_VALUE(record_id) OVER (
             PARTITION BY rule_code, supplier_reference
             ORDER BY last_observed_at DESC, updated_at DESC, created_at DESC, record_id DESC
           ) AS keeper_id,
           ROW_NUMBER() OVER (
             PARTITION BY rule_code, supplier_reference
             ORDER BY last_observed_at DESC, updated_at DESC, created_at DESC, record_id DESC
           ) AS lifecycle_rank
    FROM ops.SupplierRecords
    WHERE internal_order_id IS NULL AND lifecycle_state = N'ACTIVE'
)
UPDATE o
SET record_id = r.keeper_id
FROM ops.SupplierRecordOccurrences o
INNER JOIN ranked r ON r.record_id = o.record_id
WHERE r.lifecycle_rank > 1;
GO

;WITH ranked AS (
    SELECT record_id,
           ROW_NUMBER() OVER (
             PARTITION BY rule_code, supplier_reference
             ORDER BY last_observed_at DESC, updated_at DESC, created_at DESC, record_id DESC
           ) AS lifecycle_rank
    FROM ops.SupplierRecords
    WHERE internal_order_id IS NULL AND lifecycle_state = N'ACTIVE'
)
UPDATE r
SET lifecycle_state = N'ARCHIVED', lifecycle_archive_reason = N'SUPERSEDED',
    terminated_at = COALESCE(terminated_at, last_observed_at, updated_at)
FROM ops.SupplierRecords r
INNER JOIN ranked d ON d.record_id = r.record_id
WHERE d.lifecycle_rank > 1;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_ops_supplier_records_active_reference')
    CREATE UNIQUE INDEX UX_ops_supplier_records_active_reference
      ON ops.SupplierRecords(rule_code, supplier_reference)
      WHERE internal_order_id IS NULL AND lifecycle_state = N'ACTIVE';
GO
