const { randomUUID } = require("node:crypto");
const { getConfig } = require("./config");
const { getAppPool } = require("./db");
const { getIntegrationHealthSnapshot } = require("./integration-health");
const { getInventoryExceptionCounts } = require("./metrics/inventory");

const DASHBOARD_USERNAME = "local-dashboard";

// Tiles that link somewhere without belonging to a core.modules row. Business
// Metrics has a route and a permission but no module record, and registering
// one would show a module card to users who cannot open it.
const DIRECT_TILE_HREFS = {
  "inventory-negative-stock": "/modules/business-metrics#drill=inventory-negative",
  "inventory-zero-cost-stock": "/modules/business-metrics#drill=inventory-zero-cost"
};

/** Resolves to null on timeout or failure — a slow source degrades one tile, not the page. */
function withDeadline(promise, ms) {
  return Promise.race([
    Promise.resolve().then(() => promise).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), ms))
  ]);
}

const defaultModules = [
  {
    id: "delivery-export",
    name: "Delivery and Export",
    status: "first-build",
    href: "/modules/delivery-export",
    summary: "Access delivery, shipment prep, commercial invoice, and archive workflows.",
    isEnabled: true
  },
  {
    id: "integrations",
    name: "Integrations",
    status: "planned",
    href: "/modules/integrations",
    summary: "MSSQL, PSQL, Access import, website updates, file-share checks, and future service APIs.",
    isEnabled: true
  },
  {
    id: "automation",
    name: "Automation",
    status: "planned",
    href: "/modules/automation",
    summary: "Local LLM and rule-based automation tools routed through audited platform APIs.",
    isEnabled: true
  },
  {
    id: "pricing-automation",
    name: "Pricing Automation",
    status: "first-build",
    href: "/modules/pricing-automation",
    summary: "Rule-based pricing calculator with app-owned write history and audit events.",
    isEnabled: true
  }
];

const fallbackCatalog = [
  tile("open-source-shipments", "Open source shipments", "Source shipments still open for export prep.", "delivery-export", "kpi", 10),
  tile("shipment-prep-sessions", "Shipment prep sessions", "App-owned delivery/export prep sessions.", "delivery-export", "kpi", 20),
  tile("app-owned-closures", "App-owned closures", "Closed shipment state stored in the private app database.", "delivery-export", "kpi", 30),
  tile("reopened-shipments", "Reopened shipments", "Reopened shipment sessions tracked by the app.", "delivery-export", "kpi", 40),
  tile("source-mssql-health", "Source MSSQL health", "Read-only Innovations source connection status.", null, "health", 50),
  tile("private-app-db-health", "Private app DB health", "Private optilens_local database status.", null, "health", 60),
  tile("access-archive-import-status", "Access archive/import status", "Historic CV_Accounts_be import and archive readiness.", "delivery-export", "kpi", 70),
  tile("write-back-status", "Write-back status", "Source write-back remains disabled until explicitly approved.", null, "kpi", 80),
  tile("integration-readiness", "Integration readiness", "Integration module setup and connector readiness.", "integrations", "kpi", 90),
  tile("automation-readiness", "Automation readiness", "Local LLM and automation readiness.", "automation", "kpi", 100),
  tile("pricing-rule-count", "Pricing rules", "Active pricing automation rules in the private app database.", "pricing-automation", "kpi", 110),
  tile("pricing-calculation-count", "Pricing calculations", "App-owned pricing calculation history.", "pricing-automation", "kpi", 120),
  tile("inventory-negative-stock", "Negative stock", "Active SKUs recording less than zero on hand — correct by physical count.", "business-metrics", "kpi", 130),
  tile("inventory-zero-cost-stock", "Zero-cost stock", "Active SKUs holding quantity at zero cost — they record no COGS when used.", "business-metrics", "kpi", 140)
];

function tile(key, title, description, moduleCode, type, sort) {
  return {
    dashboard_tile_id: null,
    tile_key: key,
    title,
    description,
    module_code: moduleCode,
    tile_type: type,
    default_size: "normal",
    default_sort: sort,
    is_default_visible: true,
    is_visible: null,
    sort_order: null,
    size: null
  };
}

