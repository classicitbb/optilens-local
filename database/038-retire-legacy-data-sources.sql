-- Retire legacy source connectors. Imported archive rows remain untouched in
-- optilens_local; this removes only obsolete connection metadata and the
-- former runtime source-selection setting.

DELETE FROM integration.connections
WHERE connection_code = N'source-access-cv-accounts';
GO

DELETE FROM core.app_settings
WHERE setting_key = N'source_backend';
GO

DELETE FROM core.dashboard_tiles
WHERE tile_key = N'access-archive-import-status';
GO
