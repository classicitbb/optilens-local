USE [optilens_local];
GO

-- Migration 020 — data-driven BeSwift dropdown option positions.
--
-- Some BeSwift fields are Vuetify autocompletes whose list does NOT filter when
-- the extension types into them (the full list stays visible), so the reliable
-- way to select is a POSITIONAL click at a known 1-based index. Those positions
-- were previously hardcoded in the extension (OPTION_INDEX_HINTS in content.js:
-- Country of Origin = 3, Package Type = 18). This migration moves them into the
-- catalog so an operator can correct a position when BeSwift reorders a list,
-- without a code change or redeploy. NULL = no positional hint (type-to-filter
-- or top-option is enough).
--
-- Idempotent: safe to re-run. Adds the column only if missing, then seeds the
-- two known positions only where they aren't already set.

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID(N'delivery.standards_catalog')
      AND name = 'beswift_option_index'
)
BEGIN
    ALTER TABLE delivery.standards_catalog
        ADD beswift_option_index int NULL;
END;
GO

-- Seed the two positions confirmed live (2026-07). Only touch the default row of
-- each field, and only if its hint is still NULL, so operator edits are never
-- clobbered on a re-run.
UPDATE delivery.standards_catalog
   SET beswift_option_index = 3
 WHERE field_key = N'countryOfOrigin'
   AND option_value = N'Barbados'
   AND beswift_option_index IS NULL;

UPDATE delivery.standards_catalog
   SET beswift_option_index = 18
 WHERE field_key = N'packageType'
   AND option_value = N'Bag, plastic'
   AND beswift_option_index IS NULL;
GO