async function buildDashboard(deviceId, userId = null) {
  const config = getConfig();
  const safeDeviceId = normalizeDeviceId(deviceId);
  const health = await getIntegrationHealthSnapshot();
  const appDbHealth = health.appDatabase;
  const sourceDbHealth = health.sourceDatabase;
  const psqlDbHealth = health.psqlDatabase;

  let dbData;
  try {
    dbData = await readDashboardData(safeDeviceId, userId);
  } catch {
    dbData = null;
  }

  const modules = dbData?.modules || defaultModules;
  const enabledModules = modules.filter((module) => module.isEnabled !== false);
  const enabledModuleCodes = new Set(enabledModules.map((module) => module.id));
  const stats = dbData?.stats || {};

  // Inventory exceptions come from live Innovations, which is occasionally slow
  // to connect. The dashboard is the landing page, so this is capped and
  // failure-tolerant: a bad day for the source costs those two tiles their
  // numbers, never the whole page.
  stats.inventoryExceptions = await withDeadline(getInventoryExceptionCounts(), 4000);
  const accessHealth = accessBackendHealth(stats);
  const catalog = dbData?.tiles || fallbackCatalog;
  const moduleHrefByCode = new Map(modules.map((module) => [module.id, module.href]));
  const hydratedTiles = catalog
    .filter((tileRow) => !tileRow.module_code || enabledModuleCodes.has(tileRow.module_code))
    .map((tileRow) => hydrateTile(tileRow, stats, appDbHealth, sourceDbHealth, psqlDbHealth, config, moduleHrefByCode));

  const visibleTiles = hydratedTiles
    .filter((tileRow) => tileRow.isVisible)
    .sort(compareTiles);
  const hiddenTiles = hydratedTiles
    .filter((tileRow) => !tileRow.isVisible)
    .sort(compareTiles);

  return {
    updatedAt: new Date().toISOString(),
    launchUrl: "http://192.168.254.9:8080/",
    dashboardUser: dbData?.dashboardUser || DASHBOARD_USERNAME,
    deviceId: safeDeviceId,
    metadata: {
      editModeAvailable: true,
      visibilityScope: "user",
      layoutScope: "user-device"
    },
    modules,
    enabledModules,
    tiles: visibleTiles,
    hiddenTiles,
    metrics: visibleTiles,
    integrationHealth: [
      appDbHealth,
      sourceDbHealth,
      psqlDbHealth,
      accessHealth
    ]
  };
}

