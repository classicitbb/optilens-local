-- Retire legacy source connectors. Imported archive rows remain untouched in
-- optilens_local; this removes only obsolete connection metadata and the
-- former runtime source-selection setting.

DELETE FROM integration.connections
WHERE connection_code = N'source-access-cv-accounts';
GO

DELETE FROM core.app_settings
WHERE setting_key = N'source_backend';
GO

DELETE device_layout_row
FROM core.user_device_dashboard_tiles AS device_layout_row
INNER JOIN core.dashboard_tiles AS tile
    ON tile.dashboard_tile_id = device_layout_row.dashboard_tile_id
WHERE tile.tile_key = N'access-archive-import-status';
GO

DELETE user_layout_row
FROM core.user_dashboard_tiles AS user_layout_row
INNER JOIN core.dashboard_tiles AS tile
    ON tile.dashboard_tile_id = user_layout_row.dashboard_tile_id
WHERE tile.tile_key = N'access-archive-import-status';
GO

DELETE FROM core.dashboard_tiles
WHERE tile_key = N'access-archive-import-status';
GO
