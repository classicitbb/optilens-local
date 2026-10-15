USE [optilens_local];
GO

-- Bulk upload. Each file in a batch becomes one order (status NEW while it waits
-- in the queue). batch_id groups the files dropped together, source_file_name
-- is the name the user saw, and source_sha256 detects the same file uploaded twice.
IF COL_LENGTH(N'rx_capture.orders', N'batch_id') IS NULL
    ALTER TABLE rx_capture.orders ADD batch_id uniqueidentifier NULL;
GO

IF COL_LENGTH(N'rx_capture.orders', N'source_file_name') IS NULL
    ALTER TABLE rx_capture.orders ADD source_file_name nvarchar(260) NULL;
GO

IF COL_LENGTH(N'rx_capture.orders', N'source_sha256') IS NULL
    ALTER TABLE rx_capture.orders ADD source_sha256 char(64) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_rx_capture_orders_batch' AND object_id = OBJECT_ID(N'rx_capture.orders'))
    CREATE INDEX IX_rx_capture_orders_batch ON rx_capture.orders (batch_id, created_at);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_rx_capture_orders_source_sha256' AND object_id = OBJECT_ID(N'rx_capture.orders'))
    CREATE INDEX IX_rx_capture_orders_source_sha256 ON rx_capture.orders (source_sha256);
GO