async function readDashboardData(deviceId, userId) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("username", DASHBOARD_USERNAME)
    .input("user_id", userId)
    .input("device_id", deviceId)
    .query(`
      DECLARE @dashboard_user_id uniqueidentifier;
      DECLARE @dashboard_username nvarchar(160);

      SELECT
        @dashboard_user_id = COALESCE(@user_id, u.user_id),
        @dashboard_username = u.username
      FROM core.users u
      WHERE (@user_id IS NOT NULL AND u.user_id = @user_id)
         OR (@user_id IS NULL AND u.username = @username);

      SELECT
        module_code AS id,
        module_name AS name,
        status,
        route_path AS href,
        CASE module_code
          WHEN N'delivery-export' THEN N'Access delivery, shipment prep, commercial invoice, and archive workflows.'
          WHEN N'integrations' THEN N'MSSQL, PSQL, Access import, website updates, file-share checks, and future service APIs.'
          WHEN N'automation' THEN N'Local LLM and rule-based automation tools routed through audited platform APIs.'
          WHEN N'pricing-automation' THEN N'Rule-based pricing calculator with app-owned write history and audit events.'
          ELSE N'Platform module.'
        END AS summary,
        CAST(is_enabled AS bit) AS isEnabled
      FROM core.modules
      ORDER BY module_name;

      SELECT
        t.dashboard_tile_id,
        t.tile_key,
        t.title,
        t.description,
        t.module_code,
        t.tile_type,
        t.default_size,
        t.default_sort,
        t.is_default_visible,
        udt.is_visible,
        uddt.sort_order,
        uddt.size
      FROM core.dashboard_tiles t
      LEFT JOIN core.user_dashboard_tiles udt
        ON udt.user_id = @dashboard_user_id
       AND udt.dashboard_tile_id = t.dashboard_tile_id
      LEFT JOIN core.user_device_dashboard_tiles uddt
        ON uddt.user_id = @dashboard_user_id
       AND uddt.dashboard_tile_id = t.dashboard_tile_id
       AND uddt.device_id = @device_id
      WHERE t.is_active = 1
      ORDER BY COALESCE(uddt.sort_order, t.default_sort), t.default_sort;

      SELECT
        COUNT(*) AS shipmentPrepSessions,
        SUM(CASE WHEN app_status = N'closed' THEN 1 ELSE 0 END) AS appOwnedClosures,
        SUM(CASE WHEN reopened_at IS NOT NULL THEN 1 ELSE 0 END) AS reopenedShipments
      FROM delivery.shipment_sessions;

      SELECT
        COUNT(*) AS pricingRules,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS activePricingRules
      FROM pricing.price_rules;

      SELECT
        COUNT(*) AS pricingCalculations
      FROM pricing.price_calculations;

      SELECT
        COUNT(*) AS accessDeliveries,
        COUNT(DISTINCT CAST(delivery_date AS date)) AS accessDeliveryDates,
        MIN(CAST(delivery_date AS date)) AS accessMinDeliveryDate,
        MAX(CAST(delivery_date AS date)) AS accessMaxDeliveryDate
      FROM archive.access_deliveries;

      SELECT TOP (1)
        history_months AS accessHistoryMonths,
        cutoff_date AS accessCutoffDate,
        completed_at AS accessCompletedAt,
        status AS accessImportStatus
      FROM archive.access_import_batches
      ORDER BY started_at DESC;

      SELECT @dashboard_username AS dashboardUser;

      SELECT tile_key, value_text, state, updated_at
      FROM core.admin_dashboard_metrics;
    `);

  return {
    modules: result.recordsets[0].map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      href: row.href,
      summary: row.summary,
      isEnabled: row.isEnabled
    })),
    tiles: result.recordsets[1],
    stats: {
      ...(result.recordsets[2][0] || {}),
      ...(result.recordsets[3][0] || {}),
      ...(result.recordsets[4][0] || {}),
      ...(result.recordsets[5][0] || {}),
      ...(result.recordsets[6][0] || {}),
      adminMetrics: Object.fromEntries((result.recordsets[8] || []).map((row) => [row.tile_key, row]))
    },
    dashboardUser: result.recordsets[7]?.[0]?.dashboardUser || DASHBOARD_USERNAME
  };
}

async function saveDashboardTiles(payload, actorUserId = null) {
  const deviceId = normalizeDeviceId(payload?.deviceId);
  const tiles = Array.isArray(payload?.tiles) ? payload.tiles : [];
  if (!tiles.length) {
    const error = new Error("At least one dashboard tile is required.");
    error.statusCode = 400;
    throw error;
  }

  const pool = await getAppPool();
  const userId = actorUserId || await ensureDashboardUser(pool);

  for (const [index, item] of tiles.entries()) {
    const key = normalizeText(item.key || item.tileKey, 120);
    if (!key) continue;

    const size = normalizeTileSize(item.size);
    const sortOrder = Number.isInteger(Number(item.sortOrder)) ? Number(item.sortOrder) : index + 1;
    const isVisible = item.isVisible !== false;

    await pool.request()
      .input("user_id", userId)
      .input("device_id", deviceId)
      .input("tile_key", key)
      .input("is_visible", isVisible)
      .input("sort_order", sortOrder)
      .input("size", size)
      .query(`
        DECLARE @dashboard_tile_id uniqueidentifier;

        SELECT @dashboard_tile_id = dashboard_tile_id
        FROM core.dashboard_tiles
        WHERE tile_key = @tile_key
          AND is_active = 1;

        IF @dashboard_tile_id IS NOT NULL
        BEGIN
          MERGE core.user_dashboard_tiles AS target
          USING (SELECT @user_id AS user_id, @dashboard_tile_id AS dashboard_tile_id) AS source
          ON target.user_id = source.user_id
         AND target.dashboard_tile_id = source.dashboard_tile_id
          WHEN MATCHED THEN
            UPDATE SET is_visible = @is_visible, updated_at = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN
            INSERT (user_id, dashboard_tile_id, is_visible)
            VALUES (@user_id, @dashboard_tile_id, @is_visible);

          MERGE core.user_device_dashboard_tiles AS target
          USING (SELECT @user_id AS user_id, @device_id AS device_id, @dashboard_tile_id AS dashboard_tile_id) AS source
          ON target.user_id = source.user_id
         AND target.device_id = source.device_id
         AND target.dashboard_tile_id = source.dashboard_tile_id
          WHEN MATCHED THEN
            UPDATE SET sort_order = @sort_order, size = @size, updated_at = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN
            INSERT (user_id, device_id, dashboard_tile_id, sort_order, size)
            VALUES (@user_id, @device_id, @dashboard_tile_id, @sort_order, @size);
        END;
      `);
  }

  await pool.request()
    .input("actor_user_id", userId)
    .input("event_data", JSON.stringify({
      deviceId,
      tileCount: tiles.length
    }))
    .query(`
      INSERT INTO core.audit_events (
        module_code,
        actor_user_id,
        event_type,
        entity_type,
        entity_id,
        event_data
      )
      VALUES (
        NULL,
        @actor_user_id,
        N'dashboard.tiles_saved',
        N'core.dashboard_tiles',
        N'command-center',
        @event_data
      );
    `);

  return buildDashboard(deviceId, userId);
}

