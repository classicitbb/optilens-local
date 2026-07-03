USE [optilens_local];
GO

-- Columns needed to mirror the Innovations shipment/legacy delivery screen
-- (source_shipment_batch_id, tracking_number, shipping method, source result
-- message, source item count) directly on delivery.shipment_sessions, plus a
-- filtered unique index so the sync job can upsert on source_shipment_id
-- without ever duplicating a session.

IF COL_LENGTH(N'delivery.shipment_sessions', N'source_shipment_batch_id') IS NULL
    ALTER TABLE delivery.shipment_sessions ADD source_shipment_batch_id int NULL;
GO

IF COL_LENGTH(N'delivery.shipment_sessions', N'tracking_number') IS NULL
    ALTER TABLE delivery.shipment_sessions ADD tracking_number nvarchar(200) NULL;
GO

IF COL_LENGTH(N'delivery.shipment_sessions', N'shipping_method_id') IS NULL
    ALTER TABLE delivery.shipment_sessions ADD shipping_method_id int NULL;
GO

IF COL_LENGTH(N'delivery.shipment_sessions', N'shipping_method_name') IS NULL
    ALTER TABLE delivery.shipment_sessions ADD shipping_method_name nvarchar(200) NULL;
GO

IF COL_LENGTH(N'delivery.shipment_sessions', N'source_result_message') IS NULL
    ALTER TABLE delivery.shipment_sessions ADD source_result_message nvarchar(500) NULL;
GO

IF COL_LENGTH(N'delivery.shipment_sessions', N'source_item_count') IS NULL
    ALTER TABLE delivery.shipment_sessions ADD source_item_count int NULL;
GO

IF COL_LENGTH(N'delivery.shipment_sessions', N'source_synced_at') IS NULL
    ALTER TABLE delivery.shipment_sessions ADD source_synced_at datetime2(0) NULL;
GO

-- Upsert key: one local session per (source_system, source_shipment_id).
-- Filtered so historical rows with no source_shipment_id (manually created,
-- pre-sync) never collide.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_delivery_shipment_sessions_source' AND object_id = OBJECT_ID(N'delivery.shipment_sessions'))
    CREATE UNIQUE INDEX UX_delivery_shipment_sessions_source
        ON delivery.shipment_sessions (source_system, source_shipment_id)
        WHERE source_shipment_id IS NOT NULL;
GO

-- Note: Innovations' Customers.ShipmentBin is a per-customer attribute, not a
-- per-shipment one. It is read live via /api/source/customers (see
-- lib/source-innovations.js) and joined client-side, same as customer_name
-- already is — no local caching table needed for it.
