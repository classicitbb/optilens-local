USE [optilens_local];
GO

-- Front-dashboard tiles for the two inventory exceptions.
--
-- module_code is NULL deliberately. Business Metrics has a route
-- (/modules/business-metrics) and a permission (platform.admin) in server.js,
-- but no core.modules row — and adding one would surface a module card to every
-- user, including those who cannot open it. These tiles instead carry a direct
-- link resolved in lib/dashboard.js, so nothing changes about module access.
--
-- MERGE, not INSERT: re-running migrations must not duplicate a tile or undo an
-- operator's visibility choice beyond restoring the defaults.
MERGE core.dashboard_tiles AS target
USING (VALUES
    (N'inventory-negative-stock', N'Negative stock',
     N'Active SKUs recording less than zero on hand — correct by physical count before trusting any valuation.',
     NULL, N'kpi', N'normal', 130, 1),
    (N'inventory-zero-cost-stock', N'Zero-cost stock',
     N'Active SKUs holding quantity at zero cost — they record no COGS when used, inflating gross margin.',
     NULL, N'kpi', N'normal', 140, 1)
) AS source (tile_key, title, description, module_code, tile_type, default_size, default_sort, is_default_visible)
ON target.tile_key = source.tile_key
WHEN MATCHED THEN
    UPDATE SET
        title = source.title,
        description = source.description,
        module_code = source.module_code,
        tile_type = source.tile_type,
        default_size = source.default_size,
        default_sort = source.default_sort,
        is_default_visible = source.is_default_visible,
        is_active = 1
WHEN NOT MATCHED THEN
    INSERT (tile_key, title, description, module_code, tile_type, default_size, default_sort, is_default_visible)
    VALUES (source.tile_key, source.title, source.description, source.module_code,
            source.tile_type, source.default_size, source.default_sort, source.is_default_visible);
GO