async function ensureDashboardUser(pool) {
  const result = await pool.request()
    .input("username", DASHBOARD_USERNAME)
    .query(`
      IF NOT EXISTS (SELECT 1 FROM core.users WHERE username = @username)
      BEGIN
        INSERT INTO core.users (tenant_id, username, display_name)
        SELECT TOP (1) tenant_id, @username, N'Local Dashboard'
        FROM core.tenants
        ORDER BY created_at;
      END;

      SELECT user_id
      FROM core.users
      WHERE username = @username;
    `);

  return result.recordset[0].user_id;
}

function hydrateTile(row, stats, appDbHealth, sourceDbHealth, psqlDbHealth, config, moduleHrefByCode = new Map()) {
  const sortOrder = row.sort_order ?? row.default_sort;
  const size = row.size || row.default_size || "normal";
  const isVisible = row.is_visible === null || row.is_visible === undefined
    ? Boolean(row.is_default_visible)
    : Boolean(row.is_visible);
  const metric = metricForTile(row.tile_key, stats, appDbHealth, sourceDbHealth, psqlDbHealth, config);

  return {
    key: row.tile_key,
    title: row.title,
    description: row.description,
    moduleCode: row.module_code,
    href: row.module_code
      ? (moduleHrefByCode.get(row.module_code) || "")
      : (DIRECT_TILE_HREFS[row.tile_key] || ""),
    type: row.tile_type,
    size,
    sortOrder,
    isVisible,
    value: metric.value,
    detail: metric.detail,
    state: metric.state
  };
}

function metricForTile(key, stats, appDbHealth, sourceDbHealth, psqlDbHealth, config) {
  const custom = stats.adminMetrics?.[key];
  if (custom) return { value: custom.value_text || "—", detail: `Privileged metric · refreshed ${formatDate(custom.updated_at)}`, state: custom.state || "online" };
  const shipmentPrepSessions = Number(stats.shipmentPrepSessions || 0);
  const appOwnedClosures = Number(stats.appOwnedClosures || 0);
  const reopenedShipments = Number(stats.reopenedShipments || 0);
  const pricingRules = Number(stats.activePricingRules || stats.pricingRules || 0);
  const pricingCalculations = Number(stats.pricingCalculations || 0);

  const values = {
    "open-source-shipments": { value: "PSQL/MSSQL", detail: psqlDbHealth.state === "online" ? psqlDbHealth.detail : "Shipments.Shipped = 0", state: psqlDbHealth.state === "online" ? "online" : "discovered" },
    "shipment-prep-sessions": { value: formatCount(shipmentPrepSessions), detail: "Private app prep sessions", state: appDbHealth.state },
    "app-owned-closures": { value: appDbHealth.state === "online" ? formatCount(appOwnedClosures) : "Setup", detail: `Stored in ${config.appDb.database} first`, state: appDbHealth.state },
    "reopened-shipments": { value: formatCount(reopenedShipments), detail: "Private reopen history", state: appDbHealth.state },
    "source-mssql-health": { value: stateLabel(sourceDbHealth.state), detail: sourceDbHealth.detail, state: sourceDbHealth.state },
    "private-app-db-health": { value: stateLabel(appDbHealth.state), detail: appDbHealth.detail, state: appDbHealth.state },
    "access-archive-import-status": accessArchiveMetric(stats),
    "write-back-status": { value: config.writeBackEnabled ? "On" : "Off", detail: "Future approved workflow only", state: config.writeBackEnabled ? "enabled" : "disabled" },
    "integration-readiness": { value: "Planned", detail: "Connector catalog seeded", state: "planned" },
    "automation-readiness": { value: "Planned", detail: "Audited APIs before local LLM writes", state: "planned" },
    "pricing-rule-count": { value: formatCount(pricingRules), detail: "Active private DB rules", state: appDbHealth.state },
    "pricing-calculation-count": { value: formatCount(pricingCalculations), detail: "Saved calculation history", state: appDbHealth.state },
    "inventory-negative-stock": inventoryExceptionMetric(stats, "negative"),
    "inventory-zero-cost-stock": inventoryExceptionMetric(stats, "zeroCost")
  };

  return values[key] || { value: "", detail: "", state: "unknown" };
}

