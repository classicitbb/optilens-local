USE [optilens_local];
GO

-- Rollback for migration 020 — drop the beswift_option_index column.
-- The extension falls back to its built-in OPTION_INDEX_HINTS_FALLBACK map when
-- the column/payload hint is absent, so removing this column reverts behaviour
-- to the pre-020 hardcoded positions without breaking the fill.

IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID(N'delivery.standards_catalog')
      AND name = 'beswift_option_index'
)
BEGIN
    ALTER TABLE delivery.standards_catalog
        DROP COLUMN beswift_option_index;
END;
GO