/**
 * Inventory exception tiles.
 *
 * State drives the tile's styling, and "critical" is reserved for a real
 * problem: negative stock means the count is wrong, which invalidates every
 * valuation and reorder figure for that item. Zero-cost is "warning" — it
 * distorts margin but nothing is physically wrong.
 *
 * The tile always states the number in text alongside its state, so the signal
 * never rests on colour alone. It does not flash: flashing content is a WCAG
 * 2.1 failure, and on a dashboard that is open all day staff stop seeing it
 * within a week. The Inventory tab pulses once, and only when a count rises.
 */
function inventoryExceptionMetric(stats, kind) {
  const inv = stats.inventoryExceptions;
  if (!inv) {
    return { value: "—", detail: "Live Innovations source unavailable", state: "unknown" };
  }

  if (kind === "negative") {
    const n = Number(inv.negativeCount || 0);
    return {
      value: formatCount(n),
      detail: n === 0
        ? "On target — no negative quantities"
        : `${formatCount(Math.abs(Number(inv.negativeUnits || 0)))} units · fix by physical count`,
      state: n === 0 ? "online" : "critical"
    };
  }

  const n = Number(inv.zeroCostCount || 0);
  return {
    value: formatCount(n),
    detail: n === 0
      ? "On target — every stocked SKU carries a cost"
      : "Records no COGS when used",
    state: n === 0 ? "online" : "warning"
  };
}

function accessArchiveMetric(stats) {
  const deliveries = Number(stats.accessDeliveries || 0);
  if (!deliveries) {
    return { value: "CV_Accounts_be", detail: "Awaiting Access import", state: "ready-for-import" };
  }

  return {
    value: "Imported",
    detail: `${formatCount(deliveries)} deliveries since ${formatDate(stats.accessCutoffDate || stats.accessMinDeliveryDate)}`,
    state: String(stats.accessImportStatus || "").toLowerCase() === "completed" ? "online" : "imported"
  };
}

function accessBackendHealth(stats) {
  const metric = accessArchiveMetric(stats);
  return {
    name: "Access backend",
    state: metric.state,
    detail: metric.value === "Imported"
      ? `${metric.detail}; latest through ${formatDate(stats.accessMaxDeliveryDate)}`
      : "CV_Accounts_be.accdb is first historic source"
  };
}

function createDeviceRegistration(deviceId) {
  return {
    deviceId: normalizeDeviceId(deviceId || randomUUID()),
    dashboardUser: DASHBOARD_USERNAME
  };
}

function normalizeDeviceId(value) {
  const text = normalizeText(value, 120);
  return text || "default-device";
}

function normalizeText(value, maxLength) {
  if (value === undefined || value === null) return "";
  return String(value).trim().replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, maxLength);
}

function normalizeTileSize(value) {
  const size = normalizeText(value, 40);
  return ["normal", "wide", "compact"].includes(size) ? size : "normal";
}

function compareTiles(a, b) {
  return (a.sortOrder - b.sortOrder) || a.title.localeCompare(b.title);
}

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

function formatDate(value) {
  if (!value) return "unknown";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function stateLabel(value) {
  return String(value || "unknown")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

module.exports = {
  buildDashboard,
  createDeviceRegistration,
  defaultModules,
  saveDashboardTiles
};
